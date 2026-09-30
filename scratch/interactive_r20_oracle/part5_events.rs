
    // -- markdown / transformers / tool definitions -------------------------------

    /// Upstream `getMarkdownThemeWithSettings`.
    pub fn get_markdown_theme_with_settings(&self) -> Value {
        serde_json::json!({
            "tag": "markdownTheme",
            "codeBlockIndent": self.io.settings.code_block_indent(),
        })
    }

    /// Upstream `getMarkdownTransformers`: the mermaid transformer first, then
    /// the extension transformers.
    pub fn get_markdown_transformers(&self) -> Vec<Value> {
        let mut transformers = vec![serde_json::json!({ "tag": "mermaid" })];
        transformers.extend(
            self.io
                .session
                .extensions()
                .markdown_transformers()
                .into_iter()
                .map(|tag| serde_json::json!({ "tag": tag })),
        );
        transformers
    }

    /// Upstream `getRegisteredToolDefinition`.
    pub fn get_registered_tool_definition(&self, tool_name: &str) -> Value {
        serde_json::json!({
            "name": tool_name,
            "def": self.io.session.tool_definition(tool_name),
            "via": "builtInRenderers",
        })
    }

    // -- event → UI bridge -----------------------------------------------------------

    /// Upstream `subscribeToAgent`.
    pub fn subscribe_to_agent(&self) {
        let slot = SubscriptionSlot(self.next_id());
        self.io.view.agent_subscribed();
        self.lock().unsubscribe = Some(slot);
    }

    /// Upstream `handleEvent` — the full AgentSessionEvent switch. Events
    /// arriving before initialization trigger init first (modeled through the
    /// [`CommandSink`] as `cmd.init`, r19 presentation).
    pub async fn handle_event(&self, event: &AgentSessionEvent) {
        if !self.lock().is_initialized {
            self.io.commands.run(ShellCommand::Init);
        }

        self.io.view.footer_invalidate();

        match event {
            AgentSessionEvent::AgentStart => {
                self.lock().pending_tools.clear();
                // Restore main escape handler if retry handler is still
                // active (retry success event fires later, but we need the
                // main handler now).
                if self.lock().retry_escape_handler_active {
                    self.io.editor.set_on_escape();
                    self.lock().retry_escape_handler_active = false;
                }
            }
            AgentSessionEvent::TurnStart => {
                if self.io.settings.show_terminal_progress() {
                    self.io.view.terminal_set_progress(true);
                }
                if self.lock().working_visible {
                    let kind = self
                        .lock()
                        .active_status_indicator
                        .as_ref()
                        .map(|(kind, _)| kind.clone());
                    if kind.as_deref() != Some("working") {
                        self.show_working_status_indicator();
                    }
                } else {
                    self.clear_status_indicator(None);
                }
                self.io.view.request_render(None);
            }
            AgentSessionEvent::QueueUpdate { .. } => {
                self.update_pending_messages_display();
                self.io.view.request_render(None);
            }
            AgentSessionEvent::EntryAppended { entry } => {
                if matches!(entry, SessionEntry::Custom(_)) {
                    self.add_custom_entry_to_chat(entry);
                    self.io.view.request_render(None);
                }
            }
            AgentSessionEvent::SessionInfoChanged { .. } => {
                self.update_terminal_title();
                self.io.view.footer_invalidate();
                self.io.view.request_render(None);
            }
            AgentSessionEvent::ThinkingLevelChanged { .. } => {
                self.io.view.footer_invalidate();
                self.update_editor_border_color();
            }
            AgentSessionEvent::MessageStart { message } => {
                let role = message.role().to_string();
                match role.as_str() {
                    "custom" => {
                        self.add_message_to_chat(message);
                        self.io.view.request_render(None);
                    }
                    "user" => {
                        self.add_message_to_chat(message);
                        self.update_pending_messages_display();
                        self.io.view.request_render(None);
                    }
                    "assistant" => {
                        let args = serde_json::json!([
                            Value::Null,
                            self.lock().hide_thinking_block,
                            self.get_markdown_theme_with_settings(),
                            self.lock().hidden_thinking_label.clone(),
                            self.lock().output_pad,
                            self.get_markdown_transformers(),
                        ]);
                        let component = self
                            .io
                            .view
                            .new_component(ComponentKind::AssistantMessage, args);
                        self.io.view.container_add_component(ContainerId::Chat, &component);
                        self.lock().streaming_component = Some(component.clone());
                        self.lock().streaming_message = Some(message.clone());
                        self.io
                            .view
                            .update_component(&component, "updateContent", serde_json::json!([message, true]));
                        self.io.view.request_render(None);
                    }
                    _ => {}
                }
            }
            AgentSessionEvent::MessageUpdate { message, .. } => {
                let streaming = self.lock().streaming_component.clone();
                if let (Some(component), "assistant") =
                    (streaming.as_ref(), message.role())
                {
                    self.lock().streaming_message = Some(message.clone());
                    self.io
                        .view
                        .update_component(component, "updateContent", serde_json::json!([message, true]));

                    let content = assistant_tool_calls(message);
                    for (tool_id, tool_name, tool_args) in content {
                        let existing = self.lock().pending_tools.get(&tool_id).cloned();
                        match existing {
                            None => {
                                let args = serde_json::json!([
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
                                    .new_component(ComponentKind::ToolExecution, args);
                                self.io.view.update_component(
                                    &component,
                                    "setExpanded",
                                    Value::Bool(self.lock().tool_output_expanded),
                                );
                                self.io.view.container_add_component(ContainerId::Chat, &component);
                                self.lock().pending_tools.insert(tool_id, component);
                            }
                            Some(component) => {
                                self.io
                                    .view
                                    .update_component(&component, "updateArgs", tool_args);
                            }
                        }
                    }
                    self.io.view.request_render(None);
                }
            }
            AgentSessionEvent::MessageEnd { message } => {
                if message.role() == "user" {
                    // user messages are rendered on message_start
                } else {
                    let streaming = self.lock().streaming_component.clone();
                    if let (Some(component), "assistant") = (streaming.as_ref(), message.role()) {
                        self.lock().streaming_message = Some(message.clone());
                        let stop_reason = assistant_stop_reason(message);
                        let mut error_message: Option<String> = None;
                        if stop_reason == Some("aborted") {
                            let retry_attempt = self.io.session.retry_attempt();
                            error_message = Some(if retry_attempt > 0 {
                                format!(
                                    "Aborted after {} retry attempt{}",
                                    retry_attempt,
                                    if retry_attempt > 1 { "s" } else { "" }
                                )
                            } else {
                                "Operation aborted".to_string()
                            });
                        }
                        if let (Some(error), Some(streaming_message)) =
                            (error_message.as_ref(), self.lock().streaming_message.as_mut())
                        {
                            assistant_set_error_message(streaming_message, error);
                        }
                        self.io.view.update_component(
                            component,
                            "updateContent",
                            serde_json::json!([message, false]),
                        );

                        if stop_reason == Some("aborted") || stop_reason == Some("error") {
                            let error_text = error_message.unwrap_or_else(|| {
                                assistant_error_message(message)
                                    .unwrap_or_else(|| "Error".to_string())
                            });
                            let pending: Vec<ComponentRef> =
                                self.lock().pending_tools.values().cloned().collect();
                            for pending_component in &pending {
                                self.io.view.update_component(
                                    pending_component,
                                    "updateResult",
                                    serde_json::json!([
                                        { "content": [{ "type": "text", "text": error_text }], "isError": true },
                                        false,
                                    ]),
                                );
                            }
                            self.lock().pending_tools.clear();
                        } else {
                            // Args are now complete — trigger diff computation
                            // for edit tools.
                            let pending: Vec<ComponentRef> =
                                self.lock().pending_tools.values().cloned().collect();
                            for pending_component in &pending {
                                self.io
                                    .view
                                    .update_component(pending_component, "setArgsComplete", Value::Null);
                            }
                            self.maybe_show_thinking_drop_notice(message);
                        }
                        self.lock().streaming_component = None;
                        self.lock().streaming_message = None;
                        self.io.view.footer_invalidate();
                    }
                    self.io.view.request_render(None);
                }
            }
            AgentSessionEvent::BashExecutionUpdate { .. } => {
                // The bash execution callback handles TUI output rendering.
            }
            AgentSessionEvent::ToolExecutionStart {
                tool_call_id,
                tool_name,
                args,
            } => {
                let existing = self.lock().pending_tools.get(tool_call_id).cloned();
                let component = match existing {
                    Some(component) => component,
                    None => {
                        let ctor = serde_json::json!([
                            tool_name,
                            tool_call_id,
                            args,
                            {
                                "showImages": self.io.settings.show_images(),
                                "imageWidthCells": self.io.settings.image_width_cells(),
                            },
                            self.get_registered_tool_definition(tool_name),
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
                        self.lock().pending_tools.insert(tool_call_id.clone(), component.clone());
                        component
                    }
                };
                self.io
                    .view
                    .update_component(&component, "markExecutionStarted", Value::Null);
                self.io.view.request_render(None);
            }
            AgentSessionEvent::ToolExecutionUpdate {
                tool_call_id,
                partial_result,
                ..
            } => {
                if let Some(component) = self.lock().pending_tools.get(tool_call_id).cloned() {
                    self.io.view.update_component(
                        &component,
                        "updateResult",
                        serde_json::json!([partial_result, true]),
                    );
                    self.io.view.request_render(None);
                }
            }
            AgentSessionEvent::ToolExecutionEnd {
                tool_call_id,
                result,
                is_error,
                ..
            } => {
                if let Some(component) = self.lock().pending_tools.get(tool_call_id).cloned() {
                    self.io.view.update_component(
                        &component,
                        "updateResult",
                        serde_json::json!([result, is_error]),
                    );
                    self.lock().pending_tools.remove(tool_call_id);
                    self.io.view.request_render(None);
                }
            }
            AgentSessionEvent::AgentEnd { .. } => {
                if self.io.settings.show_terminal_progress() {
                    self.io.view.terminal_set_progress(false);
                }
                self.clear_status_indicator(Some("working"));
                if let Some(streaming) = self.lock().streaming_component.clone() {
                    self.io.view.container_remove_component(ContainerId::Chat, &streaming);
                    self.lock().streaming_component = None;
                    self.lock().streaming_message = None;
                }
                self.lock().pending_tools.clear();
                self.io.view.request_render(None);
            }
            AgentSessionEvent::AgentSettled => {
                self.check_shutdown_requested().await;
            }
            AgentSessionEvent::CompactionStart { reason } => {
                if self.io.settings.show_terminal_progress() {
                    self.io.view.terminal_set_progress(true);
                }
                // Keep editor active; submissions are queued during compaction.
                self.lock().auto_compaction_escape_handler_active = true;
                self.io.editor.set_on_escape();
                let args = serde_json::json!([reason_str(*reason)]);
                let indicator = self
                    .io
                    .view
                    .new_component(ComponentKind::CompactionStatusIndicator, args);
                self.show_status_indicator(indicator, "compaction");
                self.io.view.request_render(None);
            }
            AgentSessionEvent::CompactionEnd {
                result,
                aborted,
                reason,
                error_message,
                will_retry,
            } => {
                if self.io.settings.show_terminal_progress() {
                    self.io.view.terminal_set_progress(false);
                }
                if self.lock().auto_compaction_escape_handler_active {
                    self.lock().auto_compaction_escape_handler_active = false;
                    self.io.editor.set_on_escape();
                }
                self.clear_status_indicator(Some("compaction"));
                if *aborted {
                    if *reason == CompactionReason::Manual {
                        self.show_error("Compaction cancelled");
                    } else {
                        self.show_status("Auto-compaction cancelled");
                    }
                } else if let Some(result) = result {
                    let entries = self.io.session_manager.build_context_entries();
                    if !matches!(entries.first(), Some(SessionEntry::Compaction(_))) {
                        panic!("Completed compaction is missing from the session context");
                    }
                    self.io.view.container_clear(ContainerId::Chat);
                    // The latest compaction is prepended for model context;
                    // append it below at its chronological position.
                    self.render_session_entries(&entries[1..], false, false);
                    let summary_message = create_summary_custom_message(
                        "compactionSummary",
                        result.get("summary").and_then(Value::as_str).unwrap_or_default(),
                        result.get("tokensBefore").and_then(Value::as_f64).unwrap_or_default(),
                    );
                    self.add_message_to_chat(&summary_message);
                    if let Some(usage) = result.get("usage") {
                        if let Ok(usage) = serde_json::from_value::<Usage>(usage.clone()) {
                            self.add_compaction_cost_notice(&CompactionCostNotice {
                                kind: CompactionCostKind::Compaction,
                                usage,
                            });
                        }
                    }
                    self.io.view.footer_invalidate();
                } else if let Some(error) = error_message {
                    if *reason == CompactionReason::Manual {
                        self.show_error(error);
                    } else {
                        self.io.view.container_add_spacer(ContainerId::Chat);
                        let text = self.theme().fg("error", error).unwrap_or_default();
                        self.io
                            .view
                            .container_add_text(ContainerId::Chat, &text, 1, 0, false);
                    }
                }
                self.flush_compaction_queue(*will_retry).await;
                self.io.view.request_render(None);
            }
            AgentSessionEvent::AutoRetryStart { attempt, max_attempts, delay_ms, .. } => {
                // Set up escape to abort retry.
                self.lock().retry_escape_handler_active = true;
                self.io.editor.set_on_escape();
                let args = serde_json::json!([attempt, max_attempts, delay_ms]);
                let indicator = self
                    .io
                    .view
                    .new_component(ComponentKind::RetryStatusIndicator, args);
                self.show_status_indicator(indicator, "retry");
                self.io.view.request_render(None);
            }
            AgentSessionEvent::AutoRetryEnd { success, attempt, final_error } => {
                // Restore escape handler.
                if self.lock().retry_escape_handler_active {
                    self.io.editor.set_on_escape();
                    self.lock().retry_escape_handler_active = false;
                }
                self.clear_status_indicator(Some("retry"));
                // Show error only on final failure (success shows the normal
                // response).
                if !success {
                    self.show_error(&format!(
                        "Retry failed after {} attempts: {}",
                        attempt,
                        final_error.clone().unwrap_or_else(|| "Unknown error".to_string())
                    ));
                }
                self.io.view.request_render(None);
            }
            AgentSessionEvent::SummarizationRetryScheduled { attempt, max_attempts, delay_ms, error_message } => {
                self.show_error(error_message);
                let args = serde_json::json!([attempt, max_attempts, delay_ms]);
                let indicator = self
                    .io
                    .view
                    .new_component(ComponentKind::RetryStatusIndicator, args);
                self.show_status_indicator(indicator, "retry");
                self.io.view.request_render(None);
            }
            AgentSessionEvent::SummarizationRetryAttemptStart { source } => {
                self.clear_status_indicator(Some("retry"));
                let (kind, args) = match source {
                    SummarizationRetrySource::BranchSummary => (
                        ComponentKind::BranchSummaryStatusIndicator,
                        serde_json::json!([]),
                    ),
                    SummarizationRetrySource::Compaction => (
                        ComponentKind::CompactionStatusIndicator,
                        serde_json::json!(["threshold"]),
                    ),
                };
                let indicator = self.io.view.new_component(kind, args);
                let kind_str = match source {
                    SummarizationRetrySource::BranchSummary => "branchSummary",
                    SummarizationRetrySource::Compaction => "compaction",
                };
                self.show_status_indicator(indicator, kind_str);
                self.io.view.request_render(None);
            }
            AgentSessionEvent::SummarizationRetryFinished => {
                self.clear_status_indicator(Some("retry"));
                self.io.view.request_render(None);
            }
            AgentSessionEvent::Preserved(_) => {
                // Lossless ingress events do not drive the interactive shell.
            }
        }
    }
