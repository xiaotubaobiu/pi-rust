//! Port of upstream `coding-agent/src/core/extensions` — the extension system
//! (slice M5 W3.5).
//!
//! Provenance map (upstream file → submodule), upstream SHA256 at migration
//! time:
//!
//! | upstream | submodule | sha256 |
//! |---|---|---|
//! | `core/extensions/types.ts` | [`types`] | `e764ac48…6439f839f5b8` |
//! | `core/extensions/loader.ts` | [`loader`] | `753576ea…0be83a69ffc14a5` |
//! | `core/extensions/runner.ts` | [`runner`] | `92da35c1…8c7` (full hashes in the slice report) |
//! | `core/extensions/index.ts` | this facade | `9b980770…dc14212` |
//! | `core/extensions/wrapper.ts` | [`wrapper`] | `f71eae fd…345188cd` |
//!
//! (Full 64-hex digests are in the slice report; the oracle tree under
//! `tests/fixtures/ext_oracle/src` pins byte-identical copies.)
//!
//! The `src/extensions/` product directory contains only the `llama`
//! extension (local-LLM provider registration over a llama.cpp bridge and
//! HuggingFace model discovery). It depends on the llama bridge, the pi-ai
//! provider/stream surface, and the full TUI component set — none ported yet
//! — so the product extension is cropped (disclosed); the loader that would
//! discover it is fully ported.
//!
//! Deterministic outputs (pi-manifest parsing, discovery order, loader error
//! texts, flag/provider queueing semantics, runner event order, shortcut
//! conflict diagnostics, command invocation-name suffixing, user_bash
//! validation, input transform chaining, before_agent_start chaining,
//! ui_prompt nesting) were captured from the verbatim upstream TypeScript
//! sources under node (type stripping) into
//! `tests/fixtures/ext_oracle/{loader,runner}.oracle.json` and are pinned in
//! [`oracle_data`] (test-only) with byte-comparison tests. The generator
//! scripts live next to the captures; the captured `loader.ts` / `runner.ts`
//! are byte-identical to upstream (hashes above), with only the surrounding
//! module graph stubbed (jiti, bundled pi packages, theme, system-prompt
//! section rendering) — see the `tests/fixtures/ext_oracle/src` file headers.
//!
//! Shared seams (upstream imports modules outside this slice):
//!
//! - **jiti module loading** (loader.ts): Rust has no runtime TS module
//!   system; path → factory resolution is the [`loader::ExtensionModuleLoader`]
//!   trait, with the upstream factory cache ported over it. Everything after
//!   resolution is oracle-pinned; the jiti "Cannot find module" text is not.
//! - **SessionManager / ModelRegistry** (session-manager.ts /
//!   model-registry.ts, not yet ported): [`types::SessionManagerHandle`] and
//!   the [`types::ProviderRegistryHandle`] trait.
//! - **Provider / ScopedModel / SlashCommandInfo / ProviderConfig /
//!   ProviderModelConfig** (pi-ai + model-registry slices): JSON at the seam.
//!   The `registerProvider` queueing/routing semantics are fully ported;
//!   model-registry-owned validation text (e.g. `"api" is required when
//!   registering streamSimple`) is reproduced by test mocks, not here.
//! - **AbortSignal** (DOM): vendored minimal [`types::AbortSignal`].
//! - **TUI component surface** (`Theme`, `Component`, `TUI`,
//!   `OverlayOptions`, `AutocompleteProvider`, editor components): the UI
//!   context is the [`types::ExtensionUI`] trait with the exact
//!   `noOpUIContext` defaults; `ToolDefinition`'s `renderCall`/`renderResult`
//!   component factories are omitted.
//! - **buildSystemPrompt section rendering** (system-prompt.ts): options and
//!   normalization are ported verbatim; the renderer is the
//!   [`types::NormalizedSystemPromptRenderer`] seam handed to
//!   [`runner::ExtensionRunner::emit_before_agent_start`], pinning the
//!   `forceSystemPrompt` short-circuit.
//! - **BashOperations / BashResult** (tools slices): `exec` is an opaque
//!   closure seam; `user_bash` validation is ported structurally, with
//!   callable operations traveling through
//!   [`types::HandlerResult::UserBashOperations`].
//! - **Async**: general handlers return borrowed [`types::HandlerFuture`] values;
//!   dispatchers and AgentSession consumers await them sequentially (r12).
//!   Native handlers/dispatch are poll-driven, whereas command actions, setModel,
//!   and setup/withSession use eager shared [`types::CommandFuture`] results.
//!   Factories and the UI facade remain synchronous. Neither API is a JS host:
//!   Promise/microtask timing, arbitrary thrown values/stacks and JavaScript
//!   object identity/aliasing across the JSON seam are not fully reproduced.
//!   `ExtensionError.stack` stays `None`.
//! - **Detached notifications**: ui_prompt and the upstream void session-info /
//!   thinking-level notifications schedule owned, awaited work on Tokio. A
//!   missing runtime is explicitly reported, not blocked on or silently dropped.
//!   Nesting/outer-only semantics are retained; Tokio scheduling does not emulate
//!   JS `queueMicrotask` or the eager prefix of an async JavaScript handler.

pub mod command_future;

#[cfg(test)]
mod async_event_tests;

#[cfg(test)]
mod command_context_tests;

#[path = "loader.rs"]
pub mod loader;
#[path = "runner.rs"]
pub mod runner;
#[path = "types.rs"]
pub mod types;

#[cfg(test)]
#[path = "oracle_data.rs"]
pub mod oracle_data;

