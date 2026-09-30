// ---------------------------------------------------------------------------
// r18 shell-oracle replay (upper half): drives the ported session shell
// through the same seams the r18 node harness recorded
// (`scratch/interactive_r18_oracle/shell_oracle.json`, 210 scenarios over
// verbatim upstream bodies spread on a fake `this`). Second fixture family:
// the r18 harness vocabulary differs from the r20 lower-half one in several
// places, reproduced here:
//
// - the drive's fake chalk renders `dim` as literal `[2m…[22m` (no escape
//   bytes) while theme colors keep real ANSI;
// - `session.prompt(text)` without options records ONE argument (the r20
//   driver recorded a trailing null);
// - `session.clearQueue` records the queue contents being cleared;
// - containers track real children; the `children`/`above`/`below` probes
//   render `describeArg` walks (Spacer → `{"height": 1}`, Text → its
//   instance fields, component stubs → their describe), while
//   `Container.addChild` renders the component `describe()` (`kind`-shaped);
// - plain-object children (drive-seeded `child`, the editor, the built-in
//   footer) record as `"[object Object]"`;
// - undefined constructor arguments record as `"undefined"`;
// - `this` lacks `maybeWarnAboutAnthropicSubscriptionAuth` (not part of the
//   r18 extraction), so the `cycleModel` success path throws and surfaces
//   `Error: this.maybeWarnAboutAnthropicSubscriptionAuth is not a function`
//   through showError — the session fixture reproduces that observable
//   artifact (harness-vocabulary emulation, disclosed).
// ---------------------------------------------------------------------------

