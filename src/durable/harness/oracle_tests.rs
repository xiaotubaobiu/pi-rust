//! Byte-oracle tests against `tests/fixtures/durable_oracle/durable_oracle.json`
//! for the harness slice scenarios (`harness_docs`, `prompt_plan`,
//! `output_bound`), captured by `capture_durable_oracle.mjs` from the
//! read-only upstream sources. Serialized wire strings must match the Node
//! capture byte-for-byte (through `preserve_order` maps on both sides).

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

use crate::ai::types::{Message, StringOrBlocks, SystemMessage, Usage};

use crate::agent_core::chord_support::context::Context;

use super::config::{conversation_config, ConversationConfigState};
use super::inbox::{apply_boundary, inbox_doc, prepare_boundary, At};
use super::live::{live_doc, SlotStatus};
use super::output::{bound_output, sanitize_output, OutputLimits};
use super::prompt::{plan_system_entries, replay_sections};
use super::types::{ContextView, OutputRetain};
use super::usage::{usage_doc, UsageState};
use crate::durable::session::session::create_session;
use crate::durable::session::transaction::Transaction;
use crate::durable::storage::memory::MemoryStorage;
use crate::durable::storage::Storage;
use crate::durable::truncate::{format_size, truncate_head, TruncatedBy, TruncationOptions};
use crate::durable::types::{EntryDraft, TaskOwnership};

