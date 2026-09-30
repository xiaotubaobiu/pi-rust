//! Port of upstream `coding-agent/src/core/extensions/runner.ts` (extension
//! runner; upstream SHA256 at migration time:
//! `92da35c1df5c64b98bb4dfe485140b3e98863f6d44f4686dbf5eb77ddc4ea8c7`).
//!
//! Port notes (disclosed):
//! - General event-handler dispatch awaits borrowed native futures
//!   ([`super::types::HandlerFn`]); rejected
//!   handler errors are `Err(message)` strings routed to
//!   [`ExtensionError`] listeners exactly like upstream, minus the JS stack
//!   (`stack` stays `None`).
//! - Command-context actions preserve immediate guarded dispatch and return
//!   the handler's awaitable [`CommandFuture`] unchanged.
//! - `setUIContext(ui, mode)` takes an [`ExtensionUI`] implementor (the full
//!   `noOpUIContext` default surface lives in the trait). `None` = the
//!   upstream no-op context; `hasUI()` is `Some`-ness.
//! - `emitUIPromptEvent` upstream uses `queueMicrotask`; native UI dispatch
//!   schedules a Tokio task instead. It is intentionally not awaited by the
//!   synchronous UI facade. No-runtime use reports a host error; it never
//!   blocks on an async handler. JS microtask timing and async UI methods
//!   remain separate seams.
//! - `emitInput`'s "did anything change" check compares by value (upstream
//!   compares the `images` array by reference).
//! - `getShortcuts` reuses the W3.3 [`ResolvedKeys`] shape from the ported
//!   keybindings module and reports diagnostics through the ported
//!   `ResourceDiagnostic`; upstream's `console.warn` becomes `eprintln!`.
//! - `bindCore`'s optional provider actions and the `ModelRegistry` fallback
//!   use the [`ProviderRegistryHandle`] seam from `types.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::command_future::CommandFuture;
use super::loader::{ProviderRouting, DEFAULT_STALE_MESSAGE};
use super::types::{
    AbortSignal, BeforeAgentStartEventResult, BuildSystemPromptOptions, CompactOptions,
    ContextUsage, Extension, ExtensionActions, ExtensionCommandContext,
    ExtensionCommandContextActions, ExtensionContext, ExtensionContextActions, ExtensionError,
    ExtensionErrorListener, ExtensionMode, ExtensionShortcut, ExtensionUiDialogOptions, FlagValue,
    HandlerFn, HandlerResult, InputEventResult, InputSource, MessageRenderer,
    NormalizedBuildSystemPromptOptions, NormalizedSystemPromptRenderer, OrderedMap,
    ProjectTrustContext, ProjectTrustEvent, ProjectTrustEventResult, ProviderRegistryHandle,
    ResolvedCommand, ResourcesDiscoverReason, SessionManagerHandle, StreamingDelivery,
    ThinkingLevel, UserBashEventResult,
};
use crate::coding_agent::core::diagnostics::{ResourceDiagnostic, ResourceDiagnosticType};
use crate::coding_agent::core::keybindings::ResolvedKeys;

// Extension shortcuts compete with canonical keybinding ids from
// keybindings.json. Only editor-global shortcuts are reserved here.
// Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS: [&str; 18] = [
    "app.interrupt",
    "app.clear",
    "app.exit",
    "app.suspend",
    "app.thinking.cycle",
    "app.model.cycleForward",
    "app.model.cycleBackward",
    "app.model.select",
    "app.tools.expand",
    "app.thinking.toggle",
    "app.editor.external",
    "app.message.copy",
    "app.message.followUp",
    "tui.input.submit",
    "tui.select.confirm",
    "tui.select.cancel",
    "tui.input.copy",
    "tui.editor.deleteToLineEnd",
];

/// Upstream `BuiltInKeyBindings` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BuiltinKeybinding {
    keybinding: String,
    restrict_override: bool,
}

/// Upstream `buildBuiltinKeybindings(resolvedKeybindings)`.
fn build_builtin_keybindings(
    resolved_keybindings: &[(String, ResolvedKeys)],
) -> OrderedMap<BuiltinKeybinding> {
    let mut builtin: OrderedMap<BuiltinKeybinding> = OrderedMap::new();
    for (keybinding, keys) in resolved_keybindings {
        let key_list: Vec<String> = match keys {
            ResolvedKeys::One(key) => vec![key.clone()],
            ResolvedKeys::Many(keys) => keys.clone(),
        };
        let restrict_override =
            RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS.contains(&keybinding.as_str());
        for key in key_list {
            let normalized_key = key.to_lowercase();
            // If multiple actions bind the same key, the reserved action wins
            // so extensions remain blocked by reserved shortcuts regardless of
            // iteration order.
            if let Some(existing) = builtin.get(&normalized_key) {
                if existing.restrict_override && !restrict_override {
                    continue;
                }
            }
            builtin.set(
                normalized_key,
                BuiltinKeybinding {
                    keybinding: keybinding.clone(),
                    restrict_override,
                },
            );
        }
    }
    builtin
}

/// Upstream `isUserBashEventResult` over the JSON seam: validates the
/// `{ result }` branch structurally. The `{ operations }` branch needs a
/// callable `exec` upstream; JSON cannot carry one, so JSON-shaped operations
/// results are rejected exactly like upstream rejects objects without an exec
/// function — the typed [`HandlerResult::UserBashOperations`] variant is the
/// valid path.
fn validate_user_bash_json(value: &Value) -> Option<UserBashEventResult> {
    let object = value.as_object()?;
    let has_operations = object.contains_key("operations");
    let has_result = object.contains_key("result");
    if has_operations == has_result {
        return None;
    }

    if has_operations {
        // Upstream also requires `typeof operations.exec === "function"`;
        // a JSON object cannot carry one (see function docs).
        return None;
    }

    let result = object.get("result")?;
    let result = result.as_object()?;
    let output = result.get("output")?.as_str()?;
    let exit_code = match result.get("exitCode") {
        None => None,
        Some(value) if value.is_i64() || value.is_u64() => value.as_i64(),
        _ => return None,
    };
    let cancelled = result.get("cancelled")?.as_bool()?;
    let truncated = result.get("truncated")?.as_bool()?;
    let full_output_path = match result.get("fullOutputPath") {
        None => None,
        Some(value) if value.is_string() => Some(value.as_str()?.to_string()),
        _ => return None,
    };
    let _ = output;
    Some(UserBashEventResult::Result(
        serde_json::from_value::<super::types::BashResult>(json!({
            "output": output,
            "exitCode": exit_code,
            "cancelled": cancelled,
            "truncated": truncated,
            "fullOutputPath": full_output_path,
        }))
        .ok()?,
    ))
}

/// Combined result from all before_agent_start handlers.
#[derive(Debug, Clone)]
pub struct BeforeAgentStartCombinedResult {
    pub messages: Vec<Value>,
    pub system_prompt_options: NormalizedBuildSystemPromptOptions,
}

/// Resources discovered from `resources_discover` handlers, attributed to the
/// extension that provided them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiscoveredResources {
    pub skill_paths: Vec<(String, String)>,
    pub prompt_paths: Vec<(String, String)>,
    pub theme_paths: Vec<(String, String)>,
}

/// Optional provider actions for [`ExtensionRunner::bind_core`].
#[derive(Default)]
pub struct ProviderActions {
    pub register_provider: Option<super::types::RegisterProviderHandler>,
    pub register_native_provider: Option<super::types::RegisterNativeProviderHandler>,
    pub unregister_provider: Option<super::types::UnregisterProviderHandler>,
}

pub(crate) struct CoreActions {
    pub get_model: super::types::GetModelHandler,
    pub get_scoped_models: super::types::GetScopedModelsHandler,
    pub is_idle: super::types::IsIdleHandler,
    pub is_project_trusted: super::types::IsProjectTrustedHandler,
    pub get_signal: super::types::GetSignalHandler,
    pub abort: super::types::AbortHandler,
    pub has_pending_messages: super::types::HasPendingMessagesHandler,
    pub shutdown: super::types::ShutdownHandler,
    pub get_context_usage: super::types::GetContextUsageHandler,
    pub compact: super::types::CompactHandler,
    pub get_system_prompt: super::types::GetSystemPromptHandler,
    pub get_system_prompt_options: super::types::GetSystemPromptOptionsHandler,
    pub wait_for_idle: super::types::WaitForIdleHandler,
    pub new_session: super::types::NewSessionHandler,
    pub fork: super::types::ForkHandler,
    pub navigate_tree: super::types::NavigateTreeHandler,
    pub switch_session: super::types::SwitchSessionHandler,
    pub reload: super::types::ReloadHandler,
}

