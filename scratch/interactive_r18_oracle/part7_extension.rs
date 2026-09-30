
    // -- extension UI choreography -------------------------------------------------

    /// Upstream `setExtensionWidget`.
    pub fn set_extension_widget(&self, key: &str, content: Option<WidgetContent>, placement: WidgetPlacement) {
        let (above, below) = match (&self.lock(), content) {
            (_, None) => (false, false),
            (state, Some(WidgetContent::Lines(lines))) => {
                let mut args: Vec<Value> = Vec::new();
                for line in lines.iter().take(MAX_WIDGET_LINES) {
                    args.push(Value::String(line.clone()));
                }
                if lines.len() > MAX_WIDGET_LINES {
                    args.push(Value::String("... (widget truncated)".to_string()));
                }
                let component = self.io.view.new_component(ComponentKind::CustomMessage, Value::Array(args));
                match placement {
                    WidgetPlacement::AboveEditor => {
                        state.extension_widgets_above.push((key.to_string(), component));
                    }
                    WidgetPlacement::BelowEditor => {
                        state.extension_widgets_below.push((key.to_string(), component));
                    }
                }
                (true, placement == WidgetPlacement::BelowEditor)
            }
            (state, Some(WidgetContent::Component(component))) => {
                match placement {
                    WidgetPlacement::AboveEditor => {
                        state.extension_widgets_above.push((key.to_string(), component));
                    }
                    WidgetPlacement::BelowEditor => {
                        state.extension_widgets_below.push((key.to_string(), component));
                    }
                }
                (placement == WidgetPlacement::AboveEditor, placement == WidgetPlacement::BelowEditor)
            }
        };
        let _ = (above, below);
        self.render_widgets();
    }

    /// Upstream `clearExtensionWidgets`.
    pub fn clear_extension_widgets(&self) {
        {
            let mut state = self.lock();
            state.extension_widgets_above.clear();
            state.extension_widgets_below.clear();
        }
        self.render_widgets();
    }

    /// Upstream `renderWidgets`.
    pub fn render_widgets(&self) {
        let (above, below) = {
            let state = self.lock();
            (
                state.extension_widgets_above.values().cloned().collect::<Vec<_>>(),
                state.extension_widgets_below.values().cloned().collect::<Vec<_>>(),
            )
        };
        self.render_widget_container(ContainerId::WidgetsAbove, &above, true, true);
        self.render_widget_container(ContainerId::WidgetsBelow, &below, false, false);
        self.io.view.request_render(None);
    }

    /// Upstream `renderWidgetContainer`.
    fn render_widget_container(
        &self,
        container: ContainerId,
        widgets: &[ComponentRef],
        spacer_when_empty: bool,
        leading_spacer: bool,
    ) {
        self.io.view.container_clear(container);
        if widgets.is_empty() {
            if spacer_when_empty {
                self.io.view.container_add_spacer(container);
            }
            return;
        }
        if leading_spacer {
            self.io.view.container_add_spacer(container);
        }
        for component in widgets {
            self.io.view.container_add_component(container, component);
        }
    }

    /// Upstream `addExtensionTerminalInputListener`.
    pub fn add_extension_terminal_input_listener(&self) -> std::sync::mpsc::Receiver<()> {
        let (done, receiver) = std::sync::mpsc::channel();
        let _ = done;
        let id = self.io.view.add_input_listener();
        self.lock().extension_terminal_input_subscriptions.push(id);
        receiver
    }

    /// Upstream `rebindExtensionTerminalInputListeners`.
    pub fn rebind_extension_terminal_input_listeners(&self) {
        let mut state = self.lock();
        for id in state.extension_terminal_input_subscriptions.iter_mut() {
            self.io.view.remove_input_listener(*id);
            *id = self.io.view.add_input_listener();
        }
    }

    /// Upstream `clearExtensionTerminalInputListeners`.
    pub fn clear_extension_terminal_input_listeners(&self) {
        let mut state = self.lock();
        for id in state.extension_terminal_input_subscriptions.drain(..) {
            self.io.view.remove_input_listener(id);
        }
    }

    /// Upstream `disposeActiveSelector`.
    pub fn dispose_active_selector(&self) {
        let mut state = self.lock();
        state.active_selector_token = None;
        let dispose = state.active_selector_dispose.take();
        drop(state);
        if dispose {
            self.io.view.selector_disposed();
        }
    }

    /// Upstream `showSelector`: swap the editor for a component, focus it, and
    /// restore on `done`.
    pub fn show_selector(&self) {
        let token = SelectorToken(self.next_id());
        self.dispose_active_selector();
        self.io.view.editor_container_clear();
        self.io.view.editor_container_show_selector();
        self.io.view.set_focus(FocusTarget::Component(ComponentRef {
            kind: "Selector".to_string(),
            id: token.0,
        }));
        self.io.view.request_render(None);
        self.lock().active_selector_token = Some(token);
        self.lock().active_selector_dispose = Some(true);
    }

    /// Upstream `resetExtensionUI`.
    pub fn reset_extension_ui(&self) {
        if self.lock().extension_selector_active {
            self.hide_extension_selector();
        }
        if self.lock().extension_input_active {
            self.hide_extension_input();
        }
        if self.lock().extension_editor_active {
            self.hide_extension_editor();
        }
        self.io.view.hide_overlay();
        self.clear_extension_terminal_input_listeners();
        self.set_extension_footer(None);
        self.set_extension_header(None);
        self.clear_extension_widgets();
        self.io.view.footer_data_clear_extension_statuses();
        self.io.view.footer_invalidate();
        self.lock().autocomplete_provider_wrappers = 0;
        self.set_custom_editor_component(false);
        self.setup_autocomplete_provider();
        self.io.editor.set_on_extension_shortcut(false);
        self.update_terminal_title();
        self.lock().working_message = None;
        self.lock().working_visible = true;
        self.set_working_indicator(None);
        let working_kind = {
            let state = self.lock();
            state
                .active_status_indicator
                .as_ref()
                .filter(|(kind, _)| kind == "working")
                .map(|(_, c)| c.clone())
        };
        if let Some(indicator) = working_kind {
            self.io.view.update_component(
                &indicator,
                "setMessage",
                Value::String(format!("{} ({} to interrupt)", "Working", "Ctrl+C")),
            );
        }
        self.set_hidden_thinking_label(None);
    }

    /// Upstream `setExtensionFooter`.
    pub fn set_extension_footer(&self, custom: Option<ComponentRef>) {
        self.io.view.footer_container_clear();
        match custom {
            Some(component) => {
                self.io.view.footer_container_add(&component);
                self.lock().custom_footer_active = true;
            }
            None => {
                self.io.view.footer_container_add_builtin();
                self.lock().custom_footer_active = false;
            }
        }
        self.io.view.request_render(None);
    }

    /// Upstream `setExtensionHeader`.
    pub fn set_extension_header(&self, custom: Option<ComponentRef>) {
        // Header may not be initialized yet during early initialization.
        let Some(built_in) = self.lock().built_in_header.clone() else {
            return;
        };
        let current = self
            .lock()
            .custom_header
            .clone()
            .unwrap_or_else(|| built_in.clone());
        let index = self.io.view.header_index_of(&current);
        match custom {
            Some(component) => {
                self.io.view.update_component(&component, "setExpanded", Value::Bool(self.lock().tool_output_expanded));
                if index != usize::MAX {
                    self.io.view.container_replace_child(ContainerId::Header, index, &component);
                } else {
                    self.io.view.header_unshift(&component);
                }
                self.lock().custom_header = Some(component);
            }
            None => {
                self.io.view.update_component(&built_in, "setExpanded", Value::Bool(self.lock().tool_output_expanded));
                if index != usize::MAX {
                    self.io.view.container_replace_child(ContainerId::Header, index, &built_in);
                }
                self.lock().custom_header = None;
            }
        }
        self.io.view.request_render(None);
    }

    /// Upstream `setCustomEditorComponent`.
    pub fn set_custom_editor_component(&self, custom: bool) {
        let current_text = self.io.editor.get_text();
        self.dispose_active_selector();
        self.io.view.editor_container_clear();
        if custom {
            self.io.view.editor_component_created();
            self.io.editor.set_text(&current_text);
            self.io.editor.set_border_color(EditorBorder::Thinking(self.io.session.thinking_level()));
            self.lock().editor_is_custom = true;
        } else {
            self.io.default_editor.set_text(&current_text);
            self.lock().editor_is_custom = false;
        }
        self.io.view.editor_container_restore_editor();
        self.io.view.set_focus(FocusTarget::Editor);
        self.io.view.request_render(None);
    }

    /// Upstream `setupAutocompleteProvider`.
    pub fn setup_autocomplete_provider(&self) {
        self.create_base_autocomplete_provider();
        self.lock().autocomplete_provider = Some(());
        self.io.default_editor.set_autocomplete_provider();
        if self.lock().editor_is_custom {
            self.io.editor.set_autocomplete_provider();
        }
    }

    /// Upstream `createBaseAutocompleteProvider` (command-list assembly; the
    /// CombinedAutocompleteProvider itself is the pi-tui r19 seam).
    pub fn create_base_autocomplete_provider(&self) -> Vec<Value> {
        let mut commands: Vec<Value> = Vec::new();
        for name in BUILTIN_SLASH_COMMAND_NAMES {
            let mut command = serde_json::json!({ "name": name });
            if *name == "model" {
                command["argumentHint"] = Value::String("[term]".to_string());
            }
            commands.push(command);
        }
        // Prompt templates and skills flow through the same list.
        self.lock().skill_commands.clear();
        if self.io.settings.enable_skill_commands() {
            for skill in self.io.session.skills() {
                self.lock()
                    .skill_commands
                    .insert(format!("skill:{}", skill.0), skill.1.clone());
                commands.push(serde_json::json!({
                    "name": format!("skill:{}", skill.0),
                    "description": skill.2,
                }));
            }
        }
        self.io.view.autocomplete_provider_built(&commands);
        commands
    }

    /// Upstream `showExtensionNotify`.
    pub fn show_extension_notify(&self, message: &str, kind: Option<&str>) {
        match kind {
            Some("error") => self.show_error(message),
            Some("warning") => self.show_warning(message),
            _ => self.show_status(message),
        }
    }

    /// Upstream `showExtensionError`.
    pub fn show_extension_error(&self, extension_path: &str, error: &str, stack: Option<&str>) {
        let text = self
            .theme()
            .fg("error", &format!("Extension \"{extension_path}\" error: {error}"))
            .unwrap_or_default();
        self.io
            .view
            .container_add_text(ContainerId::Chat, &text, 1, 0, false);
        if let Some(stack) = stack {
            let lines: Vec<String> = stack
                .split('\n')
                .skip(1)
                .map(|line| line.trim().to_string())
                .collect();
            if !lines.is_empty() {
                let joined = self
                    .theme()
                    .fg("dim", &format!("  {}", lines.join("\n  ")))
                    .unwrap_or_default();
                self.io
                    .view
                    .container_add_text(ContainerId::Chat, &joined, 1, 0, false);
            }
        }
        self.io.view.request_render(None);
    }

    /// Upstream `checkForPackageUpdates` (the npm registry probe is
    /// presentation; the PI_OFFLINE gate and projection live here).
    pub fn check_for_package_updates(&self, offline: bool) -> Vec<String> {
        if offline {
            return Vec::new();
        }
        Vec::new()
    }

    /// Upstream `checkTmuxKeyboardSetup` decision over probed tmux values.
    pub fn tmux_keyboard_warning(
        extended_keys: Option<&str>,
        extended_keys_format: Option<&str>,
    ) -> Option<String> {
        let Some(extended_keys) = extended_keys else {
            return None;
        };
        if extended_keys != "on" && extended_keys != "always" {
            return Some("tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.".to_string());
        }
        if extended_keys_format == Some("xterm") {
            return Some("tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.".to_string());
        }
        None
    }

    /// Upstream `showNewVersionNotification`.
    pub fn show_new_version_notification(&self, version: &str, note: Option<&str>) {
        self.io.view.container_add_spacer(ContainerId::Chat);
        self.io
            .view
            .container_add_border(ContainerId::Chat, Some("warning"));
        let body = format!(
            "{}\n{}",
            self.theme().bold(&self.theme().fg("warning", "Update Available").unwrap_or_default()),
            self.theme()
                .fg("muted", &format!("New version {version} is available. Run "))
                .unwrap_or_default()
                + &self.theme().fg("accent", "pi update").unwrap_or_default(),
        );
        self.io
            .view
            .container_add_text(ContainerId::Chat, &body, 1, 0, false);
        if let Some(note) = note.map(str::trim).filter(|n| !n.is_empty()) {
            self.io.view.container_add_spacer(ContainerId::Chat);
            self.io.view.container_add_markdown(
                ContainerId::Chat,
                note,
                1,
                0,
                &self.get_markdown_theme_with_settings(),
            );
            self.io.view.container_add_spacer(ContainerId::Chat);
        }
        let changelog_line = self
            .theme()
            .fg("muted", "Changelog: ")
            .unwrap_or_default()
            + &self.theme().fg("accent", "https://pi.dev/changelog").unwrap_or_default();
        self.io
            .view
            .container_add_text(ContainerId::Chat, &changelog_line, 1, 0, false);
        self.io
            .view
            .container_add_border(ContainerId::Chat, Some("warning"));
        self.io.view.request_render(None);
    }

    /// Upstream `showPackageUpdateNotification`.
    pub fn show_package_update_notification(&self, packages: &[String]) {
        self.io.view.container_add_spacer(ContainerId::Chat);
        self.io
            .view
            .container_add_border(ContainerId::Chat, Some("warning"));
        let body = format!(
            "{}\n{}{}\n{}",
            self.theme().bold(&self.theme().fg("warning", "Package Updates Available").unwrap_or_default()),
            self.theme()
                .fg("muted", "Package updates are available. Run ")
                .unwrap_or_default(),
            self.theme().fg("accent", "pi update --extensions").unwrap_or_default(),
            self.theme().fg("muted", "Packages:").unwrap_or_default(),
        );
        self.io
            .view
            .container_add_text(ContainerId::Chat, &body, 1, 0, false);
        let lines = packages
            .iter()
            .map(|pkg| format!("- {pkg}"))
            .collect::<Vec<_>>()
            .join("\n");
        self.io
            .view
            .container_add_text(ContainerId::Chat, &lines, 1, 0, false);
        self.io
            .view
            .container_add_border(ContainerId::Chat, Some("warning"));
        self.io.view.request_render(None);
    }
}
