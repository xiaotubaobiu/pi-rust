//! Tests for the `micro/` port: pinned to the node oracle
//! (scratch/experimental_final_oracle/oracle_view_out.json, `microTui` and
//! `microUsage` sections).

use super::api::{
    status_text, CompactionState, GenerationState, InboxItem, MicroProviderAccount, MicroView,
    ModelRef, NoticeLevel, RunningToolView,
};
use super::main::parse_micro_args;
use super::models::{to_ai_context, ToolDeclarationInput};
use super::runtime::{
    cycle_thinking, fold_event, usage_view, AssistantUsage, UsageAccumulator, UsageEntry,
    UsageRecord, WatchEvent,
};
use super::sessions::{
    cwd_key, is_micro_session_directory_name, new_micro_session_path, newest_micro_session,
    no_micro_session_error, select_session_location,
};
use super::tui::{
    auth_selector_providers, footer_hints, footer_stats, format_tokens, notice_lines,
    order_models_current_first, queue_lines, route_submit, split_model_value, SubmitRoute,
};

#[test]
fn status_text_matches_the_oracle() {
    // Oracle: microTui.status (10 cases in order).
    let fatal = MicroView {
        fatal: Some("disk full".to_string()),
        ..Default::default()
    };
    assert_eq!(status_text(&fatal), "Fatal: disk full");

    let compaction_running = MicroView {
        compaction: Some(CompactionState {
            reason: "threshold".to_string(),
            stage: Some("running".to_string()),
            attempt: 1,
            task_id: None,
        }),
        ..Default::default()
    };
    assert_eq!(
        status_text(&compaction_running),
        "Running automatic compaction..."
    );

    let compaction_retrying = MicroView {
        compaction: Some(CompactionState {
            reason: "manual".to_string(),
            stage: Some("retrying".to_string()),
            attempt: 3,
            task_id: None,
        }),
        ..Default::default()
    };
    assert_eq!(
        status_text(&compaction_retrying),
        "Retrying manual compaction (attempt 3)..."
    );

    let generation = |stage: &str, attempt: u64| MicroView {
        generation: Some(GenerationState {
            stage: stage.to_string(),
            attempt,
        }),
        ..Default::default()
    };
    assert_eq!(
        status_text(&generation("retrying", 2)),
        "Retrying generation (attempt 2)..."
    );
    assert_eq!(
        status_text(&generation("deferred", 0)),
        "Waiting for deferred response..."
    );
    assert_eq!(
        status_text(&generation("waiting", 0)),
        "Waiting for compaction..."
    );
    assert_eq!(
        status_text(&generation("streaming", 0)),
        "Working... (esc to abort)"
    );
    assert_eq!(
        status_text(&generation("preparing", 0)),
        "Preparing response..."
    );

    let running_tool = MicroView {
        running_tool: Some(RunningToolView {
            name: "bash".to_string(),
        }),
        ..Default::default()
    };
    assert_eq!(status_text(&running_tool), "Running bash... (esc to abort)");

    assert_eq!(status_text(&MicroView::default()), "");
}