fn oracle() -> Value {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let path = manifest_dir.join("tests/fixtures/durable_oracle/durable_oracle.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Canonical wire string of a fixture value (order-preserving on both sides).
fn wire(value: &Value) -> String {
    serde_json::to_string(value).unwrap()
}

fn harness_docs() -> Value {
    oracle()["harness_docs"].clone()
}

/// The `Usage` values of scenario 4, in capture order.
fn scenario4_usages() -> (Usage, Usage) {
    let first: Usage = serde_json::from_value(serde_json::json!({
        "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 2, "totalTokens": 15,
        "cost": {"input": 0.5, "output": 0.25, "cacheRead": 0, "cacheWrite": 0, "total": 0.75},
    }))
    .unwrap();
    let second: Usage = serde_json::from_value(serde_json::json!({
        "input": 7, "output": 3, "cacheRead": 1, "cacheWrite": 0, "cacheWrite1h": 4, "reasoning": 2,
        "totalTokens": 10,
        "cost": {"input": 0.25, "output": 0.25, "cacheRead": 0.1, "cacheWrite": 0, "total": 0.6},
    }))
    .unwrap();
    (first, second)
}

#[test]
fn oracle_config_document_surface() {
    let expected = harness_docs();
    // Initial state: `{ thinkingLevel: "off", activeTools: [] }`.
    let initial = ConversationConfigState::initial().into_json().unwrap();
    assert_eq!(
        wire(&Value::Object(initial)),
        wire(&expected["configInitial"]),
        "config initial wire bytes"
    );
    // The doc definition surface.
    let definition = &conversation_config().definition;
    let surface = serde_json::json!({
        "kind": definition.kind,
        "version": definition.version,
        "scope": match definition.scope {
            super::super::documents::DefinitionScope::Conversation => "conversation",
            _ => "other",
        },
        "history": match definition.history.unwrap() {
            super::super::types::DocumentHistory::Rewindable => "rewindable",
            super::super::types::DocumentHistory::Latest => "latest",
        },
        "fork": match definition.fork.unwrap() {
            super::super::types::DocumentFork::AsOf => "asOf",
            super::super::types::DocumentFork::Current => "current",
            super::super::types::DocumentFork::Initial => "initial",
        },
    });
    assert_eq!(
        wire(&surface),
        wire(&expected["configDocSurface"]),
        "config doc surface"
    );
}

#[test]
fn oracle_usage_initial_and_totals() {
    let expected = harness_docs();
    // Initial: `{ models: {}, tools: {} }`.
    assert_eq!(
        wire(&Value::Object(super::usage::initial_json())),
        wire(&expected["usageInitial"])
    );

    // Totals: strict JSON first entry, then `addUsage` for the second.
    let (first, second) = scenario4_usages();
    let mut total = serde_json::to_value(first)
        .unwrap()
        .as_object()
        .cloned()
        .unwrap();
    super::usage::add_usage(&mut total, &second);
    let expected_total = expected["usageTotal"]["gpt-x/gpt-5"].clone();
    assert_eq!(
        wire(&Value::Object(total)),
        wire(&expected_total),
        "usage totals wire bytes"
    );
}

#[test]
fn oracle_live_state_surface() {
    let expected = harness_docs();
    let live_initial = (live_doc().definition.initial)(None);
    assert_eq!(
        wire(&Value::Object(live_initial)),
        wire(&expected["liveInitial"])
    );
    // `checkpointWhen`: a running tool slot forces a base whenever nothing
    // else does; done slots do not.
    let running = serde_json::json!({
        "generation": null,
        "tools": [{"callId": "a", "name": "bash", "status": "running"}],
    });
    let idle = serde_json::json!({
        "generation": null,
        "tools": [{"callId": "a", "name": "bash", "status": "done"}],
    });
    let checkpoint = {
        let live = live_doc();
        live.definition.checkpoint_when.clone().unwrap()
    };
    assert_eq!(
        checkpoint(
            running.as_object().unwrap(),
            &[],
            super::super::types::CheckpointInfo {
                deltas_since_base: 0
            }
        ),
        expected["liveCheckpointRunningIsNotBase"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(
        checkpoint(
            idle.as_object().unwrap(),
            &[],
            super::super::types::CheckpointInfo {
                deltas_since_base: 0
            }
        ),
        expected["liveCheckpointIdleIsBase"].as_bool().unwrap()
    );
    let _ = SlotStatus::Pending;
}
/// Scenario 4's `harness_docs` session flow: root conversation, then the
/// boundary commit with three submissions (write, steer, follow-up) and the
/// usage/config documents.
#[tokio::test]
async fn oracle_harness_boundary_documents() {
    let expected = harness_docs();
    let storage = Arc::new(MemoryStorage::new());
    let session = create_session(Arc::clone(&storage) as Arc<dyn Storage>);
    session
        .commit(
            |tx: Arc<Transaction>| {
                Box::pin(async move { tx.create_root_conversation().map(|record| record.id) })
            },
            Context::background(),
        )
        .await
        .unwrap();

    let (first, second) = scenario4_usages();
    let outcome = session
        .commit(
            move |tx: Arc<Transaction>| {
                let first = first;
                let second = second;
                Box::pin(async move {
                    let mut boundary = prepare_boundary(&tx, 1)?;
                    let write =
                        tx.create_submission(crate::durable::types::SubmissionRecord::queued(
                            1,
                            None,
                            crate::durable::types::SubmissionType::Write,
                            0,
                        ))?;
                    let steer =
                        tx.create_submission(crate::durable::types::SubmissionRecord::queued(
                            1,
                            None,
                            crate::durable::types::SubmissionType::Input,
                            0,
                        ))?;
                    let follow_up =
                        tx.create_submission(crate::durable::types::SubmissionRecord::queued(
                            1,
                            None,
                            crate::durable::types::SubmissionType::Input,
                            0,
                        ))?;
                    let inbox = inbox_doc();
                    let inbox_draft = tx.doc(&inbox.definition, Some(1), None, None)?;
                    let items = [
                        super::inbox::InboxItem::Write {
                            id: write.id,
                            entry: serde_json::json!({"kind": "note", "data": {"text": "w"}})
                                .as_object()
                                .cloned()
                                .unwrap(),
                        },
                        super::inbox::InboxItem::Input {
                            id: steer.id,
                            mode: super::inbox::InputMode::Steer,
                            content: Value::from("s"),
                        },
                        super::inbox::InboxItem::Input {
                            id: follow_up.id,
                            mode: super::inbox::InputMode::FollowUp,
                            content: Value::from("f"),
                        },
                    ];
                    inbox_draft
                        .set(
                            &[String::from("items").into()],
                            Value::Array(items.iter().map(|item| item.to_json()).collect()),
                        )
                        .map_err(|error| {
                            crate::durable::errors::PlainError::new(error.message().to_string())
                        })?;
                    let result =
                        apply_boundary(&tx, &mut boundary, At::Final, 1_758_240_001_000.0)?;

                    // `pi.usage`: strict JSON first entry, then the totals.
                    let usage = usage_doc();
                    let usage_draft = tx.doc(&usage.definition, Some(1), None, None)?;
                    let mut models = serde_json::Map::new();
                    models.insert(String::from("gpt-x/gpt-5"), {
                        let mut total = serde_json::to_value(first)
                            .unwrap()
                            .as_object()
                            .cloned()
                            .unwrap();
                        super::usage::add_usage(&mut total, &second);
                        Value::Object(total)
                    });
                    // `Object.assign(usageDraft.models, usageTotal)` — a
                    // bucket-level set, like the capture.
                    usage_draft
                        .set(&[String::from("models").into()], Value::Object(models))
                        .map_err(|error| {
                            crate::durable::errors::PlainError::new(error.message().to_string())
                        })?;

                    // `pi.inbox` and `pi.conversation.config` post-boundary.
                    let config = conversation_config();
                    let config_draft = tx.doc(&config.definition, Some(1), None, None)?;
                    // `configDraft.activeTools = [...]; configDraft.steeringMode
                    // = "all"` — property sets, like the capture.
                    config_draft
                        .set(
                            &[String::from("activeTools").into()],
                            serde_json::json!(["bash", "read"]),
                        )
                        .map_err(|error| {
                            crate::durable::errors::PlainError::new(error.message().to_string())
                        })?;
                    config_draft
                        .set(&[String::from("steeringMode").into()], Value::from("all"))
                        .map_err(|error| {
                            crate::durable::errors::PlainError::new(error.message().to_string())
                        })?;
                    let inbox_after = inbox_draft
                        .read(&[])
                        .map_err(|error: crate::chord::delta::TrackerError| {
                            crate::durable::errors::PlainError::new(error.message().to_string())
                        })?
                        .unwrap_or(Value::Null);
                    let usage_after = usage_draft
                        .read(&[])
                        .map_err(|error: crate::chord::delta::TrackerError| {
                            crate::durable::errors::PlainError::new(error.message().to_string())
                        })?
                        .unwrap_or(Value::Null);
                    let config_after = config_draft
                        .read(&[])
                        .map_err(|error: crate::chord::delta::TrackerError| {
                            crate::durable::errors::PlainError::new(error.message().to_string())
                        })?
                        .unwrap_or(Value::Null);
                    Ok::<_, crate::durable::errors::PlainError>((
                        result,
                        write.id,
                        steer.id,
                        follow_up.id,
                        inbox_after,
                        usage_after,
                        config_after,
                    ))
                })
            },
            Context::background(),
        )
        .await
        .unwrap();

    let (result, write_id, steer_id, follow_up_id, inbox_after, usage_after, config_after) =
        outcome;
    // Boundary result.
    let expected_result = serde_json::json!({
        "users": expected["boundaryResult"]["users"].as_array().unwrap().iter().map(|id| id.as_i64().unwrap()).collect::<Vec<_>>(),
        "reset": expected["boundaryResult"]["reset"].as_bool().unwrap(),
    });
    assert_eq!(
        serde_json::json!({"users": result.users, "reset": result.reset}),
        expected_result,
        "boundary result"
    );

    // Inbox items after the boundary: empty (the capture reads `.items`).
    assert_eq!(
        wire(&inbox_after.get("items").cloned().unwrap_or(Value::Null)),
        wire(&expected["inboxItemsAfter"])
    );

    // Usage doc.
    assert_eq!(wire(&usage_after), wire(&expected["usageDocAfter"]));

    // Config doc.
    assert_eq!(wire(&config_after), wire(&expected["configDocAfter"]));

    // The submission records, in creation order (write, steer, follow-up).
    let submissions = expected["submissions"].as_array().unwrap();
    assert_eq!(submissions.len(), 3);
    let context = Context::background();
    for (index, id) in [write_id, steer_id, follow_up_id].into_iter().enumerate() {
        let record = storage
            .submission(id, &context)
            .unwrap()
            .expect("submission exists");
        assert_eq!(
            wire(&serde_json::to_value(&record).unwrap()),
            wire(&submissions[index]),
            "submission {index} wire bytes"
        );
    }
    let _ = follow_up_id;
    let _ = TaskOwnership::Conversation;
    let _ = EntryDraft::new("unused");
    let _ = UsageState::initial();
}

#[test]
fn oracle_prompt_plan() {
    let expected = oracle()["prompt_plan"].clone();

    // Replay of two system messages: set in place, `null` deletes, re-add.
    let make_system = |sections: Value, timestamp: i64| {
        Message::System(SystemMessage {
            content: StringOrBlocks::Text(String::new()),
            sections: Some(serde_json::from_value(sections).unwrap()),
            tools_added: None,
            tools_removed: None,
            timestamp,
        })
    };
    let replayed = replay_sections(&[
        make_system(
            serde_json::json!({"tools": "old", "skills": null, "extra": "keep"}),
            1,
        ),
        make_system(serde_json::json!({"tools": "new"}), 2),
    ]);
    let replayed_map: serde_json::Map<String, Value> = replayed
        .iter()
        .map(|(key, value)| (key.clone(), Value::String(value.clone())))
        .collect();
    assert_eq!(
        wire(&Value::Object(replayed_map)),
        wire(&expected["replayed"])
    );
    let order: Vec<String> = replayed.iter().map(|(key, _)| key.clone()).collect();
    assert_eq!(
        wire(&Value::Array(
            order.into_iter().map(Value::String).collect()
        )),
        wire(&expected["replayedOrder"])
    );

    // Baseline plan: head marker, no later pi.system entry.
    let system_message = |content: &str,
                          sections: Value,
                          tools_added: Value,
                          tools_removed: Value,
                          timestamp: i64| {
        Message::System(SystemMessage {
            content: StringOrBlocks::Text(content.to_string()),
            sections: if sections.is_null() {
                None
            } else {
                Some(serde_json::from_value(sections).unwrap())
            },
            tools_added: if tools_added.is_null() {
                None
            } else {
                Some(serde_json::from_value(tools_added).unwrap())
            },
            tools_removed: if tools_removed.is_null() {
                None
            } else {
                Some(serde_json::from_value(tools_removed).unwrap())
            },
            timestamp,
        })
    };
    let head_entry: crate::durable::types::EntryRecord =
        serde_json::from_value(serde_json::json!({
            "kind": "pi.system", "id": 7, "conversationId": 1, "head": 7
        }))
        .unwrap();
    let view = ContextView {
        head: Some(head_entry.clone()),
        entries: vec![head_entry],
        messages: Vec::new(),
    };
    let desired = vec![
        (String::from("tools"), String::from("Use tools carefully.")),
        (String::from("safety"), String::from("Be safe")),
    ];
    let tools: Vec<crate::ai::types::Tool> = serde_json::from_value(serde_json::json!([
        {"name": "bash", "description": "Run a shell command", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}
    ]))
    .unwrap();
    let planned = plan_system_entries(&view, &desired, &tools, 1_758_240_002_000.0);
    assert_eq!(planned.len(), 1);
    assert_eq!(
        wire(&serde_json::to_value(planned[0].model.as_ref().unwrap()[0].clone()).unwrap()),
        wire(&expected["plannedBaseline"][0]["model"][0]),
        "planned baseline message wire bytes"
    );

    // Patch plan: minimal section patch over a replayed context.
    let patch_view = ContextView {
        head: None,
        entries: Vec::new(),
        messages: vec![system_message(
            "",
            serde_json::json!({"tools": "Use tools carefully.", "skills": null}),
            Value::Null,
            Value::Null,
            3,
        )],
    };
    let planned_patch = plan_system_entries(
        &patch_view,
        &[(
            String::from("tools"),
            String::from("Use tools carefully v2"),
        )],
        &[],
        1_758_240_003_000.0,
    );
    assert_eq!(planned_patch.len(), 1);
    assert_eq!(
        wire(&serde_json::to_value(planned_patch[0].model.as_ref().unwrap()[0].clone()).unwrap()),
        wire(&expected["plannedPatch"][0]["model"][0]),
        "planned patch message wire bytes"
    );
}

#[test]
fn oracle_output_bound() {
    let expected = oracle()["output_bound"].clone();
    let long_text = "one\ntwo\nthree\nfour\nfive\n";

    let case =
        |name: &str, text: &str, max_bytes: usize, max_lines: usize, retain: OutputRetain| {
            let slice = bound_output(
                text,
                &OutputLimits {
                    max_bytes,
                    max_lines,
                    retain,
                },
            );
            let expected_value = &expected[name];
            assert_eq!(
                slice.text,
                expected_value["text"].as_str().unwrap(),
                "{name} text"
            );
            assert_eq!(
                slice.bytes,
                expected_value["bytes"].as_u64().unwrap() as usize,
                "{name} bytes"
            );
            assert_eq!(
                slice.dropped_bytes,
                expected_value["droppedBytes"].as_u64().unwrap() as usize,
                "{name} droppedBytes"
            );
            assert_eq!(
                slice.dropped_lines,
                expected_value["droppedLines"].as_u64().unwrap() as usize,
                "{name} droppedLines"
            );
        };
    case("headLines", long_text, 1024, 2, OutputRetain::Head);
    case("tailLines", long_text, 1024, 2, OutputRetain::Tail);
    case("headBytesCut", long_text, 8, 100, OutputRetain::Head);
    case("tailBytesCut", long_text, 8, 100, OutputRetain::Tail);
    case("unicodeCut", "é\n한\n", 3, 10, OutputRetain::Head);

    assert_eq!(
        sanitize_output("a\u{0000}b\u{0007}c\td\ne\u{FFFA}f"),
        expected["sanitized"].as_str().unwrap()
    );

    // Truncation results.
    let head = truncate_head(
        "a\nb\nc\nd\n",
        TruncationOptions {
            max_lines: Some(2),
            max_bytes: Some(100),
        },
    );
    let expected_head = &expected["truncateHead"];
    assert_eq!(head.content, expected_head["content"].as_str().unwrap());
    assert_eq!(
        head.truncated_by == Some(TruncatedBy::Lines),
        expected_head["truncatedBy"] == "lines"
    );
    assert_eq!(
        head.total_lines,
        expected_head["totalLines"].as_u64().unwrap() as usize
    );
    assert_eq!(
        head.output_lines,
        expected_head["outputLines"].as_u64().unwrap() as usize
    );

    let head_bytes = truncate_head(
        "abc\ndef\nghi",
        TruncationOptions {
            max_lines: Some(100),
            max_bytes: Some(7),
        },
    );
    let expected_bytes = &expected["truncateHeadBytes"];
    assert_eq!(
        head_bytes.content,
        expected_bytes["content"].as_str().unwrap()
    );
    assert_eq!(
        head_bytes.first_line_exceeds_limit,
        expected_bytes["firstLineExceedsLimit"].as_bool().unwrap()
    );
    assert_eq!(
        head_bytes.truncated_by == Some(TruncatedBy::Bytes),
        expected_bytes["truncatedBy"] == "bytes"
    );

    assert_eq!(
        crate::durable::truncate::utf8_byte_length("héllo"),
        expected["utf8ByteLength"].as_u64().unwrap() as usize
    );
    let sizes: Vec<String> = expected["formatSize"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        vec![
            format_size(512),
            format_size(2048),
            format_size(3 * 1024 * 1024),
        ],
        sizes
    );
}
