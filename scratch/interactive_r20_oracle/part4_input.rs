
    // -- input ring --------------------------------------------------------------

    /// Upstream `setupKeyHandlers` registration half: the editor seam records
    /// the app-action registrations in upstream order plus the escape /
    /// ctrl-d / change / paste-image / extension-shortcut handler slots.
    pub fn setup_key_handlers(&self) {
        for action in INPUT_RING_ACTIONS {
            self.io.editor.on_action(action);
        }
        self.io.editor.set_on_escape();
        self.io.editor.set_on_ctrl_d();
        self.io.editor.set_on_change();
        self.io.editor.set_on_paste_image();
        self.io.editor.set_on_extension_shortcut(false);
    }

    /// Upstream `setupEditorSubmitHandler` registration half.
    pub fn setup_editor_submit_handler(&self) {
        self.io.editor.set_on_submit();
    }

    /// The upstream `defaultEditor.onEscape` body.
    pub fn on_escape_pressed(&self) {
        let text = self.io.editor.get_text();
        if self.io.session.is_streaming() {
            self.restore_queued_messages_to_editor(true, None);
        } else if self.io.session.is_bash_running() {
            self.io.session.abort_bash();
        } else if self.lock().is_bash_mode {
            self.io.editor.set_text("");
            self.lock().is_bash_mode = false;
            self.update_editor_border_color();
        } else if text.trim().is_empty() {
            // Double-escape with empty editor triggers /tree, /fork, or
            // nothing based on the setting.
            let action = self.io.settings.double_escape_action();
            if action != "none" {
                let now = self.io.clock.now_ms();
                let last = self.lock().last_escape_time;
                if now - last < 500 {
                    if action == "tree" {
                        self.io.commands.run(ShellCommand::TreeSelector);
                    } else {
                        self.io.commands.run(ShellCommand::UserMessageSelector);
                    }
                    self.lock().last_escape_time = 0;
                } else {
                    self.lock().last_escape_time = now;
                }
            }
        }
    }

    /// The upstream `handleCtrlC` body (500ms double-press window).
    pub fn handle_ctrl_c(&self) -> CtrlCOutcome {
        let now = self.io.clock.now_ms();
        if now - self.lock().last_sigint_time < 500 {
            CtrlCOutcome::Shutdown
        } else {
            self.clear_editor();
            self.lock().last_sigint_time = now;
            CtrlCOutcome::ClearEditor
        }
    }

    /// The upstream `handleCtrlD` body (only called with an empty editor).
    pub fn handle_ctrl_d(&self) -> CtrlCOutcome {
        CtrlCOutcome::Shutdown
    }

    /// The upstream `handleCtrlZ` decision. The posix suspend choreography
    /// (interval keep-alive, SIGINT ignore, SIGCONT restart) is an OS
    /// presentation seam (S7); win32 shows the status line.
    pub fn handle_ctrl_z(&self) -> SuspendDecision {
        if cfg!(windows) {
            self.show_status("Suspend to background is not supported on Windows");
            return SuspendDecision::Unsupported;
        }
        SuspendDecision::Suspend
    }

    // -- submit ladder -----------------------------------------------------------

    /// Upstream `setupEditorSubmitHandler`'s onSubmit body — the full command
    /// ladder in upstream order. Command handler bodies are r19 (S3); the
    /// decision, editor clearing, and history handling live here.
    pub async fn submit(&self, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }

        // Command ladder (upstream order).
        macro_rules! exact {
            ($prefix:expr, $command:expr) => {
                if text == $prefix {
                    self.io.editor.set_text("");
                    self.io.commands.run($command);
                    return;
                }
            };
        }
        macro_rules! exact_then_async {
            ($prefix:expr, $command:expr) => {
                if text == $prefix {
                    self.io.editor.set_text("");
                    self.io.commands.run($command);
                    return;
                }
            };
        }
        macro_rules! with_arg {
            ($prefix:expr, $command:expr) => {
                if text == $prefix || text.starts_with(concat!($prefix, " ")) {
                    let arg = text.strip_prefix(concat!($prefix, " ")).map(str::trim);
                    self.io.editor.set_text("");
                    self.io.commands.run($command(arg.map(str::to_string)));
                    return;
                }
            };
        }

        exact!("/settings", ShellCommand::Settings);
        exact!("/scoped-models", ShellCommand::ScopedModels);
        with_arg!("/model", ShellCommand::Model);
        with_arg!("/thinking", ShellCommand::Thinking);

        if text == "/export" || text.starts_with("/export ") {
            self.io.commands.run(ShellCommand::Export(text.to_string()));
            self.io.editor.set_text("");
            return;
        }
        if text == "/import" || text.starts_with("/import ") {
            self.io.commands.run(ShellCommand::Import(text.to_string()));
            self.io.editor.set_text("");
            return;
        }
        exact!("/share", ShellCommand::Share);
        exact!("/copy", ShellCommand::Copy { flash_confirmation: false, prefer_selection: false });
        if text == "/name" || text.starts_with("/name ") {
            self.io.commands.run(ShellCommand::Name(text.to_string()));
            self.io.editor.set_text("");
            return;
        }
        exact!("/session", ShellCommand::Session);
        exact!("/changelog", ShellCommand::Changelog);
        exact!("/hotkeys", ShellCommand::Hotkeys);
        exact!("/fork", ShellCommand::UserMessageSelector);
        exact!("/clone", ShellCommand::Clone);
        exact!("/tree", ShellCommand::TreeSelector);
        exact!("/trust", ShellCommand::Trust);
        if text == "/login" || text.starts_with("/login ") {
            let provider_ref = text.strip_prefix("/login ").map(str::trim);
            self.io.editor.set_text("");
            self.io
                .commands
                .run(ShellCommand::Login(provider_ref.map(str::to_string)));
            return;
        }
        exact!("/logout", ShellCommand::OAuthLogout);
        exact!("/new", ShellCommand::Clear);
        if text == "/compact" || text.starts_with("/compact ") {
            let custom = text.strip_prefix("/compact ").map(str::trim);
            self.io.editor.set_text("");
            self.io
                .commands
                .run(ShellCommand::Compact(custom.map(str::to_string)));
            return;
        }
        exact_then_async!("/reload", ShellCommand::Reload);
        exact!("/debug", ShellCommand::Debug);
        exact!("/arminsayshi", ShellCommand::ArminSaysHi);
        exact!("/dementedelves", ShellCommand::DementedDelves);
        exact!("/resume", ShellCommand::SessionSelector);
        if text == "/quit" {
            self.io.editor.set_text("");
            self.shutdown(false).await;
            return;
        }

        // Bash command (! for normal, !! for excluded from context).
        if let Some(rest) = text.strip_prefix('!') {
            let is_excluded = text.starts_with("!!");
            let command = if is_excluded {
                rest.strip_prefix('!').map(str::trim)
            } else {
                Some(rest.trim())
            };
            if let Some(command) = command.filter(|c| !c.is_empty()) {
                if self.io.session.is_bash_running() {
                    self.show_warning("A bash command is already running. Press Esc to cancel it first.");
                    self.io.editor.set_text(text);
                    return;
                }
                self.io.editor.add_to_history(text);
                self.io.commands.run(ShellCommand::Bash {
                    command: command.to_string(),
                    exclude_from_context: is_excluded,
                });
                self.lock().is_bash_mode = false;
                self.update_editor_border_color();
                return;
            }
        }

        // Queue input during compaction (extension commands execute
        // immediately).
        if self.io.session.is_compacting() {
            if self.is_extension_command(text) {
                self.io.editor.add_to_history(text);
                self.io.editor.set_text("");
                let _ = self.io.session.prompt(text.to_string(), None).await;
            } else {
                self.queue_compaction_message(text, QueueMode::Steer);
            }
            return;
        }

        // If streaming, use prompt() with steer behavior (extension commands,
        // prompt template expansion, and queueing all flow through prompt()).
        if self.io.session.is_streaming() {
            self.io.editor.add_to_history(text);
            self.io.editor.set_text("");
            let _ = self
                .io
                .session
                .prompt(text.to_string(), Some(StreamingDelivery::Steer))
                .await;
            self.update_pending_messages_display();
            self.io.view.request_render(None);
            return;
        }

        // Normal message submission: first move any pending bash components
        // to chat, then hand the text to the waiting input loop.
        self.flush_pending_bash_components();

        {
            let mut state = self.lock();
            if let Some(slot) = state.on_input_callback.take() {
                drop(state);
                self.io.view.user_input_resolved(slot.0, text);
                self.io.editor.add_to_history(text);
                return;
            }
            state.pending_user_inputs.push(text.to_string());
        }
        self.io.editor.add_to_history(text);
    }

    /// Upstream `handleStartupSubmit`.
    pub fn handle_startup_submit(&self, text: &str) {
        self.io.editor.set_text(text);
        self.show_status("Startup is still in progress");
    }

    /// Upstream `getUserInput`: queued inputs drain first; otherwise the
    /// first caller installs the onInput callback and waits.
    pub fn get_user_input(&self) -> Option<String> {
        let mut state = self.lock();
        if !state.pending_user_inputs.is_empty() {
            return Some(state.pending_user_inputs.remove(0));
        }
        if state.on_input_callback.is_none() {
            state.on_input_callback = Some(InputSlot(self.next_id()));
        }
        None
    }

    /// Whether a `getUserInput` waiter is pending (upstream: the promise is
    /// unresolved until the editor submits).
    pub fn has_input_waiter(&self) -> bool {
        self.lock().on_input_callback.is_some()
    }

    // -- editor border / cycles / toggles -----------------------------------------

    /// Upstream `updateEditorBorderColor`.
    pub fn update_editor_border_color(&self) {
        let border = if self.lock().is_bash_mode {
            EditorBorder::BashMode
        } else {
            self.current_border()
        };
        self.io.editor.set_border_color(border);
        if let Some((_, indicator)) = self.lock().active_status_indicator.clone() {
            self.io.view.update_component(&indicator, "invalidate", Value::Null);
        }
        self.io.view.request_render(None);
    }

    /// Upstream `cycleThinkingLevel`.
    pub fn cycle_thinking_level(&self) {
        match self.io.session.cycle_thinking_level() {
            None => self.show_status("Current model does not support thinking"),
            Some(new_level) => {
                self.io.view.footer_invalidate();
                self.update_editor_border_color();
                self.show_status(&format!("Thinking level: {}", thinking_level_lower(&new_level)));
            }
        }
    }

    /// Upstream `cycleModel`.
    pub async fn cycle_model(&self, direction: CycleDirection) {
        match self.io.session.cycle_model(direction).await {
            Err(error) => {
                self.show_error(&error.to_string());
            }
            Ok(None) => {
                let message = if !self.io.session.scoped_models().is_empty() {
                    "Only one model in scope"
                } else {
                    "Only one model available"
                };
                self.show_status(message);
            }
            Ok(Some(result)) => {
                self.io.view.footer_invalidate();
                self.update_editor_border_color();
                let thinking = if result.model.reasoning
                    && result.thinking_level != ThinkingLevel::Off
                {
                    format!(" (thinking: {})", thinking_level_lower(&result.thinking_level))
                } else {
                    String::new()
                };
                let name = result
                    .model
                    .name
                    .clone()
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| result.model.id.clone());
                self.show_status(&format!("Switched to {name}{thinking}"));
                self.io
                    .session
                    .maybe_warn_anthropic_subscription_auth(result.model.provider.as_deref());
            }
        }
    }

    /// Upstream `toggleToolOutputExpansion`.
    pub fn toggle_tool_output_expansion(&self) {
        let expanded = !self.lock().tool_output_expanded;
        self.set_tools_expanded(expanded);
    }

    /// Upstream `setToolsExpanded`.
    pub fn set_tools_expanded(&self, expanded: bool) {
        if expanded == self.lock().tool_output_expanded {
            return;
        }
        self.lock().tool_output_expanded = expanded;
        let active_header = self
            .lock()
            .custom_header
            .clone()
            .or_else(|| self.lock().built_in_header.clone());
        if let Some(header) = active_header {
            self.io
                .view
                .update_component(&header, "setExpanded", Value::Bool(expanded));
        }
        for container in [ContainerId::LoadedResources, ContainerId::Chat] {
            for component in self.io.view.container_components(container) {
                self.io
                    .view
                    .update_component(&component, "setExpanded", Value::Bool(expanded));
            }
        }
        self.show_status(&format!(
            "Tool output: {}",
            if expanded { "expanded" } else { "collapsed" }
        ));
    }

    /// Upstream `updateThinkingBlockVisibility`.
    pub fn update_thinking_block_visibility(&self) {
        let hide = self.lock().hide_thinking_block;
        for component in self.io.view.container_components(ContainerId::Chat) {
            if component.kind == "AssistantMessageComponent" {
                self.io
                    .view
                    .update_component(&component, "setHideThinkingBlock", Value::Bool(hide));
            }
        }
        self.io.view.request_render(None);
    }

    /// Upstream `toggleThinkingBlockVisibility`.
    pub fn toggle_thinking_block_visibility(&self) {
        let hide = !self.lock().hide_thinking_block;
        self.lock().hide_thinking_block = hide;
        self.io.settings.set_hide_thinking_block(hide);
        self.update_thinking_block_visibility();
        self.show_status(&format!(
            "Thinking blocks: {}",
            if hide { "hidden" } else { "visible" }
        ));
    }

    /// Upstream `setHiddenThinkingLabel`.
    pub fn set_hidden_thinking_label(&self, label: Option<&str>) {
        let label = label
            .map(str::to_string)
            .unwrap_or_else(|| "Thinking...".to_string());
        self.lock().hidden_thinking_label = label.clone();
        for component in self.io.view.container_components(ContainerId::Chat) {
            if component.kind == "AssistantMessageComponent" {
                self.io
                    .view
                    .update_component(&component, "setHiddenThinkingLabel", Value::String(label.clone()));
            }
        }
        if let Some(streaming) = self.lock().streaming_component.clone() {
            self.io
                .view
                .update_component(&streaming, "setHiddenThinkingLabel", Value::String(label));
        }
        self.io.view.request_render(None);
    }

    // -- status indicators ----------------------------------------------------------

    /// Upstream `setExtensionStatus`.
    pub fn set_extension_status(&self, key: &str, text: Option<&str>) {
        self.io.view.footer_data_set_extension_status(key, text);
        self.io.view.request_render(None);
    }

    /// Upstream `setEditorWorkingStatusIndicator` — returns whether the
    /// editor embedded the indicator.
    fn set_editor_working_status_indicator(&self, indicator: Option<&ComponentRef>) -> bool {
        self.io.default_editor.set_working_status_indicator(None);
        if !self.lock().editor_embeds_working_status {
            return false;
        }
        self.io
            .editor
            .set_working_status_indicator(indicator.cloned());
        true
    }

    /// Upstream `showStatusIndicator`.
    pub fn show_status_indicator(&self, indicator: ComponentRef, kind: &str) {
        if let Some((_, previous)) = self.lock().active_status_indicator.clone() {
            self.io.view.update_component(&previous, "dispose", Value::Null);
        }
        {
            let mut state = self.lock();
            state.active_status_indicator = Some((kind.to_string(), indicator.clone()));
            state.active_working_indicator_embedded = false;
        }
        self.io.view.container_clear(ContainerId::Status);
        if self.set_editor_working_status_indicator(None) {
            // unreachable while the default editor embeds: the first call
            // clears and the second embeds (kept for upstream parity)
        }
        if self.set_editor_working_status_indicator(Some(&indicator)) {
            self.lock().active_working_indicator_embedded = true;
            return;
        }
        self.io.view.container_add_component(ContainerId::Status, &indicator);
    }

    /// Upstream `clearStatusIndicator`.
    pub fn clear_status_indicator(&self, kind: Option<&str>) {
        {
            let state = self.lock();
            if let Some((active_kind, _)) = &state.active_status_indicator {
                if let Some(kind) = kind {
                    if active_kind != kind {
                        return;
                    }
                }
            } else if kind.is_some() {
                // upstream: `kind && this.activeStatusIndicator?.kind !== kind`
                // — no active indicator: `undefined?.kind !== kind` is true for
                // any kind → returns; without a kind it clears anyway.
                return;
            }
        }
        let cleared = self.lock().active_status_indicator.clone();
        let was_embedded = self.lock().active_working_indicator_embedded;
        if let Some((_, indicator)) = &cleared {
            self.io.view.update_component(indicator, "dispose", Value::Null);
        }
        {
            let mut state = self.lock();
            state.active_status_indicator = None;
            state.active_working_indicator_embedded = false;
        }
        self.io.view.container_clear(ContainerId::Status);
        self.set_editor_working_status_indicator(None);
        if cleared.is_some() && !was_embedded && self.options().tui_mode.as_deref() == Some("regular") && self.io.view.get_clear_on_shrink() {
            let idle = self.io.view.idle_status_component();
            self.io.view.container_add_component(ContainerId::Status, &idle);
        }
    }

    /// Upstream `showWorkingStatusIndicator`.
    pub fn show_working_status_indicator(&self) {
        let working_message = {
            let state = self.lock();
            state
                .working_message
                .clone()
                .unwrap_or_else(|| "Working".to_string())
        };
        let args = serde_json::json!({
            "message": working_message,
            "options": self.lock().working_indicator_options.clone().unwrap_or(Value::Null),
        });
        let indicator = self
            .io
            .view
            .new_component(ComponentKind::WorkingStatusIndicator, args);
        self.show_status_indicator(indicator, "working");
    }

    /// Upstream `setWorkingVisible`.
    pub fn set_working_visible(&self, visible: bool) {
        self.lock().working_visible = visible;
        if !visible {
            self.clear_status_indicator(Some("working"));
            self.io.view.request_render(None);
            return;
        }
        if self.io.session.is_streaming() {
            let kind = self
                .lock()
                .active_status_indicator
                .as_ref()
                .map(|(kind, _)| kind.clone());
            if kind.as_deref() != Some("working") {
                self.show_working_status_indicator();
            }
        }
        self.io.view.request_render(None);
    }

    /// Upstream `setWorkingIndicator`.
    pub fn set_working_indicator(&self, options: Option<Value>) {
        self.lock().working_indicator_options = options.clone();
        let kind = self
            .lock()
            .active_status_indicator
            .as_ref()
            .map(|(kind, _)| kind.clone());
        if kind.as_deref() == Some("working") {
            let (_, indicator) = self.lock().active_status_indicator.clone().unwrap();
            self.io
                .view
                .update_component(&indicator, "setIndicator", options.unwrap_or(Value::Null));
        }
        self.io.view.request_render(None);
    }

    // -- user input waiters ------------------------------------------------------------
}
