
    // -- session rendering ------------------------------------------------------

    /// Upstream `getUserMessageText`.
    pub fn get_user_message_text(message: &AgentMessage) -> String {
        let AgentMessage::User(user) = message else {
            return String::new();
        };
        match &user.content {
            crate::ai::types::message::StringOrBlocks::Text(text) => text.clone(),
            crate::ai::types::message::StringOrBlocks::Blocks(blocks) => blocks
                .iter()
                .filter_map(|block| match block {
                    crate::ai::types::message::TextOrImageBlock::Text(text) => {
                        Some(text.text.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""),
        }
    }

    /// Upstream `addCustomEntryToChat`.
    pub fn add_custom_entry_to_chat(&self, entry: &SessionEntry) {
        let SessionEntry::Custom(custom) = entry else {
            return;
        };
        if !self.io.session.extensions().has_entry_renderer(&custom.custom_type) {
            return;
        }
        let args = serde_json::json!([{ "customType": custom.custom_type }]);
        let component = self.io.view.new_component(ComponentKind::CustomEntry, args);
        self.io
            .view
            .update_component(&component, "setExpanded", Value::Bool(self.lock().tool_output_expanded));
        // hasContent() is checked by the r19 component; an empty entry adds
        // nothing (recorded through the view seam in the component args).
        self.io.view.container_add_component(ContainerId::Chat, &component);
    }

    /// Upstream `addMessageToChat`.
    pub fn add_message_to_chat(&self, message: &AgentMessage) {
        match message {
            AgentMessage::System(_) => {}
            AgentMessage::User(user) => {
                let text = Self::get_user_message_text(message);
                if !text.is_empty() {
                    if self.io.view.container_children_len(ContainerId::Chat) > 0 {
                        self.io.view.container_add_spacer(ContainerId::Chat);
                    }
                    if let Some(skill_block) = parse_skill_block(&text) {
                        // Render skill block (collapsible).
                        let args = serde_json::json!([skill_block, self.get_markdown_theme_with_settings()]);
                        let component = self
                            .io
                            .view
                            .new_component(ComponentKind::SkillInvocationMessage, args);
                        self.io.view.update_component(
                            &component,
                            "setExpanded",
                            Value::Bool(self.lock().tool_output_expanded),
                        );
                        self.io.view.container_add_component(ContainerId::Chat, &component);
                        // Render the user message separately if present.
                        if let Some(user_message) = skill_block.user_message {
                            self.io.view.container_add_spacer(ContainerId::Chat);
                            let args = serde_json::json!([
                                user_message,
                                self.get_markdown_theme_with_settings(),
                                self.lock().output_pad,
                                self.get_markdown_transformers(),
                            ]);
                            let user_component =
                                self.io.view.new_component(ComponentKind::UserMessage, args);
                            self.io
                                .view
                                .container_add_component(ContainerId::Chat, &user_component);
                        }
                    } else {
                        let args = serde_json::json!([
                            text,
                            self.get_markdown_theme_with_settings(),
                            self.lock().output_pad,
                            self.get_markdown_transformers(),
                        ]);
                        let user_component = self.io.view.new_component(ComponentKind::UserMessage, args);
                        self.io
                            .view
                            .container_add_component(ContainerId::Chat, &user_component);
                    }
                }
                let _ = user;
            }
            AgentMessage::Assistant(_) => {
                let args = serde_json::json!([
                    message,
                    self.lock().hide_thinking_block,
                    self.get_markdown_theme_with_settings(),
                    self.lock().hidden_thinking_label.clone(),
                    self.lock().output_pad,
                    self.get_markdown_transformers(),
                ]);
                let component = self.io.view.new_component(ComponentKind::AssistantMessage, args);
                self.io.view.container_add_component(ContainerId::Chat, &component);
            }
            AgentMessage::ToolResult(_) => {
                // Tool results render inline with tool calls, handled separately.
            }
            AgentMessage::Custom(custom) => match custom.role.as_str() {
                "bashExecution" => {
                    let command = custom.data.get("command").and_then(Value::as_str).unwrap_or_default();
                    let exclude = custom
                        .data
                        .get("excludeFromContext")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let args = serde_json::json!([command, Value::Null, exclude]);
                    let component = self.io.view.new_component(ComponentKind::BashExecution, args);
                    if let Some(output) = custom.data.get("output").and_then(Value::as_str) {
                        self.io
                            .view
                            .update_component(&component, "appendOutput", Value::String(output.to_string()));
                    }
                    self.io.view.update_component(
                        &component,
                        "setComplete",
                        serde_json::json!([
                            custom.data.get("exitCode").cloned().unwrap_or(Value::Null),
                            custom.data.get("cancelled").cloned().unwrap_or(Value::Null),
                            Value::Null,
                            custom.data.get("fullOutputPath").cloned().unwrap_or(Value::Null),
                        ]),
                    );
                    self.io.view.container_add_component(ContainerId::Chat, &component);
                }
                "custom" => {
                    let display = custom
                        .data
                        .get("display")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if display {
                        let custom_type = custom
                            .data
                            .get("customType")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let args = serde_json::json!([
                            message,
                            Value::Null,
                            self.get_markdown_theme_with_settings(),
                            self.lock().output_pad,
                        ]);
                        let component = self.io.view.new_component(ComponentKind::CustomMessage, args);
                        self.io.view.update_component(
                            &component,
                            "setExpanded",
                            Value::Bool(self.lock().tool_output_expanded),
                        );
                        self.io.view.container_add_component(ContainerId::Chat, &component);
                        let _ = custom_type;
                    }
                }
                "compactionSummary" | "branchSummary" => {
                    self.io.view.container_add_spacer(ContainerId::Chat);
                    let kind = if custom.role == "compactionSummary" {
                        ComponentKind::CompactionSummaryMessage
                    } else {
                        ComponentKind::BranchSummaryMessage
                    };
                    let args = serde_json::json!([message, self.get_markdown_theme_with_settings()]);
                    let component = self.io.view.new_component(kind, args);
                    self.io.view.update_component(
                        &component,
                        "setExpanded",
                        Value::Bool(self.lock().tool_output_expanded),
                    );
                    self.io.view.container_add_component(ContainerId::Chat, &component);
                }
                _ => {}
            },
        }
    }

    /// Upstream `renderSessionItems` (assistant tool calls, cache-miss
    /// notices, tool result matching). The cache-miss re-derivation is driven
    /// by the `showCacheMissNotices` setting; the collect pass itself lives in
    /// [`crate::coding_agent::core::cache_stats`].
    pub fn render_session_items(&self, items: &[RenderSessionItem]) {
        self.lock().pending_tools.clear();
        let mut rendered_pending_tools: Vec<(String, ComponentRef)> = Vec::new();

        for item in items {
            match item {
                RenderSessionItem::CustomEntry(entry) => {
                    self.add_custom_entry_to_chat(entry);
                }
                RenderSessionItem::CostNotice(notice) => {
                    self.add_compaction_cost_notice(notice);
                }
                RenderSessionItem::Message(message) => {
                    if message.role() == "assistant" {
                        self.add_message_to_chat(message);
                        for (tool_id, tool_name, tool_args) in assistant_tool_calls(message) {
                            let ctor = serde_json::json!([
                                tool_name,
                                tool_id,
                                tool_args,
                                {
                                    "showImages": self.io.settings.show_images(),
                                    "imageWidthCells": self.io.settings.image_width_cells(),
                                },
                                self.get_registered_tool_definition(&tool_name),
                                Value::Null,
                                self.io.session_manager.cwd(),
                            ]);
                            let component = self
                                .io
                                .view
                                .new_component(ComponentKind::ToolExecution, ctor);
                            self.io.view.update_component(
                                &component,
                                "setExpanded",
                                Value::Bool(self.lock().tool_output_expanded),
                            );
                            self.io.view.container_add_component(ContainerId::Chat, &component);
                            match assistant_stop_reason(message) {
                                Some("aborted") | Some("error") => {
                                    let error_message = if assistant_stop_reason(message) == Some("aborted") {
                                        let retry_attempt = self.io.session.retry_attempt();
                                        if retry_attempt > 0 {
                                            format!(
                                                "Aborted after {} retry attempt{}",
                                                retry_attempt,
                                                if retry_attempt > 1 { "s" } else { "" }
                                            )
                                        } else {
                                            "Operation aborted".to_string()
                                        }
                                    } else {
                                        assistant_error_message(message)
                                            .unwrap_or_else(|| "Error".to_string())
                                    };
                                    self.io.view.update_component(
                                        &component,
                                        "updateResult",
                                        serde_json::json!([
                                            { "content": [{ "type": "text", "text": error_message }], "isError": true },
                                            false,
                                        ]),
                                    );
                                }
                                _ => {
                                    rendered_pending_tools.push((tool_id, component));
                                }
                            }
                        }
                    } else if message.role() == "toolResult" {
                        let tool_call_id = tool_result_call_id(message);
                        if let Some(position) = rendered_pending_tools
                            .iter()
                            .position(|(id, _)| *id == tool_call_id)
                        {
                            let (_, component) = rendered_pending_tools.remove(position);
                            self.io
                                .view
                                .update_component(&component, "updateResult", serde_json::json!([message, false]));
                        }
                    } else {
                        self.add_message_to_chat(message);
                    }
                }
            }
        }

        for (tool_call_id, component) in rendered_pending_tools {
            self.lock().pending_tools.insert(tool_call_id, component);
        }
        self.io.view.request_render(None);
    }

    /// Upstream `renderSessionEntries`: entries → items, appending the
    /// compaction/branch cost notice after the summarized messages.
    pub fn render_session_entries(
        &self,
        entries: &[SessionEntry],
        update_footer: bool,
        populate_history: bool,
    ) {
        if update_footer {
            self.io.view.footer_invalidate();
            self.update_editor_border_color();
        }
        let mut items: Vec<RenderSessionItem> = Vec::new();
        for entry in entries {
            match entry {
                SessionEntry::Custom(custom) => {
                    items.push(RenderSessionItem::CustomEntry(SessionEntry::Custom(custom.clone())));
                    continue;
                }
                entry => {
                    let messages = session_entry_to_context_messages(entry);
                    if messages.is_empty() {
                        continue;
                    }
                    items.extend(messages.into_iter().map(RenderSessionItem::Message));
                    let (usage, kind) = match entry {
                        SessionEntry::Compaction(compaction) => {
                            (compaction.usage.clone(), CompactionCostKind::Compaction)
                        }
                        SessionEntry::BranchSummary(summary) => {
                            (summary.usage.clone(), CompactionCostKind::BranchSummary)
                        }
                        _ => continue,
                    };
                    if let Some(usage) = usage {
                        items.push(RenderSessionItem::CostNotice(CompactionCostNotice { kind, usage }));
                    }
                }
            }
        }
        let _ = populate_history;
        self.render_session_items(&items);
    }

    /// Upstream `addCompactionCostNotice`.
    pub fn add_compaction_cost_notice(&self, notice: &CompactionCostNotice) {
        if !self.io.settings.show_cache_miss_notices() {
            return;
        }
        self.io.view.container_add_spacer(ContainerId::Chat);
        let text = compaction_cost_notice_text(notice, &self.theme());
        self.io
            .view
            .container_add_text(ContainerId::Chat, &text, 1, 0, false);
    }

    /// Upstream `maybeShowThinkingDropNotice`.
    pub fn maybe_show_thinking_drop_notice(&self, message: &AgentMessage) {
        if !self.io.settings.show_cache_miss_notices() {
            return;
        }
        let diagnostics = assistant_diagnostics(message);
        let dropped_count = count_dropped_thinking_blocks(diagnostics);
        if dropped_count == 0 {
            return;
        }
        // message_end reaches the UI before the current message is persisted,
        // so the branch's last assistant message is the previous response.
        let branch = self.io.session_manager.branch();
        let mut previous_dropped_count = 0;
        for entry in branch.iter().rev() {
            if let SessionEntry::Message(entry_message) = entry {
                if entry_message.message.role() == "assistant" {
                    previous_dropped_count =
                        count_dropped_thinking_blocks(assistant_diagnostics(&entry_message.message));
                    break;
                }
            }
        }
        if dropped_count <= previous_dropped_count {
            return;
        }
        let noun = if dropped_count == 1 {
            "thinking block"
        } else {
            "thinking blocks"
        };
        self.io.view.container_add_spacer(ContainerId::Chat);
        let text = self
            .theme()
            .fg(
                "warning",
                &format!("Anthropic dropped {dropped_count} {noun} (details in session)"),
            )
            .unwrap_or_default();
        self.io
            .view
            .container_add_text(ContainerId::Chat, &text, 1, 0, false);
    }

    /// Upstream `renderInitialMessages`.
    pub fn render_initial_messages(&self) {
        let entries = self.io.session_manager.build_context_entries();
        self.render_session_entries(&entries, true, true);
        self.render_project_trust_warning_if_needed();

        // Show compaction info if the session was compacted.
        let all_entries = self.io.session_manager.entries();
        let compaction_count = all_entries
            .iter()
            .filter(|e| matches!(e, SessionEntry::Compaction(_)))
            .count();
        if compaction_count > 0 {
            let times = if compaction_count == 1 {
                "1 time".to_string()
            } else {
                format!("{compaction_count} times")
            };
            self.show_status(&format!("Session compacted {times}"));
        }
    }

    /// Upstream `renderProjectTrustWarningIfNeeded`.
    pub fn render_project_trust_warning_if_needed(&self) {
        if self.io.settings.project_trusted() {
            return;
        }
        if self.io.view.container_children_len(ContainerId::Chat) > 0 {
            self.io.view.container_add_spacer(ContainerId::Chat);
        }
        let text = self
            .theme()
            .fg(
                "warning",
                &format!(
                    "This project is not trusted. Project {} resources and packages are ignored. Use /trust to save a trust decision, then restart pi.",
                    CONFIG_DIR_NAME
                ),
            )
            .unwrap_or_default();
        self.io
            .view
            .container_add_text(ContainerId::Chat, &text, 1, 0, false);
    }

    /// Upstream `showStartupNoticesIfNeeded`.
    pub fn show_startup_notices_if_needed(&self) {
        if self.lock().startup_notices_shown {
            return;
        }
        self.lock().startup_notices_shown = true;

        let Some(changelog_markdown) = self.lock().changelog_markdown.clone() else {
            return;
        };

        if self.io.view.container_children_len(ContainerId::Chat) > 0 {
            self.io.view.container_add_spacer(ContainerId::Chat);
        }
        self.io.view.container_add_border(ContainerId::Chat, None);
        if self.io.settings.collapse_changelog() {
            // `##\s+\[?(\d+\.\d+\.\d+)\]?` — the first version heading.
            let latest_version = first_changelog_version(&changelog_markdown)
                .unwrap_or_else(|| self.io.version.clone());
            let condensed = format!(
                "Updated to v{latest_version}. Use {} to view full changelog.",
                self.theme().bold("/changelog")
            );
            let text = self.theme().fg("dim", &condensed).unwrap_or_default();
            self.io
                .view
                .container_add_text(ContainerId::Chat, &text, 1, 0, false);
        } else {
            let heading = self.theme().bold(&self.theme().fg("accent", "What's New").unwrap_or_default());
            let text = self.theme().fg("dim", &heading).unwrap_or_default();
            self.io
                .view
                .container_add_text(ContainerId::Chat, &text, 1, 0, false);
            self.io.view.container_add_spacer(ContainerId::Chat);
            self.io.view.container_add_markdown(
                ContainerId::Chat,
                changelog_markdown.trim(),
                1,
                0,
                &self.get_markdown_theme_with_settings(),
            );
            self.io.view.container_add_spacer(ContainerId::Chat);
        }
        self.io.view.container_add_border(ContainerId::Chat, None);
    }

    // -- lifecycle -----------------------------------------------------------------

    /// Upstream `updateTerminalTitle`.
    pub fn update_terminal_title(&self) {
        let cwd_basename = self
            .io
            .session_manager
            .cwd()
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string();
        let session_name = self.io.session_manager.session_name();
        let title = match session_name {
            Some(name) => format!("{} - {name} - {}", self.io.app_title, cwd_basename),
            None => format!("{} - {}", self.io.app_title, cwd_basename),
        };
        self.io.view.terminal_set_title(&title);
    }

    /// Upstream `getChangelogForDisplay`.
    pub fn get_changelog_for_display(&self) -> Option<String> {
        // Skip the changelog for resumed/continued sessions.
        if !self.io.session.messages().is_empty() {
            return None;
        }
        match self.io.settings.last_changelog_version() {
            None => {
                // Fresh install — record the version, don't show the changelog.
                self.io.settings.set_last_changelog_version(&self.io.version.clone());
                Some(String::new())
            }
            Some(last_version) => {
                let new_entries = self.io.changelog.new_entries(&last_version);
                if !new_entries.is_empty() {
                    self.io.settings.set_last_changelog_version(&self.io.version.clone());
                    return Some(
                        new_entries
                            .iter()
                            .map(|(content, _)| self.io.changelog.normalize_links(content))
                            .collect::<Vec<_>>()
                            .join("\n\n"),
                    );
                }
                None
            }
        }
    }

    /// Upstream `updateAvailableProviderCount`.
    pub fn update_available_provider_count(&self) {
        let models: Vec<String> = {
            let scoped = self.io.session.scoped_models();
            if !scoped.is_empty() {
                scoped.iter().map(|s| s.model.provider.clone()).collect()
            } else {
                Vec::new()
            }
        };
        let providers: std::collections::HashSet<&String> = models.iter().collect();
        self.io
            .view
            .footer_data_set_available_provider_count(providers.len());
    }

    /// Upstream `checkShutdownRequested`.
    pub async fn check_shutdown_requested(&self) {
        if !self.lock().shutdown_requested {
            return;
        }
        self.shutdown(false).await;
    }

    /// Upstream `shutdown`. `from_signal` mirrors the SIGTERM/SIGHUP path
    /// (extension teardown before terminal restore). `process.exit` is the
    /// embedder's job (S7) — the shell performs the ordered teardown and
    /// returns the resume command.
    pub async fn shutdown(&self, from_signal: bool) -> Option<String> {
        if self.lock().is_shutting_down {
            return None;
        }
        self.lock().is_shutting_down = true;

        if from_signal {
            // Emit extension cleanup (session_shutdown) BEFORE touching the
            // terminal.
            self.io.host.dispose().await;
            self.io.view.terminal_drain_input(1000);
            self.stop(&self.io.settings.fullscreen_exit_output());
            return None;
        }

        // Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()).
        // Drain in-flight Kitty key release events before stopping.
        self.io.view.terminal_drain_input(1000);
        self.stop(&self.io.settings.fullscreen_exit_output());
        self.io.host.dispose().await;

        let resume_command = format_resume_command(
            self.io.session_manager.as_ref(),
            &self.io.app_name.clone(),
            true,
            |path| !path.is_empty(),
        );
        resume_command
    }

    /// Upstream `stop`.
    pub fn stop(&self, fullscreen_exit_output: &str) {
        self.dispose_active_selector();
        if self.io.settings.show_terminal_progress() {
            self.io.view.terminal_set_progress(false);
        }
        self.clear_status_indicator(None);
        self.clear_extension_terminal_input_listeners();
        self.io.view.footer_dispose();
        self.io.view.footer_data_dispose();
        if let Some(subscription) = self.lock().unsubscribe.take() {
            self.io.view.agent_unsubscribe(subscription);
        }
        if self.lock().is_initialized {
            self.stop_interactive_tui(fullscreen_exit_output);
            self.lock().is_initialized = false;
        }
        self.unregister_signal_handlers();
    }

    /// Upstream `registerSignalHandlers` — registration bookkeeping; the OS
    /// signal wiring is the embedder's (S7).
    pub fn register_signal_handlers(&self) {
        self.unregister_signal_handlers();
        let mut state = self.lock();
        state.signal_cleanup_handlers = vec![
            CleanupId(self.next_id()),
            CleanupId(self.next_id()),
            CleanupId(self.next_id()),
            CleanupId(self.next_id()),
        ];
    }

    /// Upstream `unregisterSignalHandlers`.
    pub fn unregister_signal_handlers(&self) {
        self.lock().signal_cleanup_handlers.clear();
    }

    /// Upstream `stopInteractiveTui`.
    fn stop_interactive_tui(&self, fullscreen_exit_output: &str) {
        if self.io.view.renderer_mode() == "fullscreen" && fullscreen_exit_output == "transcript" {
            while self.io.view.has_overlay_entries() {
                self.io.view.hide_overlay();
            }
            self.switch_tui_mode("regular", false, false);
            self.io.view.render_now();
        }
        self.io.view.stop(self.io.view.renderer_mode() == "fullscreen");
    }

    /// Upstream `mountInteractiveTui`.
    pub fn mount_interactive_tui(&self, components: &[ContainerId]) {
        for component in components {
            self.io.view.renderer_add_child(*component);
        }
    }

    /// Upstream `switchTuiMode`. Returns whether the switch happened; the
    /// renderer construction/capture is the view seam (S1/S5).
    pub fn switch_tui_mode(&self, mode: &str, restore_progress: bool, start_renderer: bool) -> bool {
        let previous_mode = self.io.view.renderer_mode();
        if mode == previous_mode {
            return true;
        }
        if self.io.view.has_overlay_entries() {
            return false;
        }
        let components = self.io.view.renderer_children();
        let focus = self.io.view.renderer_focused_component();
        let terminal = self.io.view.renderer_terminal_id();
        let show_hardware_cursor = self.io.view.renderer_show_hardware_cursor();
        let clear_on_shrink = self.io.view.renderer_clear_on_shrink();

        self.io.view.renderer_stop_preserving_screen();
        self.io.view.renderer_set_focus_none();
        self.io.view.renderer_clear();
        self.io.view.renderer_set_layout_root_none();

        let next = self
            .io
            .view
            .renderer_create(mode, show_hardware_cursor, clear_on_shrink, &components, &focus, terminal);
        self.io.view.renderer_become(next);
        self.lock_options_tui_mode(mode);
        self.io.view.renderer_invalidate();
        self.io.view.renderer_set_focus(focus);
        if !start_renderer {
            return true;
        }
        self.io.view.renderer_start();
        if restore_progress
            && self.io.settings.show_terminal_progress()
            && (self.io.session.is_streaming() || self.io.session.is_compacting())
        {
            self.io.view.terminal_set_progress(true);
        }
        true
    }

    fn lock_options_tui_mode(&self, mode: &str) {
        self.options.lock().expect("options lock").tui_mode = Some(mode.to_string());
    }

    /// Upstream `rebindCurrentSession`.
    pub async fn rebind_current_session(&self, options: RebindOptions) {
        let session_before = self.io.view.session_identity();

        self.io.view.agent_unsubscribe_current();
        self.lock().unsubscribe = None;
        self.apply_runtime_settings();

        if options.render_before_bind {
            self.render_current_session_state();
            self.subscribe_to_agent();
        }

        self.bind_current_session_extensions().await;

        if self.io.view.session_identity() != session_before {
            return;
        }

        if !options.render_before_bind {
            self.subscribe_to_agent();
        }

        self.update_available_provider_count();
        self.update_editor_border_color();
        self.update_terminal_title();
    }

    /// Upstream `handleFatalRuntimeError`.
    pub fn handle_fatal_runtime_error(&self, prefix: &str, error: &str) {
        self.show_error(&format!("{prefix}: {error}"));
        self.stop("transcript");
    }

    /// Upstream `renderCurrentSessionState`.
    pub fn render_current_session_state(&self) {
        self.io.view.container_clear(ContainerId::LoadedResources);
        self.io.view.container_clear(ContainerId::Chat);
        self.io.view.container_clear(ContainerId::PendingMessages);
        self.lock().compaction_queued_messages.clear();
        self.lock().streaming_component = None;
        self.lock().streaming_message = None;
        self.lock().pending_tools.clear();
        self.render_initial_messages();
    }

    /// Upstream `applyRuntimeSettings`.
    pub fn apply_runtime_settings(&self) {
        self.io.view.apply_capability_overrides();
        self.io
            .view
            .apply_http_dispatcher(self.io.settings.http_idle_timeout_ms());
        self.io
            .view
            .transcript_set_scrollbar(self.io.settings.fullscreen_scrollbar());
        self.io.view.footer_set_session();
        self.io
            .view
            .footer_set_auto_compact(self.io.session.auto_compaction_enabled());
        self.io.view.footer_data_set_cwd(&self.io.session_manager.cwd());
        {
            let mut state = self.lock();
            state.hide_thinking_block = self.io.settings.hide_thinking_block();
            state.output_pad = self.io.settings.output_pad();
        }
        self.io
            .view
            .set_show_hardware_cursor(self.io.settings.show_hardware_cursor());
        let clear_on_shrink = self.io.settings.clear_on_shrink();
        self.io.view.set_clear_on_shrink(clear_on_shrink);
        if !clear_on_shrink && self.lock().active_status_indicator.is_none() {
            self.io.view.container_clear(ContainerId::Status);
        }
        let editor_padding_x = self.io.settings.editor_padding_x();
        let autocomplete_max_visible = self.io.settings.autocomplete_max_visible();
        self.io.default_editor.set_padding_x(editor_padding_x);
        self.io
            .default_editor
            .set_autocomplete_max_visible(autocomplete_max_visible);
        if self.lock().editor_is_custom {
            self.io.editor.set_padding_x(editor_padding_x);
            self.io.editor.set_autocomplete_max_visible(autocomplete_max_visible);
        }
    }

    /// Upstream `bindCurrentSessionExtensions` (ordering core; the extension
    /// UI context itself is the r19 component seam — S3/S5).
    pub async fn bind_current_session_extensions(&self) {
        self.io.view.bind_extensions();
        self.io.view.set_registered_themes();
        self.setup_autocomplete_provider();

        self.setup_extension_shortcuts();
        self.show_loaded_resources(false, true);
        self.show_startup_notices_if_needed();
    }
}
