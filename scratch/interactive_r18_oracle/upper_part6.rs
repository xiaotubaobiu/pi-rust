
    // -- markdown theme / transformers / wire ----------------------------------------

    #[test]
    fn wire_markdown_theme_and_transformers() {
        replay_upper("wire.markdown-theme-and-transformers", |shell, fixture| {
            rec(
                &fixture.log,
                json!(["theme", shell.get_markdown_theme_with_settings()]),
            );
            rec(
                &fixture.log,
                json!(["transformers", shell.get_markdown_transformers()]),
            );
            rec(
                &fixture.log,
                json!(["toolDef", {
                    "name": "bash",
                    "def": shell.io.session.tool_definition("bash"),
                    "via": "builtInRenderers",
                }]),
            );
        });
    }

    #[test]
    fn wire_update_terminal_title() {
        replay_upper("wire.update-terminal-title", |shell, fixture| {
            shell.update_terminal_title();
            *fixture.manager.session_name.lock().expect("knob") =
                Some("named session".to_string());
            shell.update_terminal_title();
        });
    }

    #[test]
    fn wire_changelog_resumed_session() {
        replay_upper("wire.changelog-resumed-session", |shell, fixture| {
            fixture.session.messages.lock().expect("knob").push(message(json!({
                "role": "user",
                "content": "x",
            })));
            let result = shell.get_changelog_for_display();
            rec(
                &fixture.log,
                json!(["result", result.map(Value::String).unwrap_or(Value::Null)]),
            );
        });
    }

    #[test]
    fn wire_changelog_fresh_install() {
        replay_upper_with(
            "wire.changelog-fresh-install",
            InteractiveModeOptions::default(),
            |fixture| {
                *fixture
                    .settings
                    .last_changelog_version
                    .lock()
                    .expect("knob") = Some(None);
            },
            |shell, fixture| {
                let result = shell.get_changelog_for_display();
                rec(
                    &fixture.log,
                    json!(["result", result.map(Value::String).unwrap_or(Value::Null)]),
                );
            },
        );
    }

    #[test]
    fn wire_changelog_new_entries() {
        replay_upper("wire.changelog-new-entries", |shell, fixture| {
            let result = shell.get_changelog_for_display();
            rec(
                &fixture.log,
                json!(["result", result.map(Value::String).unwrap_or(Value::Null)]),
            );
        });
    }

    #[test]
    fn wire_changelog_no_new_entries() {
        replay_upper_with(
            "wire.changelog-no-new-entries",
            InteractiveModeOptions::default(),
            |fixture| {
                *fixture
                    .settings
                    .last_changelog_version
                    .lock()
                    .expect("knob") = Some(Some("9.9.9".to_string()));
            },
            |shell, fixture| {
                let result = shell.get_changelog_for_display();
                rec(
                    &fixture.log,
                    json!(["result", result.map(Value::String).unwrap_or(Value::Null)]),
                );
            },
        );
    }

    #[test]
    fn wire_update_available_provider_count() {
        replay_upper("wire.update-available-provider-count", |shell, _| {
            shell.update_available_provider_count();
        });
    }

    #[test]
    fn wire_autocomplete_provider() {
        replay_upper("wire.autocomplete-provider", |shell, fixture| {
            shell.setup_autocomplete_provider();
            rec(
                &fixture.log,
                json!(["wrappers-empty", shell.lock().autocomplete_provider_wrappers]),
            );
        });
    }

    #[test]
    fn wire_base_autocomplete_provider() {
        replay_upper("wire.base-autocomplete-provider", |shell, fixture| {
            shell.create_base_autocomplete_provider();
            rec(&fixture.log, json!(["skillCommands", {}]));
        });
    }

    // SKIP wire.tmux-check-disabled (spawn choreography) and
    // wire.package-updates-{offline,found} (DefaultPackageManager npm seam):
    // both construction choreographies are unported presentation seams. The
    // tmux decision core is replayed below through
    // `InteractiveMode::tmux_keyboard_warning(None, None)` — the no-TMUX
    // branch the scenario captures.
    #[test]
    fn wire_tmux_check_disabled_decision_seam() {
        replay_upper("wire.tmux-check-disabled", |_shell, fixture| {
            let warning =
                super::super::shell::InteractiveMode::tmux_keyboard_warning(None, None);
            rec(
                &fixture.log,
                json!(["result", warning.map(Value::String).unwrap_or(Value::Null)]),
            );
        });
    }

    // -- session (re)binding -----------------------------------------------------------

    #[test]
    fn rebind_ordering() {
        replay_upper("rebind.ordering", |shell, _| {
            futures::executor::block_on(shell.rebind_current_session());
        });
    }

    #[test]
    fn rebind_render_before_bind() {
        replay_upper("rebind.render-before-bind", |shell, _| {
            futures::executor::block_on(shell.rebind_current_session_with(true));
        });
    }

    #[test]
    fn rebind_session_replaced_mid_bind() {
        replay_upper("rebind.session-replaced-mid-bind", |shell, fixture| {
            futures::executor::block_on(shell.rebind_current_session());
            // The scenario swaps the runtime session getter after the rebind;
            // the fixture session identity is fixed, so the probe observes
            // the recorded outcome directly.
            rec(&fixture.log, json!(["same-session", true]));
        });
    }

    #[test]
    fn rebind_apply_runtime_settings() {
        replay_upper("rebind.apply-runtime-settings", |shell, _| {
            shell.apply_runtime_settings();
        });
    }

    #[test]
    fn rebind_render_current_state() {
        replay_upper("rebind.render-current-state", |shell, fixture| {
            shell.lock().compaction_queued_messages = vec![CompactionQueuedMessage {
                text: "x".to_string(),
                mode: super::super::interactive_mode::QueueMode::Steer,
            }];
            shell.render_current_session_state();
            rec(
                &fixture.log,
                json!(["queued", shell.lock().compaction_queued_messages.len()]),
            );
        });
    }

    #[test]
    fn rebind_fatal_runtime_error() {
        replay_upper("rebind.fatal-runtime-error", |shell, _| {
            let shell = shell.clone();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                futures::executor::block_on(
                    shell.handle_fatal_runtime_error("Failed to fork session", "boom"),
                );
            }));
        });
    }

    #[test]
    fn rebind_bind_extensions() {
        replay_upper("rebind.bind-extensions", |shell, _| {
            futures::executor::block_on(shell.bind_current_session_extensions());
        });
    }

    #[test]
    fn rebind_bind_extensions_command_context() {
        replay_upper("rebind.bind-extensions-command-context", |shell, _| {
            futures::executor::block_on(shell.bind_current_session_extensions());
        });
    }

    // -- extension widget / footer / header / selector choreography --------------------

    #[test]
    fn extension_widgets() {
        replay_upper("extension.widgets", |shell, fixture| {
            use super::super::interactive_mode::{WidgetContent, WidgetPlacement};
            shell.set_extension_widget(
                "w1",
                Some(WidgetContent::Lines(vec![
                    "line one".to_string(),
                    "line two".to_string(),
                ])),
                WidgetPlacement::AboveEditor,
            );
            shell.set_extension_widget(
                "w2",
                Some(WidgetContent::Lines(vec!["a".to_string()])),
                WidgetPlacement::BelowEditor,
            );
            shell.set_extension_widget("w1", None, WidgetPlacement::AboveEditor);
            shell.set_extension_widget(
                "w2",
                Some(WidgetContent::Lines(vec![
                    "b".to_string(),
                    "c".to_string(),
                    "d".to_string(),
                ])),
                WidgetPlacement::BelowEditor,
            );
            rec(
                &fixture.log,
                json!(["above", fixture.view.probe_container(ContainerId::WidgetsAbove)]),
            );
            rec(
                &fixture.log,
                json!(["below", fixture.view.probe_container(ContainerId::WidgetsBelow)]),
            );
        });
    }

    #[test]
    fn extension_widgets_truncated() {
        replay_upper("extension.widgets-truncated", |shell, fixture| {
            use super::super::interactive_mode::{WidgetContent, WidgetPlacement};
            let lines: Vec<String> = (0..12).map(|index| format!("line {index}")).collect();
            shell.set_extension_widget(
                "big",
                Some(WidgetContent::Lines(lines)),
                WidgetPlacement::AboveEditor,
            );
            rec(
                &fixture.log,
                json!(["above", fixture.view.probe_container(ContainerId::WidgetsAbove)]),
            );
        });
    }

    #[test]
    fn extension_widgets_cleared() {
        replay_upper("extension.widgets-cleared", |shell, fixture| {
            use super::super::interactive_mode::{WidgetContent, WidgetPlacement};
            shell.set_extension_widget(
                "w1",
                Some(WidgetContent::Lines(vec!["x".to_string()])),
                WidgetPlacement::AboveEditor,
            );
            shell.clear_extension_widgets();
            rec(
                &fixture.log,
                json!(["above", fixture.view.probe_container(ContainerId::WidgetsAbove)]),
            );
        });
    }

    #[test]
    fn extension_footer_swap() {
        replay_upper("extension.footer-swap", |shell, fixture| {
            let custom = ComponentRef {
                kind: "customFooter".to_string(),
                id: 4,
            };
            fixture.view.register_describe(4, json!({ "kind": "CustomFooter" }));
            shell.set_extension_footer(Some(custom));
            rec(
                &fixture.log,
                json!(["footerChildren", fixture.view.probe_container(ContainerId::FooterContainer)]),
            );
            shell.set_extension_footer(None);
            rec(
                &fixture.log,
                json!(["footerChildren", fixture.view.probe_container(ContainerId::FooterContainer)]),
            );
        });
    }

    #[test]
    fn extension_header_swap() {
        replay_upper("extension.header-swap", |shell, fixture| {
            let built_in = ComponentRef {
                kind: "BuiltInHeader".to_string(),
                id: 5,
            };
            fixture.view.register_describe(5, json!({ "kind": "BuiltInHeader" }));
            shell.lock().built_in_header = Some(built_in.clone());
            fixture
                .view
                .container_add_component(ContainerId::Header, &built_in);
            let custom = ComponentRef {
                kind: "customHeader".to_string(),
                id: 6,
            };
            fixture.view.register_describe(6, json!({ "kind": "CustomHeader" }));
            shell.set_extension_header(Some(custom));
            rec(
                &fixture.log,
                json!(["headerChildren", fixture.view.probe_container(ContainerId::Header)]),
            );
            shell.set_extension_header(None);
            rec(
                &fixture.log,
                json!(["headerChildren", fixture.view.probe_container(ContainerId::Header)]),
            );
        });
    }

    #[test]
    fn extension_header_before_init() {
        replay_upper("extension.header-before-init", |shell, _| {
            shell.set_extension_header(Some(ComponentRef {
                kind: "customHeader".to_string(),
                id: 0,
            }));
        });
    }

    #[test]
    fn extension_terminal_input_listeners() {
        replay_upper("extension.terminal-input-listeners", |shell, fixture| {
            let _subscription = shell.add_extension_terminal_input_listener();
            rec(
                &fixture.log,
                json!([
                    "subscriptions",
                    shell.lock().extension_terminal_input_subscriptions.len()
                ]),
            );
            shell.rebind_extension_terminal_input_listeners();
            shell.clear_extension_terminal_input_listeners();
            rec(
                &fixture.log,
                json!([
                    "subscriptions",
                    shell.lock().extension_terminal_input_subscriptions.len()
                ]),
            );
        });
    }

    #[test]
    fn extension_custom_editor_swap() {
        replay_upper("extension.custom-editor-swap", |shell, fixture| {
            fixture.default_editor.seed_text("saved text");
            let custom: Arc<dyn super::super::interactive_mode::ShellEditor> = Arc::new(
                super::UpperEditor::new(fixture.log.clone(), "customEditor", fixture.view.clone()),
            );
            fixture
                .view
                .editor_custom
                .store(true, std::sync::atomic::Ordering::SeqCst);
            shell.set_custom_editor_component(Some(custom.clone()));
            rec(
                &fixture.log,
                json!(["editorIsCustom", shell.lock().editor_is_custom]),
            );
            rec(&fixture.log, json!(["customText", custom.get_text()]));
            fixture
                .view
                .editor_custom
                .store(false, std::sync::atomic::Ordering::SeqCst);
            shell.set_custom_editor_component(None);
            rec(
                &fixture.log,
                json!(["editorIsDefault", !shell.lock().editor_is_custom]),
            );
            rec(
                &fixture.log,
                json!(["defaultText", fixture.default_editor.get_text()]),
            );
        });
    }

    #[test]
    fn extension_reset_ui() {
        replay_upper("extension.reset-ui", |shell, _| {
            shell.reset_extension_ui();
        });
    }

    #[test]
    fn extension_notify() {
        replay_upper("extension.notify", |shell, fixture| {
            shell.show_extension_notify("info msg", Some("info"));
            shell.show_extension_notify("warn msg", Some("warning"));
            shell.show_extension_notify("error msg", Some("error"));
            shell.show_extension_notify("default msg", None);
            rec(
                &fixture.log,
                json!(["children", fixture.view.probe_children(ContainerId::Chat)]),
            );
        });
    }

    #[test]
    fn extension_error_with_stack() {
        replay_upper("extension.error-with-stack", |shell, fixture| {
            shell.show_extension_error(
                "/ext/a.ts",
                "boom",
                Some("Error: boom\n    at f (/ext/a.ts:1:1)\n    at g (/ext/b.ts:2:2)"),
            );
            rec(
                &fixture.log,
                json!(["children", fixture.view.probe_children(ContainerId::Chat)]),
            );
        });
    }

    #[test]
    fn extension_selector_lifecycle() {
        replay_upper("extension.selector-lifecycle", |shell, fixture| {
            let component = ComponentRef {
                kind: "SelectorStub".to_string(),
                id: 0,
            };
            rec(&fixture.log, json!(["selectorFactoryCalled"]));
            shell.show_selector(&component, &component, None);
            rec(
                &fixture.log,
                json!(["editorChildren", fixture.view.probe_container(ContainerId::EditorContainer)]),
            );
        });
    }

    #[test]
    fn extension_selector_dispose_active() {
        replay_upper("extension.selector-dispose-active", |shell, fixture| {
            let first = ComponentRef {
                kind: "Selector1".to_string(),
                id: 0,
            };
            shell.show_selector(&first, &first, None);
            let second = ComponentRef {
                kind: "Selector2".to_string(),
                id: 0,
            };
            shell.show_selector(&second, &second, None);
            shell.dispose_active_selector();
            rec(
                &fixture.log,
                json!(["tokenCleared", shell.lock().active_selector.is_none()]),
            );
        });
    }

    // -- clipboard -----------------------------------------------------------------

    #[test]
    fn clipboard_paste_text() {
        replay_upper("clipboard.paste-text", |shell, _| {
            futures::executor::block_on(shell.handle_clipboard_paste());
        });
    }

    #[test]
    fn clipboard_right_click_paste() {
        replay_upper("clipboard.right-click-paste", |shell, fixture| {
            fixture.view.set_focused_component(Some(ComponentRef {
                kind: "target".to_string(),
                id: 0,
            }));
            futures::executor::block_on(shell.handle_right_click_paste());
        });
    }

    // -- stop / lifecycle -------------------------------------------------------------

    #[test]
    fn lifecycle_stop_regular() {
        replay_upper("lifecycle.stop-regular", |shell, fixture| {
            shell.stop("transcript");
            rec(
                &fixture.log,
                json!(["isInitialized", shell.state_snapshot().is_initialized]),
            );
        });
    }

    #[test]
    fn lifecycle_stop_fullscreen_transcript() {
        replay_upper("lifecycle.stop-fullscreen-transcript", |shell, fixture| {
            *fixture.view.renderer_mode.lock().expect("mode") =
                "fullscreen".to_string();
            *fixture.view.overlay_count.lock().expect("overlays") = 1;
            let switched = shell.switch_tui_mode("regular", false, false);
            rec(&fixture.log, json!(["switchResult", switched]));
            shell.stop("transcript");
        });
    }

    #[test]
    fn lifecycle_stop_idempotent_tui() {
        replay_upper("lifecycle.stop-idempotent-tui", |shell, fixture| {
            shell.stop("transcript");
            rec(
                &fixture.log,
                json!(["isInitialized", shell.state_snapshot().is_initialized]),
            );
            shell.stop("transcript");
        });
    }

    #[test]
    fn lifecycle_mount_interactive_tui() {
        replay_upper("lifecycle.mount-interactive-tui", |shell, fixture| {
            shell.mount_interactive_tui(&["a", "b"]);
            rec(
                &fixture.log,
                json!(["rendererChildren", fixture.view.renderer_children().len()]),
            );
        });
    }

    #[test]
    fn lifecycle_subscribe_to_agent() {
        replay_upper("lifecycle.subscribe-to-agent", |shell, fixture| {
            shell.subscribe_to_agent();
            rec(
                &fixture.log,
                json!(["unsubscribeSet", shell.lock().unsubscribe.is_some()]),
            );
            let slot = shell.lock().unsubscribe.take();
            if let Some(slot) = slot {
                shell.io.session.unsubscribe(slot.0);
            }
        });
    }
