
// ===========================================================================
// The shell: upstream `class InteractiveMode` (state + decision cores)
// ===========================================================================

/// Handle to a pending `getUserInput` waiter (upstream
/// `this.onInputCallback`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputSlot(pub u64);

/// Handle to an agent subscription (upstream `this.unsubscribe`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubscriptionSlot(pub u64);

/// Handle to a registered cleanup (signal/stdout/stderr listeners).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupId(pub u64);

/// All upstream private state fields, at their upstream initial values.
#[derive(Debug, Clone, Default)]
pub struct ShellState {
    pub is_initialized: bool,
    pub on_input_callback: Option<InputSlot>,
    pub pending_user_inputs: Vec<String>,
    pub active_status_indicator: Option<(String, ComponentRef)>,
    pub active_working_indicator_embedded: bool,
    pub working_message: Option<String>,
    pub working_visible: bool,
    pub working_indicator_options: Option<Value>,
    pub last_sigint_time: i64,
    pub last_escape_time: i64,
    pub changelog_markdown: Option<String>,
    pub startup_notices_shown: bool,
    pub anthropic_subscription_warning_shown: bool,
    /// `(chat container version, text id)` at the last `showStatus` add;
    /// upstream compares component identity of the last two chat children.
    pub last_status: Option<(u64, u64)>,
    pub managed_tool_status_started: bool,
    pub streaming_component: Option<ComponentRef>,
    pub streaming_message: Option<AgentMessage>,
    pub pending_tools: std::collections::HashMap<String, ComponentRef>,
    pub tool_output_expanded: bool,
    pub hide_thinking_block: bool,
    pub output_pad: i64,
    pub skill_commands: BTreeMap<String, String>,
    pub unsubscribe: Option<SubscriptionSlot>,
    pub signal_cleanup_handlers: Vec<CleanupId>,
    pub is_bash_mode: bool,
    pub pending_bash_components: Vec<ComponentRef>,
    pub auto_compaction_escape_handler_active: bool,
    pub retry_escape_handler_active: bool,
    pub compaction_queued_messages: Vec<CompactionQueuedMessage>,
    pub shutdown_requested: bool,
    pub is_shutting_down: bool,
    pub extension_selector_active: bool,
    pub extension_input_active: bool,
    pub extension_editor_active: bool,
    pub extension_terminal_input_subscriptions: Vec<u64>,
    pub extension_widgets_above: Vec<(String, ComponentRef)>,
    pub extension_widgets_below: Vec<(String, ComponentRef)>,
    pub custom_footer_active: bool,
    pub built_in_header: Option<ComponentRef>,
    pub custom_header: Option<ComponentRef>,
    pub active_selector: Option<(SelectorToken, Option<CleanupId>)>,
    pub fd_path: Option<String>,
    pub editor_is_custom: bool,
    pub autocomplete_provider_wrappers: usize,
}

/// Upstream `this.activeSelectorToken` — a fresh per-show identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectorToken(pub u64);

/// The collaborators bundle (upstream constructor dependency assembly).
pub struct ShellIo {
    pub session: Arc<dyn ShellSession>,
    pub session_manager: Arc<dyn ShellSessionManager>,
    pub settings: Arc<dyn ShellSettings>,
    pub editor: Arc<dyn ShellEditor>,
    pub default_editor: Arc<dyn ShellEditor>,
    pub view: Arc<dyn ShellView>,
    pub host: Arc<dyn ShellHost>,
    pub commands: Arc<dyn CommandSink>,
    pub clock: Arc<dyn ShellClock>,
    /// `getAppKeyDisplay(action)` — `keyDisplayText` over the keybindings
    /// manager (the hints module is an r19 component seam).
    pub key_display: Box<dyn Fn(&str) -> String + Send + Sync>,
    /// The r17 theme singleton (`theme` upstream), swappable at runtime.
    pub theme: RwLock<Theme>,
    pub version: String,
    pub app_name: String,
    pub app_title: String,
    /// `os.homedir()`.
    pub home: String,
    /// The changelog fs probes (parseChangelog/getNewEntries over the
    /// changelog path) — the fs read is presentation (S5).
    pub changelog: Box<dyn ChangelogSource + Send + Sync>,
}

/// Upstream changelog helpers (changelog.ts).
pub trait ChangelogSource: Send + Sync {
    /// `parseChangelog(getChangelogPath())` → `[(version, content)]`.
    fn entries(&self) -> Vec<(String, String)>;
    /// `getNewEntries(entries, lastVersion)`.
    fn new_entries(&self, last_version: &str) -> Vec<(String, String)>;
    /// `normalizeChangelogLinks(content, entry)`.
    fn normalize_links(&self, content: &str) -> String;
}