pub(crate) struct RunnerInner {
    // Startup ProjectTrustContext.hasUI is independent of its (always present) UI.
    has_ui_override: Option<bool>,
    pub extensions: Vec<Extension>,
    pub runtime: super::loader::ExtensionRuntime,
    pub ui: Mutex<Option<Arc<dyn super::types::ExtensionUI>>>,
    pub mode: Mutex<ExtensionMode>,
    pub cwd: String,
    pub session_manager: SessionManagerHandle,
    pub model_registry: Arc<dyn ProviderRegistryHandle>,
    pub error_listeners: Arc<Mutex<ErrorListeners>>,
    pub actions: Mutex<CoreActions>,
    pub shortcut_diagnostics: Mutex<Vec<ResourceDiagnostic>>,
    pub command_diagnostics: Mutex<Vec<ResourceDiagnostic>>,
    /// Runner-level stale cell (upstream `private staleMessage`); the
    /// runtime's own cell drives captured `pi` APIs.
    pub stale: Mutex<Option<String>>,
    pub ui_prompt_depth: Mutex<u32>,
    pub active_ui_prompt: Mutex<Option<(super::types::UIPromptKind, Option<String>)>>,
}

pub(crate) struct ErrorListeners {
    next_id: u64,
    listeners: Vec<(u64, ExtensionErrorListener)>,
}

/// Upstream `onError` unsubscribe closure.
#[derive(Clone)]
pub struct ErrorListenerUnsubscribe {
    listeners: Arc<Mutex<ErrorListeners>>,
    id: u64,
}

impl ErrorListenerUnsubscribe {
    pub fn unsubscribe(&self) {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        listeners.listeners.retain(|(id, _)| *id != self.id);
    }
}

/// Upstream `ExtensionRunner`: executes extensions and manages their
/// lifecycle. Clones share state.
#[derive(Clone)]
pub struct ExtensionRunner {
    pub(crate) inner: Arc<RunnerInner>,
}

impl ExtensionRunner {
    /// Upstream `new ExtensionRunner(extensions, runtime, cwd,
    /// sessionManager, modelRegistry)`.
    pub fn new(
        extensions: Vec<Extension>,
        runtime: super::loader::ExtensionRuntime,
        cwd: &str,
        session_manager: SessionManagerHandle,
        model_registry: Arc<dyn ProviderRegistryHandle>,
    ) -> Self {
        let cwd = cwd.to_string();
        Self {
            inner: Arc::new(RunnerInner {
                has_ui_override: None,
                extensions,
                runtime,
                ui: Mutex::new(None),
                mode: Mutex::new(ExtensionMode::Print),
                cwd: cwd.clone(),
                session_manager,
                model_registry,
                error_listeners: Arc::new(Mutex::new(ErrorListeners {
                    next_id: 0,
                    listeners: Vec::new(),
                })),
                actions: Mutex::new(CoreActions {
                    get_model: Arc::new(|| None),
                    get_scoped_models: Arc::new(Vec::new),
                    is_idle: Arc::new(|| true),
                    is_project_trusted: Arc::new(|| true),
                    get_signal: Arc::new(|| None),
                    abort: Arc::new(|| {}),
                    has_pending_messages: Arc::new(|| false),
                    shutdown: Arc::new(|| {}),
                    get_context_usage: Arc::new(|| None),
                    compact: Arc::new(|_| {}),
                    get_system_prompt: Arc::new(String::new),
                    get_system_prompt_options: Arc::new(move || {
                        BuildSystemPromptOptions::with_cwd(&cwd)
                    }),
                    wait_for_idle: Arc::new(|| Ok(CommandFuture::resolved(()))),
                    new_session: Arc::new(|_| {
                        Ok(CommandFuture::resolved(super::types::Cancelled {
                            cancelled: false,
                        }))
                    }),
                    fork: Arc::new(|_, _| {
                        Ok(CommandFuture::resolved(super::types::Cancelled {
                            cancelled: false,
                        }))
                    }),
                    navigate_tree: Arc::new(|_, _| {
                        Ok(CommandFuture::resolved(super::types::Cancelled {
                            cancelled: false,
                        }))
                    }),
                    switch_session: Arc::new(|_, _| {
                        Ok(CommandFuture::resolved(super::types::Cancelled {
                            cancelled: false,
                        }))
                    }),
                    reload: Arc::new(|| Ok(CommandFuture::resolved(()))),
                }),
                shortcut_diagnostics: Mutex::new(Vec::new()),
                command_diagnostics: Mutex::new(Vec::new()),
                stale: Mutex::new(None),
                ui_prompt_depth: Mutex::new(0),
                active_ui_prompt: Mutex::new(None),
            }),
        }
    }

    /// Upstream `bindCore(actions, contextActions, providerActions?)`.
    pub fn bind_core(
        &self,
        actions: Arc<ExtensionActions>,
        context_actions: Arc<ExtensionContextActions>,
        provider_actions: Option<ProviderActions>,
    ) {
        // Copy actions into the shared runtime (all extension APIs reference
        // this).
        self.inner
            .runtime
            .with_state(|state| state.actions = Some(Arc::clone(&actions)));

        // Context actions (required).
        {
            let mut core = self
                .inner
                .actions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            core.get_model = Arc::clone(&context_actions.get_model);
            core.get_scoped_models = Arc::clone(&context_actions.get_scoped_models);
            core.is_idle = Arc::clone(&context_actions.is_idle);
            core.is_project_trusted = Arc::clone(&context_actions.is_project_trusted);
            core.get_signal = Arc::clone(&context_actions.get_signal);
            core.abort = Arc::clone(&context_actions.abort);
            core.has_pending_messages = Arc::clone(&context_actions.has_pending_messages);
            core.shutdown = Arc::clone(&context_actions.shutdown);
            core.get_context_usage = Arc::clone(&context_actions.get_context_usage);
            core.compact = Arc::clone(&context_actions.compact);
            core.get_system_prompt = Arc::clone(&context_actions.get_system_prompt);
            core.get_system_prompt_options = match &context_actions.get_system_prompt_options {
                Some(get) => Arc::clone(get),
                None => Arc::new({
                    let cwd = self.inner.cwd.clone();
                    move || BuildSystemPromptOptions::with_cwd(&cwd)
                }),
            };
        }

        // Flush provider registrations queued during extension loading.
        self.inner.runtime.flush_pending_providers(|registration| {
            let result = match provider_actions
                .as_ref()
                .and_then(|actions| actions.register_provider.as_ref())
            {
                Some(register) => register(&registration.name, &registration.config),
                None => self
                    .inner
                    .model_registry
                    .register_provider(&registration.name, &registration.config),
            };
            if let Err(error) = result {
                self.emit_error(ExtensionError {
                    extension_path: registration.extension_path,
                    event: "register_provider".to_string(),
                    error,
                    stack: None,
                });
            }
        });
        self.inner
            .runtime
            .flush_pending_native_providers(|registration| {
                let result = match provider_actions
                    .as_ref()
                    .and_then(|actions| actions.register_native_provider.as_ref())
                {
                    Some(register) => register(&registration.provider),
                    None => self
                        .inner
                        .model_registry
                        .register_native_provider(&registration.provider),
                };
                if let Err(error) = result {
                    self.emit_error(ExtensionError {
                        extension_path: registration.extension_path,
                        event: "register_provider".to_string(),
                        error,
                        stack: None,
                    });
                }
            });

        // From this point on, provider registration/unregistration takes
        // effect immediately without requiring a /reload.
        let registry = Arc::clone(&self.inner.model_registry);
        let fallback_register: super::types::RegisterProviderHandler =
            Arc::new(move |name, config| registry.register_provider(name, config));
        let registry = Arc::clone(&self.inner.model_registry);
        let fallback_register_native: super::types::RegisterNativeProviderHandler =
            Arc::new(move |provider| registry.register_native_provider(provider));
        let registry = Arc::clone(&self.inner.model_registry);
        let fallback_unregister: super::types::UnregisterProviderHandler =
            Arc::new(move |name| registry.unregister_provider(name));
        self.inner.runtime.with_state(|state| {
            state.provider_routing = Some(ProviderRouting {
                register_provider: provider_actions
                    .as_ref()
                    .and_then(|actions| actions.register_provider.clone())
                    .unwrap_or(fallback_register),
                register_native_provider: provider_actions
                    .as_ref()
                    .and_then(|actions| actions.register_native_provider.clone())
                    .unwrap_or(fallback_register_native),
                unregister_provider: provider_actions
                    .as_ref()
                    .and_then(|actions| actions.unregister_provider.clone())
                    .unwrap_or(fallback_unregister),
            });
        });
    }

