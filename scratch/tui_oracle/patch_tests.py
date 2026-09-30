# One-off patcher for src/tui/tui_tests.rs compile fixes (scratch tool).
import io

p = r"C:/Users/13063/Desktop/code/agent work/pi-rust/src/tui/tui_tests.rs"
src = io.open(p, encoding="utf-8").read()

src = src.replace(
    "use crate::tui::terminal::Terminal as _;",
    "use crate::tui::component::{TuiMouseButton, TuiMouseEventType};\n"
    "use crate::tui::terminal::Terminal;\n"
    "use crate::tui::terminal_colors::{\n"
    "    RgbColor as OracleRgbColor,\n"
    "    TerminalColorScheme as OracleColorScheme,\n"
    "};",
)

src = src.replace(
    """            ScriptAction::Unfocus { overlay, target } => {
                let options = target.map(|target| OverlayUnfocusOptions {
                    target: target.map(|name| self.component(name)),
                });
                self.harness.tui.overlay_unfocus(&overlay, options);
            }""",
    """            ScriptAction::Unfocus { overlay, target } => {
                let options = target.map(|target| OverlayUnfocusOptions { target });
                self.harness.tui.overlay_unfocus(&overlay, options);
            }""",
)

src = src.replace(
    """        let hits_cell: Rc<Cell<u32>> = Rc::new(Cell::new(0));
        let hits_clone = hits_cell.clone();
        debug_harness.tui.on_debug = Some(Box::new(move || {
            hits_clone.set(hits_clone.get() + 1);
        }));""",
    """        let hits_cell = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let hits_clone = hits_cell.clone();
        debug_harness.tui.on_debug = Some(Box::new(move || {
            hits_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));""",
)
src = src.replace(
    "hits.push(hits_cell.get());",
    "hits.push(hits_cell.load(std::sync::atomic::Ordering::SeqCst));",
)

src = src.replace(
    '"results": [["first", first.map(|rgb| json!({"r": rgb.r, "g": rgb.g, "b": rgb.b}))]],',
    '"results": [["first", rgb_oracle_json(first)]],',
)
src = src.replace(
    'assert_oracle_json(json!({ "results": [timed_out] }), OSC11_TIMEOUT);',
    'assert_oracle_json(json!({ "results": [rgb_oracle_json(timed_out)] }), OSC11_TIMEOUT);',
)
src = src.replace(
    'assert_oracle_json(json!({ "schemes": [timed_out] }), SCHEME_TIMEOUT);',
    'assert_oracle_json(json!({ "schemes": [scheme_oracle_json(timed_out)] }), SCHEME_TIMEOUT);',
)

helper = """
fn rgb_oracle_json(rgb: Option<OracleRgbColor>) -> serde_json::Value {
    match rgb {
        Some(rgb) => json!({ "r": rgb.r, "g": rgb.g, "b": rgb.b }),
        None => serde_json::Value::Null,
    }
}

fn scheme_oracle_json(scheme: Option<OracleColorScheme>) -> serde_json::Value {
    match scheme {
        Some(TerminalColorScheme::Dark) => json!("dark"),
        Some(TerminalColorScheme::Light) => json!("light"),
        None => serde_json::Value::Null,
    }
}

fn viewport_of("""
src = src.replace("\nfn viewport_of(", helper, 1)

io.open(p, "w", encoding="utf-8", newline="").write(src)
print("patched")