#[test]
fn footer_stats_and_hints_match_the_oracle() {
    // Oracle: microTui.footer (5 cases).
    let usage = |input: f64,
                 output: f64,
                 cache_read: f64,
                 cache_write: f64,
                 total_cost: f64,
                 rate: Option<f64>,
                 context_tokens: Option<f64>,
                 context_window: u64,
                 context_percent: Option<f64>|
     -> MicroUsageViewFixture {
        MicroUsageViewFixture {
            input,
            output,
            cache_read,
            cache_write,
            total_cost,
            rate,
            context_tokens,
            context_window,
            context_percent,
        }
    };
    struct MicroUsageViewFixture {
        input: f64,
        output: f64,
        cache_read: f64,
        cache_write: f64,
        total_cost: f64,
        rate: Option<f64>,
        context_tokens: Option<f64>,
        context_window: u64,
        context_percent: Option<f64>,
    }
    // Upstream `#syncFooter` reads the precomputed `usage.contextPercent`
    // field (oracle fixtures carry it directly).
    let build = |fixture: &MicroUsageViewFixture, threshold: Option<f64>| MicroView {
        usage: super::api::MicroUsageView {
            input: fixture.input,
            output: fixture.output,
            cache_read: fixture.cache_read,
            cache_write: fixture.cache_write,
            total_cost: fixture.total_cost,
            last_cache_hit_rate: fixture.rate,
            context_tokens: fixture.context_tokens,
            context_window: fixture.context_window,
            context_percent: fixture.context_percent,
        },
        threshold,
        ..Default::default()
    };

    let first = build(
        &usage(
            1234.0,
            567.0,
            89_000.0,
            0.0,
            1.23456,
            Some(66.66),
            Some(90_000.0),
            200_000,
            Some(45.0),
        ),
        Some(0.0),
    );
    assert_eq!(
        footer_stats(&first).text,
        "↑1.2k ↓567 R89.0k CH66.7% $1.235 45.0%/200.0k"
    );

    let second = build(
        &usage(0.0, 0.0, 0.0, 0.0, 0.0, None, None, 100_000, None),
        Some(5000.0),
    );
    assert_eq!(footer_stats(&second).text, "$0.000 ?/100.0k (auto)");

    let third = build(
        &usage(
            10.0,
            10.0,
            95_000.0,
            1000.0,
            0.5,
            Some(92.5),
            Some(180_000.0),
            200_000,
            Some(90.5),
        ),
        Some(5000.0),
    );
    assert_eq!(
        footer_stats(&third).text,
        "↑10 ↓10 R95.0k W1.0k CH92.5% $0.500 90.5%/200.0k (auto)"
    );
    assert_eq!(footer_stats(&third).color, Some("error"));

    let fourth = build(
        &usage(
            10.0,
            10.0,
            75_000.0,
            1000.0,
            0.5,
            Some(75.0),
            Some(150_000.0),
            200_000,
            Some(75.5),
        ),
        None,
    );
    assert_eq!(
        footer_stats(&fourth).text,
        "↑10 ↓10 R75.0k W1.0k CH75.0% $0.500 75.5%/200.0k"
    );
    assert_eq!(footer_stats(&fourth).color, Some("warning"));

    assert_eq!(
        footer_hints(
            Some(&ModelRef {
                provider: "p".to_string(),
                model_id: "m".to_string(),
            }),
            Some("high"),
            "alt+t",
            "(ctrl+p)",
            "(alt+enter)",
            "(ctrl+c)",
        ),
        "p/m · thinking:high (alt+t) · (ctrl+p) or /model · /login · /compact · (alt+enter) follow-up · (ctrl+c) exit"
    );
    assert_eq!(
        footer_hints(None, None, "alt+t", "(ctrl+p)", "(alt+enter)", "(ctrl+c)"),
        "no model · thinking:off (alt+t) · (ctrl+p) or /model · /login · /compact · (alt+enter) follow-up · (ctrl+c) exit"
    );
}

