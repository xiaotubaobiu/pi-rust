
    // ---------------------------------------------------------------------------
    // UpperEditor — the recording editor with drive knobs
    // ---------------------------------------------------------------------------

    struct UpperEditor {
        log: Log,
        name: &'static str,
        view: Arc<UpperView>,
        text: Mutex<String>,
        embeds: AtomicBool,
    }

    impl UpperEditor {
        fn new(log: Log, name: &'static str, view: Arc<UpperView>) -> Self {
            Self {
                log,
                name,
                view,
                text: Mutex::new(String::new()),
                embeds: AtomicBool::new(true),
            }
        }

        /// Drive-side text seed (upstream `(t.defaultEditor)._state.text = …`
        /// writes no log).
        fn seed_text(&self, text: &str) {
            *self.text.lock().expect("text") = text.to_string();
        }
    }

    impl ShellEditor for UpperEditor {
        fn get_text(&self) -> String {
            self.text.lock().expect("text").clone()
        }
        fn get_expanded_text(&self) -> String {
            self.get_text()
        }
        fn set_text(&self, text: &str) {
            rec(
                &self.log,
                json!([format!("{}.setText", self.name), text]),
            );
            *self.text.lock().expect("text") = text.to_string();
        }
        fn add_to_history(&self, text: &str) {
            rec(
                &self.log,
                json!([format!("{}.addToHistory", self.name), text]),
            );
        }
        fn insert_text_at_cursor(&self, text: &str) {
            rec(
                &self.log,
                json!([format!("{}.insertTextAtCursor", self.name), text]),
            );
        }
        fn set_border_color(&self, border: EditorBorder) {
            rec(
                &self.log,
                json!([format!("{}.borderColor", self.name), border.tag()]),
            );
        }
        fn border_color(&self) -> Option<String> {
            None
        }
        fn handle_input(&self, data: &str) {
            rec(
                &self.log,
                json!([format!("{}.handleInput", self.name), data]),
            );
        }
        fn set_working_status_indicator(&self, indicator: Option<ComponentRef>) {
            let described = match indicator {
                Some(component) => self.view.describe_component(&ComponentRef {
                    kind: component.kind,
                    id: component.id,
                }),
                None => json!("undefined"),
            };
            rec(
                &self.log,
                json!([
                    format!("{}.setWorkingStatusIndicator", self.name),
                    described
                ]),
            );
        }
        fn set_autocomplete_provider(&self) {
            rec(
                &self.log,
                json!([format!("{}.setAutocompleteProvider", self.name), "provider"]),
            );
        }
        fn set_padding_x(&self, px: i64) {
            rec(&self.log, json!([format!("{}.setPaddingX", self.name), px]));
        }
        fn set_autocomplete_max_visible(&self, n: i64) {
            rec(
                &self.log,
                json!([format!("{}.setAutocompleteMaxVisible", self.name), n]),
            );
        }
        fn get_padding_x(&self) -> i64 {
            2
        }
        fn get_autocomplete_max_visible(&self) -> i64 {
            6
        }
        fn on_action(&self, action: &'static str) {
            rec(
                &self.log,
                json!([format!("{}.onAction", self.name), action, "handler"]),
            );
        }
        fn set_on_escape(&self) {}
        fn set_on_ctrl_d(&self) {}
        fn set_on_submit(&self) {}
        fn set_on_change(&self) {}
        fn set_on_paste_image(&self) {}
        fn set_on_extension_shortcut(&self, _enabled: bool) {}
        fn embeds_working_status(&self) -> bool {
            self.embeds.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    // ---------------------------------------------------------------------------
    // UpperCommands — the `cmd.<name>` recording command sink
    // ---------------------------------------------------------------------------

    struct UpperCommands {
        log: Log,
    }

    impl CommandSink for UpperCommands {
        fn run(&self, command: ShellCommand) {
            let undefined = json!("undefined");
            let tuple = match &command {
                ShellCommand::Settings => json!(["cmd.showSettingsSelector"]),
                ShellCommand::ScopedModels => json!(["cmd.showModelsSelector"]),
                ShellCommand::Model(arg) => json!([
                    "cmd.handleModelCommand",
                    arg.clone().map(Value::String).unwrap_or(undefined)
                ]),
                ShellCommand::Thinking(arg) => json!([
                    "cmd.handleThinkingCommand",
                    arg.clone().map(Value::String).unwrap_or(json!("undefined"))
                ]),
                ShellCommand::Export(text) => json!(["cmd.handleExportCommand", text]),
                ShellCommand::Import(text) => json!(["cmd.handleImportCommand", text]),
                ShellCommand::Share => json!(["cmd.handleShareCommand"]),
                ShellCommand::Copy { .. } => json!(["cmd.handleCopyCommand"]),
                ShellCommand::Name(text) => json!(["cmd.handleNameCommand", text]),
                ShellCommand::Session => json!(["cmd.handleSessionCommand"]),
                ShellCommand::Changelog => json!(["cmd.handleChangelogCommand"]),
                ShellCommand::Hotkeys => json!(["cmd.handleHotkeysCommand"]),
                ShellCommand::UserMessageSelector => json!(["cmd.showUserMessageSelector"]),
                ShellCommand::Clone => json!(["cmd.handleCloneCommand"]),
                ShellCommand::Tree => json!(["cmd.showTreeSelector"]),
                ShellCommand::Trust => json!(["cmd.showTrustSelector"]),
                ShellCommand::Login(arg) => json!([
                    "cmd.handleLoginCommand",
                    arg.clone().map(Value::String).unwrap_or(json!("undefined"))
                ]),
                ShellCommand::OAuthLogout => json!(["cmd.showOAuthSelector", "logout"]),
                ShellCommand::Clear => json!(["cmd.handleClearCommand"]),
                ShellCommand::Compact(arg) => json!([
                    "cmd.handleCompactCommand",
                    arg.clone().map(Value::String).unwrap_or(json!("undefined"))
                ]),
                ShellCommand::Reload => json!(["cmd.handleReloadCommand"]),
                ShellCommand::Debug => json!(["cmd.handleDebugCommand"]),
                ShellCommand::ArminSaysHi => json!(["cmd.handleArminSaysHi"]),
                ShellCommand::DementedDelves => json!(["cmd.handleDementedDelves"]),
                ShellCommand::SessionSelector => json!(["cmd.showSessionSelector"]),
                ShellCommand::Bash {
                    command,
                    exclude_from_context,
                } => json!([
                    "cmd.handleBashCommand",
                    command,
                    exclude_from_context
                ]),
                ShellCommand::TreeSelector => json!(["cmd.showTreeSelector"]),
                ShellCommand::ModelSelector => json!(["cmd.showModelSelector"]),
                ShellCommand::Init => json!(["cmd.init"]),
            };
            rec(&self.log, tuple);
        }
    }

    // ---------------------------------------------------------------------------
    // UpperSession — the r18 fake session (queues, cycle knobs, recording)
    // ---------------------------------------------------------------------------

    /// The `cycleModel` outcome knob.
    enum CycleOutcome {
        None,
        Success(ModelCycleResult),
        Error(String),
    }

    struct UpperSession {
        log: Log,
        streaming: AtomicBool,
        compacting: AtomicBool,
        bash_running: AtomicBool,
        retry_attempt: AtomicU32,
        steering: Mutex<Vec<String>>,
        follow_up: Mutex<Vec<String>>,
        cycle_thinking: Mutex<Option<ThinkingLevel>>,
        cycle_model_outcome: Mutex<CycleOutcome>,
        scoped: Mutex<Vec<ScopedModel>>,
        messages: Mutex<Vec<AgentMessage>>,
        /// `prompt(text)` calls matching this text reject without recording
        /// (the throwing driver override).
        prompt_error: Mutex<Option<(String, String)>>,
        runtime: Arc<super::RecModelRuntime>,
        resources: Arc<super::RecResources>,
        shortcuts: Arc<super::RecShortcuts>,
    }

    impl UpperSession {
        fn new(
            log: Log,
            runtime: Arc<super::RecModelRuntime>,
            resources: Arc<super::RecResources>,
            shortcuts: Arc<super::RecShortcuts>,
        ) -> Self {
            Self {
                log,
                streaming: AtomicBool::new(false),
                compacting: AtomicBool::new(false),
                bash_running: AtomicBool::new(false),
                retry_attempt: AtomicU32::new(0),
                steering: Mutex::new(Vec::new()),
                follow_up: Mutex::new(Vec::new()),
                cycle_thinking: Mutex::new(None),
                cycle_model_outcome: Mutex::new(CycleOutcome::None),
                scoped: Mutex::new(Vec::new()),
                messages: Mutex::new(Vec::new()),
                prompt_error: Mutex::new(None),
                runtime,
                resources,
                shortcuts,
            }
        }

        /// The r18 fake `this` lacks `maybeWarnAboutAnthropicSubscriptionAuth`
        /// (outside the r18 extraction), so upstream's
        /// `void this.maybeWarn…(model)` throws a TypeError inside the
        /// `cycleModel` try block, which surfaces through `showError`. The
        /// fixture reproduces that observable artifact.
        fn record_missing_warn_artifact(&self) {
            let theme = super::theme::load_builtin_theme("dark", Some(super::theme::ColorMode::Truecolor))
                .expect("built-in theme");
            let text = theme
                .fg(
                    "error",
                    "Error: this.maybeWarnAboutAnthropicSubscriptionAuth is not a function",
                )
                .expect("error color");
            rec(&self.log, json!(["Container.addChild", "chat", { "kind": "Spacer" }]));
            rec(
                &self.log,
                json!([
                    "Container.addChild",
                    "chat",
                    {
                        "kind": "Text",
                        "text": text,
                        "paddingX": 1,
                        "paddingY": 0,
                    }
                ]),
            );
            rec(&self.log, json!(["ui.requestRender"]));
        }
    }

    impl ShellSession for UpperSession {
        fn is_streaming(&self) -> bool {
            self.streaming.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn is_compacting(&self) -> bool {
            self.compacting.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn is_bash_running(&self) -> bool {
            self.bash_running.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn is_idle(&self) -> bool {
            !self.is_streaming()
        }
        fn thinking_level(&self) -> ThinkingLevel {
            ThinkingLevel::Medium
        }
        fn retry_attempt(&self) -> u32 {
            self.retry_attempt
                .load(std::sync::atomic::Ordering::SeqCst)
        }
        fn pending_message_count(&self) -> usize {
            0
        }
        fn scoped_models(&self) -> Vec<ScopedModel> {
            self.scoped.lock().expect("scoped").clone()
        }
        fn steering_messages(&self) -> Vec<String> {
            self.steering.lock().expect("steering").clone()
        }
        fn follow_up_messages(&self) -> Vec<String> {
            self.follow_up.lock().expect("follow up").clone()
        }
        fn clear_queue(&self) -> (Vec<String>, Vec<String>) {
            let steering = self.steering.lock().expect("steering").clone();
            let follow_up = self.follow_up.lock().expect("follow up").clone();
            rec(
                &self.log,
                json!([
                    "session.clearQueue",
                    { "steering": steering, "followUp": follow_up }
                ]),
            );
            self.steering.lock().expect("steering").clear();
            self.follow_up.lock().expect("follow up").clear();
            (steering, follow_up)
        }
        fn prompt(
            &self,
            text: String,
            streaming_behavior: Option<StreamingDelivery>,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), AgentSessionError>> + Send + '_>,
        > {
            let log = self.log.clone();
            let throwing = self
                .prompt_error
                .lock()
                .expect("prompt error")
                .clone()
                .filter(|(pattern, _)| *pattern == text)
                .map(|(_, error)| error);
            Box::pin(async move {
                if let Some(error) = throwing {
                    // The throwing driver override replaces the logging stub.
                    return Err(AgentSessionError::Upstream(error));
                }
                rec(
                    &log,
                    match streaming_behavior {
                        None => json!(["session.prompt", text]),
                        Some(behavior) => json!([
                            "session.prompt",
                            text,
                            { "streamingBehavior": match behavior {
                                StreamingDelivery::Steer => "steer",
                                StreamingDelivery::FollowUp => "followUp",
                            } }
                        ]),
                    },
                );
                Ok(())
            })
        }
        fn steer(
            &self,
            text: String,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), AgentSessionError>> + Send + '_>,
        > {
            let log = self.log.clone();
            Box::pin(async move {
                rec(&log, json!(["session.steer", text]));
                Ok(())
            })
        }
        fn follow_up(
            &self,
            text: String,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), AgentSessionError>> + Send + '_>,
        > {
            let log = self.log.clone();
            Box::pin(async move {
                rec(&log, json!(["session.followUp", text]));
                Ok(())
            })
        }
        fn abort(&self) {
            rec(&self.log, json!(["session.abort"]));
        }
        fn abort_bash(&self) {
            rec(&self.log, json!(["session.abortBash"]));
        }
        fn abort_compaction(&self) {
            rec(&self.log, json!(["session.abortCompaction"]));
        }
        fn abort_retry(&self) {
            rec(&self.log, json!(["session.abortRetry"]));
        }
        fn cycle_thinking_level(&self) -> Option<ThinkingLevel> {
            *self.cycle_thinking.lock().expect("cycle thinking")
        }
        fn cycle_model(
            &self,
            _direction: CycleDirection,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<Option<ModelCycleResult>, AgentSessionError>,
                    > + Send
                    + '_,
            >,
        > {
            let outcome = match &*self.cycle_model_outcome.lock().expect("cycle outcome") {
                CycleOutcome::None => Ok(None),
                CycleOutcome::Success(result) => Ok(Some(result.clone())),
                CycleOutcome::Error(message) => Err(AgentSessionError::Upstream(message.clone())),
            };
            Box::pin(async move { outcome })
        }
        fn extensions(&self) -> Arc<dyn ShellExtensionSurface> {
            Arc::new(super::RecExtensions {
                log: self.log.clone(),
                command_diagnostics: Arc::new(Mutex::new(Vec::new())),
            })
        }
        fn maybe_warn_anthropic_subscription_auth(&self, _provider: Option<&str>) {
            self.record_missing_warn_artifact();
        }
        fn subscribe(&self) -> u64 {
            rec(&self.log, json!(["session.subscribe"]));
            1
        }
        fn unsubscribe(&self, _slot: u64) {
            rec(&self.log, json!(["session.unsubscribe"]));
        }
        fn model(&self) -> Option<ModelRef> {
            None
        }
        fn model_runtime(&self) -> Arc<dyn super::interactive_mode::ShellModelRuntime> {
            self.runtime.clone()
        }
        fn resources(&self) -> Arc<dyn super::interactive_mode::ShellResources> {
            self.resources.clone()
        }
        fn shortcuts(&self) -> Arc<dyn ShellShortcutSurface> {
            self.shortcuts.clone()
        }
        fn available_thinking_levels(&self) -> Vec<ThinkingLevel> {
            vec![
                ThinkingLevel::Off,
                ThinkingLevel::Minimal,
                ThinkingLevel::Low,
                ThinkingLevel::Medium,
                ThinkingLevel::High,
            ]
        }
        fn set_model(
            &self,
            _model: &ModelRef,
            _persist: bool,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
        {
            Box::pin(async { Ok(()) })
        }
        fn set_thinking_level(&self, _level: ThinkingLevel, _persist: bool) -> Result<(), String> {
            Ok(())
        }
        fn set_scoped_models(&self, _models: &[ModelRef]) {}
        fn auto_compaction_enabled(&self) -> bool {
            true
        }
        fn set_auto_compaction_enabled(&self, _enabled: bool) {}
        fn steering_mode(&self) -> Value {
            Value::Null
        }
        fn follow_up_mode(&self) -> Value {
            Value::Null
        }
        fn set_steering_mode(&self, _mode: Value) {}
        fn set_follow_up_mode(&self, _mode: Value) {}
        fn user_messages_for_forking(&self) -> Vec<super::interactive_mode::ForkableUserMessage> {
            Vec::new()
        }
        fn session_stats(&self) -> SessionStats {
            SessionStats::default()
        }
        fn last_assistant_text(&self) -> Option<String> {
            None
        }
        fn set_session_name(&self, _name: &str) {}
        fn emit(&self, tuple: Value) {
            rec(&self.log, tuple);
        }
        fn navigate_tree(
            &self,
            _entry_id: &str,
            _summarize: bool,
            _custom_instructions: Option<&str>,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<super::interactive_mode::NavigateOutcome, String>,
                    > + Send
                    + '_,
            >,
        > {
            Box::pin(async { Ok(super::interactive_mode::NavigateOutcome::default()) })
        }
        fn abort_branch_summary(&self) {}
        fn compact(
            &self,
            _custom_instructions: Option<&str>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
        {
            Box::pin(async { Ok(()) })
        }
        fn execute_bash(
            &self,
            _command: &str,
            _exclude_from_context: bool,
            _chunk_sink: &dyn Fn(&str),
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<super::interactive_mode::BashOutcome, String>,
                    > + Send
                    + '_,
            >,
        > {
            Box::pin(async {
                Ok(super::interactive_mode::BashOutcome {
                    exit_code: Some(0),
                    cancelled: false,
                    output: String::new(),
                    truncated: false,
                    full_output_path: None,
                })
            })
        }
        fn record_bash_result(
            &self,
            _command: &str,
            _result: &super::interactive_mode::BashOutcome,
            _exclude_from_context: bool,
        ) {
        }
        fn reload(
            &self,
            _before_session_start: Option<&dyn Fn()>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
        {
            Box::pin(async { Ok(()) })
        }
        fn export_to_jsonl(&self, path: &str) -> Result<String, String> {
            Ok(path.to_string())
        }
        fn export_to_html(
            &self,
            _path: Option<&str>,
            _theme_name: &str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>
        {
            Box::pin(async { Ok("/out.html".to_string()) })
        }
        fn tool_definition(&self, name: &str) -> Value {
            json!({ "name": name, "builtIn": true })
        }
        fn context_usage(&self) -> Option<Value> {
            None
        }
        fn system_prompt(&self) -> String {
            "sys".to_string()
        }
        fn messages(&self) -> Vec<AgentMessage> {
            self.messages.lock().expect("messages").clone()
        }
        fn wait_for_idle(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>>
        {
            Box::pin(async {})
        }
        fn bind_extensions(&self, context: Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
            let log = self.log.clone();
            Box::pin(async move {
                rec(
                    &log,
                    json!(["session.bindExtensions", render_arg(&context)]),
                );
            })
        }
        fn detect_cache_miss(
            &self,
            _message: &AgentMessage,
        ) -> Option<super::interactive_mode::CacheMiss> {
            None
        }
        fn collect_cache_misses(&self) -> Vec<(Value, super::interactive_mode::CacheMiss)> {
            Vec::new()
        }
    }

    // ---------------------------------------------------------------------------
    // UpperPlatform / UpperClock — the patched-process seam
    // ---------------------------------------------------------------------------

    struct UpperPlatform {
        log: Log,
        is_windows: AtomicBool,
        stdout_is_tty: AtomicBool,
        pi_offline: AtomicBool,
    }

    impl UpperPlatform {
        fn new(log: Log) -> Self {
            Self {
                log,
                is_windows: AtomicBool::new(false),
                stdout_is_tty: AtomicBool::new(false),
                pi_offline: AtomicBool::new(false),
            }
        }
    }

    impl ShellPlatform for UpperPlatform {
        fn exit(&self, code: i32) -> bool {
            // The r18 harness's fake `process.exit` records and returns, so
            // upstream `shutdown(fromSignal)` falls through to the
            // interactive quit path (the oracle's double teardown tail).
            rec(&self.log, json!(["process.exit", code]));
            true
        }
        fn is_windows(&self) -> bool {
            self.is_windows.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn now_ms(&self) -> i64 {
            FIXED_MS
        }
        fn stdout_is_tty(&self) -> bool {
            self.stdout_is_tty
                .load(std::sync::atomic::Ordering::SeqCst)
        }
        fn kill_tracked_detached_children(&self) {}
        fn copy_to_clipboard(
            &self,
            _text: &str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
        {
            Box::pin(async { Ok(()) })
        }
        fn read_clipboard_text(
            &self,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send + '_>>
        {
            Box::pin(async { Some("clip text".to_string()) })
        }
        fn read_clipboard_image(
            &self,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Option<(String, Vec<u8>)>> + Send + '_>,
        > {
            Box::pin(async { None })
        }
        fn pi_offline(&self) -> bool {
            self.pi_offline.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn has_trust_requiring_project_resources(&self, _cwd: &str) -> bool {
            false
        }
        fn register_signal_handlers(&self) -> Vec<u64> {
            // The r18 harness's fake process: SIGTERM/SIGHUP prepend, two
            // stdout listeners, one stderr listener, uncaughtException.
            rec(
                &self.log,
                json!(["process.prependListener", "SIGTERM", "function"]),
            );
            rec(
                &self.log,
                json!(["process.prependListener", "SIGHUP", "function"]),
            );
            rec(&self.log, json!(["process.stdout.on"]));
            rec(&self.log, json!(["process.stdout.on"]));
            rec(&self.log, json!(["process.stderr.on"]));
            rec(
                &self.log,
                json!(["process.prependListener", "uncaughtException", "function"]),
            );
            vec![1, 2, 3, 4, 5, 6]
        }
        fn unregister_signal_handlers(&self, _ids: &[u64]) {
            rec(&self.log, json!(["process.off", "SIGTERM", "function"]));
            rec(&self.log, json!(["process.off", "SIGHUP", "function"]));
            rec(&self.log, json!(["process.stdout.off"]));
            rec(&self.log, json!(["process.stderr.off"]));
            rec(&self.log, json!(["process.off", "uncaughtException", "function"]));
        }
        fn suspend(&self) -> Option<()> {
            Some(())
        }
        fn now_iso(&self) -> String {
            "2026-09-28T14:02:27.438Z".to_string()
        }
        fn basename(&self, path: &str) -> String {
            path.rsplit(['/', '\\'])
                .next()
                .unwrap_or_default()
                .to_string()
        }
        fn join_path(&self, parts: &[&str]) -> String {
            // node win32 `path.join` (the harness ran on win32): normalize
            // separators, keep the leading segment.
            let normalized: Vec<String> = parts.iter().map(|p| p.replace('/', "\\")).collect();
            normalized.join("\\")
        }
        fn file_exists(&self, path: &str) -> bool {
            // The harness fs stub: only the session file exists.
            path.ends_with("abc123.jsonl")
        }
    }

    struct UpperClock(std::sync::Mutex<i64>);

    impl UpperClock {
        fn new() -> Self {
            Self(std::sync::Mutex::new(FIXED_MS))
        }
        fn set(&self, ms: i64) {
            *self.0.lock().expect("clock") = ms;
        }
    }

    impl ShellClock for UpperClock {
        fn now_ms(&self) -> i64 {
            *self.0.lock().expect("clock")
        }
    }

    /// The r18 changelog document (drive_shell.ts deps).
    struct UpperChangelog;

    impl ChangelogSource for UpperChangelog {
        fn entries(&self) -> Vec<(String, String)> {
            vec![
                ("1.2.0".to_string(), "old".to_string()),
                ("1.1.0".to_string(), "older".to_string()),
            ]
        }
        fn new_entries(&self, last_version: &str) -> Vec<(String, String)> {
            self.entries()
                .into_iter()
                .filter(|(version, _)| version.as_str() > last_version)
                .collect()
        }
        fn normalize_links(&self, content: &str) -> String {
            content.to_string()
        }
    }

    fn key_display(_action: &str) -> String {
        // The harness keybindings resolve every action to `["ctrl+c"]`.
        "Ctrl+C".to_string()
    }

    // ---------------------------------------------------------------------------
    // Fixture assembly + replay driver
    // ---------------------------------------------------------------------------

    struct UpperFixture {
        log: Log,
        view: Arc<UpperView>,
        default_editor: Arc<UpperEditor>,
        settings: Arc<super::RecSettings>,
        manager: Arc<super::RecSessionManager>,
        runtime: Arc<super::RecModelRuntime>,
        resources: Arc<super::RecResources>,
        shortcuts: Arc<super::RecShortcuts>,
        session: Arc<UpperSession>,
        platform: Arc<UpperPlatform>,
        clock: Arc<UpperClock>,
    }

    impl UpperFixture {
        fn new(log: Log) -> Self {
            let view = Arc::new(UpperView::new(log.clone()));
            let default_editor = Arc::new(UpperEditor::new(log.clone(), "defaultEditor", view.clone()));
            let settings = Arc::new(super::RecSettings::new(log.clone()));
            let manager = Arc::new(super::RecSessionManager::new());
            let runtime = Arc::new(super::RecModelRuntime::new(log.clone()));
            runtime.snapshot.lock().expect("snapshot").clear();
            let resources = Arc::new(super::RecResources::default());
            let shortcuts = Arc::new(super::RecShortcuts::new(log.clone()));
            let session = Arc::new(UpperSession::new(
                log.clone(),
                runtime.clone(),
                resources.clone(),
                shortcuts.clone(),
            ));
            let platform = Arc::new(UpperPlatform::new(log.clone()));
            Self {
                log,
                view,
                default_editor,
                settings,
                manager,
                runtime,
                resources,
                shortcuts,
                session,
                platform,
                clock: Arc::new(UpperClock::new()),
            }
        }

        fn build(&self, options: InteractiveModeOptions) -> Arc<InteractiveMode> {
            let io = ShellIo {
                session: self.session.clone(),
                session_manager: self.manager.clone(),
                settings: self.settings.clone(),
                view: self.view.clone(),
                host: Arc::new(super::RecHost::new(self.log.clone())),
                commands: Arc::new(UpperCommands {
                    log: self.log.clone(),
                }),
                clock: self.clock.clone(),
                platform: self.platform.clone(),
                default_editor: self.default_editor.clone(),
                default_model_per_provider: vec![
                    ("anthropic".to_string(), "claude-opus-4-8".to_string()),
                    ("radius".to_string(), "balanced".to_string()),
                ],
                auth_path: "/home/u/.pi/agent/auth.json".to_string(),
                docs_path: "/docs".to_string(),
                debug_log_path: "/tmp/pi-debug.log".to_string(),
                app_name: "pi".to_string(),
                app_title: "Pi".to_string(),
                version: "1.2.3".to_string(),
                home: "/home/u".to_string(),
                changelog: Box::new(UpperChangelog),
                key_display: Box::new(key_display),
                theme: std::sync::RwLock::new(
                    load_builtin_theme("dark", Some(ColorMode::Truecolor)).expect("built-in theme"),
                ),
                cache_stats: None,
                // The drive's fake chalk has no color support (literal
                // brackets).
                chalk_styler: Box::new(|text: &str| format!("[2m{text}[22m")),
            };
            let shell = Arc::new(InteractiveMode::new(io, options));
            shell.force_initialized();
            shell
        }
    }

    /// Replays one upper scenario and asserts byte-parity with the oracle.
    fn replay_upper_with(
        name: &str,
        options: InteractiveModeOptions,
        customize: impl FnOnce(&UpperFixture),
        drive: impl FnOnce(&Arc<InteractiveMode>, &UpperFixture) + Send,
    ) {
        let log: Log = Arc::new(Mutex::new(Vec::new()));
        let fixture = UpperFixture::new(log.clone());
        customize(&fixture);
        let shell = fixture.build(options);
        drive(&shell, &fixture);
        let ours: Vec<Value> = log.lock().expect("log").clone();
        let expected = oracle_log(name);
        let failures: Vec<String> = ours
            .iter()
            .enumerate()
            .zip(expected.iter())
            .filter(|(ours_pair, expected)| ours_pair.1 != *expected)
            .map(|((index, actual), expected)| {
                format!(
                    "  [{index}] ours:   {}\n      oracle: {}",
                    serde_json::to_string(actual).unwrap_or_default(),
                    serde_json::to_string(expected).unwrap_or_default()
                )
            })
            .collect();
        assert!(
            failures.is_empty() && ours.len() == expected.len(),
            "scenario {name} diverged ({} vs {} entries):\n{}",
            ours.len(),
            expected.len(),
            failures.join("\n")
        );
    }

    /// Replays one upper scenario against the default fixture.
    fn replay_upper(
        name: &str,
        drive: impl FnOnce(&Arc<InteractiveMode>, &UpperFixture) + Send,
    ) {
        replay_upper_with(name, InteractiveModeOptions::default(), |_| {}, drive);
    }

    use super::interactive_mode::{BashOutcome, CacheMiss, ShellModelRuntime, ShellResources};
}