mod upper_oracle {
    use std::collections::{BTreeMap, HashMap};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};

    use super::interactive_mode::{
        ComponentKind, ComponentRef, ContainerId, CycleDirection, FocusTarget,
        InteractiveModeOptions, ShellClock, ShellView,
    };
    use super::shell::{ChangelogSource, CommandSink, InteractiveMode, ShellIo};
    use super::theme::{load_builtin_theme, ColorMode};
    use crate::agent_core::types::{AgentMessage, ThinkingLevel};
    use crate::coding_agent::agent_session::{
        AgentSessionError, CycleDirection as SessionCycleDirection, ResourceDiagnostic,
        SessionStats,
    };
    use crate::coding_agent::extensions::types::StreamingDelivery;
    use crate::coding_agent::session_manager::SessionEntry;

    type Log = Arc<Mutex<Vec<Value>>>;

    fn rec(log: &Log, parts: Value) {
        log.lock().expect("log").push(parts);
    }

    /// The fixed driver date (drive_shell.ts `FIXED_MS`).
    const FIXED_MS: i64 = 1_790_604_147_438;

    fn upper_oracle() -> &'static Value {
        static ORACLE: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        ORACLE.get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../../scratch/interactive_r18_oracle/shell_oracle.json"
            ))
            .expect("upper oracle parses")
        })
    }

    fn oracle_log(scenario: &str) -> Vec<Value> {
        upper_oracle()["scenarios"]
            .as_array()
            .expect("scenarios")
            .iter()
            .find(|s| s["name"] == json!(scenario))
            .unwrap_or_else(|| panic!("scenario {scenario} missing from oracle"))["log"]
            .as_array()
            .expect("log array")
            .clone()
    }

    /// The drive's `describeArg`: top-level `null` is the JS `undefined`
    /// sentinel and renders `"undefined"`; nested message payloads keep
    /// their JSON nulls; `__describe` markers render the handle shape.
    fn render_arg(value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(render_arg).collect()),
            Value::Object(map) => {
                if let Some(kind) = map.get("__describe").and_then(Value::as_str) {
                    json!({ "kind": kind })
                } else {
                    Value::Object(
                        map.iter()
                            .map(|(k, v)| (k.clone(), describe_nested(v)))
                            .collect(),
                    )
                }
            }
            Value::Null => json!("undefined"),
            other => other.clone(),
        }
    }

    fn describe_nested(value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(describe_nested).collect()),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), describe_nested(v)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    fn render_args(args: &Value) -> Vec<Value> {
        match args {
            Value::Array(items) => items.iter().map(render_arg).collect(),
            Value::Null => Vec::new(),
            other => vec![render_arg(other)],
        }
    }

    /// The default (`fakeEditor`) object describe from the harness.
    fn editor_describe(custom: bool) -> Value {
        let handler = if custom { "function" } else { "undefined" };
        json!({
            "_editorName": "<state>", "_state": "<state>",
            "onEscape": handler, "onCtrlD": handler, "onSubmit": "undefined",
            "onChange": "undefined", "onPasteImage": handler,
            "onExtensionShortcut": handler, "embedWorkingStatus": true,
            "actionHandlers": {},
            "getText": "function", "getExpandedText": "function", "setText": "function",
            "addToHistory": "function", "insertTextAtCursor": "function",
            "handleInput": "function", "setWorkingStatusIndicator": "function",
            "setAutocompleteProvider": "function", "setPaddingX": "function",
            "getPaddingX": "function", "setAutocompleteMaxVisible": "function",
            "getAutocompleteMaxVisible": "function", "onAction": "function",
        })
    }

    // ---------------------------------------------------------------------------
    // UpperView — real-container recording view (r18 vocabulary)
    // ---------------------------------------------------------------------------

    #[derive(Clone)]
    enum UpperChild {
        Spacer,
        Text {
            id: u64,
            text: String,
            pad_x: i64,
            pad_y: i64,
        },
        Border {
            color_tag: String,
        },
        Markdown {
            text: String,
            pad_x: i64,
        },
        Component(ComponentRef),
    }

    /// Plain-object children record as their JS `String()` form.
    fn plain_object_kind(kind: &str) -> bool {
        matches!(
            kind,
            "editor" | "customEditor" | "footer" | "reloadBox" | "child"
        )
    }

    struct UpperView {
        log: Log,
        ids: AtomicU64,
        containers: Mutex<HashMap<&'static str, Vec<UpperChild>>>,
        /// The detached widget box (`containerName: "container"`).
        box_children: Mutex<Vec<UpperChild>>,
        chat_version: AtomicU64,
        /// Drive-flipped: whether the focused editor is the custom editor.
        editor_custom: AtomicBool,
        /// Drive-registered component describes (id → describe) for the
        /// focus / working-indicator probes.
        describes: Mutex<BTreeMap<u64, Value>>,
        renderer_mode: Mutex<String>,
        overlay_count: Mutex<usize>,
    }

    impl UpperView {
        fn new(log: Log) -> Self {
            Self {
                log,
                ids: AtomicU64::new(1),
                containers: Mutex::new(HashMap::new()),
                box_children: Mutex::new(Vec::new()),
                chat_version: AtomicU64::new(0),
                editor_custom: AtomicBool::new(false),
                describes: Mutex::new(BTreeMap::new()),
                renderer_mode: Mutex::new("regular".to_string()),
                overlay_count: Mutex::new(0),
            }
        }

        fn id(&self) -> u64 {
            self.ids.fetch_add(1, Ordering::SeqCst)
        }

        fn container(&self, container: ContainerId) -> std::sync::MutexGuard<'_, Vec<UpperChild>> {
            self.containers
                .lock()
                .expect("containers")
                .entry(container.as_str())
                .or_default()
        }

        fn bump(&self, container: ContainerId) {
            if container == ContainerId::Chat {
                self.chat_version.fetch_add(1, Ordering::SeqCst);
            }
        }

        fn describe_component(&self, component: &ComponentRef) -> Value {
            if let Some(describe) = self.describes.lock().expect("describes").get(&component.id) {
                return describe.clone();
            }
            if plain_object_kind(&component.kind) {
                return json!("[object Object]");
            }
            json!({ "kind": component.kind })
        }

        /// The `describeArg` rendering of a stored child (children probes).
        fn describe_child(child: &UpperChild) -> Value {
            match child {
                UpperChild::Spacer => json!({ "height": 1 }),
                UpperChild::Text {
                    id: _,
                    text,
                    pad_x,
                    pad_y,
                } => json!({
                    "text": text,
                    "paddingX": pad_x,
                    "paddingY": pad_y,
                }),
                UpperChild::Border { color_tag } => json!({ "colorTag": color_tag }),
                UpperChild::Markdown { text, pad_x } => {
                    json!({ "text": text, "paddingX": pad_x })
                }
                UpperChild::Component(component) => json!({ "kind": component.kind }),
            }
        }

        fn describe_children(children: &[UpperChild]) -> Vec<Value> {
            children.iter().map(Self::describe_child).collect()
        }

        /// `{container: name, children: [...]}` (the drive's `describeArg`
        /// of a `Container` instance).
        fn probe_container(&self, container: ContainerId) -> Value {
            json!({
                "container": container.as_str(),
                "children": Self::describe_children(&self.container(container)),
            })
        }

        fn probe_children(&self, container: ContainerId) -> Value {
            Value::Array(Self::describe_children(&self.container(container)))
        }

        /// The detached widget box probe.
        fn probe_box(&self) -> Value {
            json!({
                "container": "container",
                "children": Self::describe_children(&self.box_children.lock().expect("box")),
            })
        }

        fn register_describe(&self, id: u64, describe: Value) {
            self.describes
                .lock()
                .expect("describes")
                .insert(id, describe);
        }
    }

    impl ShellView for UpperView {
        fn request_render(&self, force: Option<bool>) {
            rec(
                &self.log,
                match force {
                    Some(force) => json!(["ui.requestRender", force]),
                    None => json!(["ui.requestRender"]),
                },
            );
        }
        fn invalidate(&self) {
            rec(&self.log, json!(["ui.invalidate"]));
        }
        fn render_now(&self) {
            rec(&self.log, json!(["ui.renderNow"]));
        }
        fn start(&self) {
            rec(&self.log, json!(["ui.start"]));
        }
        fn stop(&self, preserve_screen: bool) {
            rec(
                &self.log,
                json!(["ui.stop", { "preserveScreen": preserve_screen }]),
            );
        }
        fn set_clear_on_shrink(&self, enabled: bool) {
            rec(&self.log, json!(["ui.setClearOnShrink", enabled]));
        }
        fn set_show_hardware_cursor(&self, enabled: bool) {
            rec(&self.log, json!(["ui.setShowHardwareCursor", enabled]));
        }
        fn terminal_set_progress(&self, enabled: bool) {
            rec(&self.log, json!(["terminal.setProgress", enabled]));
        }
        fn terminal_set_title(&self, title: &str) {
            rec(&self.log, json!(["terminal.setTitle", title]));
        }
        fn drain_input(&self, ms: u64) {
            rec(&self.log, json!(["terminal.drainInput", ms]));
        }
        fn set_focus(&self, target: FocusTarget) {
            let described = match target {
                FocusTarget::Editor => editor_describe(self.editor_custom.load(Ordering::SeqCst)),
                FocusTarget::Component(component) => self.describe_component(&component),
                FocusTarget::None => Value::Null,
            };
            rec(&self.log, json!(["ui.setFocus", described]));
        }
        fn show_overlay(&self, component: &ComponentRef, _options: Option<Value>) {
            rec(
                &self.log,
                json!(["ui.showOverlay", { "kind": component.kind }, "undefined"]),
            );
        }
        fn hide_overlay(&self) {
            rec(&self.log, json!(["ui.hideOverlay"]));
        }
        fn add_input_listener(&self) -> u64 {
            rec(&self.log, json!(["ui.addInputListener", "function"]));
            self.id()
        }
        fn remove_input_listener(&self, _id: u64) {
            rec(&self.log, json!(["ui.removeInputListener"]));
        }
        fn container_version(&self, container: ContainerId) -> u64 {
            if container == ContainerId::Chat {
                self.chat_version.load(Ordering::SeqCst)
            } else {
                0
            }
        }
        fn container_clear(&self, container: ContainerId) {
            rec(
                &self.log,
                json!(["Container.clear", container.as_str()]),
            );
            self.container(container).clear();
        }
        fn container_add_spacer(&self, container: ContainerId) -> u64 {
            self.bump(container);
            self.container(container).push(UpperChild::Spacer);
            rec(
                &self.log,
                json!([
                    "Container.addChild",
                    container.as_str(),
                    { "kind": "Spacer" }
                ]),
            );
            self.id()
        }
        fn container_add_text(
            &self,
            container: ContainerId,
            text: &str,
            pad_x: i64,
            pad_y: i64,
            truncated: bool,
        ) -> u64 {
            // The harness `describe()` matches `Text` before `TruncatedText`,
            // so truncated rows record as plain `Text`.
            let _ = truncated;
            self.bump(container);
            let id = self.id();
            self.container(container).push(UpperChild::Text {
                id,
                text: text.to_string(),
                pad_x,
                pad_y,
            });
            rec(
                &self.log,
                json!([
                    "Container.addChild",
                    container.as_str(),
                    {
                        "kind": "Text",
                        "text": text,
                        "paddingX": pad_x,
                        "paddingY": pad_y,
                    }
                ]),
            );
            id
        }
        fn container_set_text(&self, _container: ContainerId, id: u64, text: &str) {
            let old = {
                let containers = self.containers.lock().expect("containers");
                containers
                    .values()
                    .flat_map(|children| children.iter())
                    .find_map(|child| match child {
                        UpperChild::Text {
                            id: child_id,
                            text,
                            pad_x: _,
                            pad_y: _,
                        } if *child_id == id => Some(text.clone()),
                        _ => None,
                    })
            };
            rec(&self.log, json!(["Text.setText", old.unwrap_or_default(), text]));
            // Keep the mutated content for the next coalesce / probe.
            for children in self.containers.lock().expect("containers").values_mut() {
                for child in children.iter_mut() {
                    if let UpperChild::Text {
                        id: child_id,
                        text: stored,
                        pad_x: _,
                        pad_y: _,
                    } = child
                    {
                        if *child_id == id {
                            *stored = text.to_string();
                        }
                    }
                }
            }
        }
        fn container_add_component(&self, container: ContainerId, component: &ComponentRef) {
            self.bump(container);
            let described = self.describe_component(component);
            self.container(container)
                .push(UpperChild::Component(component.clone()));
            rec(
                &self.log,
                json!([
                    "Container.addChild",
                    container.as_str(),
                    described
                ]),
            );
        }
        fn container_remove_component(&self, container: ContainerId, component: &ComponentRef) {
            self.bump(container);
            let kind = component.kind.clone();
            if let Some(position) = self
                .container(container)
                .iter()
                .position(|child| matches!(child, UpperChild::Component(c) if c.kind == kind))
            {
                self.container(container).remove(position);
            }
            rec(
                &self.log,
                json!([
                    "Container.removeChild",
                    container.as_str(),
                    { "kind": component.kind }
                ]),
            );
        }
        fn container_replace_child(
            &self,
            container: ContainerId,
            index: usize,
            component: &ComponentRef,
        ) {
            rec(
                &self.log,
                json!([
                    "Container.replaceChild",
                    container.as_str(),
                    index,
                    { "kind": component.kind }
                ]),
            );
        }
        fn container_children_len(&self, container: ContainerId) -> usize {
            self.container(container).len()
        }
        fn new_component(&self, kind: ComponentKind, args: Value) -> ComponentRef {
            let mut tuple = vec![Value::String(format!("new {}", kind.as_str()))];
            tuple.extend(render_args(&args));
            rec(&self.log, Value::Array(tuple));
            ComponentRef {
                kind: kind.as_str().to_string(),
                id: self.id(),
            }
        }
        fn update_component(&self, component: &ComponentRef, op: &str, args: Value) {
            let mut tuple = vec![Value::String(format!("{}.{}", component.kind, op))];
            if op != "dispose" && !args.is_null() {
                tuple.extend(render_args(&args));
            }
            rec(&self.log, Value::Array(tuple));
        }
        fn emit(&self, tuple: Value) {
            // Track the detached widget box ("container") so the drive-side
            // probes render its live children.
            if tuple.get(0).and_then(Value::as_str) == Some("Container.addChild")
                && tuple.get(1).and_then(Value::as_str) == Some("container")
            {
                if let Some(child) = tuple.get(2) {
                    self.box_children
                        .lock()
                        .expect("box")
                        .push(box_child_from_record(child));
                }
            } else if tuple.get(0).and_then(Value::as_str) == Some("Container.clear")
                && tuple.get(1).and_then(Value::as_str) == Some("container")
            {
                self.box_children.lock().expect("box").clear();
            }
            rec(&self.log, tuple);
        }
        fn get_clear_on_shrink(&self) -> bool {
            false
        }
        fn idle_status_component(&self) -> ComponentRef {
            ComponentRef {
                kind: "IdleStatus".to_string(),
                id: 0,
            }
        }
        fn has_overlay_entries(&self) -> bool {
            *self.overlay_count.lock().expect("overlays") > 0
        }
        fn renderer_mode(&self) -> String {
            self.renderer_mode.lock().expect("mode").clone()
        }
        fn renderer_children(&self) -> Vec<ComponentRef> {
            Vec::new()
        }
        fn renderer_focused_component(&self) -> Option<ComponentRef> {
            None
        }
        fn renderer_terminal_id(&self) -> u64 {
            1
        }
        fn renderer_show_hardware_cursor(&self) -> bool {
            false
        }
        fn renderer_capture_render_state(&self) {}
        fn renderer_create(&self, mode: &str, _terminal: u64) -> u64 {
            *self.renderer_mode.lock().expect("mode") = mode.to_string();
            rec(
                &self.log,
                json!(["createInteractiveTui", {
                    "tuiMode": mode,
                    "showHardwareCursor": false,
                    "logDirectory": "/home/u/.pi/agent",
                    "terminal": {
                        "columns": 80,
                        "rows": 24,
                        "setProgress": "function",
                        "setTitle": "function",
                        "drainInput": "function",
                    },
                    "onRightClickPaste": "undefined",
                    "fullscreenCopyOnSelect": false,
                }]),
            );
            self.id()
        }
        fn renderer_become(&self, _id: u64) {}
        fn renderer_stop_preserving_screen(&self) {
            rec(&self.log, json!(["ui.stop", { "preserveScreen": true }]));
        }
        fn renderer_set_focus_none(&self) {
            rec(&self.log, json!(["ui.setFocus", "undefined"]));
        }
        fn renderer_clear(&self) {
            rec(&self.log, json!(["ui.clear"]));
        }
        fn renderer_set_layout_root_none(&self) {
            rec(&self.log, json!(["ui.setLayoutRoot", "undefined"]));
        }
        fn renderer_invalidate(&self) {
            rec(&self.log, json!(["ui.invalidate"]));
        }
        fn renderer_start(&self) {
            rec(&self.log, json!(["ui.start"]));
        }
        fn renderer_add_child(&self, container: ContainerId) {
            rec(
                &self.log,
                json!([
                    "renderer.addChild",
                    { "container": container.as_str(), "children": [] }
                ]),
            );
        }
        fn renderer_hide_overlay(&self) {
            let mut count = self.overlay_count.lock().expect("overlays");
            *count = count.saturating_sub(1);
            drop(count);
            rec(&self.log, json!(["renderer.hideOverlay"]));
        }
        fn renderer_render_now(&self) {
            rec(&self.log, json!(["renderer.renderNow"]));
        }
        fn renderer_add_child_by_name(&self, name: &str) {
            rec(
                &self.log,
                json!(["renderer.addChild", { "container": name, "children": [] }]),
            );
        }
        fn header_unshift(&self, component: &ComponentRef) {
            rec(
                &self.log,
                json!([
                    "Container.unshift",
                    "header",
                    { "kind": component.kind }
                ]),
            );
        }
        fn get_copy_on_select(&self) -> bool {
            false
        }
        fn has_active_selection(&self) -> bool {
            false
        }
        fn debug_render(&self) -> (usize, usize, Vec<String>) {
            (80, 24, vec!["line-one".to_string()])
        }
        fn container_components(&self, container: ContainerId) -> Vec<ComponentRef> {
            self.container(container)
                .iter()
                .filter_map(|child| match child {
                    UpperChild::Component(component) => Some(component.clone()),
                    _ => None,
                })
                .collect()
        }
        fn container_insert_at(&self, container: ContainerId, index: usize, component: &ComponentRef) {
            rec(
                &self.log,
                json!([
                    "Container.insertChild",
                    container.as_str(),
                    index,
                    { "kind": component.kind }
                ]),
            );
        }
        fn container_add_border(&self, container: ContainerId, _color_tag: Option<&str>) -> u64 {
            self.bump(container);
            self.container(container).push(UpperChild::Border {
                color_tag: "default".to_string(),
            });
            rec(
                &self.log,
                json!([
                    "Container.addChild",
                    container.as_str(),
                    { "kind": "DynamicBorder", "colorTag": "default" }
                ]),
            );
            self.id()
        }
        fn container_add_markdown(
            &self,
            container: ContainerId,
            text: &str,
            pad_x: i64,
            _pad_y: i64,
            _theme: &Value,
        ) -> u64 {
            self.bump(container);
            self.container(container).push(UpperChild::Markdown {
                text: text.to_string(),
                pad_x,
            });
            rec(
                &self.log,
                json!([
                    "Container.addChild",
                    container.as_str(),
                    { "kind": "Markdown", "text": text, "paddingX": pad_x }
                ]),
            );
            self.id()
        }
        fn container_remove_at(&self, _container: ContainerId, _component: &ComponentRef) {}
        fn session_identity(&self) -> u64 {
            1
        }
        fn user_input_resolved(&self, _slot: u64, _text: &str) {}
        fn component_handle_input(&self, component: &ComponentRef, data: &str) -> bool {
            if component.kind == "target" {
                rec(&self.log, json!(["target.handleInput", data]));
                return true;
            }
            false
        }
    }

    /// Rebuilds a detached-box child from the recorded addChild describe.
    fn box_child_from_record(child: &Value) -> UpperChild {
        let kind = child.get("kind").and_then(Value::as_str).unwrap_or("");
        match kind {
            "Spacer" => UpperChild::Spacer,
            "Text" => UpperChild::Text {
                id: 0,
                text: child
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                pad_x: child
                    .get("paddingX")
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
                pad_y: child
                    .get("paddingY")
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
            },
            _ => UpperChild::Component(ComponentRef {
                kind: kind.to_string(),
                id: 0,
            }),
        }
    }
}