#[test]
fn queue_notice_and_provider_lines_match_the_oracle() {
    // Oracle: microTui.queue / notices / authProviders / selectModelOrder /
    // valueSplit.
    let view = MicroView {
        inbox: vec![
            InboxItem::Message {
                mode: "steer".to_string(),
                text: "hello".to_string(),
            },
            InboxItem::Message {
                mode: "followUp".to_string(),
                text: "ab".to_string(),
            },
            InboxItem::Write {
                mode: "write".to_string(),
                entry_kind: "memory.append".to_string(),
            },
        ],
        ..Default::default()
    };
    assert_eq!(
        queue_lines(&view),
        vec![
            "[steer] hello".to_string(),
            "[followUp] ab".to_string(),
            "[write] <memory.append>".to_string()
        ]
    );

    let mut view = MicroView::default();
    for (id, level, message) in [
        (1, NoticeLevel::Info, "a"),
        (2, NoticeLevel::Warning, "b"),
        (3, NoticeLevel::Error, "c"),
        (4, NoticeLevel::Info, "d"),
        (5, NoticeLevel::Error, "e"),
    ] {
        view.notices.push(super::api::MicroNotice {
            id,
            level,
            message: message.to_string(),
        });
    }
    assert_eq!(
        notice_lines(&view),
        vec![
            ("b".to_string(), "warning"),
            ("c".to_string(), "error"),
            ("d".to_string(), "muted"),
            ("e".to_string(), "error"),
        ]
    );

    let providers = auth_selector_providers(&[
        MicroProviderAccount {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            auth_type: super::api::AuthType::Oauth,
            configured: true,
            source: Some("stored".to_string()),
            interactive: true,
            method_name: Some("Claude account".to_string()),
        },
        MicroProviderAccount {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            auth_type: super::api::AuthType::ApiKey,
            configured: false,
            source: None,
            interactive: true,
            method_name: Some("API key".to_string()),
        },
        MicroProviderAccount {
            id: "bedrock".to_string(),
            name: "Bedrock".to_string(),
            auth_type: super::api::AuthType::ApiKey,
            configured: true,
            source: None,
            interactive: false,
            method_name: None,
        },
    ]);
    assert_eq!(providers[0].status.as_ref().unwrap().source, "stored");
    assert_eq!(providers[1].status, None);
    assert_eq!(providers[2].status.as_ref().unwrap().source, "configured");

    let models = vec![
        ModelRef {
            provider: "p1".to_string(),
            model_id: "m1".to_string(),
        },
        ModelRef {
            provider: "p2".to_string(),
            model_id: "m1".to_string(),
        },
        ModelRef {
            provider: "p2".to_string(),
            model_id: "m2".to_string(),
        },
        ModelRef {
            provider: "p1".to_string(),
            model_id: "m3".to_string(),
        },
    ];
    let ordered = order_models_current_first(
        &models,
        Some(&ModelRef {
            provider: "p2".to_string(),
            model_id: "m1".to_string(),
        }),
    );
    let labels: Vec<String> = ordered
        .iter()
        .map(|model| format!("{}/{}", model.provider, model.model_id))
        .collect();
    assert_eq!(
        labels,
        vec![
            "p2/m1".to_string(),
            "p1/m1".to_string(),
            "p2/m2".to_string(),
            "p1/m3".to_string()
        ]
    );

    assert_eq!(
        split_model_value("provider.name/model-id"),
        ("provider.name".to_string(), "model-id".to_string())
    );
}

