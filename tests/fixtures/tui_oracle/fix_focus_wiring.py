# One-off fixer for focus-scenario wiring in tui_tests.rs (scratch tool).
import io

p = r"C:/Users/13063/Desktop/code/agent work/pi-rust/src/tui/tui_tests.rs"
src = io.open(p, encoding="utf-8").read()

CR = "\r"

def rep(old, new, tag, expect=1):
    global src
    n = src.count(old)
    print(tag, "->", n)
    if n == expect:
        src = src.replace(old, new)

# Scenario: replacement receives close input (plain component, script only).
old1 = (
    '        fx.show_scripted("OVERLAY", None, FocusFixture::focus_script("REPLACEMENT"));\n'
    '        fx.plain_component("REPLACEMENT");\n'
    '        fx.show_scripted(\n'
    '            "REPLACEMENT",\n'
    '            None,\n'
    '            Box::new(|data| {\n'
    '                if data == "\\r" {\n'
    '                    vec![ScriptAction::Focus("editor")]\n'
    '                } else {\n'
    '                    Vec::new()\n'
    '                }\n'
    '            }),\n'
    '        );\n'
)
new1 = (
    '        fx.show_scripted("OVERLAY", None, FocusFixture::focus_script("REPLACEMENT"));\n'
    '        fx.plain_component("REPLACEMENT");\n'
    '        fx.shared["REPLACEMENT"].borrow_mut().script = Some(Box::new(|data| {\n'
    '            if data == "\\r" {\n'
    '                vec![ScriptAction::Focus("editor")]\n'
    '            } else {\n'
    '                Vec::new()\n'
    '            }\n'
    '        }));\n'
)
rep(old1, new1, "close-input")

# Scenario: replacement is another overlay preFocus (plain component).
old2 = (
    '        fx.show_scripted("OVERLAY", None, FocusFixture::focus_script("REPLACEMENT"));\n'
    '        fx.plain_component("REPLACEMENT");\n'
    '        fx.show_scripted(\n'
    '            "REPLACEMENT",\n'
    '            None,\n'
    '            Box::new(|data| {\n'
    '                if data == "\\r" {\n'
    '                    vec![ScriptAction::Focus("editor")]\n'
    '                } else {\n'
    '                    Vec::new()\n'
    '                }\n'
    '            }),\n'
    '        );\n'
    '        fx.send("b", "OVERLAY");'
)
new2 = (
    '        fx.show_scripted("OVERLAY", None, FocusFixture::focus_script("REPLACEMENT"));\n'
    '        fx.plain_component("REPLACEMENT");\n'
    '        fx.shared["REPLACEMENT"].borrow_mut().script = Some(Box::new(|data| {\n'
    '            if data == "\\r" {\n'
    '                vec![ScriptAction::Focus("editor")]\n'
    '            } else {\n'
    '                Vec::new()\n'
    '            }\n'
    '        }));\n'
    '        fx.send("b", "OVERLAY");'
)
rep(old2, new2, "pre-focus")

# Blocked test 1: FIRST/SECOND are plain base children.
old3 = (
    '        fx.show_scripted("OVERLAY", None, FocusFixture::focus_script("FIRST"));\n'
    '        fx.show_scripted(\n'
    '            "FIRST",\n'
    '            None,\n'
    '            Box::new(|data| {\n'
    '                if data == "n" {\n'
    '                    vec![ScriptAction::Focus("SECOND")]\n'
    '                } else {\n'
    '                    Vec::new()\n'
    '                }\n'
    '            }),\n'
    '        );\n'
    '        {\n'
    '            let base_shared = base_shared.clone();\n'
    '            let editor_handle = fx.component("editor");\n'
    '            fx.show_scripted(\n'
    '                "SECOND",\n'
    '                None,\n'
    '                Box::new(move |data| {\n'
    '                    if data == "\\r" {\n'
    '                        vec![ScriptAction::RebuildBaseAndFocus {\n'
    '                            base: base_shared.clone(),\n'
    '                            child: editor_handle.clone(),\n'
    '                        }]\n'
    '                    } else {\n'
    '                        Vec::new()\n'
    '                    }\n'
    '                }),\n'
    '            );\n'
    '        }'
)
new3 = (
    '        fx.show_scripted("OVERLAY", None, FocusFixture::focus_script("FIRST"));\n'
    '        fx.shared["FIRST"].borrow_mut().script = Some(Box::new(|data| {\n'
    '            if data == "n" {\n'
    '                vec![ScriptAction::Focus("SECOND")]\n'
    '            } else {\n'
    '                Vec::new()\n'
    '            }\n'
    '        }));\n'
    '        {\n'
    '            let base_shared = base_shared.clone();\n'
    '            let editor_handle = fx.component("editor");\n'
    '            fx.shared["SECOND"].borrow_mut().script = Some(Box::new(move |data| {\n'
    '                if data == "\\r" {\n'
    '                    vec![ScriptAction::RebuildBaseAndFocus {\n'
    '                        base: base_shared.clone(),\n'
    '                        child: editor_handle.clone(),\n'
    '                    }]\n'
    '                } else {\n'
    '                    Vec::new()\n'
    '                }\n'
    '            }));\n'
    '        }'
)
rep(old3, new3, "blocked1")

# Blocked test 2: REPLACEMENT is a plain base child.
old4 = (
    '        fx.show_scripted("OVERLAY", None, FocusFixture::focus_script("REPLACEMENT"));\n'
    '        {\n'
    '            let base_shared = base_shared.clone();\n'
    '            let editor_handle = fx.component("editor");\n'
    '            fx.show_scripted(\n'
    '                "REPLACEMENT",\n'
    '                None,\n'
    '                Box::new(move |data| {\n'
    '                    if data == "\\r" {\n'
    '                        vec![ScriptAction::RebuildBaseAndFocus {\n'
    '                            base: base_shared.clone(),\n'
    '                            child: editor_handle.clone(),\n'
    '                        }]\n'
    '                    } else {\n'
    '                        Vec::new()\n'
    '                    }\n'
    '                }),\n'
    '            );\n'
    '        }'
)
new4 = (
    '        fx.show_scripted("OVERLAY", None, FocusFixture::focus_script("REPLACEMENT"));\n'
    '        {\n'
    '            let base_shared = base_shared.clone();\n'
    '            let editor_handle = fx.component("editor");\n'
    '            fx.shared["REPLACEMENT"].borrow_mut().script = Some(Box::new(move |data| {\n'
    '                if data == "\\r" {\n'
    '                    vec![ScriptAction::RebuildBaseAndFocus {\n'
    '                        base: base_shared.clone(),\n'
    '                        child: editor_handle.clone(),\n'
    '                    }]\n'
    '                } else {\n'
    '                    Vec::new()\n'
    '                }\n'
    '            }));\n'
    '        }'
)
rep(old4, new4, "blocked2")

io.open(p, "w", encoding="utf-8", newline="").write(src)
print("done")