    /// Upstream `bindCommandContext(actions?)`.
    pub fn bind_command_context(&self, actions: Option<ExtensionCommandContextActions>) {
        let mut core = self
            .inner
            .actions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match actions {
            Some(actions) => {
                core.wait_for_idle = Arc::clone(&actions.wait_for_idle);
                core.new_session = Arc::clone(&actions.new_session);
                core.fork = Arc::clone(&actions.fork);
                core.navigate_tree = Arc::clone(&actions.navigate_tree);
                core.switch_session = Arc::clone(&actions.switch_session);
                core.reload = Arc::clone(&actions.reload);
            }
            None => {
                core.wait_for_idle = Arc::new(|| Ok(CommandFuture::resolved(())));
                core.new_session = Arc::new(|_| {
                    Ok(CommandFuture::resolved(super::types::Cancelled {
                        cancelled: false,
                    }))
                });
                core.fork = Arc::new(|_, _| {
                    Ok(CommandFuture::resolved(super::types::Cancelled {
                        cancelled: false,
                    }))
                });
                core.navigate_tree = Arc::new(|_, _| {
                    Ok(CommandFuture::resolved(super::types::Cancelled {
                        cancelled: false,
                    }))
                });
                core.switch_session = Arc::new(|_, _| {
                    Ok(CommandFuture::resolved(super::types::Cancelled {
                        cancelled: false,
                    }))
                });
                core.reload = Arc::new(|| Ok(CommandFuture::resolved(())));
            }
        }
    }

    /// Upstream `setUIContext(uiContext?, mode = "print")`.
    pub fn set_ui_context(
        &self,
        ui_context: Option<Arc<dyn super::types::ExtensionUI>>,
        mode: ExtensionMode,
    ) {
        *self
            .inner
            .ui
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = ui_context;
        *self
            .inner
            .mode
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = mode;
    }