#[test]
fn usage_accumulator_and_view_match_the_oracle() {
    // Oracle: microUsage.accumulator / view / viewNoWindow.
    let mut accumulator = UsageAccumulator::default();
    let assistant = |stop_reason: &str, usage: UsageRecord| AssistantUsage {
        stop_reason: stop_reason.to_string(),
        usage,
    };
    accumulator.accumulate(&UsageEntry {
        id: 1,
        assistant: Some(assistant(
            "stop",
            UsageRecord {
                input: 10.0,
                output: 5.0,
                cache_read: 70.0,
                cache_write: 20.0,
                total_tokens: 105.0,
                cost_total: 0.1,
            },
        )),
        usage_record: None,
    });
    accumulator.accumulate(&UsageEntry {
        id: 2,
        assistant: Some(assistant(
            "aborted",
            UsageRecord {
                input: 10.0,
                output: 5.0,
                cache_read: 0.0,
                cache_write: 0.0,
                total_tokens: 15.0,
                cost_total: 0.2,
            },
        )),
        usage_record: None,
    });
    accumulator.accumulate(&UsageEntry {
        id: 3,
        assistant: None,
        usage_record: Some(UsageRecord {
            input: 1.0,
            output: 1.0,
            cache_read: 0.0,
            cache_write: 0.0,
            total_tokens: 0.0,
            cost_total: 0.3,
        }),
    });
    // Duplicate entry id: skipped entirely (upstream `seen` set).
    accumulator.accumulate(&UsageEntry {
        id: 2,
        assistant: Some(assistant(
            "stop",
            UsageRecord {
                input: 999.0,
                output: 999.0,
                cache_read: 0.0,
                cache_write: 0.0,
                total_tokens: 0.0,
                cost_total: 9.0,
            },
        )),
        usage_record: None,
    });

    assert_eq!(accumulator.input, 21.0);
    assert_eq!(accumulator.output, 11.0);
    assert_eq!(accumulator.cache_read, 70.0);
    assert_eq!(accumulator.cache_write, 20.0);
    assert!((accumulator.total_cost - 0.6).abs() < 1e-12);
    assert_eq!(accumulator.last_assistant_id, 1);
    assert!((accumulator.last_cache_hit_rate.unwrap() - 70.0).abs() < 1e-12);

    let entries = vec![
        super::runtime::ConversationEntryView {
            id: 1,
            is_summary: false,
            assistant: None,
        },
        super::runtime::ConversationEntryView {
            id: 2,
            is_summary: true,
            assistant: None,
        },
        super::runtime::ConversationEntryView {
            id: 3,
            is_summary: false,
            assistant: Some(assistant(
                "stop",
                UsageRecord {
                    input: 7.0,
                    output: 3.0,
                    cache_read: 40.0,
                    cache_write: 10.0,
                    total_tokens: 0.0,
                    cost_total: 0.0,
                },
            )),
        },
        super::runtime::ConversationEntryView {
            id: 4,
            is_summary: false,
            assistant: Some(assistant(
                "aborted",
                UsageRecord {
                    input: 999.0,
                    output: 999.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                    total_tokens: 0.0,
                    cost_total: 0.0,
                },
            )),
        },
        super::runtime::ConversationEntryView {
            id: 5,
            is_summary: false,
            assistant: Some(assistant(
                "error",
                UsageRecord {
                    input: 888.0,
                    output: 888.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                    total_tokens: 0.0,
                    cost_total: 0.0,
                },
            )),
        },
    ];
    let view = usage_view(
        &accumulator,
        Some(&ModelRef {
            provider: "p".to_string(),
            model_id: "m".to_string(),
        }),
        &entries,
        1000,
    );
    assert_eq!(view.context_tokens, Some(60.0));
    assert_eq!(view.context_window, 1000);
    assert_eq!(view.context_percent, Some(6.0));
    assert_eq!(view.last_cache_hit_rate, Some(70.0));

    // Unknown model reference: zero window, null percent.
    let view = usage_view(
        &accumulator,
        Some(&ModelRef {
            provider: "x".to_string(),
            model_id: "y".to_string(),
        }),
        &entries,
        0,
    );
    assert_eq!(view.context_window, 0);
    assert_eq!(view.context_percent, None);
}

#[test]
fn fold_events_match_the_oracle_notices() {
    // Oracle: microUsage.folds / notices.
    let fold = |event: &WatchEvent, previous: Option<&CompactionState>| match fold_event(
        event, previous,
    ) {
        super::runtime::FoldOutcome::Accumulate => "accumulate".to_string(),
        super::runtime::FoldOutcome::Folded(_) => "folded".to_string(),
    };
    assert_eq!(fold(&WatchEvent::EntryAdded, None), "accumulate");
    assert_eq!(
        fold(
            &WatchEvent::Warning {
                message: "watch out".to_string()
            },
            None
        ),
        "folded"
    );
    assert_eq!(
        fold(
            &WatchEvent::GenerationFailed {
                reason: "overflow".to_string(),
                detail: "context full".to_string()
            },
            None
        ),
        "folded"
    );
    assert_eq!(
        fold(
            &WatchEvent::GenerationFailed {
                reason: "error".to_string(),
                detail: "boom".to_string()
            },
            None
        ),
        "folded"
    );
    assert_eq!(
        fold(
            &WatchEvent::CompactionFailed {
                detail: "no space".to_string()
            },
            None
        ),
        "folded"
    );
    assert_eq!(
        fold(
            &WatchEvent::CompactionFinished,
            Some(&CompactionState {
                reason: "threshold".to_string(),
                stage: None,
                attempt: 1,
                task_id: None,
            })
        ),
        "folded"
    );
    assert_eq!(
        fold(
            &WatchEvent::CompactionFinished,
            Some(&CompactionState {
                reason: "manual".to_string(),
                stage: None,
                attempt: 1,
                task_id: None,
            })
        ),
        "folded"
    );

    // The exact notice payloads.
    let folded = |event: &WatchEvent, previous: Option<&CompactionState>| match fold_event(
        event, previous,
    ) {
        super::runtime::FoldOutcome::Folded(notices) => notices,
        super::runtime::FoldOutcome::Accumulate => Vec::new(),
    };
    assert_eq!(
        folded(
            &WatchEvent::Warning {
                message: "watch out".to_string()
            },
            None
        ),
        vec![(NoticeLevel::Warning, "watch out".to_string())]
    );
    assert_eq!(
        folded(
            &WatchEvent::GenerationFailed {
                reason: "overflow".to_string(),
                detail: "context full".to_string()
            },
            None
        ),
        vec![(NoticeLevel::Info, "context full".to_string())]
    );
    assert_eq!(
        folded(
            &WatchEvent::GenerationFailed {
                reason: "error".to_string(),
                detail: "boom".to_string()
            },
            None
        ),
        vec![(NoticeLevel::Error, "boom".to_string())]
    );
    assert_eq!(
        folded(
            &WatchEvent::CompactionFailed {
                detail: "no space".to_string()
            },
            None
        ),
        vec![(
            NoticeLevel::Error,
            "Compaction failed: no space".to_string()
        )]
    );
    assert_eq!(
        folded(
            &WatchEvent::CompactionFinished,
            Some(&CompactionState {
                reason: "threshold".to_string(),
                stage: None,
                attempt: 1,
                task_id: None,
            })
        ),
        vec![(
            NoticeLevel::Info,
            "Automatic compaction completed.".to_string()
        )]
    );
    assert!(folded(
        &WatchEvent::CompactionFinished,
        Some(&CompactionState {
            reason: "manual".to_string(),
            stage: None,
            attempt: 1,
            task_id: None,
        })
    )
    .is_empty());
}