/// Read-only projection of the shell state for assertions.
#[derive(Debug, Clone)]
pub struct ShellStateSnapshot {
    pub is_bash_mode: bool,
    pub tool_output_expanded: bool,
    pub hide_thinking_block: bool,
    pub compaction_queued_messages: Vec<CompactionQueuedMessage>,
    pub shutdown_requested: bool,
    pub is_shutting_down: bool,
    pub last_sigint_time: i64,
    pub last_escape_time: i64,
    pub pending_user_inputs: Vec<String>,
    pub is_initialized: bool,
}

/// The interactive session shell (upstream `InteractiveMode`).
pub struct InteractiveMode {
    io: ShellIo,
    state: Mutex<ShellState>,
    options: Mutex<InteractiveModeOptions>,
    next_id: AtomicU64,
    /// Registered by the embedder (`register_handle`) so Ctrl+C can fire the
    /// async shutdown like upstream `void this.shutdown()`.
    self_handle: Mutex<Option<Weak<InteractiveMode>>>,
}

impl InteractiveMode {
    /// Upstream `constructor(runtimeHost, options)`: options normalization
    /// (`tuiMode` default), hide-thinking/output-pad preload, and the theme
    /// initialized from the built-in dark document with the Truecolor mode
    /// (upstream resolves the mode via the terminal capability probe — S5).
    pub fn new(io: ShellIo, options: InteractiveModeOptions) -> Self {
        let hide_thinking_block = io.settings.hide_thinking_block();
        let output_pad = io.settings.output_pad();
        let mut normalized = options.clone();
        normalized.tui_mode = Some(
            options
                .tui_mode
                .clone()
                .unwrap_or_else(|| "regular".to_string()),
        );
        let theme = create_theme(
            &get_builtin_theme_json("dark").expect("built-in dark theme"),
            Some(super::theme::ColorMode::Truecolor),
            None,
        )
        .expect("built-in theme builds");
        Self {
            io,
            state: Mutex::new(ShellState {
                hide_thinking_block,
                output_pad,
                ..ShellState::default()
            }),
            options: Mutex::new(normalized),
            next_id: AtomicU64::new(1),
            self_handle: Mutex::new(None),
        }
    }

    /// Registers the Arc handle used by `handleCtrlC`.
    pub fn register_handle(self: &Arc<Self>) {
        *self.self_handle.lock().expect("handle lock") = Some(Arc::downgrade(self));
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    pub fn theme(&self) -> std::sync::RwLockReadGuard<'_, Theme> {
        self.io.theme.read().expect("theme lock")
    }

    pub fn session(&self) -> &Arc<dyn ShellSession> {
        &self.io.session
    }

    pub fn options(&self) -> InteractiveModeOptions {
        self.options.lock().expect("options lock").clone()
    }

