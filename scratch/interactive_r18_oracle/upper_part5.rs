
    // -- paths / labels / scope groups ----------------------------------------------

    use super::super::super::interactive_mode::{
        build_scope_groups, find_source_info_for_path, format_diagnostics, format_display_path,
        format_extension_display_path, format_path_with_source, format_scope_groups,
        get_compact_extension_label, get_compact_extension_labels, get_compact_package_source_label,
        get_compact_path_label, get_display_source_info, get_scope_group, get_short_path,
        SourceInfoView,
    };
    use super::super::theme::Theme;

    fn source_info(value: Value) -> SourceInfoView {
        serde_json::from_value(value).expect("source info parses")
    }

    fn strip_ansi(text: &str) -> String {
        let mut out = String::new();
        let mut chars = text.chars();
        while let Some(char) = chars.next() {
            if char == '\x1b' {
                for escape in chars.by_ref() {
                    if escape.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                out.push(char);
            }
        }
        out
    }

    fn live_theme() -> Theme {
        load_builtin_theme("dark", Some(ColorMode::Truecolor)).expect("built-in theme")
    }

    #[test]
    fn paths_short_path() {
        replay_upper("paths.short-path", |shell, fixture| {
            let home = "/home/u";
            rec(&fixture.log, json!(["plain", get_short_path("/home/u/proj/file.ts", None, home)]));
            rec(&fixture.log, json!(["home", get_short_path("/home/u/file.ts", None, home)]));
            rec(
                &fixture.log,
                json!(["package", get_short_path(
                    "/home/u/proj/node_modules/@scope/pkg/dist/ext/index.js",
                    Some(&source_info(json!({
                        "baseDir": "/home/u/proj/node_modules/@scope/pkg",
                        "source": "npm:@scope/pkg",
                        "scope": "project",
                    }))),
                    home,
                )]),
            );
            rec(
                &fixture.log,
                json!(["package-external-under-root", get_short_path(
                    "/home/u/proj/node_modules/@scope/pkg-other/ext.js",
                    Some(&source_info(json!({
                        "baseDir": "/home/u/proj/node_modules/@scope/pkg",
                        "source": "npm:@scope/pkg",
                        "scope": "project",
                    }))),
                    home,
                )]),
            );
            rec(
                &fixture.log,
                json!(["npm-source", get_short_path(
                    "/work/project/node_modules/other/lib/x.ts",
                    Some(&source_info(json!({ "source": "npm:other", "scope": "project" }))),
                    home,
                )]),
            );
            rec(
                &fixture.log,
                json!(["npm-source-no-match", get_short_path(
                    "/elsewhere/x.ts",
                    Some(&source_info(json!({ "source": "npm:other", "scope": "project" }))),
                    home,
                )]),
            );
            rec(
                &fixture.log,
                json!(["no-source-info", get_short_path("/work/project/a/b.ts", None, home)]),
            );
            let _ = shell;
        });
    }

    #[test]
    fn paths_compact_labels() {
        replay_upper("paths.compact-labels", |shell, fixture| {
            let home = "/home/u";
            rec(
                &fixture.log,
                json!(["path", get_compact_path_label("/home/u/deep/dir/file.ts", None, home)]),
            );
            rec(&fixture.log, json!(["path-empty-segments", get_compact_path_label("", None, home)]));
            rec(
                &fixture.log,
                json!(["package-source", get_compact_package_source_label(Some(&source_info(
                    json!({ "source": "npm:@scope/pkg", "scope": "project" }),
                )))]),
            );
            rec(
                &fixture.log,
                json!(["package-source-git", get_compact_package_source_label(Some(&source_info(
                    json!({ "source": "git://github.com/o/r", "scope": "project" }),
                )))]),
            );
            rec(
                &fixture.log,
                json!(["package-source-bare", get_compact_package_source_label(Some(&source_info(
                    json!({ "source": "local", "scope": "project" }),
                )))]),
            );
            rec(
                &fixture.log,
                json!(["ext-label-package", get_compact_extension_label(
                    "/work/project/node_modules/@scope/pkg/extensions/index.js",
                    Some(&source_info(json!({
                        "baseDir": "/work/project/node_modules/@scope/pkg",
                        "source": "npm:@scope/pkg",
                        "scope": "project",
                    }))),
                    home,
                )]),
            );
            rec(
                &fixture.log,
                json!(["ext-label-package-subdir", get_compact_extension_label(
                    "/work/project/node_modules/@scope/pkg/extensions/tools/run.js",
                    Some(&source_info(json!({
                        "baseDir": "/work/project/node_modules/@scope/pkg",
                        "source": "npm:@scope/pkg",
                        "scope": "project",
                    }))),
                    home,
                )]),
            );
            rec(
                &fixture.log,
                json!(["ext-label-nonpackage", get_compact_extension_label(
                    "/work/project/exts/my.ts",
                    None,
                    home,
                )]),
            );
            let _ = shell;
        });
    }

    #[test]
    fn paths_compact_extension_labels() {
        replay_upper("paths.compact-extension-labels", |shell, fixture| {
            let home = "/home/u";
            let extensions = vec![
                ("/work/project/exts/alpha.ts".to_string(), None),
                ("/work/project/exts/beta/index.ts".to_string(), None),
                ("/work/project/exts/beta/gamma/index.js".to_string(), None),
                (
                    "/work/project/node_modules/@scope/pkg/extensions/index.js".to_string(),
                    Some(source_info(json!({
                        "baseDir": "/work/project/node_modules/@scope/pkg",
                        "source": "npm:@scope/pkg",
                        "scope": "project",
                    }))),
                ),
                ("/single.ts".to_string(), None),
            ];
            rec(
                &fixture.log,
                json!(["labels", get_compact_extension_labels(&extensions, home)]),
            );
            let _ = shell;
        });
    }

    #[test]
    fn paths_display_source_info_and_scope() {
        replay_upper("paths.display-source-info-and-scope", |shell, fixture| {
            let render = |info: Option<SourceInfoView>| -> Value {
                let rendered = get_display_source_info(info.as_ref());
                let mut map = serde_json::Map::new();
                map.insert("label".to_string(), json!(rendered.label));
                if let Some(scope_label) = rendered.scope_label {
                    map.insert("scopeLabel".to_string(), json!(scope_label));
                }
                map.insert("color".to_string(), json!(rendered.color));
                Value::Object(map)
            };
            rec(&fixture.log, json!(["undefined", render(None)]));
            rec(
                &fixture.log,
                json!(["local-user", render(Some(source_info(json!({ "scope": "user", "source": "local" }))))]),
            );
            rec(
                &fixture.log,
                json!(["local-project", render(Some(source_info(json!({ "scope": "project", "source": "local" }))))]),
            );
            rec(
                &fixture.log,
                json!(["local-temporary", render(Some(source_info(json!({ "scope": "temporary", "source": "local" }))))]),
            );
            rec(
                &fixture.log,
                json!(["cli", render(Some(source_info(json!({ "scope": "project", "source": "cli" }))))]),
            );
            rec(
                &fixture.log,
                json!(["cli-temp", render(Some(source_info(json!({ "scope": "temporary", "source": "cli" }))))]),
            );
            rec(
                &fixture.log,
                json!(["npm", render(Some(source_info(json!({ "scope": "project", "source": "npm:pkg" }))))]),
            );
            let scope = |info: Option<SourceInfoView>| get_scope_group(info.as_ref()).as_str();
            rec(
                &fixture.log,
                json!([
                    "scope",
                    scope(Some(source_info(json!({ "scope": "user", "source": "local" })))),
                    scope(Some(source_info(json!({ "scope": "project", "source": "local" })))),
                    scope(Some(source_info(json!({ "scope": "temporary", "source": "cli" })))),
                    scope(Some(source_info(json!({ "scope": "temporary", "source": "local" })))),
                    scope(None),
                ]),
            );
            let _ = shell;
        });
    }

    #[test]
    fn paths_scope_groups() {
        replay_upper("paths.scope-groups", |shell, fixture| {
            let items = vec![
                ("/work/project/b.ts".to_string(), None),
                ("/work/project/a.ts".to_string(), None),
                (
                    "/home/u/.pi/skills/s.md".to_string(),
                    Some(source_info(json!({ "scope": "user", "source": "local" }))),
                ),
                (
                    "/work/project/node_modules/p/extensions/e.js".to_string(),
                    Some(source_info(json!({
                        "baseDir": "/work/project/node_modules/p",
                        "source": "npm:p",
                        "scope": "project",
                    }))),
                ),
                (
                    "/work/project/node_modules/p/extensions/a.js".to_string(),
                    Some(source_info(json!({
                        "baseDir": "/work/project/node_modules/p",
                        "source": "npm:p",
                        "scope": "project",
                    }))),
                ),
                (
                    "/tmp/x.ts".to_string(),
                    Some(source_info(json!({ "scope": "temporary", "source": "cli" }))),
                ),
            ];
            let groups = build_scope_groups(&items);
            let rendered_groups: Vec<Value> = groups
                .iter()
                .map(|group| {
                    json!({
                        "scope": group.scope.as_str(),
                        "paths": group.paths.iter().map(|(path, info)| {
                            let mut map = serde_json::Map::new();
                            map.insert("path".to_string(), json!(path));
                            if let Some(info) = info {
                                map.insert("sourceInfo".to_string(), serde_json::to_value(info).expect("info"));
                            }
                            Value::Object(map)
                        }).collect::<Vec<_>>(),
                        "packages": Value::Object(group.packages.iter().map(|(source, package_paths)| {
                            (source.clone(), Value::Array(package_paths.iter().map(|(path, info)| {
                                let mut map = serde_json::Map::new();
                                map.insert("path".to_string(), json!(path));
                                if let Some(info) = info {
                                    map.insert("sourceInfo".to_string(), serde_json::to_value(info).expect("info"));
                                }
                                Value::Object(map)
                            }).collect()))
                        }).collect()),
                    })
                })
                .collect();
            rec(&fixture.log, json!(["groups", rendered_groups]));
            let formatted = format_scope_groups(
                &groups,
                &live_theme(),
                |(path, _)| path.clone(),
                |(path, _)| path.clone(),
            );
            rec(
                &fixture.log,
                json!(["formatted", strip_ansi(&formatted)]),
            );
            let _ = shell;
        });
    }

    #[test]
    fn paths_find_source_info() {
        replay_upper("paths.find-source-info", |shell, fixture| {
            let mut infos = std::collections::HashMap::new();
            infos.insert(
                "/work/project/node_modules/p".to_string(),
                source_info(json!({
                    "baseDir": "/work/project/node_modules/p",
                    "source": "npm:p",
                    "scope": "project",
                })),
            );
            infos.insert(
                "/work/project".to_string(),
                source_info(json!({ "scope": "project", "source": "local" })),
            );
            rec(
                &fixture.log,
                json!(["exact", find_source_info_for_path("/work/project/a.ts", &infos).is_some()]),
            );
            rec(
                &fixture.log,
                json!(["parent", serde_json::to_value(
                    find_source_info_for_path("/work/project/node_modules/p/dist/ext.js", &infos),
                ).unwrap()]),
            );
            rec(
                &fixture.log,
                json!(["missing", find_source_info_for_path("/nowhere/a.ts", &infos).map(Value::from).unwrap_or(Value::Null)]),
            );
            let _ = shell;
        });
    }

    #[test]
    fn paths_format_path_with_source() {
        replay_upper("paths.format-path-with-source", |shell, fixture| {
            let home = "/home/u";
            let theme = live_theme();
            rec(
                &fixture.log,
                json!(["with-source", format_path_with_source(
                    "/work/project/node_modules/p/ext.js",
                    Some(&source_info(json!({
                        "baseDir": "/work/project/node_modules/p",
                        "source": "npm:p",
                        "scope": "project",
                    }))),
                    home,
                    &theme,
                )]),
            );
            rec(
                &fixture.log,
                json!(["user-scope", format_path_with_source(
                    "/home/u/.pi/x.md",
                    Some(&source_info(json!({ "scope": "user", "source": "local" }))),
                    home,
                    &theme,
                )]),
            );
            rec(
                &fixture.log,
                json!(["temp-scope", format_path_with_source(
                    "/tmp/y.md",
                    Some(&source_info(json!({ "scope": "temporary", "source": "cli" }))),
                    home,
                    &theme,
                )]),
            );
            rec(
                &fixture.log,
                json!(["no-source", format_path_with_source("/outside/path.md", None, home, &theme)]),
            );
            let _ = shell;
        });
    }

    #[test]
    fn paths_format_diagnostics() {
        replay_upper("paths.format-diagnostics", |shell, fixture| {
            let mut infos = std::collections::HashMap::new();
            infos.insert(
                "/work/project/skills/a.md".to_string(),
                source_info(json!({ "scope": "project", "source": "local" })),
            );
            use super::super::super::interactive_mode::DiagnosticKind;
            let diagnostics = vec![
                super::super::super::interactive_mode::ResourceDiagnostic {
                    kind: DiagnosticKind::Collision,
                    message: "duplicate skill".to_string(),
                    path: Some("/work/project/skills/a.md".to_string()),
                    collision: Some((
                        "review".to_string(),
                        "/work/project/skills/a.md".to_string(),
                        "/work/project/skills/other/review.md".to_string(),
                    )),
                },
                super::super::super::interactive_mode::ResourceDiagnostic {
                    kind: DiagnosticKind::Collision,
                    message: "duplicate skill 2".to_string(),
                    path: Some("/work/project/skills/other/review.md".to_string()),
                    collision: Some((
                        "review".to_string(),
                        "/work/project/skills/a.md".to_string(),
                        "/work/project/skills/other/review.md".to_string(),
                    )),
                },
                super::super::super::interactive_mode::ResourceDiagnostic {
                    kind: DiagnosticKind::Warning,
                    message: "bad frontmatter".to_string(),
                    path: Some("/work/project/skills/a.md".to_string()),
                    collision: None,
                },
                super::super::super::interactive_mode::ResourceDiagnostic {
                    kind: DiagnosticKind::Error,
                    message: "load failed".to_string(),
                    path: None,
                    collision: None,
                },
            ];
            let out = format_diagnostics(&diagnostics, &infos, "/home/u", &live_theme());
            rec(&fixture.log, json!(["out", strip_ansi(&out)]));
            let _ = shell;
        });
    }

    #[test]
    fn paths_format_display_helpers() {
        replay_upper("paths.format-display-helpers", |shell, fixture| {
            let home = "/home/u";
            rec(&fixture.log, json!(["display", format_display_path("/home/u/x.ts", home)]));
            rec(&fixture.log, json!(["display-other", format_display_path("/var/x.ts", home)]));
            rec(
                &fixture.log,
                json!(["extension", format_extension_display_path("/home/u/pack/extensions/index.ts", home)]),
            );
            rec(
                &fixture.log,
                json!(["extension-js", format_extension_display_path("/var/pack/extensions/index.js", home)]),
            );
            rec(&fixture.log, json!(["context", shell.format_context_path("/work/project/AGENTS.md")]));
            rec(
                &fixture.log,
                json!(["context-absolute", shell.format_context_path("/outside/AGENTS.md")]),
            );
            rec(
                &fixture.log,
                json!(["startup-expansion", shell.get_startup_expansion_state()]),
            );
        });
    }

    #[test]
    fn paths_show_loaded_resources() {
        replay_upper_with(
            "paths.show-loaded-resources",
            InteractiveModeOptions {
                verbose: true,
                ..InteractiveModeOptions::default()
            },
            |fixture| {
                *fixture.resources.skills.lock().expect("knob") =
                    super::super::super::interactive_mode::ResourceGroupRead {
                        items: vec![
                            loaded_resource(json!({
                                "name": "review",
                                "path": "/work/project/skills/review.md",
                                "description": "Review code",
                                "sourceInfo": { "scope": "project", "source": "local" },
                            })),
                            loaded_resource(json!({
                                "name": "deploy",
                                "path": "/work/project/node_modules/p/skills/deploy.md",
                                "description": "Deploy",
                                "sourceInfo": {
                                    "baseDir": "/work/project/node_modules/p",
                                    "source": "npm:p",
                                    "scope": "project",
                                },
                            })),
                        ],
                        diagnostics: vec![super::super::super::interactive_mode::ResourceDiagnostic {
                            kind: super::super::super::interactive_mode::DiagnosticKind::Collision,
                            message: "dup".to_string(),
                            path: Some("/work/project/skills/review.md".to_string()),
                            collision: Some((
                                "review".to_string(),
                                "/work/project/skills/review.md".to_string(),
                                "/work/project/skills/review.md".to_string(),
                            )),
                        }],
                    };
                *fixture.resources.prompts.lock().expect("knob") =
                    super::super::super::interactive_mode::ResourceGroupRead {
                        items: vec![loaded_resource(json!({
                            "name": "fix",
                            "path": "/work/project/prompts/fix.md",
                            "description": "Fix it",
                            "argumentHint": "[what]",
                            "sourceInfo": { "scope": "project", "source": "local" },
                        }))],
                        diagnostics: Vec::new(),
                    };
                *fixture.resources.themes.lock().expect("knob") =
                    super::super::super::interactive_mode::ResourceGroupRead {
                        items: vec![loaded_resource(json!({
                            "name": "solarized",
                            "sourcePath": "/work/project/themes/solarized.json",
                            "sourceInfo": { "scope": "project", "source": "local" },
                        }))],
                        diagnostics: Vec::new(),
                    };
                *fixture.resources.extensions.lock().expect("knob") = (
                    vec![
                        loaded_resource(json!({
                            "path": "/work/project/exts/one.ts",
                            "sourceInfo": { "scope": "project", "source": "local" },
                            "hidden": false,
                        })),
                        loaded_resource(json!({
                            "path": "/work/project/exts/hidden.ts",
                            "sourceInfo": { "scope": "project", "source": "local" },
                            "hidden": true,
                        })),
                        loaded_resource(json!({
                            "path": "/work/project/node_modules/p/extensions/index.js",
                            "sourceInfo": {
                                "baseDir": "/work/project/node_modules/p",
                                "source": "npm:p",
                                "scope": "project",
                            },
                            "hidden": false,
                        })),
                    ],
                    vec![(
                        "/work/project/exts/broken.ts".to_string(),
                        "syntax error".to_string(),
                    )],
                );
                *fixture
                    .resources
                    .system_prompt_source
                    .lock()
                    .expect("knob") = Some(loaded_resource(json!({
                        "path": "/work/project/AGENTS.md",
                    })));
            },
            |shell, fixture| {
                shell.show_loaded_resources(false, true);
                rec(
                    &fixture.log,
                    json!([
                        "children",
                        fixture.view.probe_children(ContainerId::LoadedResources),
                    ]),
                );
            },
        );
    }

    fn loaded_resource(value: Value) -> super::super::super::interactive_mode::LoadedResource {
        serde_json::from_value(value).expect("loaded resource parses")
    }

    // -- cycling + toggles + working indicator ---------------------------------------

    fn harness_model(name: &str, id: &str, provider: &str) -> crate::ai::types::model::Model {
        crate::ai::types::model::Model {
            id: id.to_string(),
            name: name.to_string(),
            api: String::new(),
            provider: provider.to_string(),
            base_url: String::new(),
            reasoning: false,
            thinking_level_map: None,
            input: Vec::new(),
            cost: crate::ai::types::primitives::ModelCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
                tiers: None,
            },
            context_window: 200_000,
            max_tokens: 8_192,
            sampling_params: None,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn cycle_thinking_supported() {
        replay_upper("cycle.thinking-supported", |shell, fixture| {
            *fixture.session.cycle_thinking.lock().expect("knob") = Some(ThinkingLevel::High);
            shell.cycle_thinking_level();
        });
    }

    #[test]
    fn cycle_thinking_unsupported() {
        replay_upper("cycle.thinking-unsupported", |shell, _| {
            shell.cycle_thinking_level();
        });
    }

    #[test]
    fn cycle_model_success() {
        replay_upper("cycle.model-success", |shell, fixture| {
            *fixture.session.cycle_model_outcome.lock().expect("knob") =
                super::CycleOutcome::Success(crate::coding_agent::agent_session::ModelCycleResult {
                    model: harness_model("Claude", "claude-x", "anthropic"),
                    thinking_level: ThinkingLevel::Medium,
                    is_scoped: false,
                });
            futures::executor::block_on(shell.cycle_model(CycleDirection::Forward));
        });
    }

    #[test]
    fn cycle_model_success_thinking_off() {
        replay_upper("cycle.model-success-thinking-off", |shell, fixture| {
            *fixture.session.cycle_model_outcome.lock().expect("knob") =
                super::CycleOutcome::Success(crate::coding_agent::agent_session::ModelCycleResult {
                    model: harness_model("", "m1", "p"),
                    thinking_level: ThinkingLevel::Off,
                    is_scoped: false,
                });
            futures::executor::block_on(shell.cycle_model(CycleDirection::Backward));
        });
    }

    #[test]
    fn cycle_model_single_in_scope() {
        replay_upper("cycle.model-single-in-scope", |shell, fixture| {
            fixture.session.scoped.lock().expect("knob").push(ScopedModel {
                model: harness_model("", "m", "p"),
                thinking_level: Some(ThinkingLevel::Off),
            });
            futures::executor::block_on(shell.cycle_model(CycleDirection::Forward));
        });
    }

    #[test]
    fn cycle_model_single_available() {
        replay_upper("cycle.model-single-available", |shell, _| {
            futures::executor::block_on(shell.cycle_model(CycleDirection::Backward));
        });
    }

    #[test]
    fn cycle_model_error() {
        replay_upper("cycle.model-error", |shell, fixture| {
            *fixture.session.cycle_model_outcome.lock().expect("knob") =
                super::CycleOutcome::Error("no models".to_string());
            futures::executor::block_on(shell.cycle_model(CycleDirection::Forward));
        });
    }

    #[test]
    fn cycle_model_custom_error() {
        replay_upper("cycle.model-custom-error", |shell, fixture| {
            *fixture.session.cycle_model_outcome.lock().expect("knob") =
                super::CycleOutcome::Error("string error".to_string());
            futures::executor::block_on(shell.cycle_model(CycleDirection::Forward));
        });
    }

    #[test]
    fn toggle_tool_output() {
        replay_upper("toggle.tool-output", |shell, fixture| {
            shell.lock().built_in_header = Some(ComponentRef {
                kind: "header".to_string(),
                id: 0,
            });
            fixture
                .view
                .container_add_component(ContainerId::Chat, &ComponentRef {
                    kind: "child".to_string(),
                    id: 0,
                });
            shell.set_tools_expanded(true);
            shell.set_tools_expanded(true); // idempotent
            shell.toggle_tool_output_expansion();
            rec(
                &fixture.log,
                json!(["final", shell.state_snapshot().tool_output_expanded]),
            );
        });
    }

    #[test]
    fn toggle_thinking_blocks() {
        replay_upper("toggle.thinking-blocks", |shell, fixture| {
            fixture
                .view
                .container_add_component(ContainerId::Chat, &ComponentRef {
                    kind: "child".to_string(),
                    id: 0,
                });
            shell.toggle_thinking_block_visibility();
            rec(
                &fixture.log,
                json!(["final", shell.state_snapshot().hide_thinking_block]),
            );
        });
    }

    #[test]
    fn toggle_hidden_thinking_label() {
        replay_upper("toggle.hidden-thinking-label", |shell, fixture| {
            fixture
                .view
                .container_add_component(ContainerId::Chat, &ComponentRef {
                    kind: "child".to_string(),
                    id: 0,
                });
            shell.lock().streaming_component = Some(ComponentRef {
                kind: "streaming".to_string(),
                id: 0,
            });
            shell.set_hidden_thinking_label(Some("Eliding..."));
            shell.set_hidden_thinking_label(None);
        });
    }

    #[test]
    fn working_visible_false() {
        replay_upper("working.visible-false", |shell, _| {
            shell.set_working_visible(false);
        });
    }

    #[test]
    fn working_visible_true_while_streaming() {
        replay_upper("working.visible-true-while-streaming", |shell, fixture| {
            fixture
                .session
                .streaming
                .store(true, std::sync::atomic::Ordering::SeqCst);
            shell.set_working_visible(true);
        });
    }

    #[test]
    fn working_indicator_options() {
        replay_upper("working.indicator-options", |shell, _| {
            shell.set_working_indicator(Some(json!({ "frames": ["a", "b"] })));
            shell.set_working_indicator(None);
        });
    }

    #[test]
    fn working_status_indicator_lifecycle() {
        replay_upper("working.status-indicator-lifecycle", |shell, fixture| {
            let indicator = ComponentRef {
                kind: "indicator".to_string(),
                id: 7,
            };
            fixture.view.register_describe(
                7,
                indicator_describe("working", &["dispose", "invalidate", "setMessage", "setIndicator"]),
            );
            shell.show_status_indicator(indicator, "working");
            shell.clear_status_indicator(Some("retry")); // wrong kind, no-op
            shell.clear_status_indicator(Some("working"));
            rec(
                &fixture.log,
                json!(["children", fixture.view.probe_children(ContainerId::Status)]),
            );
        });
    }

    #[test]
    fn working_show_working_indicator_non_embedded() {
        replay_upper("working.show-working-indicator-non-embedded", |shell, fixture| {
            fixture
                .default_editor
                .embeds
                .store(false, std::sync::atomic::Ordering::SeqCst);
            shell.show_working_status_indicator();
            rec(
                &fixture.log,
                json!(["embedded", shell.lock().active_working_indicator_embedded]),
            );
            rec(
                &fixture.log,
                json!(["children", fixture.view.probe_children(ContainerId::Status)]),
            );
        });
    }

    #[test]
    fn working_editor_embedded() {
        replay_upper("working.editor-embedded", |shell, fixture| {
            let indicator = ComponentRef {
                kind: "indicator".to_string(),
                id: 9,
            };
            fixture.view.register_describe(
                9,
                indicator_describe("working", &["dispose", "setMessage"]),
            );
            shell.show_status_indicator(indicator, "working");
            rec(
                &fixture.log,
                json!(["embedded", shell.lock().active_working_indicator_embedded]),
            );
        });
    }

    #[test]
    fn extension_set_status() {
        replay_upper("extension.set-status", |shell, _| {
            shell.set_extension_status("k1", Some("text"));
            shell.set_extension_status("k1", None);
        });
    }