#[test]
fn thinking_cycle_advances_through_supported_levels() {
    // Upstream cycleThinking: next level wraps; "off" default.
    assert_eq!(cycle_thinking(Some("off"), &["off", "high"]), "high");
    assert_eq!(cycle_thinking(Some("high"), &["off", "high"]), "off");
    assert_eq!(cycle_thinking(Some("unknown"), &["off", "high"]), "off");
    assert_eq!(cycle_thinking(None, &[]), "off");
}

#[test]
fn session_naming_matches_the_oracle_scheme() {
    // Upstream cwdKey: sha256 hex prefix; the port's scheme pinned here.
    assert_eq!(cwd_key("/work/demo").len(), 24);
    assert!(is_micro_session_directory_name(
        "1700000000000-0123456789abcdef-0123-4567-89ab-cdef"
    ));
    assert!(is_micro_session_directory_name(
        "1700000000000-01234567-89ab-cdef-0123-456789abcdef"
    ));
    assert!(!is_micro_session_directory_name(
        "170000000000-0123456789abcdef-0123-4567-89ab-cdef"
    ));
    assert!(!is_micro_session_directory_name("not-a-session"));

    let entries = vec![
        "1700000000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_string(),
        "1699999999999-11111111-2222-3333-4444-555555555555".to_string(),
        "notes".to_string(),
    ];
    assert_eq!(
        newest_micro_session(&entries).unwrap(),
        "1700000000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    );
    assert_eq!(newest_micro_session(&["notes".to_string()]), None);

    let created = new_micro_session_path("/root", 1700000000123, "abc-def");
    assert!(created.ends_with("1700000000123-abc-def"));
    assert!(created.contains("1700000000123-abc-def"));
    assert_eq!(
        no_micro_session_error("/work/demo"),
        "No micro session exists for /work/demo"
    );
    assert_eq!(
        select_session_location("/work/demo", true, 0, "x", None, "/root").unwrap_err(),
        "No micro session exists for /work/demo"
    );
    let created =
        select_session_location("/work/demo", false, 1700000000123, "abc", None, "/root").unwrap();
    assert!(created.created);
    assert!(created.path.ends_with("1700000000123-abc"));
    let continued =
        select_session_location("/work/demo", true, 0, "", Some("17000-abc"), "/root").unwrap();
    assert!(!continued.created);
    assert_eq!(continued.id, "17000-abc");
}

#[test]
fn ai_context_grouping_matches_the_oracle() {
    // Oracle: microModels.aiContext — system prompts joined with blank
    // lines, removals before additions, non-system messages pass through.
    let system_messages = vec![
        super::models::SystemMessage {
            content: Some("one".to_string()),
            tools_removed: vec![],
            tools_added: vec![ToolDeclarationInput {
                name: "read".to_string(),
                description: "Read.".to_string(),
                parameters: serde_json::json!({ "t": 1 }),
            }],
        },
        super::models::SystemMessage {
            content: Some("two".to_string()),
            tools_removed: vec!["read".to_string()],
            tools_added: vec![ToolDeclarationInput {
                name: "bash".to_string(),
                description: "Bash.".to_string(),
                parameters: serde_json::json!({ "t": 2 }),
            }],
        },
    ];
    let mut metadata = std::collections::HashMap::new();
    metadata.insert(
        "bash".to_string(),
        super::models::ModelToolMetadata {
            constrained_sampling: Some(false),
        },
    );
    let context = to_ai_context(&system_messages, 2, &metadata);
    assert_eq!(context.system_prompt.as_deref(), Some("one\n\ntwo"));
    assert_eq!(context.non_system_message_count, 2);
    assert_eq!(context.tools.len(), 1);
    assert_eq!(context.tools[0].name, "bash");
    assert_eq!(context.tools[0].parameters, serde_json::json!({ "t": 2 }));
    assert_eq!(context.tools[0].constrained_sampling, Some(false));
}

#[test]
fn tool_declarations_follow_the_upstream_table() {
    // Upstream createMicroTools: read/bash/edit/write with exact replay and
    // output policies.
    let declarations = super::tools::micro_tool_declarations();
    let names: Vec<&str> = declarations
        .iter()
        .map(|declaration| declaration.name)
        .collect();
    assert_eq!(names, vec!["read", "bash", "edit", "write"]);
    assert_eq!(declarations[0].replay, super::tools::Replay::Safe);
    assert_eq!(declarations[1].replay, super::tools::Replay::Unsafe);
    assert_eq!(declarations[1].output.retain, super::tools::Retain::Tail);
    assert_eq!(declarations[0].output.retain, super::tools::Retain::Head);
    for declaration in &declarations {
        assert_eq!(declaration.output.max_bytes, 128 * 1024);
        assert_eq!(declaration.output.max_lines, 2500);
    }
    // Progress flush cadence: checkpoint or >=100ms.
    assert!(super::tools::should_flush_progress(true, 0, 0));
    assert!(!super::tools::should_flush_progress(false, 1000, 1050));
    assert!(super::tools::should_flush_progress(false, 1000, 1100));
}

#[test]
fn submit_routing_and_args_match_upstream() {
    // Oracle: submitRoute decisions + micro main parseArgs.
    assert_eq!(route_submit("", false), SubmitRoute::Ignore);
    assert_eq!(route_submit("/model", false), SubmitRoute::SelectModel);
    assert_eq!(route_submit("/login", false), SubmitRoute::Login);
    assert_eq!(route_submit("/compact", false), SubmitRoute::Compact);
    assert_eq!(route_submit("hello", true), SubmitRoute::Steer);
    assert_eq!(route_submit("hello", false), SubmitRoute::Prompt);

    let options = parse_micro_args(&["--continue".to_string()]).unwrap();
    assert!(options.continue_session);
    let options = parse_micro_args(&["-c".to_string()]).unwrap();
    assert!(options.continue_session);
    let options = parse_micro_args(&[]).unwrap();
    assert!(!options.continue_session);
    assert_eq!(
        parse_micro_args(&["--bogus".to_string()]).unwrap_err(),
        "Unknown argument: --bogus"
    );
}

#[test]
fn format_tokens_matches_the_oracle_scale() {
    assert_eq!(format_tokens(1234.0), "1.2k");
    assert_eq!(format_tokens(567.0), "567");
    assert_eq!(format_tokens(89_000.0), "89.0k");
    assert_eq!(format_tokens(200_000.0), "200.0k");
    assert_eq!(format_tokens(1_500_000.0), "1.5M");
}