    pub fn state_snapshot(&self) -> ShellStateSnapshot {
        let state = self.state.lock().expect("state lock");
        ShellStateSnapshot {
            is_bash_mode: state.is_bash_mode,
            tool_output_expanded: state.tool_output_expanded,
            hide_thinking_block: state.hide_thinking_block,
            compaction_queued_messages: state.compaction_queued_messages.clone(),
            shutdown_requested: state.shutdown_requested,
            is_shutting_down: state.is_shutting_down,
            last_sigint_time: state.last_sigint_time,
            last_escape_time: state.last_escape_time,
            pending_user_inputs: state.pending_user_inputs.clone(),
            is_initialized: state.is_initialized,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ShellState> {
        self.state.lock().expect("state lock")
    }

    /// The key the current border color resolves to
    /// (`theme.getThinkingBorderColor(this.session.thinkingLevel || "off")`).
    fn current_border(&self) -> EditorBorder {
        EditorBorder::Thinking(self.io.session.thinking_level())
    }

    // -- constructor wiring --------------------------------------------------

    /// Upstream constructor body: `runtimeHost.setBeforeSessionInvalidate(()
    /// => this.resetExtensionUI())` and `setRebindSession(...)` with Weak
    /// handles so the hooks cannot outlive the shell.
    pub fn bind_runtime_hooks(self: &Arc<Self>) {
        let weak_invalidate = Arc::downgrade(self);
        self.io
            .host
            .set_before_session_invalidate(Some(Box::new(move || {
                if let Some(shell) = weak_invalidate.upgrade() {
                    shell.reset_extension_ui();
                }
            })));
        let weak_rebind = Arc::downgrade(self);
        self.io
            .host
            .set_rebind_session(Some(Box::new(move || {
                let weak_rebind = weak_rebind.clone();
                Box::pin(async move {
                    if let Some(shell) = weak_rebind.upgrade() {
                        shell.rebind_current_session(RebindOptions::default()).await;
                        // themeController.applyFromSettings() is r19 (S5).
                    }
                })
            })));
    }

    /// Upstream `getStartupExpansionState`.
    pub fn get_startup_expansion_state(&self) -> bool {
        self.options().verbose || self.state_snapshot().tool_output_expanded
    }

    // -- status / notifications ----------------------------------------------

    /// Upstream `showManagedToolStatus`.
    pub fn show_managed_tool_status(&self, is_warning: bool, message: &str) {
        {
            let state = self.lock();
            if !state.managed_tool_status_started {
                self.io.view.container_add_spacer(ContainerId::Chat);
            }
        }
        self.lock().managed_tool_status_started = true;
        let display = if is_warning {
            format!("Warning: {message}")
        } else {
            message.to_string()
        };
        let color = if is_warning { "warning" } else { "dim" };
        let text = self.theme().fg(color, &display).unwrap_or_default();
        self.io
            .view
            .container_add_text(ContainerId::Chat, &text, 1, 0, false);
        self.lock().last_status = None;
        self.io.view.request_render(None);
    }

    /// Upstream `showStatus` (immediately-sequential updates coalesce into a
    /// text mutation instead of appending rows).
    pub fn show_status(&self, message: &str) {
        let version = self.io.view.container_version(ContainerId::Chat);
        let coalesce = {
            let state = self.lock();
            state.last_status.is_some_and(|(added_version, id)| added_version == version && id != 0)
        };
        if coalesce {
            let (_, id) = self.lock().last_status.expect("coalesce id");
            let text = self.theme().fg("dim", message).unwrap_or_default();
            self.io.view.container_set_text(ContainerId::Chat, id, &text);
            self.io.view.request_render(None);
            return;
        }
        self.io.view.container_add_spacer(ContainerId::Chat);
        let text = self.theme().fg("dim", message).unwrap_or_default();
        let id = self
            .io
            .view
            .container_add_text(ContainerId::Chat, &text, 1, 0, false);
        let version = self.io.view.container_version(ContainerId::Chat);
        self.lock().last_status = Some((version, id));
        self.io.view.request_render(None);
    }

    /// Upstream `showError`.
    pub fn show_error(&self, error_message: &str) {
        let pad = self.lock().output_pad;
        self.io.view.container_add_spacer(ContainerId::Chat);
        let text = self
            .theme()
            .fg("error", &format!("Error: {error_message}"))
            .unwrap_or_default();
        self.io
            .view
            .container_add_text(ContainerId::Chat, &text, pad, 0, false);
        self.io.view.request_render(None);
    }

    /// Upstream `showWarning`.
    pub fn show_warning(&self, warning_message: &str) {
        self.io.view.container_add_spacer(ContainerId::Chat);
        let text = self
            .theme()
            .fg("warning", &format!("Warning: {warning_message}"))
            .unwrap_or_default();
        self.io
            .view
            .container_add_text(ContainerId::Chat, &text, 1, 0, false);
        self.io.view.request_render(None);
    }

    /// Upstream `clearEditor`.
    pub fn clear_editor(&self) {
        self.io.editor.set_text("");
        self.io.view.request_render(None);
    }

    // -- queues ---------------------------------------------------------------

    /// Upstream `isExtensionCommand`.
    pub fn is_extension_command(&self, text: &str) -> bool {
        if !text.starts_with('/') {
            return false;
        }
        let rest = &text[1..];
        let command_name = match rest.split_once(' ') {
            Some((name, _)) => name,
            None => rest,
        };
        self.io.session.extensions().has_command(command_name)
    }

    /// Upstream `getAllQueuedMessages` (read-only merge of session queue and
    /// compaction queue, session messages first).
    pub fn get_all_queued_messages(&self) -> QueueSnapshot {
        let state = self.lock();
        QueueSnapshot {
            steering: [
                self.io.session.steering_messages(),
                state
                    .compaction_queued_messages
                    .iter()
                    .filter(|m| m.mode == QueueMode::Steer)
                    .map(|m| m.text.clone())
                    .collect(),
            ]
            .concat(),
            follow_up: [
                self.io.session.follow_up_messages(),
                state
                    .compaction_queued_messages
                    .iter()
                    .filter(|m| m.mode == QueueMode::FollowUp)
                    .map(|m| m.text.clone())
                    .collect(),
            ]
            .concat(),
        }
    }

    /// Upstream `clearAllQueues` (clearing merge; no display update).
    pub fn clear_all_queues(&self) -> QueueSnapshot {
        let (steering, follow_up) = self.io.session.clear_queue();
        let mut state = self.lock();
        let compaction_steering: Vec<String> = state
            .compaction_queued_messages
            .iter()
            .filter(|m| m.mode == QueueMode::Steer)
            .map(|m| m.text.clone())
            .collect();
        let compaction_follow_up: Vec<String> = state
            .compaction_queued_messages
            .iter()
            .filter(|m| m.mode == QueueMode::FollowUp)
            .map(|m| m.text.clone())
            .collect();
        state.compaction_queued_messages.clear();
        drop(state);
        QueueSnapshot {
            steering: [steering, compaction_steering].concat(),
            follow_up: [follow_up, compaction_follow_up].concat(),
        }
    }

    /// Upstream `updatePendingMessagesDisplay`.
    pub fn update_pending_messages_display(&self) {
        self.io.view.container_clear(ContainerId::PendingMessages);
        let snapshot = self.get_all_queued_messages();
        if snapshot.steering.is_empty() && snapshot.follow_up.is_empty() {
            return;
        }
        self.io.view.container_add_spacer(ContainerId::PendingMessages);
        let theme = self.theme();
        for message in &snapshot.steering {
            let text = theme
                .fg("dim", &format!("Steering: {message}"))
                .unwrap_or_default();
            self.io
                .view
                .container_add_text(ContainerId::PendingMessages, &text, 1, 0, true);
        }
        for message in &snapshot.follow_up {
            let text = theme
                .fg("dim", &format!("Follow-up: {message}"))
                .unwrap_or_default();
            self.io
                .view
                .container_add_text(ContainerId::PendingMessages, &text, 1, 0, true);
        }
        let dequeue_hint = (self.io.key_display)("app.message.dequeue");
        let hint_text = theme
            .fg("dim", &format!("↳ {dequeue_hint} to edit all queued messages"))
            .unwrap_or_default();
        self.io
            .view
            .container_add_text(ContainerId::PendingMessages, &hint_text, 1, 0, true);
    }

    /// Upstream `restoreQueuedMessagesToEditor`. `current_text` mirrors
    /// `options.currentText` (None = `this.editor.getText()`).
    pub fn restore_queued_messages_to_editor(&self, abort: bool, current_text: Option<&str>) -> usize {
        let snapshot = self.clear_all_queues();
        let all_queued: Vec<String> = [snapshot.steering, snapshot.follow_up].concat();
        if all_queued.is_empty() {
            self.update_pending_messages_display();
            if abort {
                self.io.session.abort();
            }
            return 0;
        }
        let queued_text = all_queued.join("\n\n");
        let current = current_text
            .map(str::to_string)
            .unwrap_or_else(|| self.io.editor.get_text());
        let combined_text = [queued_text, current]
            .into_iter()
            .filter(|t| !t.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        self.io.editor.set_text(&combined_text);
        self.update_pending_messages_display();
        if abort {
            self.io.session.abort();
        }
        all_queued.len()
    }

    /// Upstream `queueCompactionMessage`.
    pub fn queue_compaction_message(&self, text: &str, mode: QueueMode) {
        self.lock()
            .compaction_queued_messages
            .push(CompactionQueuedMessage { text: text.to_string(), mode });
        self.io.editor.add_to_history(text);
        self.io.editor.set_text("");
        self.update_pending_messages_display();
        self.show_status("Queued message for after compaction");
    }

    /// Upstream `flushPendingBashComponents`.
    pub fn flush_pending_bash_components(&self) {
        let pending = std::mem::take(&mut self.lock().pending_bash_components);
        for component in pending {
            self.io
                .view
                .container_remove_component(ContainerId::PendingMessages, &component);
            self.io.view.container_add_component(ContainerId::Chat, &component);
        }
    }

    /// Routes one queued message: extension commands prompt immediately,
    /// everything else follows the message's queue mode.
    fn route_queued_message(
        &self,
        message: &CompactionQueuedMessage,
    ) -> BoxFuture<'_, Result<(), AgentSessionError>> {
        match (self.is_extension_command(&message.text), message.mode) {
            (true, _) => self.io.session.prompt(message.text.clone(), None),
            (false, QueueMode::FollowUp) => self.io.session.follow_up(message.text.clone()),
            (false, QueueMode::Steer) => self.io.session.steer(message.text.clone()),
        }
    }

    /// Upstream `flushCompactionQueue`. The first prompt's failure restores
    /// after the remaining messages are queued but before the trailing
    /// display update (the upstream microtask order captured by the oracle);
    /// other failures restore immediately without the trailing update.
    pub async fn flush_compaction_queue(&self, will_retry: bool) {
        let queued: Vec<CompactionQueuedMessage> = {
            let mut state = self.lock();
            if state.compaction_queued_messages.is_empty() {
                return;
            }
            std::mem::take(&mut state.compaction_queued_messages)
        };
        let count = queued.len();
        self.update_pending_messages_display();

        let restore = |shell: &Self, messages: Vec<CompactionQueuedMessage>, error: String| {
            shell.io.session.clear_queue();
            shell.lock().compaction_queued_messages = messages;
            shell.update_pending_messages_display();
            shell.show_error(&format!(
                "Failed to send queued message{}: {}",
                if count > 1 { "s" } else { "" },
                error
            ));
        };
        let route = |message: &CompactionQueuedMessage| -> BoxFuture<'_, Result<(), AgentSessionError>> {
            self.route_queued_message(message)
        };

        if will_retry {
            // When retry is pending, queue messages for the retry turn.
            for message in &queued {
                if let Err(error) = route(message).await {
                    restore(self, queued, error.to_string());
                    return;
                }
            }
            self.update_pending_messages_display();
            return;
        }

        // Find first non-extension-command message to use as prompt.
        let first_prompt_index = queued
            .iter()
            .position(|message| !self.is_extension_command(&message.text));
        let Some(first_prompt_index) = first_prompt_index else {
            // All extension commands — execute them all.
            for message in &queued {
                if let Err(error) = self.io.session.prompt(message.text.clone(), None).await {
                    restore(self, queued, error.to_string());
                    return;
                }
            }
            return;
        };

        // Execute any extension commands before the first prompt.
        for message in &queued[..first_prompt_index] {
            if let Err(error) = self.io.session.prompt(message.text.clone(), None).await {
                restore(self, queued, error.to_string());
                return;
            }
        }

        // Start a prompt when idle, or queue it into a run still finishing
        // compaction; the first prompt's failure restores the whole queue.
        let first_prompt = &queued[first_prompt_index];
        let streaming = match first_prompt.mode {
            QueueMode::FollowUp => Some(StreamingDelivery::FollowUp),
            QueueMode::Steer => Some(StreamingDelivery::Steer),
        };
        let mut first_prompt_error: Option<String> = None;
        if let Err(error) = self
            .io
            .session
            .prompt(first_prompt.text.clone(), streaming)
            .await
        {
            first_prompt_error = Some(error.to_string());
        }

        // Queue remaining messages.
        for message in &queued[first_prompt_index + 1..] {
            if let Err(error) = route(message).await {
                restore(self, queued, error.to_string());
                return;
            }
        }

        if let Some(error) = first_prompt_error {
            restore(self, queued.clone(), error);
        }
        self.update_pending_messages_display();
    }

    // -- follow-up / dequeue ---------------------------------------------------

    /// Upstream `handleFollowUp`.
    pub async fn handle_follow_up(&self) {
        let text = self.io.editor.get_expanded_text().trim().to_string();
        if text.is_empty() {
            return;
        }
        if self.io.session.is_compacting() {
            if self.is_extension_command(&text) {
                self.io.editor.add_to_history(&text);
                self.io.editor.set_text("");
                let _ = self.io.session.prompt(text, None).await;
            } else {
                self.queue_compaction_message(&text, QueueMode::FollowUp);
            }
            return;
        }
        if self.io.session.is_streaming() {
            self.io.editor.add_to_history(&text);
            self.io.editor.set_text("");
            let _ = self
                .io
                .session
                .prompt(text, Some(StreamingDelivery::FollowUp))
                .await;
            self.update_pending_messages_display();
            self.io.view.request_render(None);
        } else {
            // Not streaming: Alt+Enter acts like regular Enter (onSubmit).
            self.io.editor.set_text("");
            self.submit(text).await;
        }
    }

    /// Upstream `handleDequeue`.
    pub fn handle_dequeue(&self) {
        let restored = self.restore_queued_messages_to_editor(false, None);
        if restored == 0 {
            self.show_status("No queued messages to restore");
        } else {
            self.show_status(&format!(
                "Restored {} queued message{} to editor",
                restored,
                if restored > 1 { "s" } else { "" }
            ));
        }
    }
}
