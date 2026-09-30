
    use super::interactive_mode::{CompactionCostKind, CompactionCostNotice, QueueSnapshot};

    fn queue_snapshot_value(snapshot: &QueueSnapshot) -> Value {
        json!({
            "steering": snapshot.steering,
            "followUp": snapshot.follow_up,
        })
    }

    fn compaction_queue_value(
        messages: &[CompactionQueuedMessage],
    ) -> Value {
        Value::Array(
            messages
                .iter()
                .map(|message| {
                    json!({
                        "text": message.text,
                        "mode": message.mode.as_str(),
                    })
                })
                .collect(),
        )
    }

    /// Parses a message from the scenario's JSON literal.
    fn message(value: Value) -> AgentMessage {
        serde_json::from_value(value).expect("scenario message parses")
    }

    /// The harness `WorkingStatusIndicator`-style model for drive-seeded
    /// indicator describes.
    fn indicator_describe(kind: &str, methods: &[&str]) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("kind".to_string(), json!(kind));
        for method in methods {
            map.insert(method.to_string(), json!("function"));
        }
        Value::Object(map)
    }

    // -- submit ladder -------------------------------------------------------

    #[test]
    fn submit_empty() {
        replay_upper("submit.empty", |shell, _| {
            futures::executor::block_on(shell.submit("   "));
        });
    }

    #[test]
    fn submit_settings() {
        replay_upper("submit.settings", |shell, _| {
            futures::executor::block_on(shell.submit("/settings"));
        });
    }

    #[test]
    fn submit_model_arg() {
        replay_upper("submit.model.arg", |shell, _| {
            futures::executor::block_on(shell.submit("/model gpt-5"));
        });
    }

    #[test]
    fn submit_model_bare() {
        replay_upper("submit.model.bare", |shell, _| {
            futures::executor::block_on(shell.submit("/model"));
        });
    }

    #[test]
    fn submit_thinking_arg() {
        replay_upper("submit.thinking.arg", |shell, _| {
            futures::executor::block_on(shell.submit("/thinking high"));
        });
    }

    #[test]
    fn submit_bash_normal() {
        replay_upper("submit.bash.normal", |shell, _| {
            futures::executor::block_on(shell.submit("!ls -la"));
        });
    }

    #[test]
    fn submit_bash_excluded() {
        replay_upper("submit.bash.excluded", |shell, _| {
            futures::executor::block_on(shell.submit("!!rm -rf /tmp/x"));
        });
    }

    #[test]
    fn submit_bash_bang_only_falls_through() {
        replay_upper("submit.bash.bang-only-falls-through", |shell, _| {
            futures::executor::block_on(shell.submit("!"));
        });
    }

    #[test]
    fn submit_bash_conflict() {
        replay_upper("submit.bash.conflict", |shell, fixture| {
            fixture
                .session
                .bash_running
                .store(true, std::sync::atomic::Ordering::SeqCst);
            futures::executor::block_on(shell.submit("!echo hi"));
        });
    }

    #[test]
    fn submit_normal_idle() {
        replay_upper("submit.normal.idle", |shell, _| {
            futures::executor::block_on(shell.submit("hello world"));
        });
    }

    #[test]
    fn submit_normal_idle_no_callback_queues() {
        replay_upper("submit.normal.idle.no-callback-queues", |shell, _| {
            futures::executor::block_on(shell.submit("queued for later"));
        });
    }

    #[test]
    fn submit_streaming_steer() {
        replay_upper("submit.streaming.steer", |shell, fixture| {
            fixture
                .session
                .streaming
                .store(true, std::sync::atomic::Ordering::SeqCst);
            futures::executor::block_on(shell.submit("mid-stream input"));
        });
    }

    #[test]
    fn submit_compacting_queues() {
        replay_upper("submit.compacting.queues", |shell, fixture| {
            fixture
                .session
                .compacting
                .store(true, std::sync::atomic::Ordering::SeqCst);
            futures::executor::block_on(shell.submit("hold this"));
        });
    }

    #[test]
    fn submit_compacting_extension_command() {
        replay_upper("submit.compacting.extension-command", |shell, fixture| {
            fixture
                .session
                .compacting
                .store(true, std::sync::atomic::Ordering::SeqCst);
            futures::executor::block_on(shell.submit("/extcmd run"));
        });
    }

    #[test]
    fn submit_command_tail_not_recognized() {
        replay_upper("submit.command.tail-not-recognized", |shell, _| {
            futures::executor::block_on(shell.submit("/settingsfoo"));
        });
    }

    #[test]
    fn submit_share() {
        replay_upper("submit.share", |shell, _| {
            futures::executor::block_on(shell.submit("/share"));
        });
    }

    #[test]
    fn submit_name_arg() {
        replay_upper("submit.name.arg", |shell, _| {
            futures::executor::block_on(shell.submit("/name my session"));
        });
    }

    #[test]
    fn submit_bash_clears_bash_mode() {
        replay_upper("submit.bash.clears-bash-mode", |shell, fixture| {
            // The scenario drives `defaultEditor.onChange("!ls")`, whose body
            // toggles bash mode before the submit.
            shell.lock().is_bash_mode = true;
            futures::executor::block_on(shell.submit("!ls"));
            rec(
                &fixture.log,
                json!(["final.isBashMode", shell.state_snapshot().is_bash_mode]),
            );
        });
    }

    // -- escape ring -----------------------------------------------------------

    #[test]
    fn escape_streaming() {
        replay_upper("escape.streaming", |shell, fixture| {
            shell.setup_key_handlers();
            fixture
                .session
                .streaming
                .store(true, std::sync::atomic::Ordering::SeqCst);
            futures::executor::block_on(shell.on_escape_pressed());
        });
    }

    #[test]
    fn escape_bash_running() {
        replay_upper("escape.bash-running", |shell, fixture| {
            shell.setup_key_handlers();
            fixture
                .session
                .bash_running
                .store(true, std::sync::atomic::Ordering::SeqCst);
            futures::executor::block_on(shell.on_escape_pressed());
        });
    }

    #[test]
    fn escape_bash_mode() {
        replay_upper("escape.bash-mode", |shell, fixture| {
            shell.setup_key_handlers();
            shell.lock().is_bash_mode = true;
            futures::executor::block_on(shell.on_escape_pressed());
            rec(
                &fixture.log,
                json!(["final.isBashMode", shell.state_snapshot().is_bash_mode]),
            );
        });
    }

    #[test]
    fn escape_empty_once() {
        replay_upper("escape.empty.once", |shell, _| {
            shell.setup_key_handlers();
            futures::executor::block_on(shell.on_escape_pressed());
        });
    }

    #[test]
    fn escape_empty_double_fork() {
        replay_upper("escape.empty.double-fork", |shell, _| {
            shell.setup_key_handlers();
            futures::executor::block_on(shell.on_escape_pressed());
            futures::executor::block_on(shell.on_escape_pressed());
        });
    }

    #[test]
    fn escape_empty_double_tree() {
        replay_upper_with(
            "escape.empty.double-tree",
            InteractiveModeOptions::default(),
            |fixture| {
                *fixture
                    .settings
                    .double_escape_action
                    .lock()
                    .expect("knob") = Some("tree".to_string());
            },
            |shell, _| {
                shell.setup_key_handlers();
                futures::executor::block_on(shell.on_escape_pressed());
                futures::executor::block_on(shell.on_escape_pressed());
            },
        );
    }

    #[test]
    fn escape_empty_double_none() {
        replay_upper_with(
            "escape.empty.double-none",
            InteractiveModeOptions::default(),
            |fixture| {
                *fixture
                    .settings
                    .double_escape_action
                    .lock()
                    .expect("knob") = Some("none".to_string());
            },
            |shell, _| {
                shell.setup_key_handlers();
                futures::executor::block_on(shell.on_escape_pressed());
                futures::executor::block_on(shell.on_escape_pressed());
            },
        );
    }

    #[test]
    fn escape_nonempty_idle() {
        replay_upper("escape.nonempty.idle", |shell, fixture| {
            shell.setup_key_handlers();
            fixture.default_editor.seed_text("draft");
            futures::executor::block_on(shell.on_escape_pressed());
        });
    }

    #[test]
    fn keyring_action_table() {
        replay_upper("keyring.action-table", |shell, fixture| {
            shell.setup_key_handlers();
            let mut actions: Vec<&str> =
                super::super::interactive_mode::INPUT_RING_ACTIONS.to_vec();
            actions.sort_unstable();
            rec(
                &fixture.log,
                json!(["actionHandlerNames", actions]),
            );
        });
    }

    // -- ctrl-c / ctrl-d / startup / ctrl-z / shutdown / signals ---------------

    #[test]
    fn ctrlc_first_clears() {
        replay_upper("ctrlc.first-clears", |shell, fixture| {
            fixture.default_editor.seed_text("draft");
            futures::executor::block_on(shell.handle_ctrl_c());
            rec(
                &fixture.log,
                json!([
                    "final.lastSigintTimeSet",
                    shell.state_snapshot().last_sigint_time > 0
                ]),
            );
        });
    }

    #[test]
    fn ctrlc_double_shuts_down() {
        replay_upper("ctrlc.double-shuts-down", |shell, fixture| {
            fixture.platform.stdout_is_tty.store(true, std::sync::atomic::Ordering::SeqCst);
            fixture.clock.set(1000);
            futures::executor::block_on(shell.handle_ctrl_c());
            fixture.clock.set(1200);
            futures::executor::block_on(shell.handle_ctrl_c());
        });
    }

    #[test]
    fn ctrlc_second_late_clears() {
        replay_upper("ctrlc.second-late-clears", |shell, fixture| {
            fixture.clock.set(1000);
            futures::executor::block_on(shell.handle_ctrl_c());
            fixture.clock.set(2000);
            futures::executor::block_on(shell.handle_ctrl_c());
        });
    }

    #[test]
    fn ctrld_shuts_down() {
        replay_upper("ctrld.shuts-down", |shell, fixture| {
            fixture.platform.stdout_is_tty.store(true, std::sync::atomic::Ordering::SeqCst);
            futures::executor::block_on(shell.handle_ctrl_d());
        });
    }

    #[test]
    fn startup_submit() {
        replay_upper("startup-submit", |shell, _| {
            shell.handle_startup_submit("early input");
        });
    }

    #[test]
    fn ctrlz_win32() {
        replay_upper("ctrlz.win32", |shell, fixture| {
            fixture
                .platform
                .is_windows
                .store(true, std::sync::atomic::Ordering::SeqCst);
            shell.handle_ctrl_z();
        });
    }

    #[test]
    fn shutdown_graceful() {
        replay_upper("shutdown.graceful", |shell, fixture| {
            fixture.platform.stdout_is_tty.store(true, std::sync::atomic::Ordering::SeqCst);
            futures::executor::block_on(shell.shutdown(false));
        });
    }

    #[test]
    fn shutdown_from_signal() {
        replay_upper("shutdown.from-signal", |shell, fixture| {
            fixture.platform.stdout_is_tty.store(true, std::sync::atomic::Ordering::SeqCst);
            futures::executor::block_on(shell.shutdown(true));
        });
    }

    #[test]
    fn shutdown_resumed_session_no_command() {
        replay_upper("shutdown.resumed-session-no-command", |shell, fixture| {
            fixture
                .manager
                .persisted
                .store(false, std::sync::atomic::Ordering::SeqCst);
            fixture.platform.stdout_is_tty.store(true, std::sync::atomic::Ordering::SeqCst);
            futures::executor::block_on(shell.shutdown(false));
        });
    }

    #[test]
    fn signals_register_and_unregister() {
        replay_upper("signals.register-and-unregister", |shell, _| {
            shell.register_signal_handlers();
            shell.unregister_signal_handlers();
        });
    }

    #[test]
    fn signals_dead_terminal_error_codes() {
        replay_upper("signals.dead-terminal-error-codes", |shell, fixture| {
            let code = super::super::interactive_mode::is_dead_terminal_error_code;
            rec(
                &fixture.log,
                json!([
                    "deadTerminal",
                    code(Some("EPIPE")),
                    code(Some("EIO")),
                    code(Some("ENOTCONN")),
                    code(Some("ENOENT")),
                    code(None),
                    code(Some("x")),
                    code(Some("")),
                ]),
            );
        });
    }

    #[test]
    fn check_shutdown_requested_idle() {
        replay_upper("check-shutdown-requested.idle", |shell, fixture| {
            futures::executor::block_on(shell.check_shutdown_requested());
            shell.lock().shutdown_requested = true;
            fixture.platform.stdout_is_tty.store(true, std::sync::atomic::Ordering::SeqCst);
            futures::executor::block_on(shell.check_shutdown_requested());
        });
    }

    // -- queues ------------------------------------------------------------------

    #[test]
    fn queue_get_combines() {
        replay_upper("queue.get-combines", |shell, fixture| {
            *fixture.session.steering.lock().expect("bag") =
                vec!["s1".to_string(), "s2".to_string()];
            *fixture.session.follow_up.lock().expect("bag") = vec!["f1".to_string()];
            shell.lock().compaction_queued_messages = vec![
                CompactionQueuedMessage {
                    text: "cs1".to_string(),
                    mode: super::super::interactive_mode::QueueMode::Steer,
                },
                CompactionQueuedMessage {
                    text: "cf1".to_string(),
                    mode: super::super::interactive_mode::QueueMode::FollowUp,
                },
            ];
            let result = shell.get_all_queued_messages();
            rec(
                &fixture.log,
                json!(["result", queue_snapshot_value(&result)]),
            );
        });
    }

    #[test]
    fn queue_clear_all() {
        replay_upper("queue.clear-all", |shell, fixture| {
            *fixture.session.steering.lock().expect("bag") = vec!["s1".to_string()];
            *fixture.session.follow_up.lock().expect("bag") =
                vec!["f1".to_string(), "f2".to_string()];
            shell.lock().compaction_queued_messages = vec![CompactionQueuedMessage {
                text: "cs1".to_string(),
                mode: super::super::interactive_mode::QueueMode::Steer,
            }];
            let result = shell.clear_all_queues();
            rec(
                &fixture.log,
                json!(["result", queue_snapshot_value(&result)]),
            );
            rec(
                &fixture.log,
                json!(["remaining", shell.lock().compaction_queued_messages.len()]),
            );
        });
    }

    #[test]
    fn queue_restore_to_editor() {
        replay_upper("queue.restore-to-editor", |shell, fixture| {
            *fixture.session.steering.lock().expect("bag") = vec!["s1".to_string()];
            *fixture.session.follow_up.lock().expect("bag") = vec!["f1".to_string()];
            shell.lock().compaction_queued_messages = vec![CompactionQueuedMessage {
                text: "cs1".to_string(),
                mode: super::super::interactive_mode::QueueMode::Steer,
            }];
            fixture.default_editor.seed_text("current draft");
            let count = shell.restore_queued_messages_to_editor(false, None);
            rec(&fixture.log, json!(["count", count]));
            rec(
                &fixture.log,
                json!(["editorText", fixture.default_editor.get_text()]),
            );
        });
    }

    #[test]
    fn queue_restore_empty_abort() {
        replay_upper("queue.restore-empty-abort", |shell, _| {
            let count = shell.restore_queued_messages_to_editor(true, None);
            rec(&fixture.log, json!(["count", count]));
        });
    }

    #[test]
    fn queue_restore_abort_with_queue() {
        replay_upper("queue.restore-abort-with-queue", |shell, fixture| {
            *fixture.session.steering.lock().expect("bag") = vec!["s1".to_string()];
            let count = shell.restore_queued_messages_to_editor(true, None);
            rec(&fixture.log, json!(["count", count]));
        });
    }

    #[test]
    fn queue_restore_skips_empty_current() {
        replay_upper("queue.restore-skips-empty-current", |shell, fixture| {
            *fixture.session.steering.lock().expect("bag") = vec!["s1".to_string()];
            fixture.default_editor.seed_text("   ");
            let count = shell.restore_queued_messages_to_editor(false, None);
            rec(&fixture.log, json!(["count", count]));
            rec(
                &fixture.log,
                json!(["editorText", fixture.default_editor.get_text()]),
            );
        });
    }

    #[test]
    fn queue_dequeue_empty() {
        replay_upper("queue.dequeue-empty", |shell, _| {
            shell.handle_dequeue();
        });
    }

    #[test]
    fn queue_dequeue_restores() {
        replay_upper("queue.dequeue-restores", |shell, fixture| {
            *fixture.session.steering.lock().expect("bag") =
                vec!["s1".to_string(), "s2".to_string()];
            *fixture.session.follow_up.lock().expect("bag") = vec!["f1".to_string()];
            shell.handle_dequeue();
            rec(
                &fixture.log,
                json!(["editorText", fixture.default_editor.get_text()]),
            );
        });
    }

    #[test]
    fn queue_compaction_message() {
        replay_upper("queue.compaction-message", |shell, fixture| {
            shell.queue_compaction_message("queued text", super::super::interactive_mode::QueueMode::Steer);
            let queued = shell.lock().compaction_queued_messages.clone();
            rec(
                &fixture.log,
                json!(["queued", compaction_queue_value(&queued)]),
            );
            rec(
                &fixture.log,
                json!(["editorText", fixture.default_editor.get_text()]),
            );
        });
    }

    #[test]
    fn queue_follow_up_streaming() {
        replay_upper("queue.follow-up.streaming", |shell, fixture| {
            fixture
                .session
                .streaming
                .store(true, std::sync::atomic::Ordering::SeqCst);
            fixture.default_editor.seed_text("follow up please");
            futures::executor::block_on(shell.handle_follow_up());
        });
    }

    #[test]
    fn queue_follow_up_streaming_extension_command() {
        replay_upper("queue.follow-up.streaming-extension-command", |shell, fixture| {
            fixture
                .session
                .streaming
                .store(true, std::sync::atomic::Ordering::SeqCst);
            fixture.default_editor.seed_text("/extcmd do");
            futures::executor::block_on(shell.handle_follow_up());
        });
    }

    #[test]
    fn queue_follow_up_compacting() {
        replay_upper("queue.follow-up.compacting", |shell, fixture| {
            fixture
                .session
                .compacting
                .store(true, std::sync::atomic::Ordering::SeqCst);
            fixture.default_editor.seed_text("wait for me");
            futures::executor::block_on(shell.handle_follow_up());
        });
    }

    #[test]
    fn queue_follow_up_compacting_extension_command() {
        replay_upper("queue.follow-up.compacting-extension-command", |shell, fixture| {
            fixture
                .session
                .compacting
                .store(true, std::sync::atomic::Ordering::SeqCst);
            fixture.default_editor.seed_text("/extcmd do");
            futures::executor::block_on(shell.handle_follow_up());
        });
    }

    #[test]
    fn queue_follow_up_idle_acts_as_submit() {
        replay_upper("queue.follow-up.idle-acts-as-submit", |shell, fixture| {
            fixture.default_editor.seed_text("idle follow");
            futures::executor::block_on(shell.handle_follow_up());
        });
    }

    #[test]
    fn queue_follow_up_empty() {
        replay_upper("queue.follow-up.empty", |shell, _| {
            futures::executor::block_on(shell.handle_follow_up());
        });
    }

    #[test]
    fn queue_is_extension_command() {
        replay_upper("queue.is-extension-command", |shell, fixture| {
            let results = [
                shell.is_extension_command("/extcmd a"),
                shell.is_extension_command("/unknown"),
                shell.is_extension_command("plain"),
                shell.is_extension_command("/"),
            ];
            rec(&fixture.log, json!(["results", results[0], results[1], results[2], results[3]]));
        });
    }

    #[test]
    fn queue_flush_will_retry() {
        replay_upper("queue.flush.will-retry", |shell, _| {
            shell.lock().compaction_queued_messages = vec![
                CompactionQueuedMessage {
                    text: "/extcmd prep".to_string(),
                    mode: super::super::interactive_mode::QueueMode::Steer,
                },
                CompactionQueuedMessage {
                    text: "real prompt".to_string(),
                    mode: super::super::interactive_mode::QueueMode::FollowUp,
                },
                CompactionQueuedMessage {
                    text: "steered".to_string(),
                    mode: super::super::interactive_mode::QueueMode::Steer,
                },
            ];
            futures::executor::block_on(shell.flush_compaction_queue(true));
        });
    }

    #[test]
    fn queue_flush_normal() {
        replay_upper("queue.flush.normal", |shell, _| {
            shell.lock().compaction_queued_messages = vec![
                CompactionQueuedMessage {
                    text: "/extcmd prep".to_string(),
                    mode: super::super::interactive_mode::QueueMode::Steer,
                },
                CompactionQueuedMessage {
                    text: "real prompt".to_string(),
                    mode: super::super::interactive_mode::QueueMode::FollowUp,
                },
                CompactionQueuedMessage {
                    text: "extra".to_string(),
                    mode: super::super::interactive_mode::QueueMode::Steer,
                },
                CompactionQueuedMessage {
                    text: "extra2".to_string(),
                    mode: super::super::interactive_mode::QueueMode::FollowUp,
                },
            ];
            futures::executor::block_on(shell.flush_compaction_queue(false));
        });
    }

    #[test]
    fn queue_flush_all_extension_commands() {
        replay_upper("queue.flush.all-extension-commands", |shell, _| {
            shell.lock().compaction_queued_messages = vec![
                CompactionQueuedMessage {
                    text: "/extcmd a".to_string(),
                    mode: super::super::interactive_mode::QueueMode::Steer,
                },
                CompactionQueuedMessage {
                    text: "/extcmd b".to_string(),
                    mode: super::super::interactive_mode::QueueMode::FollowUp,
                },
            ];
            futures::executor::block_on(shell.flush_compaction_queue(false));
        });
    }

    #[test]
    fn queue_flush_empty() {
        replay_upper("queue.flush.empty", |shell, _| {
            futures::executor::block_on(shell.flush_compaction_queue(false));
        });
    }

    #[test]
    fn queue_flush_prompt_error_restores() {
        replay_upper("queue.flush.prompt-error-restores", |shell, fixture| {
            *fixture.session.prompt_error.lock().expect("knob") = Some((
                "boom prompt".to_string(),
                "prompt failed".to_string(),
            ));
            shell.lock().compaction_queued_messages = vec![
                CompactionQueuedMessage {
                    text: "boom prompt".to_string(),
                    mode: super::super::interactive_mode::QueueMode::Steer,
                },
                CompactionQueuedMessage {
                    text: "after".to_string(),
                    mode: super::super::interactive_mode::QueueMode::FollowUp,
                },
            ];
            futures::executor::block_on(shell.flush_compaction_queue(false));
            let restored = shell.lock().compaction_queued_messages.clone();
            rec(
                &fixture.log,
                json!(["restored", compaction_queue_value(&restored)]),
            );
        });
    }

    #[test]
    fn queue_flush_pending_bash() {
        replay_upper("queue.flush-pending-bash", |shell, fixture| {
            let one = ComponentRef { kind: "BashStub".to_string(), id: 1 };
            let two = ComponentRef { kind: "BashStub".to_string(), id: 2 };
            fixture.view.register_describe(1, json!({ "kind": "BashStub", "id": 1 }));
            fixture.view.register_describe(2, json!({ "kind": "BashStub", "id": 2 }));
            fixture
                .view
                .container_add_component(ContainerId::Chat, &one);
            fixture
                .view
                .container_add_component(ContainerId::PendingMessages, &two);
            shell.lock().pending_bash_components = vec![two];
            shell.flush_pending_bash_components();
            rec(
                &fixture.log,
                json!([
                    "pendingChildren",
                    fixture.view.container_children_len(ContainerId::PendingMessages),
                    "chatChildren",
                    fixture.view.probe_children(ContainerId::Chat),
                ]),
            );
        });
    }

    // -- status coalescing + notifications --------------------------------------

    #[test]
    fn status_coalesce_consecutive() {
        replay_upper("status.coalesce-consecutive", |shell, fixture| {
            shell.show_status("first");
            shell.show_status("second");
            shell.show_status("third");
            rec(
                &fixture.log,
                json!(["children", fixture.view.probe_children(ContainerId::Chat)]),
            );
        });
    }

    #[test]
    fn status_not_coalesced_after_other() {
        replay_upper("status.not-coalesced-after-other", |shell, fixture| {
            shell.show_status("first");
            fixture
                .view
                .container_add_text(ContainerId::Chat, "user message", 1, 0, false);
            shell.show_status("second");
            rec(
                &fixture.log,
                json!(["children", fixture.view.probe_children(ContainerId::Chat)]),
            );
        });
    }

    #[test]
    fn status_managed_tool() {
        replay_upper("status.managed-tool", |shell, fixture| {
            shell.show_managed_tool_status(false, "downloading fd");
            shell.show_managed_tool_status(true, "checksum mismatch");
            rec(
                &fixture.log,
                json!(["children", fixture.view.probe_children(ContainerId::Chat)]),
            );
        });
    }

    #[test]
    fn status_error_and_warning() {
        replay_upper("status.error-and-warning", |shell, fixture| {
            shell.show_error("boom");
            shell.show_warning("careful");
            rec(
                &fixture.log,
                json!(["children", fixture.view.probe_children(ContainerId::Chat)]),
            );
        });
    }

    #[test]
    fn status_clear_editor() {
        replay_upper("status.clear-editor", |shell, fixture| {
            fixture.default_editor.seed_text("text");
            shell.clear_editor();
        });
    }

    #[test]
    fn status_new_version_notification() {
        replay_upper("status.new-version-notification", |shell, fixture| {
            shell.show_new_version_notification("9.9.9", Some("  Fixed stuff.  "));
            rec(
                &fixture.log,
                json!(["children", fixture.view.probe_children(ContainerId::Chat)]),
            );
        });
    }

    #[test]
    fn status_package_update_notification() {
        replay_upper("status.package-update-notification", |shell, fixture| {
            shell.show_package_update_notification(&["ext-a".to_string(), "ext-b".to_string()]);
            rec(
                &fixture.log,
                json!(["children", fixture.view.probe_children(ContainerId::Chat)]),
            );
        });
    }
