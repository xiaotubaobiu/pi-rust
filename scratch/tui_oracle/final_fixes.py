# Final wiring fixes: plain REPLACEMENT components + resize event polling.
import io

p = r"C:/Users/13063/Desktop/code/agent work/pi-rust/src/tui/tui_tests.rs"
src = io.open(p, encoding="utf-8", newline="").read()
BS = chr(92)

# --- unfocus target scenario: REPLACEMENT must be a plain component.
old1 = (
    '        fx.show_scripted(\n'
    '            "REPLACEMENT",\n'
    '            None,\n'
    '            Box::new(|data| {\n'
    '                if data == "' + BS + 'r" {\n'
    '                    vec![ScriptAction::Focus("FALLBACK")]\n'
    '                } else {\n'
    '                    Vec::new()\n'
    '                }\n'
    '            }),\n'
    '        );\n'
)
new1 = (
    '        fx.plain_component("REPLACEMENT");\n'
    '        fx.shared["REPLACEMENT"].borrow_mut().script = Some(Box::new(|data| {\n'
    '            if data == "' + BS + 'r" {\n'
    '                vec![ScriptAction::Focus("FALLBACK")]\n'
    '            } else {\n'
    '                Vec::new()\n'
    '            }\n'
    '        }));\n'
)
print("unfocus-target:", src.count(old1))
src = src.replace(old1, new1)

# --- blocked setFocus(null) scenario: REPLACEMENT must be a plain component.
old2 = (
    '        fx.plain_component("REPLACEMENT");\n'
    '        fx.show_scripted(\n'
    '            "REPLACEMENT",\n'
    '            None,\n'
    '            Box::new(|data| {\n'
    '                if data == "' + BS + 'r" {\n'
    '                    vec![ScriptAction::FocusNull]\n'
    '                } else {\n'
    '                    Vec::new()\n'
    '                }\n'
    '            }),\n'
    '        );\n'
)
new2 = (
    '        fx.plain_component("REPLACEMENT");\n'
    '        fx.shared["REPLACEMENT"].borrow_mut().script = Some(Box::new(|data| {\n'
    '            if data == "' + BS + 'r" {\n'
    '                vec![ScriptAction::FocusNull]\n'
    '            } else {\n'
    '                Vec::new()\n'
    '            }\n'
    '        }));\n'
)
print("blocked-null:", src.count(old2))
src = src.replace(old2, new2)

# --- resize test: drain the terminal event queue after resize.
old3 = (
    '    harness.terminal.borrow_mut().writes.clear();\n'
    '    harness.terminal.borrow_mut().resize(60, 10);\n'
    '    settle(&mut harness);\n'
)
new3 = (
    '    harness.terminal.borrow_mut().writes.clear();\n'
    '    harness.terminal.borrow_mut().resize(60, 10);\n'
    '    harness.tui.poll_terminal_events();\n'
    '    settle(&mut harness);\n'
)
print("resize1:", src.count(old3))
src = src.replace(old3, new3)

old4 = (
    '    harness.terminal.borrow_mut().writes.clear();\n'
    '    harness.terminal.borrow_mut().resize(60, 15);\n'
    '    settle(&mut harness);\n'
)
new4 = (
    '    harness.terminal.borrow_mut().writes.clear();\n'
    '    harness.terminal.borrow_mut().resize(60, 15);\n'
    '    harness.tui.poll_terminal_events();\n'
    '    settle(&mut harness);\n'
)
print("resize2:", src.count(old4))
src = src.replace(old4, new4)

io.open(p, "w", encoding="utf-8", newline="").write(src)
print("done")