    /// Upstream `getUIContext()`.
    pub fn get_ui_context(&self) -> Option<Arc<dyn super::types::ExtensionUI>> {
        self.inner
            .ui
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Upstream `hasUI()`.
    pub fn has_ui(&self) -> bool {
        self.get_ui_context().is_some()
    }

    /// Upstream `getExtensionPaths()`.
    pub fn get_extension_paths(&self) -> Vec<String> {
        self.inner
            .extensions
            .iter()
            .map(|extension| extension.path.clone())
            .collect()
    }

    /// Get all registered tools from all extensions (first registration per
    /// name wins).
    pub fn get_all_registered_tools(&self) -> Vec<super::types::RegisteredTool> {
        let mut tools_by_name = OrderedMap::new();
        for extension in &self.inner.extensions {
            for (name, tool) in extension.tools.iter() {
                if !tools_by_name.has(name) {
                    tools_by_name.set(name, tool.clone());
                }
            }
        }
        tools_by_name.values().cloned().collect()
    }

    /// Get a tool definition by name.
    pub fn get_tool_definition(
        &self,
        tool_name: &str,
    ) -> Option<Arc<super::types::ToolDefinition>> {
        for extension in &self.inner.extensions {
            if let Some(tool) = extension.tools.get(tool_name) {
                return Some(Arc::clone(&tool.definition));
            }
        }
        None
    }

    /// Upstream `getFlags()` — first flag per name wins.
    pub fn get_flags(&self) -> OrderedMap<super::types::ExtensionFlag> {
        let mut all_flags = OrderedMap::new();
        for extension in &self.inner.extensions {
            for (name, flag) in extension.flags.iter() {
                if !all_flags.has(name) {
                    all_flags.set(name, flag.clone());
                }
            }
        }
        all_flags
    }

    /// Upstream `setFlagValue(name, value)`.
    pub fn set_flag_value(&self, name: &str, value: FlagValue) {
        self.inner.runtime.set_flag_value(name, value);
    }

    /// Upstream `getFlagValues()` — a snapshot.
    pub fn get_flag_values(&self) -> OrderedMap<FlagValue> {
        self.inner.runtime.flag_values()
    }

    /// Upstream `getShortcuts(resolvedKeybindings)`.
    pub fn get_shortcuts(
        &self,
        resolved_keybindings: &[(String, ResolvedKeys)],
    ) -> OrderedMap<ExtensionShortcut> {
        *self
            .inner
            .shortcut_diagnostics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Vec::new();
        let builtin_keybindings = build_builtin_keybindings(resolved_keybindings);
        let mut extension_shortcuts: OrderedMap<ExtensionShortcut> = OrderedMap::new();

        for extension in &self.inner.extensions {
            for (key, shortcut) in extension.shortcuts.iter() {
                let normalized_key = key.to_lowercase();
                let built_in = builtin_keybindings.get(&normalized_key);

                if built_in.is_some_and(|built_in| built_in.restrict_override) {
                    self.add_shortcut_diagnostic(
                        format!(
                            "Extension shortcut '{key}' from {path} conflicts with built-in shortcut. Skipping.",
                            path = shortcut.extension_path
                        ),
                        &shortcut.extension_path,
                    );
                    continue;
                }

                if let Some(built_in) = built_in {
                    if !built_in.restrict_override {
                        self.add_shortcut_diagnostic(
                            format!(
                                "Extension shortcut conflict: '{key}' is built-in shortcut for {keybinding} and {path}. Using {path}.",
                                keybinding = built_in.keybinding,
                                path = shortcut.extension_path
                            ),
                            &shortcut.extension_path,
                        );
                    }
                }

                if let Some(existing) = extension_shortcuts.get(&normalized_key) {
                    self.add_shortcut_diagnostic(
                        format!(
                            "Extension shortcut conflict: '{key}' registered by both {existing} and {path}. Using {path}.",
                            existing = existing.extension_path,
                            path = shortcut.extension_path
                        ),
                        &shortcut.extension_path,
                    );
                }
                extension_shortcuts.set(normalized_key, shortcut.clone());
            }
        }
        extension_shortcuts
    }

    fn add_shortcut_diagnostic(&self, message: String, extension_path: &str) {
        self.inner
            .shortcut_diagnostics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(ResourceDiagnostic {
                r#type: ResourceDiagnosticType::Warning,
                message: message.clone(),
                path: Some(extension_path.to_string()),
                collision: None,
            });
        if !self.has_ui() {
            // upstream `console.warn(message)`.
            eprintln!("{message}");
        }
    }

    /// Upstream `getShortcutDiagnostics()`.
    pub fn get_shortcut_diagnostics(&self) -> Vec<ResourceDiagnostic> {
        self.inner
            .shortcut_diagnostics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Upstream `invalidate(message?)`.
    pub fn invalidate(&self, message: Option<&str>) {
        let mut stale = self
            .inner
            .stale
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if stale.as_ref().is_some_and(|message| !message.is_empty()) {
            return;
        }
        let message = message.unwrap_or(DEFAULT_STALE_MESSAGE);
        *stale = Some(message.to_string());
        drop(stale);
        self.inner.runtime.invalidate(Some(message));
    }

    fn assert_active(&self) -> Result<(), String> {
        match self
            .inner
            .stale
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            Some(message) if !message.is_empty() => Err(message),
            _ => Ok(()),
        }
    }

    /// Upstream `onError(listener)`; returns the unsubscribe closure.
    pub fn on_error(&self, listener: ExtensionErrorListener) -> ErrorListenerUnsubscribe {
        let mut listeners = self
            .inner
            .error_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let id = listeners.next_id;
        listeners.next_id += 1;
        listeners.listeners.push((id, listener));
        ErrorListenerUnsubscribe {
            listeners: Arc::clone(&self.inner.error_listeners),
            id,
        }
    }

    /// Upstream `emitError(error)`.
    pub fn emit_error(&self, error: ExtensionError) {
        let listeners = self
            .inner
            .error_listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .listeners
            .clone();
        for (_, listener) in listeners {
            listener(&error);
        }
    }

    /// Upstream `hasHandlers(eventType)`.
    pub fn has_handlers(&self, event_type: &str) -> bool {
        for extension in &self.inner.extensions {
            if !extension.handlers.get_cloned_list(event_type).is_empty() {
                return true;
            }
        }
        false
    }

    /// Upstream `getMessageRenderer(customType)`.
    pub fn get_message_renderer(&self, custom_type: &str) -> Option<MessageRenderer> {
        for extension in &self.inner.extensions {
            if let Some(renderer) = extension.message_renderers.get(custom_type) {
                return Some(Arc::clone(renderer));
            }
        }
        None
    }

    /// Upstream `getMarkdownTransformers()`.
    pub fn get_markdown_transformers(&self) -> Vec<super::types::MarkdownTransformer> {
        self.inner
            .extensions
            .iter()
            .filter_map(|extension| extension.markdown_transformer.clone())
            .collect()
    }

    /// Upstream `getEntryRenderer(customType)`.
    pub fn get_entry_renderer(&self, custom_type: &str) -> Option<super::types::EntryRenderer> {
        for extension in &self.inner.extensions {
            if let Some(renderers) = &extension.entry_renderers {
                if let Some(renderer) = renderers.get(custom_type) {
                    return Some(Arc::clone(renderer));
                }
            }
        }
        None
    }

    /// Upstream `resolveRegisteredCommands()`.
    fn resolve_registered_commands(&self) -> Vec<ResolvedCommand> {
        let mut commands = Vec::new();
        let mut counts: HashMap<String, usize> = HashMap::new();

        for extension in &self.inner.extensions {
            for command in extension.commands.values() {
                commands.push(command.clone());
                *counts.entry(command.name.clone()).or_insert(0) += 1;
            }
        }

        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut taken_invocation_names: HashSet<String> = HashSet::new();

        commands
            .into_iter()
            .map(|command| {
                let occurrence = seen.get(&command.name).copied().unwrap_or(0) + 1;
                seen.insert(command.name.clone(), occurrence);

                let mut invocation_name = if counts.get(&command.name).copied().unwrap_or(0) > 1 {
                    format!("{}:{}", command.name, occurrence)
                } else {
                    command.name.clone()
                };

                if taken_invocation_names.contains(&invocation_name) {
                    let mut suffix = occurrence;
                    loop {
                        suffix += 1;
                        invocation_name = format!("{}:{}", command.name, suffix);
                        if !taken_invocation_names.contains(&invocation_name) {
                            break;
                        }
                    }
                }

                taken_invocation_names.insert(invocation_name.clone());
                ResolvedCommand {
                    command,
                    invocation_name,
                }
            })
            .collect()
    }

    /// Upstream `getRegisteredCommands()`.
    pub fn get_registered_commands(&self) -> Vec<ResolvedCommand> {
        *self
            .inner
            .command_diagnostics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Vec::new();
        self.resolve_registered_commands()
    }

    /// Upstream `getCommandDiagnostics()`.
    pub fn get_command_diagnostics(&self) -> Vec<ResourceDiagnostic> {
        self.inner
            .command_diagnostics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Upstream `getCommand(name)`.
    pub fn get_command(&self, name: &str) -> Option<ResolvedCommand> {
        self.resolve_registered_commands()
            .into_iter()
            .find(|command| command.invocation_name == name)
    }

    /// Upstream `shutdown()`.
    pub fn shutdown(&self) {
        let shutdown = Arc::clone(
            &self
                .inner
                .actions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .shutdown,
        );
        shutdown();
    }

    /// Upstream `getActiveTools()` (asserts the runner is not stale).
    pub fn get_active_tools(&self) -> Result<Vec<String>, String> {
        self.assert_active()?;
        self.inner.runtime.get_active_tools()
    }

    /// The shared runtime handle (bind_core target for scenarios that
    /// re-wrap extensions).
    pub fn runtime(&self) -> super::loader::ExtensionRuntime {
        self.inner.runtime.clone()
    }

    /// Upstream `createContext()`.
    pub fn create_context(&self) -> ExtensionContext {
        ExtensionContext {
            inner: Arc::clone(&self.inner),
            system_prompt_override: None,
        }
    }

    /// Upstream `createCommandContext()`.
    pub fn create_command_context(&self) -> ExtensionCommandContext {
        ExtensionCommandContext {
            base: self.create_context(),
        }
    }

    // ========================================================================
    // Event dispatch
    // ========================================================================

    fn snapshot_event_handlers(&self, event_type: &str) -> Vec<(String, Vec<HandlerFn>)> {
        self.inner
            .extensions
            .iter()
            .map(|extension| {
                (
                    extension.path.clone(),
                    extension.handlers.get_cloned_list(event_type),
                )
            })
            .collect()
    }

    fn is_session_before_event(event_type: &str) -> bool {
        matches!(
            event_type,
            "session_before_switch"
                | "session_before_fork"
                | "session_before_compact"
                | "session_before_tree"
        )
    }

    /// Upstream `emit(event)`: generic dispatch; session-before results are
    /// accumulated and short-circuit on `cancel`.
    pub async fn emit(&self, event: &mut Value) -> Option<Value> {
        let ctx = self.create_context();
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut result: Option<Value> = None;

        for (extension_path, handlers) in self.snapshot_event_handlers(&event_type) {
            for handler in handlers {
                match handler(event, &ctx).await {
                    Ok(handler_result) => {
                        if Self::is_session_before_event(
                            event
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                        ) {
                            if let Some(handler_result) = handler_result
                                .as_ref()
                                .and_then(HandlerResult::as_json)
                                .filter(|r| js_truthy(r))
                            {
                                result = Some(handler_result.clone());
                                if result
                                    .as_ref()
                                    .and_then(|r| r.get("cancel"))
                                    .is_some_and(js_truthy)
                                {
                                    return result;
                                }
                            }
                        }
                    }
                    Err(error) => self.emit_error(ExtensionError {
                        extension_path: extension_path.clone(),
                        event: event
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        error,
                        stack: None,
                    }),
                }
            }
        }

        result
    }

    /// Upstream `emitMessageEnd(event)`.
    pub async fn emit_message_end(&self, event: &Value) -> Option<Value> {
        let ctx = self.create_context();
        let mut current_message = event.get("message").cloned().unwrap_or(Value::Null);
        let mut modified = false;
        let event_type = "message_end";

        for (extension_path, handlers) in self.snapshot_event_handlers(event_type) {
            for handler in handlers {
                let mut current_event = event.clone();
                current_event["message"] = current_message.clone();
                match handler(&mut current_event, &ctx).await {
                    Ok(handler_result) => {
                        let Some(result) = handler_result.and_then(|r| r.as_json().cloned()) else {
                            continue;
                        };
                        let Some(message) = result.get("message").filter(|m| !m.is_null()) else {
                            continue;
                        };
                        let current_role = current_message.get("role").and_then(Value::as_str);
                        let new_role = message.get("role").and_then(Value::as_str);
                        if current_role != new_role {
                            self.emit_error(ExtensionError {
                                extension_path: extension_path.clone(),
                                event: event_type.to_string(),
                                error:
                                    "message_end handlers must return a message with the same role"
                                        .to_string(),
                                stack: None,
                            });
                            continue;
                        }
                        current_message = message.clone();
                        modified = true;
                    }
                    Err(error) => self.emit_error(ExtensionError {
                        extension_path: extension_path.clone(),
                        event: event_type.to_string(),
                        error,
                        stack: None,
                    }),
                }
            }
        }

        modified.then_some(current_message)
    }

    /// Upstream `emitToolResult(event)`.
    pub async fn emit_tool_result(&self, event: &Value) -> Option<Value> {
        let ctx = self.create_context();
        let mut current_event = event.clone();
        let mut modified = false;
        let event_type = "tool_result";

        for (extension_path, handlers) in self.snapshot_event_handlers(event_type) {
            for handler in handlers {
                match handler(&mut current_event, &ctx).await {
                    Ok(handler_result) => {
                        let Some(result) = handler_result.and_then(|r| r.as_json().cloned()) else {
                            continue;
                        };
                        let object = result.as_object()?;
                        if let Some(content) = object.get("content") {
                            current_event["content"] = content.clone();
                            modified = true;
                        }
                        if let Some(details) = object.get("details") {
                            current_event["details"] = details.clone();
                            modified = true;
                        }
                        if let Some(is_error) = object.get("isError") {
                            current_event["isError"] = is_error.clone();
                            modified = true;
                        }
                        if let Some(usage) = object.get("usage") {
                            current_event["usage"] = usage.clone();
                            modified = true;
                        }
                    }
                    Err(error) => self.emit_error(ExtensionError {
                        extension_path: extension_path.clone(),
                        event: event_type.to_string(),
                        error,
                        stack: None,
                    }),
                }
            }
        }

        if !modified {
            return None;
        }

        let mut combined = serde_json::Map::new();
        combined.insert(
            "content".to_string(),
            current_event.get("content").cloned().unwrap_or(Value::Null),
        );
        if let Some(details) = current_event.get("details") {
            combined.insert("details".to_string(), details.clone());
        }
        if let Some(is_error) = current_event.get("isError") {
            combined.insert("isError".to_string(), is_error.clone());
        }
        if let Some(usage) = current_event.get("usage") {
            combined.insert("usage".to_string(), usage.clone());
        }
        Some(Value::Object(combined))
    }

    /// Upstream `emitToolCall(event)`: handler errors propagate (no error
    /// isolation upstream); `event.input` mutations persist for the caller.
    pub async fn emit_tool_call(&self, event: &mut Value) -> Result<Option<Value>, String> {
        let ctx = self.create_context();
        let mut result: Option<Value> = None;
        let event_type = "tool_call";

        for (_, handlers) in self.snapshot_event_handlers(event_type) {
            for handler in handlers {
                if let Some(handler_result) = handler(event, &ctx).await? {
                    if let Some(handler_result) = handler_result.as_json().filter(|r| !r.is_null())
                    {
                        result = Some(handler_result.clone());
                        if result
                            .as_ref()
                            .and_then(|r| r.get("block"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        {
                            return Ok(result);
                        }
                    }
                }
            }
        }

        Ok(result)
    }

    /// Upstream `emitUserBash(event)`: fails closed — handler errors and
    /// invalid results emit an extension error and rethrow.
    pub async fn emit_user_bash(
        &self,
        event: &Value,
    ) -> Result<Option<UserBashEventResult>, String> {
        let ctx = self.create_context();
        let event_type = "user_bash";

        for (extension_path, handlers) in self.snapshot_event_handlers(event_type) {
            for handler in handlers {
                let mut event_copy = event.clone();
                let outcome = handler(&mut event_copy, &ctx).await;
                match outcome {
                    Ok(Some(HandlerResult::UserBashOperations(operations))) => {
                        return Ok(Some(UserBashEventResult::Operations(operations)));
                    }
                    Ok(result) => {
                        let value = result.and_then(|r| r.as_json().cloned());
                        let Some(value) = value.filter(|value| !value.is_null()) else {
                            continue;
                        };
                        return match validate_user_bash_json(&value) {
                            Some(valid) => Ok(Some(valid)),
                            None => {
                                let error = "Invalid user_bash handler result: return undefined for local execution or exactly one valid { operations } or { result } object";
                                self.emit_error(ExtensionError {
                                    extension_path: extension_path.clone(),
                                    event: event_type.to_string(),
                                    error: error.to_string(),
                                    stack: None,
                                });
                                Err(error.to_string())
                            }
                        };
                    }
                    Err(error) => {
                        self.emit_error(ExtensionError {
                            extension_path: extension_path.clone(),
                            event: event_type.to_string(),
                            error: error.clone(),
                            stack: None,
                        });
                        return Err(error);
                    }
                }
            }
        }

        Ok(None)
    }

    /// Upstream `emitContext(messages)`.
    pub async fn emit_context(&self, messages: &[Value]) -> Vec<Value> {
        let ctx = self.create_context();
        let mut current_messages = messages.to_vec();
        let event_type = "context";

        for (extension_path, handlers) in self.snapshot_event_handlers(event_type) {
            for handler in handlers {
                let mut event = json!({ "type": "context", "messages": current_messages });
                match handler(&mut event, &ctx).await {
                    Ok(handler_result) => {
                        if let Some(messages) = handler_result
                            .as_ref()
                            .and_then(HandlerResult::as_json)
                            .and_then(|result| result.get("messages"))
                            .and_then(Value::as_array)
                        {
                            current_messages = messages.clone();
                        }
                    }
                    Err(error) => self.emit_error(ExtensionError {
                        extension_path: extension_path.clone(),
                        event: event_type.to_string(),
                        error,
                        stack: None,
                    }),
                }
            }
        }

        current_messages
    }

    /// Upstream `emitBeforeProviderRequest(payload)`.
    pub async fn emit_before_provider_request(&self, payload: Value) -> Value {
        let ctx = self.create_context();
        let mut current_payload = payload;
        let event_type = "before_provider_request";

        for (extension_path, handlers) in self.snapshot_event_handlers(event_type) {
            for handler in handlers {
                let mut event =
                    json!({ "type": "before_provider_request", "payload": current_payload });
                match handler(&mut event, &ctx).await {
                    Ok(handler_result) => {
                        if let Some(result) = handler_result.and_then(|r| r.as_json().cloned()) {
                            current_payload = result;
                        }
                    }
                    Err(error) => self.emit_error(ExtensionError {
                        extension_path: extension_path.clone(),
                        event: event_type.to_string(),
                        error,
                        stack: None,
                    }),
                }
            }
        }

        current_payload
    }

    /// Upstream `emitBeforeProviderHeaders(headers)`: handlers mutate
    /// `event.headers` in place; the final record is returned.
    pub async fn emit_before_provider_headers(&self, headers: Value) -> Value {
        let ctx = self.create_context();
        let event_type = "before_provider_headers";
        let mut current_headers = headers;

        for (extension_path, handlers) in self.snapshot_event_handlers(event_type) {
            for handler in handlers {
                let mut event =
                    json!({ "type": "before_provider_headers", "headers": current_headers });
                let outcome = handler(&mut event, &ctx).await;
                // A handler's in-place writes survive a later rejection. The
                // JSON seam still cannot distinguish nested object mutation
                // from assigning a different JS object to event.headers.
                current_headers = event.get("headers").cloned().unwrap_or(Value::Null);
                if let Err(error) = outcome {
                    self.emit_error(ExtensionError {
                        extension_path: extension_path.clone(),
                        event: event_type.to_string(),
                        error,
                        stack: None,
                    });
                }
            }
        }

        current_headers
    }

    /// Upstream `emitBeforeAgentStart(prompt, images, systemPromptOptions)`.
    pub async fn emit_before_agent_start(
        &self,
        prompt: &str,
        images: Option<Vec<Value>>,
        system_prompt_options: &BuildSystemPromptOptions,
        renderer: Arc<dyn NormalizedSystemPromptRenderer>,
    ) -> Result<BeforeAgentStartCombinedResult, String> {
        let current_options =
            super::types::normalize_build_system_prompt_options(system_prompt_options);
        // The live normalized options: handler overrides and in-place
        // mutations feed back into `ctx.getSystemPrompt()` for later handlers.
        let live = Arc::new(std::sync::Mutex::new(current_options.clone()));
        let ctx = ExtensionContext {
            inner: Arc::clone(&self.inner),
            system_prompt_override: Some({
                let renderer = Arc::clone(&renderer);
                let live = Arc::clone(&live);
                Arc::new(move || {
                    let current = live
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    renderer.build(&current)
                })
            }),
        };
        let mut current_options = current_options;
        let sync_live =
            |current: &NormalizedBuildSystemPromptOptions,
             live: &std::sync::Mutex<NormalizedBuildSystemPromptOptions>| {
                *live
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = current.clone();
            };
        sync_live(&current_options, &live);
        let mut messages: Vec<Value> = Vec::new();
        let event_type = "before_agent_start";

        for (extension_path, handlers) in self.snapshot_event_handlers(event_type) {
            for handler in handlers {
                let mut event = json!({
                    "type": "before_agent_start",
                    "prompt": prompt,
                    "images": images,
                    "systemPrompt": renderer.build(&current_options),
                    "systemPromptOptions": current_options.to_value(),
                });
                if event.get("images").map(Value::is_null).unwrap_or(false) {
                    event.as_object_mut().unwrap().shift_remove("images");
                }
                match handler(&mut event, &ctx).await {
                    Ok(handler_result) => {
                        // Handlers may mutate `event.systemPromptOptions` in
                        // place; later handlers observe the mutations.
                        if let Some(mutated) = event
                            .get("systemPromptOptions")
                            .and_then(NormalizedBuildSystemPromptOptions::from_value)
                        {
                            current_options = mutated;
                            sync_live(&current_options, &live);
                        }
                        if let Some(result_value) =
                            handler_result.and_then(|r| r.as_json().cloned())
                        {
                            let result: BeforeAgentStartEventResult =
                                serde_json::from_value(result_value).unwrap_or_default();
                            if let Some(message) = result.message {
                                messages.push(message);
                            }
                            if let Some(system_prompt) = result.system_prompt {
                                current_options.force_system_prompt = Some(system_prompt);
                                sync_live(&current_options, &live);
                            }
                        }
                    }
                    Err(error) => self.emit_error(ExtensionError {
                        extension_path: extension_path.clone(),
                        event: event_type.to_string(),
                        error,
                        stack: None,
                    }),
                }
            }
        }

        Ok(BeforeAgentStartCombinedResult {
            messages,
            system_prompt_options: current_options,
        })
    }

    /// Upstream `emitResourcesDiscover(cwd, reason)`.
    pub async fn emit_resources_discover(
        &self,
        cwd: &str,
        reason: ResourcesDiscoverReason,
    ) -> DiscoveredResources {
        let ctx = self.create_context();
        let mut discovered = DiscoveredResources::default();
        let event_type = "resources_discover";
        let reason_str = match reason {
            ResourcesDiscoverReason::Startup => "startup",
            ResourcesDiscoverReason::Reload => "reload",
        };

        for (extension_path, handlers) in self.snapshot_event_handlers(event_type) {
            for handler in handlers {
                let mut event =
                    json!({ "type": "resources_discover", "cwd": cwd, "reason": reason_str });
                match handler(&mut event, &ctx).await {
                    Ok(handler_result) => {
                        let result = handler_result.and_then(|r| r.as_json().cloned());
                        let Some(result) = result.filter(|r| !r.is_null()) else {
                            continue;
                        };
                        let collect =
                            |field: &str, out: &mut Vec<(String, String)>| {
                                if let Some(paths) = result.get(field).and_then(Value::as_array) {
                                    if !paths.is_empty() {
                                        out.extend(paths.iter().filter_map(Value::as_str).map(
                                            |path| (path.to_string(), extension_path.clone()),
                                        ));
                                    }
                                }
                            };
                        collect("skillPaths", &mut discovered.skill_paths);
                        collect("promptPaths", &mut discovered.prompt_paths);
                        collect("themePaths", &mut discovered.theme_paths);
                    }
                    Err(error) => self.emit_error(ExtensionError {
                        extension_path: extension_path.clone(),
                        event: event_type.to_string(),
                        error,
                        stack: None,
                    }),
                }
            }
        }

        discovered
    }

    /// Emit input event. Transforms chain, "handled" short-circuits.
    pub async fn emit_input(
        &self,
        text: &str,
        images: Option<Vec<Value>>,
        source: InputSource,
        streaming_behavior: Option<StreamingDelivery>,
    ) -> InputEventResult {
        let ctx = self.create_context();
        let mut current_text = text.to_string();
        let mut current_images = images.clone();
        let event_type = "input";
        let source_str = match source {
            InputSource::Interactive => "interactive",
            InputSource::Rpc => "rpc",
            InputSource::Extension => "extension",
        };
        let behavior_str = streaming_behavior.map(|behavior| match behavior {
            StreamingDelivery::Steer => "steer",
            StreamingDelivery::FollowUp => "followUp",
        });

        for (extension_path, handlers) in self.snapshot_event_handlers(event_type) {
            for handler in handlers {
                let mut event = json!({
                    "type": "input",
                    "text": current_text,
                    "images": current_images,
                    "source": source_str,
                    "streamingBehavior": behavior_str,
                });
                let object = event.as_object_mut().unwrap();
                if current_images.is_none() {
                    object.shift_remove("images");
                }
                if behavior_str.is_none() {
                    object.shift_remove("streamingBehavior");
                }
                match handler(&mut event, &ctx).await {
                    Ok(result) => {
                        let Some(result) = result.and_then(|r| r.as_json().cloned()) else {
                            continue;
                        };
                        match InputEventResult::from_value(&result) {
                            Some(InputEventResult::Handled) => return InputEventResult::Handled,
                            Some(InputEventResult::Transform { text, images }) => {
                                current_text = text;
                                current_images = images.or(current_images);
                            }
                            _ => {}
                        }
                    }
                    Err(error) => self.emit_error(ExtensionError {
                        extension_path: extension_path.clone(),
                        event: event_type.to_string(),
                        error,
                        stack: None,
                    }),
                }
            }
        }

        if current_text != text || current_images != images {
            InputEventResult::Transform {
                text: current_text,
                images: current_images,
            }
        } else {
            InputEventResult::Continue
        }
    }

    // ========================================================================
    // UI prompt wrapping
    // ========================================================================

    pub(crate) async fn with_ui_prompt<T, F: std::future::Future<Output = T>>(
        &self,
        kind: super::types::UIPromptKind,
        title: Option<&str>,
        run: impl FnOnce() -> F,
    ) -> T {
        let outer = {
            let mut depth = self
                .inner
                .ui_prompt_depth
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let outer = *depth == 0;
            *depth += 1;
            outer
        };
        if outer {
            *self
                .inner
                .active_ui_prompt
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                Some((kind, title.map(str::to_string)));
            self.emit_ui_prompt_event(true, kind, title);
        }

        let _guard = UiPromptGuard {
            runner: self.clone(),
            kind,
            title: title.map(str::to_owned),
        };
        run().await
    }

    fn finish_ui_prompt(&self, kind: super::types::UIPromptKind, title: Option<&str>) {
        let depth_exited = {
            let mut depth = self
                .inner
                .ui_prompt_depth
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *depth = depth.saturating_sub(1);
            if *depth > 0 {
                return;
            }
            *depth = 0;
            true
        };
        if depth_exited {
            let prompt = self
                .inner
                .active_ui_prompt
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
                .unwrap_or((kind, title.map(str::to_string)));
            self.emit_ui_prompt_event(false, prompt.0, prompt.1.as_deref());
        }
    }

    fn emit_ui_prompt_event(
        &self,
        start: bool,
        kind: super::types::UIPromptKind,
        title: Option<&str>,
    ) {
        let event = if start {
            json!({
                "type": "ui_prompt_start",
                "reason": "ui_prompt",
                "kind": kind.as_str(),
                "title": title,
            })
        } else {
            json!({
                "type": "ui_prompt_end",
                "reason": "ui_prompt",
                "kind": kind.as_str(),
                "title": title,
            })
        };
        let mut event = event;
        if title.is_none() {
            event.as_object_mut().unwrap().shift_remove("title");
        }
        self.emit_detached(event);
    }

    /// Native host counterpart of upstream `void emit`/UI microtasks. This is
    /// deliberately not awaited, unlike lifecycle/input dispatch. Tokio task
    /// scheduling is not JS eager Promise/microtask timing. A missing runtime
    /// is reported, never silently dropped or substituted with `block_on`.
    pub(crate) fn emit_detached(&self, mut event: Value) {
        if !self.has_handlers(event["type"].as_str().unwrap_or_default()) {
            return;
        }
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                let runner = self.clone();
                runtime.spawn(async move { runner.emit(&mut event).await });
            }
            Err(_) => self.emit_error(ExtensionError {
                extension_path: "<host>".into(),
                event: event["type"].as_str().unwrap_or_default().into(),
                error: "Detached extension events require a Tokio runtime".into(),
                stack: None,
            }),
        }
    }
}

/// Helper function to emit session_shutdown event to extensions
/// (`emitSessionShutdownEvent`). Returns true if the event was emitted.
pub async fn emit_session_shutdown_event(
    extension_runner: &ExtensionRunner,
    event: &Value,
) -> bool {
    if extension_runner.has_handlers("session_shutdown") {
        let mut event = event.clone();
        extension_runner.emit(&mut event).await;
        return true;
    }
    false
}

/// Upstream `emitProjectTrustEvent(extensionsResult, event, ctx)`. Handlers
/// receive the [`ProjectTrustContext`]; the port projects it onto a minimal
/// [`ExtensionContext`] (cwd/mode/hasUI/ui live) since the handler map is
/// uniform — disclosed as a seam in the module docs.
pub async fn emit_project_trust_event(
    extensions: &[Extension],
    event: &ProjectTrustEvent,
    ctx: &ProjectTrustContext,
) -> (Option<ProjectTrustEventResult>, Vec<ExtensionError>) {
    let mut errors = Vec::new();
    let mut event_value = serde_json::to_value(event).unwrap_or(Value::Null);
    let handler_ctx = trust_context_shim(ctx);

    // Snapshot every extension before the first await, just like the generic
    // dispatcher. Re-registration while suspended affects the next event.
    let snapshot: Vec<_> = extensions
        .iter()
        .map(|extension| {
            (
                extension.path.clone(),
                extension.handlers.get_cloned_list("project_trust"),
            )
        })
        .collect();
    for (extension_path, handlers) in snapshot {
        // The first decision wins; undecided falls through.
        for handler in handlers {
            match handler(&mut event_value, &handler_ctx).await {
                Ok(result) => {
                    let Some(result) = result.and_then(|r| r.as_json().cloned()) else {
                        continue;
                    };
                    if result.get("trusted").and_then(Value::as_str)
                        == Some(super::types::PROJECT_TRUST_UNDECIDED)
                    {
                        continue;
                    }
                    match serde_json::from_value::<ProjectTrustEventResult>(result) {
                        Ok(result) => return (Some(result), errors),
                        Err(_) => continue,
                    }
                }
                Err(error) => {
                    errors.push(ExtensionError {
                        extension_path: extension_path.clone(),
                        event: "project_trust".to_string(),
                        error,
                        stack: None,
                    });
                }
            }
        }
    }
    (None, errors)
}

/// Build the minimal [`ExtensionContext`] projection of a
/// [`ProjectTrustContext`].
fn trust_context_shim(ctx: &ProjectTrustContext) -> ExtensionContext {
    use super::loader::ExtensionRuntime;
    use super::types::NoopProviderRegistry;
    let cwd = ctx.cwd.clone();
    let ui = ctx.ui.clone();
    let mode = ctx.mode;
    let inner = RunnerInner {
        has_ui_override: Some(ctx.has_ui),
        extensions: Vec::new(),
        runtime: ExtensionRuntime::new(),
        ui: Mutex::new(ui),
        mode: Mutex::new(mode),
        cwd: cwd.clone(),
        session_manager: Arc::new(()),
        model_registry: Arc::new(NoopProviderRegistry),
        error_listeners: Arc::new(Mutex::new(ErrorListeners {
            next_id: 0,
            listeners: Vec::new(),
        })),
        actions: Mutex::new(CoreActions {
            get_model: Arc::new(|| None),
            get_scoped_models: Arc::new(Vec::new),
            is_idle: Arc::new(|| true),
            is_project_trusted: Arc::new(|| true),
            get_signal: Arc::new(|| None),
            abort: Arc::new(|| {}),
            has_pending_messages: Arc::new(|| false),
            shutdown: Arc::new(|| {}),
            get_context_usage: Arc::new(|| None),
            compact: Arc::new(|_| {}),
            get_system_prompt: Arc::new(String::new),
            get_system_prompt_options: Arc::new(move || BuildSystemPromptOptions::with_cwd(&cwd)),
            wait_for_idle: Arc::new(|| Ok(CommandFuture::resolved(()))),
            new_session: Arc::new(|_| {
                Ok(CommandFuture::resolved(super::types::Cancelled {
                    cancelled: false,
                }))
            }),
            fork: Arc::new(|_, _| {
                Ok(CommandFuture::resolved(super::types::Cancelled {
                    cancelled: false,
                }))
            }),
            navigate_tree: Arc::new(|_, _| {
                Ok(CommandFuture::resolved(super::types::Cancelled {
                    cancelled: false,
                }))
            }),
            switch_session: Arc::new(|_, _| {
                Ok(CommandFuture::resolved(super::types::Cancelled {
                    cancelled: false,
                }))
            }),
            reload: Arc::new(|| Ok(CommandFuture::resolved(()))),
        }),
        shortcut_diagnostics: Mutex::new(Vec::new()),
        command_diagnostics: Mutex::new(Vec::new()),
        stale: Mutex::new(None),
        ui_prompt_depth: Mutex::new(0),
        active_ui_prompt: Mutex::new(None),
    };
    ExtensionContext {
        inner: Arc::new(inner),
        system_prompt_override: None,
    }
}

// ============================================================================
// ExtensionContext implementation (upstream createContext getters)
// ============================================================================

impl ExtensionContext {
    fn assert_active(&self) -> Result<(), String> {
        match self
            .inner
            .stale
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            Some(message) if !message.is_empty() => Err(message),
            _ => Ok(()),
        }
    }

    fn actions(&self) -> std::sync::MutexGuard<'_, CoreActions> {
        self.inner
            .actions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Upstream `ctx.ui`.
    pub fn ui(&self) -> Result<UiHandle, String> {
        self.assert_active()?;
        Ok(UiHandle {
            runner: Arc::clone(&self.inner),
        })
    }

    /// Upstream `ctx.mode`.
    pub fn mode(&self) -> Result<ExtensionMode, String> {
        self.assert_active()?;
        Ok(*self
            .inner
            .mode
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// Upstream `ctx.hasUI`.
    pub fn has_ui(&self) -> Result<bool, String> {
        self.assert_active()?;
        if let Some(has_ui) = self.inner.has_ui_override {
            return Ok(has_ui);
        }
        Ok(self
            .inner
            .ui
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some())
    }

    /// Upstream `ctx.cwd`.
    pub fn cwd(&self) -> Result<String, String> {
        self.assert_active()?;
        Ok(self.inner.cwd.clone())
    }

    /// Upstream `ctx.sessionManager`.
    pub fn session_manager(&self) -> Result<SessionManagerHandle, String> {
        self.assert_active()?;
        Ok(Arc::clone(&self.inner.session_manager))
    }

    /// Upstream `ctx.modelRegistry`.
    pub fn model_registry(&self) -> Result<Arc<dyn ProviderRegistryHandle>, String> {
        self.assert_active()?;
        Ok(Arc::clone(&self.inner.model_registry))
    }

    /// Upstream `ctx.model`.
    pub fn model(&self) -> Result<Option<Value>, String> {
        self.assert_active()?;
        let get_model = Arc::clone(&self.actions().get_model);
        Ok(get_model())
    }

    /// Upstream `ctx.scopedModels`.
    pub fn scoped_models(&self) -> Result<Vec<Value>, String> {
        self.assert_active()?;
        let get_scoped_models = Arc::clone(&self.actions().get_scoped_models);
        Ok(get_scoped_models())
    }

    /// Upstream `ctx.thinkingLevel`.
    pub fn thinking_level(&self) -> Result<ThinkingLevel, String> {
        self.assert_active()?;
        self.inner.runtime.get_thinking_level()
    }

    /// Upstream `ctx.isIdle()`.
    pub fn is_idle(&self) -> Result<bool, String> {
        self.assert_active()?;
        let is_idle = Arc::clone(&self.actions().is_idle);
        Ok(is_idle())
    }

    /// Upstream `ctx.isProjectTrusted()`.
    pub fn is_project_trusted(&self) -> Result<bool, String> {
        self.assert_active()?;
        let is_project_trusted = Arc::clone(&self.actions().is_project_trusted);
        Ok(is_project_trusted())
    }

    /// Upstream `ctx.signal`.
    pub fn signal(&self) -> Result<Option<Arc<AbortSignal>>, String> {
        self.assert_active()?;
        let get_signal = Arc::clone(&self.actions().get_signal);
        Ok(get_signal())
    }

    /// Upstream `ctx.abort()`.
    pub fn abort(&self) -> Result<(), String> {
        self.assert_active()?;
        let abort = Arc::clone(&self.actions().abort);
        abort();
        Ok(())
    }

    /// Upstream `ctx.hasPendingMessages()`.
    pub fn has_pending_messages(&self) -> Result<bool, String> {
        self.assert_active()?;
        let has_pending_messages = Arc::clone(&self.actions().has_pending_messages);
        Ok(has_pending_messages())
    }

    /// Upstream `ctx.shutdown()`.
    pub fn shutdown(&self) -> Result<(), String> {
        self.assert_active()?;
        let shutdown = Arc::clone(&self.actions().shutdown);
        shutdown();
        Ok(())
    }

    /// Upstream `ctx.getContextUsage()`.
    pub fn get_context_usage(&self) -> Result<Option<ContextUsage>, String> {
        self.assert_active()?;
        let get_context_usage = Arc::clone(&self.actions().get_context_usage);
        Ok(get_context_usage())
    }

    /// Upstream `ctx.compact(options)`.
    pub fn compact(&self, options: Option<CompactOptions>) -> Result<(), String> {
        self.assert_active()?;
        let compact = Arc::clone(&self.actions().compact);
        compact(options);
        Ok(())
    }

    /// Upstream `ctx.getSystemPrompt()`.
    pub fn get_system_prompt(&self) -> Result<String, String> {
        self.assert_active()?;
        if let Some(override_fn) = &self.system_prompt_override {
            return Ok(override_fn());
        }
        let get_system_prompt = Arc::clone(&self.actions().get_system_prompt);
        Ok(get_system_prompt())
    }
}

impl ExtensionCommandContext {
    fn assert_active(&self) -> Result<(), String> {
        match self
            .base
            .inner
            .stale
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            Some(message) if !message.is_empty() => Err(message),
            _ => Ok(()),
        }
    }

    /// Upstream `ctx.getSystemPromptOptions()`.
    pub fn get_system_prompt_options(&self) -> Result<BuildSystemPromptOptions, String> {
        self.assert_active()?;
        let get = Arc::clone(&self.base.actions().get_system_prompt_options);
        Ok(get())
    }

    /// Upstream `ctx.waitForIdle()`: check and dispatch now, then await the result.
    /// Never move the stale check or handler selection into a lazy async body.
    pub fn wait_for_idle(&self) -> Result<CommandFuture<()>, String> {
        self.assert_active()?;
        let wait = Arc::clone(&self.base.actions().wait_for_idle);
        wait()
    }

    /// Upstream `ctx.newSession(options)`.
    pub fn new_session(
        &self,
        options: Option<super::types::NewSessionOptions>,
    ) -> Result<CommandFuture<super::types::Cancelled>, String> {
        self.assert_active()?;
        let new_session = Arc::clone(&self.base.actions().new_session);
        new_session(options)
    }

    /// Upstream `ctx.fork(entryId, options)`.
    pub fn fork(
        &self,
        entry_id: &str,
        options: Option<super::types::ForkOptions>,
    ) -> Result<CommandFuture<super::types::Cancelled>, String> {
        self.assert_active()?;
        let fork = Arc::clone(&self.base.actions().fork);
        fork(entry_id, options)
    }

    /// Upstream `ctx.navigateTree(targetId, options)`.
    pub fn navigate_tree(
        &self,
        target_id: &str,
        options: Option<super::types::NavigateTreeOptions>,
    ) -> Result<CommandFuture<super::types::Cancelled>, String> {
        self.assert_active()?;
        let navigate_tree = Arc::clone(&self.base.actions().navigate_tree);
        navigate_tree(target_id, options)
    }

    /// Upstream `ctx.switchSession(sessionPath, options)`.
    pub fn switch_session(
        &self,
        session_path: &str,
        options: Option<super::types::SwitchSessionOptions>,
    ) -> Result<CommandFuture<super::types::Cancelled>, String> {
        self.assert_active()?;
        let switch_session = Arc::clone(&self.base.actions().switch_session);
        switch_session(session_path, options)
    }

    /// Upstream `ctx.reload()`.
    pub fn reload(&self) -> Result<CommandFuture<()>, String> {
        self.assert_active()?;
        let reload = Arc::clone(&self.base.actions().reload);
        reload()
    }
}

// ============================================================================
// UI handle (wrapped no-op + prompt-aware delegate)
// ============================================================================

/// The `ctx.ui` handle: routes the five blocking prompts through the
/// runner's `withUIPrompt` nesting; everything else delegates to the bound
/// [`super::types::ExtensionUI`] (or the trait's no-op defaults).
struct UiPromptGuard {
    runner: ExtensionRunner,
    kind: super::types::UIPromptKind,
    title: Option<String>,
}
impl Drop for UiPromptGuard {
    fn drop(&mut self) {
        self.runner
            .finish_ui_prompt(self.kind, self.title.as_deref());
    }
}

pub struct UiHandle {
    runner: Arc<RunnerInner>,
}

impl UiHandle {
    fn raw(&self) -> Option<Arc<dyn super::types::ExtensionUI>> {
        self.runner
            .ui
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn runner(&self) -> ExtensionRunner {
        ExtensionRunner {
            inner: Arc::clone(&self.runner),
        }
    }

    pub async fn select(
        &self,
        title: &str,
        options: &[String],
        opts: &ExtensionUiDialogOptions,
    ) -> Result<Option<String>, String> {
        match self.raw() {
            Some(ui) => {
                self.runner()
                    .with_ui_prompt(super::types::UIPromptKind::Select, Some(title), || {
                        ui.select(title, options, opts)
                    })
                    .await
            }
            None => Ok(None),
        }
    }
    pub async fn confirm(
        &self,
        title: &str,
        message: &str,
        opts: &ExtensionUiDialogOptions,
    ) -> Result<bool, String> {
        match self.raw() {
            Some(ui) => {
                self.runner()
                    .with_ui_prompt(super::types::UIPromptKind::Confirm, Some(title), || {
                        ui.confirm(title, message, opts)
                    })
                    .await
            }
            None => Ok(false),
        }
    }
    pub async fn input(
        &self,
        title: &str,
        placeholder: Option<&str>,
        opts: &ExtensionUiDialogOptions,
    ) -> Result<Option<String>, String> {
        match self.raw() {
            Some(ui) => {
                self.runner()
                    .with_ui_prompt(super::types::UIPromptKind::Input, Some(title), || {
                        ui.input(title, placeholder, opts)
                    })
                    .await
            }
            None => Ok(None),
        }
    }
    pub async fn editor(
        &self,
        title: &str,
        prefill: Option<&str>,
    ) -> Result<Option<String>, String> {
        match self.raw() {
            Some(ui) => {
                self.runner()
                    .with_ui_prompt(super::types::UIPromptKind::Editor, Some(title), || {
                        ui.editor(title, prefill)
                    })
                    .await
            }
            None => Ok(None),
        }
    }
    pub async fn custom(
        &self,
        factory: &Value,
        opts: &ExtensionUiDialogOptions,
    ) -> Result<Option<Value>, String> {
        match self.raw() {
            Some(ui) => {
                self.runner()
                    .with_ui_prompt(super::types::UIPromptKind::Custom, None, || {
                        ui.custom(factory, opts)
                    })
                    .await
            }
            None => Ok(None),
        }
    }

    /// Non-prompt delegates (no ui_prompt events, matching upstream where
    /// only the five blocking prompts are wrapped).
    pub fn notify(&self, message: &str, notify_type: Option<&str>) {
        if let Some(ui) = self.raw() {
            ui.notify(message, notify_type);
        }
    }
    pub fn set_status(&self, key: &str, text: Option<&str>) {
        if let Some(ui) = self.raw() {
            ui.set_status(key, text);
        }
    }
    pub fn set_title(&self, title: &str) {
        if let Some(ui) = self.raw() {
            ui.set_title(title);
        }
    }
    pub fn set_editor_text(&self, text: &str) {
        if let Some(ui) = self.raw() {
            ui.set_editor_text(text);
        }
    }
    pub fn get_editor_text(&self) -> String {
        self.raw()
            .map(|ui| ui.get_editor_text())
            .unwrap_or_default()
    }
    pub fn theme(&self) -> Value {
        self.raw().map(|ui| ui.theme()).unwrap_or(Value::Null)
    }
    pub fn get_tools_expanded(&self) -> bool {
        self.raw()
            .map(|ui| ui.get_tools_expanded())
            .unwrap_or(false)
    }
}

// MessageRenderOptions stays in `types` (renderer surface); the runner only
// routes renderers, it does not render.

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;

// JSON-representable JavaScript truthiness. Objects/arrays are truthy even empty.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