pub use loader::ExtensionApi;
pub use loader::{
    clear_extension_cache, discover_and_load_extensions, load_extension_from_factory,
    load_extensions, load_extensions_cached, ExecOptions, ExecResult, ExtensionCacheToken,
    ExtensionFactory, ExtensionModuleLoader, ExtensionRuntime, NullModuleLoader, PiManifest,
    TrackedEventBusUnsubscribe,
};
pub use runner::{emit_project_trust_event, emit_session_shutdown_event, ExtensionRunner};
pub use types::{
    Extension, ExtensionCommandContext, ExtensionContext, ExtensionError, ExtensionLoadError,
    HandlerFn, LoadExtensionsResult,
};

/// Port of upstream `wrapper.ts`: tool wrappers for extension-registered
/// tools. The wrappers adapt tool execution so extension tools receive the
/// runner context; tool call/result interception is handled by AgentSession
/// via agent-core hooks (not part of this slice).
///
/// The full upstream `wrapToolDefinition` (tools slice) does argument
/// re-validation after `prepareArguments`; this port copies the declaration
/// fields, applies the shim, and executes against the shared runner context.
pub mod wrapper {
    use std::sync::Arc;

    use anyhow::anyhow;

    use super::runner::ExtensionRunner;
    use super::types::{AbortSignal, RegisteredTool};
    use crate::agent_core::types::{
        AgentTool, AgentToolResult, ExecuteFn, PrepareArgumentsFn, ToolExecutionMode,
    };
    use crate::ai::types::ConstrainedSampling;

    struct AbortForwarder(Option<tokio::task::JoinHandle<()>>);
    impl Drop for AbortForwarder {
        fn drop(&mut self) {
            if let Some(task) = self.0.take() {
                task.abort();
            }
        }
    }

    /// Upstream `wrapRegisteredTool(registeredTool, runner)` — uses the
    /// runner's `createContext()` for consistent context across tools and
    /// event handlers.
    pub fn wrap_registered_tool(
        registered_tool: &RegisteredTool,
        runner: &ExtensionRunner,
    ) -> AgentTool {
        let definition = registered_tool.definition.clone();
        let context_provider = {
            let runner = runner.clone();
            move || runner.create_context()
        };

        let execute: Arc<ExecuteFn> = {
            let definition = Arc::clone(&definition);
            let context_provider = context_provider.clone();
            Arc::new(move |tool_call_id, params, signal, on_update| {
                let definition = Arc::clone(&definition);
                let ctx = context_provider();
                type ValueUpdateCallback = Arc<dyn Fn(&serde_json::Value) + Send + Sync>;
                let on_update: Option<ValueUpdateCallback> = on_update.map(|callback| {
                    let forward: ValueUpdateCallback =
                        Arc::new(move |value: &serde_json::Value| {
                            if let Ok(typed) =
                                serde_json::from_value::<AgentToolResult>(value.clone())
                            {
                                callback(&typed);
                            }
                        });
                    forward
                });
                Box::pin(async move {
                    // The forwarding task is scoped to this execution, including
                    // future cancellation: never leave an idle token waiter behind.
                    let mut forwarding = AbortForwarder(None);
                    let signal: Option<Arc<AbortSignal>> = signal.map(|token| {
                        let aborted = Arc::new(AbortSignal::new());
                        if token.is_cancelled() {
                            aborted.abort();
                        } else {
                            let forward = Arc::clone(&aborted);
                            forwarding.0 = Some(tokio::spawn(async move {
                                token.cancelled().await;
                                forward.abort();
                            }));
                        }
                        aborted
                    });
                    let result = if let Some(execute) = &definition.execute_async {
                        execute(tool_call_id, params, signal, on_update, ctx).await
                    } else if let Some(execute) = &definition.execute {
                        execute(
                            &tool_call_id,
                            &params,
                            signal.as_ref(),
                            on_update.as_ref(),
                            &ctx,
                        )
                    } else {
                        return Err(anyhow!(
                            "Tool \"{}\" does not define an execute implementation",
                            definition.name
                        ));
                    }
                    .map_err(|error| anyhow!("{error}"))?;
                    serde_json::from_value::<AgentToolResult>(result).map_err(|error| {
                        anyhow!(
                            "Tool \"{}\" produced an invalid result: {error}",
                            definition.name
                        )
                    })
                })
            })
        };

        AgentTool {
            name: definition.name.clone(),
            label: definition.label.clone(),
            description: definition.description.clone(),
            parameters: definition.parameters.clone(),
            constrained_sampling: definition.constrained_sampling.as_ref().and_then(|value| {
                serde_json::from_value::<ConstrainedSampling>(value.clone()).ok()
            }),
            execute,
            prepare_arguments: definition.prepare_arguments.clone().map(|prepare| {
                Arc::new(move |value: serde_json::Value| prepare(&value)) as Arc<PrepareArgumentsFn>
            }),
            replay: None,
            execution_mode: definition
                .execution_mode
                .as_deref()
                .and_then(|mode| match mode {
                    "sequential" => Some(ToolExecutionMode::Sequential),
                    "parallel" => Some(ToolExecutionMode::Parallel),
                    _ => None,
                }),
        }
    }

    /// Upstream `wrapRegisteredTools(registeredTools, runner)`.
    pub fn wrap_registered_tools(
        registered_tools: &[RegisteredTool],
        runner: &ExtensionRunner,
    ) -> Vec<AgentTool> {
        registered_tools
            .iter()
            .map(|tool| wrap_registered_tool(tool, runner))
            .collect()
    }
}

#[cfg(test)]
mod async_tool_tests;
