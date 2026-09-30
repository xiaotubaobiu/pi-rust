//! Component glue mirrors upstream callback signatures whose types are
//! inherently wide; factoring each into an alias adds no information.
#![allow(clippy::type_complexity)]
//! r16 tests for the interactive-mode deterministic core
//! (`modes/interactive/`): upstream test ports plus node-captured byte
//! oracles.
//!
//! Oracle provenance: `scratch/interactive_r16_oracle/` —
//! `capture_share_oracle.mjs` (verbatim upstream `exportSessionToJsonl` +
//! `exportSessionForShare` bodies over a fixed fixture, fixed export
//! timestamp `2026-02-03T04:05:06.789Z`, fixed share id `abcd1234`) and
//! `model_search_oracle.json` (the real upstream `model-search.ts` imported
//! by file URL). Upstream test sources ported:
//! `test/export-jsonl-share.test.ts`, `test/model-catalog-refresh.test.ts`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::model_catalog_refresh::{
    refresh_model_catalogs, ModelCatalogRefreshCoordinator, ModelCatalogRefreshError,
    ModelCatalogRuntime,
};
use super::model_search::{get_model_search_text, get_model_selector_search_text, ModelSearchItem};
use super::session_share::{
    export_session_for_share_with_presentation, export_session_to_jsonl_at, share_custom_entry,
    share_tool_presentations, ShareToolPresentation, SHARE_CUSTOM_TYPE,
};
use crate::agent_core::types::AgentMessage;
use crate::ai::types::content::{TextContent, ToolCall};
use crate::ai::types::message::{
    AssistantBlock, AssistantMessage, StringOrBlocks, TextOrImageBlock, ToolResultMessage,
    UserMessage,
};
use crate::ai::types::primitives::{StopReason, Usage, UsageCost};
use crate::coding_agent::extensions::types::{create_synthetic_source_info, ToolInfo};
use crate::coding_agent::session_manager::SessionManager;

// ---------------------------------------------------------------------------
// model-search.ts (oracle: scratch/interactive_r16_oracle/model_search_oracle.json)
// ---------------------------------------------------------------------------

mod model_search_tests {
    use super::*;

    fn item(id: &str, provider: &str, name: Option<&str>) -> ModelSearchItem {
        ModelSearchItem {
            id: id.to_string(),
            provider: provider.to_string(),
            name: name.map(str::to_string),
        }
    }

    /// Byte-exact against the real upstream `model-search.ts` run under
    /// `node --experimental-strip-types` (model_search_oracle.json).
    #[test]
    fn search_texts_match_the_node_oracle_byte_for_byte() {
        let cases: Vec<(ModelSearchItem, &str, &str)> = vec![
            (
                item("gpt-5", "openai", None),
                "gpt-5 openai openai/gpt-5 openai gpt-5",
                "openai openai/gpt-5 openai gpt-5",
            ),
            (
                item("gpt-5", "openai", Some("GPT-5")),
                "gpt-5 openai openai/gpt-5 openai gpt-5 GPT-5",
                "openai openai/gpt-5 openai gpt-5 GPT-5",
            ),
            (
                item("claude-sonnet-4-5", "anthropic", Some("Claude Sonnet 4.5")),
                "claude-sonnet-4-5 anthropic anthropic/claude-sonnet-4-5 anthropic claude-sonnet-4-5 Claude Sonnet 4.5",
                "anthropic anthropic/claude-sonnet-4-5 anthropic claude-sonnet-4-5 Claude Sonnet 4.5",
            ),
            (
                item("openai/gpt-5", "openrouter", None),
                "openai/gpt-5 openrouter openrouter/openai/gpt-5 openrouter openai/gpt-5",
                "openrouter openrouter/openai/gpt-5 openrouter openai/gpt-5",
            ),
            (item("", "p", None), " p p/ p ", "p p/ p "),
        ];
        for (item, search, selector) in cases {
            assert_eq!(get_model_search_text(&item), search);
            assert_eq!(get_model_selector_search_text(&item), selector);
        }
    }

    /// Upstream comment: keep the bare model ID out of the leading position
    /// so provider-prefixed queries rank first for proxy-provider ids.
    #[test]
    fn selector_text_leads_with_the_provider_prefix() {
        let proxy = item("openai/gpt-5", "openrouter", None);
        let selector = get_model_selector_search_text(&proxy);
        assert!(selector.starts_with("openrouter "));
        assert!(!selector.starts_with("openai/gpt-5 "));
    }
}

// ---------------------------------------------------------------------------
// session-share.ts + session-export.ts
// (oracle: scratch/interactive_r16_oracle/capture_share_oracle.mjs)
// ---------------------------------------------------------------------------

/// Fixture session document (header + 3 chained message entries), byte-shared
/// with the oracle script.
const FIXTURE: &str = r#"{"type":"session","version":3,"id":"sess-oracle-16","timestamp":"2026-01-01T00:00:00.000Z","cwd":"C:\\pi-oracle-cwd"}
{"type":"message","id":"e-user-1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello","timestamp":1767225601000}}
{"type":"message","id":"e-asst-1","parentId":"e-user-1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"calling tool"}],"api":"anthropic-messages","provider":"anthropic","model":"test","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1767225602000}}
{"type":"message","id":"e-tool-1","parentId":"e-asst-1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"call-1","toolName":"share_tool","content":[{"type":"text","text":"done"}],"details":{},"isError":false,"timestamp":1767225603000}}
"#;

/// Oracle export without trailing entries (fixed timestamp
/// `2026-02-03T04:05:06.789Z`).
const ORACLE_NORMAL: &str = r#"{"type":"session","version":3,"id":"sess-oracle-16","timestamp":"2026-02-03T04:05:06.789Z","cwd":"C:\\pi-oracle-cwd"}
{"type":"message","id":"e-user-1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello","timestamp":1767225601000}}
{"type":"message","id":"e-asst-1","parentId":"e-user-1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"calling tool"}],"api":"anthropic-messages","provider":"anthropic","model":"test","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1767225602000}}
{"type":"message","id":"e-tool-1","parentId":"e-asst-1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"call-1","toolName":"share_tool","content":[{"type":"text","text":"done"}],"details":{},"isError":false,"timestamp":1767225603000}}
"#;

/// Oracle export with the fixed `pi.share` trailing entry (share id
/// `abcd1234`, presentation payload below).
const ORACLE_SHARE: &str = r#"{"type":"session","version":3,"id":"sess-oracle-16","timestamp":"2026-02-03T04:05:06.789Z","cwd":"C:\\pi-oracle-cwd"}
{"type":"message","id":"e-user-1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello","timestamp":1767225601000}}
{"type":"message","id":"e-asst-1","parentId":"e-user-1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"calling tool"}],"api":"anthropic-messages","provider":"anthropic","model":"test","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1767225602000}}
{"type":"message","id":"e-tool-1","parentId":"e-asst-1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"call-1","toolName":"share_tool","content":[{"type":"text","text":"done"}],"details":{},"isError":false,"timestamp":1767225603000}}
{"type":"custom","customType":"pi.share","id":"abcd1234","parentId":"e-tool-1","timestamp":"2026-02-03T04:05:06.789Z","data":{"systemPrompt":"You are pi.","tools":[{"name":"share_tool","description":"Render a value for sharing","parameters":{"type":"object","properties":{"value":{"type":"string","description":"Value to render"}},"required":["value"]}}]}}
"#;

const FIXTURE_TIMESTAMP: &str = "2026-02-03T04:05:06.789Z";
const FIXTURE_SHARE_ID: &str = "abcd1234";

fn fixture_presentations() -> Vec<ShareToolPresentation> {
    let tool = ToolInfo {
        name: "share_tool".to_string(),
        description: "Render a value for sharing".to_string(),
        parameters: json!({
            "type": "object",
            "properties": { "value": { "type": "string", "description": "Value to render" } },
            "required": ["value"],
        }),
        prompt_guidelines: None,
        source_info: create_synthetic_source_info("builtin", "builtin", None, None, None),
    };
    share_tool_presentations(&[tool])
}

fn open_fixture_session(dir: &std::path::Path) -> Arc<Mutex<SessionManager>> {
    let fixture_path = dir.join("fixture.jsonl");
    std::fs::write(&fixture_path, FIXTURE).expect("write fixture");
    let manager =
        SessionManager::open(fixture_path.to_str().expect("utf8 path"), None, None).expect("open");
    Arc::new(Mutex::new(manager))
}

mod session_share_tests {
    use super::*;

    /// Byte-exact against the verbatim upstream export bodies captured in
    /// `scratch/interactive_r16_oracle/share_oracle.json`: plain export and
    /// share export must match byte for byte.
    #[test]
    fn exports_match_the_node_oracle_byte_for_byte() {
        let temp = std::env::temp_dir().join(format!("pi-r16-oracle-{}", std::process::id()));
        std::fs::create_dir_all(&temp).expect("temp dir");
        let manager = open_fixture_session(&temp);

        let normal_path = temp.join("normal.jsonl");
        let written = export_session_to_jsonl_at(
            &manager,
            Some(normal_path.to_str().unwrap()),
            FIXTURE_TIMESTAMP,
            &|_parent_id, _timestamp| vec![],
        )
        .expect("export");
        assert_eq!(written, normal_path.to_str().unwrap());
        assert_eq!(
            std::fs::read(&normal_path).expect("read"),
            ORACLE_NORMAL.as_bytes()
        );

        let share_path = temp.join("share.jsonl");
        let presentations = fixture_presentations();
        export_session_to_jsonl_at(
            &manager,
            Some(share_path.to_str().unwrap()),
            FIXTURE_TIMESTAMP,
            &|parent_id, timestamp| {
                vec![share_custom_entry(
                    parent_id,
                    timestamp,
                    FIXTURE_SHARE_ID,
                    "You are pi.",
                    &presentations,
                )]
            },
        )
        .expect("export");
        assert_eq!(
            std::fs::read(&share_path).expect("read"),
            ORACLE_SHARE.as_bytes()
        );

        std::fs::remove_dir_all(&temp).expect("cleanup");
    }

    /// Upstream test/export-jsonl-share.test.ts "adds presentation data
    /// without changing conversation IDs or links", ported over the ported
    /// SessionManager (the upstream test drives the full SDK session; the
    /// document construction this test exercises is the same code path —
    /// the AgentSession accessor glue reads the same state).
    #[test]
    fn adds_presentation_data_without_changing_conversation_ids_or_links() {
        let temp = std::env::temp_dir().join(format!("pi-r16-share-{}", std::process::id()));
        std::fs::create_dir_all(&temp).expect("temp dir");

        let manager = Arc::new(Mutex::new(
            SessionManager::in_memory(temp.to_str().unwrap(), None, None).expect("in memory"),
        ));

        let user_id = manager
            .lock()
            .expect("lock")
            .append_message(AgentMessage::User(UserMessage {
                content: StringOrBlocks::Text("hello".to_string()),
                timestamp: 1,
            }))
            .expect("append");
        let assistant_id = manager
            .lock()
            .expect("lock")
            .append_message(AgentMessage::Assistant(AssistantMessage {
                content: vec![AssistantBlock::ToolCall(ToolCall {
                    id: "call-1".to_string(),
                    name: "share_tool".to_string(),
                    arguments: json!({ "value": "example" }),
                    thought_signature: None,
                    namespace: None,
                })],
                api: "anthropic-messages".to_string(),
                provider: "anthropic".to_string(),
                model: "test".to_string(),
                response_model: None,
                response_id: None,
                provider_thinking_level: None,
                diagnostics: None,
                usage: Usage {
                    input: 1,
                    output: 1,
                    cache_read: 0,
                    cache_write: 0,
                    cache_write_1h: None,
                    reasoning: None,
                    total_tokens: 2,
                    cost: UsageCost {
                        input: 0.0,
                        output: 0.0,
                        cache_read: 0.0,
                        cache_write: 0.0,
                        total: 0.0,
                    },
                },
                stop_reason: StopReason::ToolUse,
                deferred: None,
                error_message: None,
                raw_stop_reason: None,
                end_turn: None,
                timestamp: 1,
            }))
            .expect("append");
        let result_id = manager
            .lock()
            .expect("lock")
            .append_message(AgentMessage::ToolResult(ToolResultMessage {
                tool_call_id: "call-1".to_string(),
                tool_name: "share_tool".to_string(),
                content: vec![TextOrImageBlock::Text(TextContent {
                    text: "done".to_string(),
                    text_signature: None,
                })],
                details: Some(json!({})),
                usage: None,
                is_error: false,
                timestamp: 1,
            }))
            .expect("append");
        let original_entry_ids: Vec<String> = {
            let manager = manager.lock().expect("lock");
            manager
                .get_branch(None)
                .iter()
                .filter_map(|entry| entry.id().map(str::to_string))
                .collect()
        };
        assert_eq!(
            original_entry_ids,
            vec![user_id.clone(), assistant_id.clone(), result_id.clone()]
        );

        // The plain export never carries a share record.
        let normal_path = temp.join("normal.jsonl");
        export_session_to_jsonl_at(
            &manager,
            Some(normal_path.to_str().unwrap()),
            FIXTURE_TIMESTAMP,
            &|_parent_id, _timestamp| vec![],
        )
        .expect("export");
        let normal_records = parse_jsonl(&std::fs::read_to_string(&normal_path).expect("read"));
        assert!(normal_records
            .iter()
            .all(|record| record["customType"] != json!(SHARE_CUSTOM_TYPE)));

        // The share export appends the presentation entry.
        let share_path = temp.join("share.jsonl");
        let presentations = vec![ShareToolPresentation {
            name: "share_tool".to_string(),
            description: "Render a value for sharing".to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "value": { "type": "string", "description": "Value to render" } },
                "required": ["value"],
            }),
        }];
        export_session_for_share_with_presentation(
            share_path.to_str().unwrap(),
            &manager,
            FIXTURE_SHARE_ID,
            "You are pi.",
            &presentations,
        )
        .expect("export");
        let share_bytes = std::fs::read_to_string(&share_path).expect("read");
        let records = parse_jsonl(&share_bytes);
        let conversation_records = &records[1..records.len() - 1];
        let conversation_ids: Vec<&str> = conversation_records
            .iter()
            .map(|record| record["id"].as_str().expect("id"))
            .collect();
        assert_eq!(
            conversation_ids,
            original_entry_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
        let expected_parent_ids: Vec<Option<String>> = std::iter::once(None)
            .chain(
                original_entry_ids[..original_entry_ids.len() - 1]
                    .iter()
                    .cloned()
                    .map(Some),
            )
            .collect();
        let actual_parent_ids: Vec<Option<String>> = conversation_records
            .iter()
            .map(|record| record["parentId"].as_str().map(str::to_string))
            .collect();
        assert_eq!(actual_parent_ids, expected_parent_ids);
        assert_eq!(
            conversation_records[conversation_records.len() - 3]["id"],
            json!(user_id)
        );
        assert_eq!(
            conversation_records[conversation_records.len() - 2]["id"],
            json!(assistant_id)
        );
        assert_eq!(
            conversation_records[conversation_records.len() - 1]["id"],
            json!(result_id)
        );

        let share_entry = records.last().expect("share entry");
        assert_eq!(share_entry["type"], json!("custom"));
        assert_eq!(share_entry["customType"], json!("pi.share"));
        assert_eq!(share_entry["parentId"], json!(result_id));
        assert!(share_entry["timestamp"].is_string());
        assert_eq!(share_entry["data"]["systemPrompt"], json!("You are pi."));
        let share_tools = share_entry["data"]["tools"].as_array().expect("tools");
        assert_eq!(share_tools.len(), 1);
        assert_eq!(share_tools[0]["name"], json!("share_tool"));
        assert_eq!(
            share_tools[0]["description"],
            json!("Render a value for sharing")
        );
        assert!(share_tools[0]["parameters"].is_object());
        // Upstream: the share payload carries presentation data only.
        let data_keys: Vec<&str> = share_entry["data"]
            .as_object()
            .expect("data object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(data_keys, vec!["systemPrompt", "tools"]);

        // Re-importing the share file keeps the share entry as the leaf and
        // reconstructs the conversation.
        let imported =
            SessionManager::open(share_path.to_str().unwrap(), None, None).expect("open");
        assert_eq!(imported.get_leaf_id(), Some(FIXTURE_SHARE_ID));
        let context = imported.build_session_context();
        let roles: Vec<&str> = context
            .messages
            .iter()
            .map(|message| message.role())
            .collect();
        assert_eq!(roles, vec!["user", "assistant", "toolResult"]);

        std::fs::remove_dir_all(&temp).expect("cleanup");
    }

    /// The trailing-entry callback receives the last branch entry as parent
    /// and the shared export timestamp (session-export.ts:23,26-29).
    #[test]
    fn trailing_entries_receive_the_leaf_parent_and_shared_timestamp() {
        let temp = std::env::temp_dir().join(format!("pi-r16-trailing-{}", std::process::id()));
        std::fs::create_dir_all(&temp).expect("temp dir");
        let manager = open_fixture_session(&temp);
        let observed: Mutex<Vec<(Option<String>, String)>> = Mutex::new(Vec::new());
        let out_path = temp.join("observed.jsonl");
        export_session_to_jsonl_at(
            &manager,
            Some(out_path.to_str().unwrap()),
            FIXTURE_TIMESTAMP,
            &|parent_id, timestamp| {
                observed
                    .lock()
                    .expect("lock")
                    .push((parent_id.map(str::to_string), timestamp.to_string()));
                vec![share_custom_entry(
                    parent_id,
                    timestamp,
                    FIXTURE_SHARE_ID,
                    "",
                    &[],
                )]
            },
        )
        .expect("export");
        assert_eq!(
            observed.into_inner().expect("observed"),
            vec![(Some("e-tool-1".to_string()), FIXTURE_TIMESTAMP.to_string())]
        );

        // Error path: an unwritable export location surfaces a message the
        // upstream callers render as `Failed to export session: …`.
        let blocking = temp.join("blocking.txt");
        std::fs::write(&blocking, "not a directory").expect("write blocking file");
        let error = export_session_to_jsonl_at(
            &manager,
            Some(blocking.join("out.jsonl").to_str().unwrap()),
            FIXTURE_TIMESTAMP,
            &|_parent_id, _timestamp| vec![],
        )
        .expect_err("export into a non-directory path fails");
        assert!(!error.message.is_empty());
        let _displayed: String = error.to_string();

        std::fs::remove_dir_all(&temp).expect("cleanup");
    }

    fn parse_jsonl(document: &str) -> Vec<Value> {
        document
            .trim_end_matches('\n')
            .split('\n')
            .map(|line| serde_json::from_str(line).expect("jsonl line"))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// model-catalog-refresh.ts (upstream test/model-catalog-refresh.test.ts)
// ---------------------------------------------------------------------------

mod model_catalog_refresh_tests {
    use super::*;
    use std::future::pending;
    use tokio::sync::watch;

    type Outcome = Result<crate::ai::models::ModelsRefreshResult, String>;

    /// Mock runtime whose refresh waits on a shared watch gate before
    /// returning a fixed outcome (upstream `createDeferred`).
    struct GatedRuntime {
        ready: watch::Receiver<bool>,
        outcome: Outcome,
        calls: Arc<AtomicUsize>,
        signals: Arc<Mutex<Vec<CancellationToken>>>,
    }

    impl ModelCatalogRuntime for GatedRuntime {
        fn refresh<'a>(
            &'a self,
            options: crate::ai::models::ModelsRefreshOptions,
        ) -> futures::future::BoxFuture<'a, Outcome> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(signal) = options.signal {
                self.signals.lock().expect("signals lock").push(signal);
            }
            let mut ready = self.ready.clone();
            Box::pin(async move {
                while !*ready.borrow() {
                    if ready.changed().await.is_err() {
                        break;
                    }
                }
                self.outcome.clone()
            })
        }
    }

    /// Mock runtime whose refresh never settles (upstream
    /// `new Promise(() => {})`).
    struct PendingRuntime {
        calls: Arc<AtomicUsize>,
        signals: Arc<Mutex<Vec<CancellationToken>>>,
    }

    impl ModelCatalogRuntime for PendingRuntime {
        fn refresh<'a>(
            &'a self,
            options: crate::ai::models::ModelsRefreshOptions,
        ) -> futures::future::BoxFuture<'a, Outcome> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(signal) = options.signal {
                self.signals.lock().expect("signals lock").push(signal);
            }
            Box::pin(pending())
        }
    }

    fn successful_refresh() -> Outcome {
        Ok(crate::ai::models::ModelsRefreshResult::default())
    }

    async fn wait_until(condition: impl Fn() -> bool) {
        for _ in 0..10_000 {
            if condition() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("condition never became true");
    }

    // Note: unlike JS promises, Rust futures are lazy — each caller future is
    // spawned so the concurrent-join behavior under test actually executes.

    /// "shares one runtime refresh between concurrent callers"
    #[tokio::test]
    async fn shares_one_runtime_refresh_between_concurrent_callers() {
        let coordinator = ModelCatalogRefreshCoordinator::new();
        let (ready_tx, ready_rx) = watch::channel(false);
        let runtime = Arc::new(GatedRuntime {
            ready: ready_rx,
            outcome: successful_refresh(),
            calls: Arc::new(AtomicUsize::new(0)),
            signals: Arc::new(Mutex::new(Vec::new())),
        });
        let first_signal = CancellationToken::new();
        let second_signal = CancellationToken::new();

        let first = {
            let coordinator = coordinator.clone();
            let runtime = runtime.clone();
            tokio::spawn(async move {
                coordinator
                    .refresh(runtime, first_signal)
                    .await
                    .expect("first refresh resolves")
            })
        };
        let second = {
            let coordinator = coordinator.clone();
            let runtime = runtime.clone();
            tokio::spawn(async move {
                coordinator
                    .refresh(runtime, second_signal)
                    .await
                    .expect("second refresh resolves")
            })
        };

        wait_until(|| runtime.calls.load(Ordering::SeqCst) == 1).await;
        // Give the second caller a chance to (wrongly) start its own refresh.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(runtime.calls.load(Ordering::SeqCst), 1);
        ready_tx.send(true).expect("send");
        let first_result = first.await.expect("join");
        assert!(!first_result.aborted);
        assert!(first_result.errors.is_empty());
        let second_result = second.await.expect("join");
        assert!(!second_result.aborted);
        assert!(second_result.errors.is_empty());
    }

    /// "keeps the shared refresh alive when one caller stops waiting"
    #[tokio::test]
    async fn keeps_the_shared_refresh_alive_when_one_caller_stops_waiting() {
        let coordinator = ModelCatalogRefreshCoordinator::new();
        let (ready_tx, ready_rx) = watch::channel(false);
        let runtime = Arc::new(GatedRuntime {
            ready: ready_rx,
            outcome: successful_refresh(),
            calls: Arc::new(AtomicUsize::new(0)),
            signals: Arc::new(Mutex::new(Vec::new())),
        });
        let first_signal = CancellationToken::new();
        let second_signal = CancellationToken::new();
        let first = {
            let coordinator = coordinator.clone();
            let runtime = runtime.clone();
            let signal = first_signal.clone();
            tokio::spawn(async move { coordinator.refresh(runtime, signal).await })
        };
        let second = {
            let coordinator = coordinator.clone();
            let runtime = runtime.clone();
            let signal = second_signal.clone();
            tokio::spawn(async move { coordinator.refresh(runtime, signal).await })
        };
        wait_until(|| runtime.calls.load(Ordering::SeqCst) == 1).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(runtime.calls.load(Ordering::SeqCst), 1);

        first_signal.cancel();
        assert!(matches!(
            first.await,
            Ok(Err(ModelCatalogRefreshError::Abort(_)))
        ));
        let shared_refresh_signal = runtime.signals.lock().expect("signals lock")[0].clone();
        assert!(!shared_refresh_signal.is_cancelled());

        ready_tx.send(true).expect("send");
        let second_result = second
            .await
            .expect("join")
            .expect("second refresh resolves");
        assert!(!second_result.aborted);
        assert!(second_result.errors.is_empty());
    }

    /// "aborts an abandoned refresh and allows a later refresh to start"
    #[tokio::test]
    async fn aborts_an_abandoned_refresh_and_allows_a_later_refresh_to_start() {
        let coordinator = ModelCatalogRefreshCoordinator::new();
        let runtime = Arc::new(PendingRuntime {
            calls: Arc::new(AtomicUsize::new(0)),
            signals: Arc::new(Mutex::new(Vec::new())),
        });
        let first_signal = CancellationToken::new();
        let first = {
            let coordinator = coordinator.clone();
            let runtime = runtime.clone();
            let signal = first_signal.clone();
            tokio::spawn(async move { coordinator.refresh(runtime, signal).await })
        };
        wait_until(|| runtime.calls.load(Ordering::SeqCst) == 1).await;

        first_signal.cancel();
        assert!(matches!(
            first.await,
            Ok(Err(ModelCatalogRefreshError::Abort(_)))
        ));
        let first_refresh_signal = runtime.signals.lock().expect("signals lock")[0].clone();
        wait_until(|| first_refresh_signal.is_cancelled()).await;

        let second_signal = CancellationToken::new();
        let second = {
            let coordinator = coordinator.clone();
            let runtime = runtime.clone();
            let signal = second_signal.clone();
            tokio::spawn(async move { coordinator.refresh(runtime, signal).await })
        };
        wait_until(|| runtime.calls.load(Ordering::SeqCst) == 2).await;
        second_signal.cancel();
        assert!(matches!(
            second.await,
            Ok(Err(ModelCatalogRefreshError::Abort(_)))
        ));
    }

    /// Upstream `signal.throwIfAborted()`: an already-cancelled caller signal
    /// rejects before any refresh starts, through the module-level singleton
    /// (`refreshModelCatalogs`).
    #[tokio::test]
    async fn the_global_entry_point_rejects_an_already_cancelled_signal() {
        let runtime = Arc::new(PendingRuntime {
            calls: Arc::new(AtomicUsize::new(0)),
            signals: Arc::new(Mutex::new(Vec::new())),
        });
        let signal = CancellationToken::new();
        signal.cancel();
        let result = refresh_model_catalogs(runtime.clone(), signal).await;
        assert!(matches!(result, Err(ModelCatalogRefreshError::Abort(_))));
        assert_eq!(runtime.calls.load(Ordering::SeqCst), 0);
    }
}

// ---------------------------------------------------------------------------
// r17: theme/theme.ts + theme/theme-json.ts + external-editor.ts (oracle:
// scratch/interactive_r17_oracle/theme_oracle.mjs and
// validate_theme_json_oracle.mjs — verbatim upstream bodies run under node;
// upstream tests ported: test/theme-detection.test.ts,
// test/theme-export.test.ts, test/external-editor.test.ts)
// ---------------------------------------------------------------------------

mod theme_r17_tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};

    // `edit_in_external_editor` is exercised by the windows-gated tests
    // below; keep the import honest on unix too.
    #[cfg_attr(not(windows), allow(unused_imports))]
    use super::super::external_editor::{
        edit_in_external_editor, edit_in_external_editor_with, EditorRunner, ExternalEditorOptions,
        ExternalEditorResult,
    };
    use super::super::theme::{
        ansi256_to_hex, bg_ansi, builtin_theme_names, create_theme,
        detect_terminal_background_from_env, detect_terminal_background_theme,
        detect_terminal_theme_for_auto, fg_ansi, get_builtin_theme_json,
        get_color_fg_bg_background_index, get_language_from_path, get_resolved_theme_colors,
        get_rgb_color_luminance, get_theme_export_colors, get_theme_for_rgb_color, hex_to_256,
        hex_to_rgb, is_light_theme, load_builtin_theme, parse_auto_theme_setting,
        resolve_theme_colors, resolve_theme_setting, resolve_var_refs, rgb_to_256,
        with_theme_color_fallbacks, ColorMode, ColorValue, Confidence, DetectionSource,
        ResolvedColor, TerminalTheme, TerminalThemeDetection,
    };
    use super::super::theme_json::{validate_theme_json, ThemeJson};

    const BUILTIN_DARK: &str = include_str!("theme/dark.json");
    const BUILTIN_LIGHT: &str = include_str!("theme/light.json");

    /// The node-captured oracle (generated by
    /// `scratch/interactive_r17_oracle/theme_oracle.mjs` over verbatim
    /// upstream bodies) embedded at compile time.
    const ORACLE: &str =
        include_str!("../../../../scratch/interactive_r17_oracle/theme_oracle.json");
    const JSON_ORACLE: &str =
        include_str!("../../../../scratch/interactive_r17_oracle/theme_json_oracle.json");

    fn oracle() -> Value {
        serde_json::from_str(ORACLE).expect("theme oracle parses")
    }

    fn json_oracle() -> Value {
        serde_json::from_str(JSON_ORACLE).expect("theme json oracle parses")
    }

    fn index_list(value: &Value) -> Vec<u8> {
        value
            .as_array()
            .expect("oracle array")
            .iter()
            .map(|entry| u8::try_from(entry.as_u64().expect("index")).expect("u8"))
            .collect()
    }

    fn string_list(value: &Value) -> Vec<String> {
        value
            .as_array()
            .expect("oracle array")
            .iter()
            .map(|entry| entry.as_str().expect("string").to_string())
            .collect()
    }

    fn resolved_to_value(resolved: &BTreeMap<String, ResolvedColor>) -> Value {
        Value::Object(
            resolved
                .iter()
                .map(|(key, value)| {
                    let rendered = match value {
                        ResolvedColor::Index(index) => json!(index),
                        ResolvedColor::Str(text) => json!(text),
                    };
                    (key.clone(), rendered)
                })
                .collect(),
        )
    }

    fn detection_to_value(detection: &TerminalThemeDetection) -> Value {
        let theme = match detection.theme {
            TerminalTheme::Light => "light",
            TerminalTheme::Dark => "dark",
        };
        let source = match detection.source {
            DetectionSource::TerminalBackground => "terminal background",
            DetectionSource::Colorfgbg => "COLORFGBG",
            DetectionSource::Fallback => "fallback",
        };
        let confidence = match detection.confidence {
            Confidence::High => "high",
            Confidence::Low => "low",
        };
        json!({
            "theme": theme,
            "source": source,
            "detail": detection.detail,
            "confidence": confidence,
        })
    }

    fn dark_value() -> Value {
        serde_json::from_str(BUILTIN_DARK).expect("dark.json")
    }

    #[test]
    fn builtin_theme_names_match_the_upstream_registry_order() {
        assert_eq!(builtin_theme_names(), ["dark", "light"]);
    }

    /// Upstream `rgbTo256`/`hexTo256` over the oracle's dense grid (channels
    /// stepped by 17) — exact against the node run.
    #[test]
    fn rgb_to_256_grid_matches_the_node_oracle() {
        let expected = index_list(&oracle()["rgb_to_256"]);
        let mut ours = Vec::new();
        for r in (0..=255u8).step_by(17) {
            for g in (0..=255u8).step_by(17) {
                for b in (0..=255u8).step_by(17) {
                    ours.push(rgb_to_256(r, g, b));
                }
            }
        }
        assert_eq!(ours.len(), expected.len());
        assert_eq!(ours, expected);
    }

    /// Upstream `ansi256ToHex` over all 256 indices.
    #[test]
    fn ansi256_to_hex_table_matches_the_node_oracle() {
        let expected = string_list(&oracle()["ansi256_to_hex"]);
        let ours: Vec<String> = (0..=255u8).map(ansi256_to_hex).collect();
        assert_eq!(ours, expected);
    }

    /// Upstream `fgAnsi`/`bgAnsi` over both color modes, plus the invalid
    /// color error message.
    #[test]
    fn ansi_sequences_match_the_node_oracle_byte_for_byte() {
        let expected = string_list(&oracle()["ansi"]);
        let values = [
            ResolvedColor::Str(String::new()),
            ResolvedColor::Str("#ff0000".to_string()),
            ResolvedColor::Str("#00d7ff".to_string()),
            ResolvedColor::Str("#d4d4d4".to_string()),
            ResolvedColor::Str("#808080".to_string()),
            ResolvedColor::Index(0),
            ResolvedColor::Index(15),
            ResolvedColor::Index(24),
            ResolvedColor::Index(255),
        ];
        let mut ours = Vec::new();
        for mode in [ColorMode::Truecolor, ColorMode::Color256] {
            for value in &values {
                ours.push(fg_ansi(value, mode).expect("fg ansi"));
                ours.push(bg_ansi(value, mode).expect("bg ansi"));
            }
        }
        assert_eq!(ours, expected);

        let error = fg_ansi(
            &ResolvedColor::Str("primary".to_string()),
            ColorMode::Truecolor,
        )
        .expect_err("non-hex color");
        assert_eq!(
            error,
            oracle()["ansi_error"].as_str().expect("error string")
        );
    }

    /// Upstream `resolveVarRefs`: literals, var chains, circular and missing
    /// reference errors.
    #[test]
    fn var_resolution_matches_the_node_oracle() {
        let vars = BTreeMap::from([
            ("a".to_string(), ColorValue::Str("#112233".to_string())),
            ("b".to_string(), ColorValue::Str("a".to_string())),
            ("c".to_string(), ColorValue::Str("b".to_string())),
            ("loop1".to_string(), ColorValue::Str("loop2".to_string())),
            ("loop2".to_string(), ColorValue::Str("loop1".to_string())),
            ("missing".to_string(), ColorValue::Str("nope".to_string())),
        ]);
        let resolve = |name: &str| resolve_var_refs(&ColorValue::Str(name.to_string()), &vars);

        let expected = &oracle()["resolve"];
        assert_eq!(
            resolve("#abcdef").expect("hex"),
            ResolvedColor::Str("#abcdef".to_string())
        );
        assert_eq!(
            resolve("").expect("empty"),
            ResolvedColor::Str(String::new())
        );
        assert_eq!(
            resolve_var_refs(&ColorValue::Index(24), &vars).expect("index"),
            ResolvedColor::Index(24)
        );
        assert_eq!(
            resolve("a").expect("a"),
            ResolvedColor::Str("#112233".to_string())
        );
        assert_eq!(
            resolve("c").expect("c"),
            ResolvedColor::Str("#112233".to_string())
        );
        assert_eq!(
            resolve("loop1").expect_err("circular"),
            expected["circular_error"].as_str().expect("string")
        );
        assert_eq!(
            resolve("nope").expect_err("missing"),
            expected["missing_error"].as_str().expect("string")
        );
    }

    /// Upstream `getResolvedThemeColors` over the byte-identical built-in
    /// documents, plus the optional-key fallback path.
    #[test]
    fn resolved_builtin_colors_match_the_node_oracle() {
        let oracle = oracle();
        let dark = ThemeJson::parse(BUILTIN_DARK).expect("dark");
        let light = ThemeJson::parse(BUILTIN_LIGHT).expect("light");
        assert_eq!(
            json!(get_resolved_theme_colors(&dark)),
            oracle["resolved_dark"],
            "dark resolved colors diverge"
        );
        assert_eq!(
            json!(get_resolved_theme_colors(&light)),
            oracle["resolved_light"],
            "light resolved colors diverge"
        );

        // Fallbacks on a doc without the optional keys.
        let mut stripped = dark_value();
        let colors = stripped
            .get_mut("colors")
            .and_then(Value::as_object_mut)
            .expect("colors");
        for key in [
            "scrollbarTrack",
            "scrollbarThumb",
            "thinkingMax",
            "searchMatchBg",
            "searchMatchText",
        ] {
            colors.remove(key);
        }
        let stripped_doc = ThemeJson::parse(&serde_json::to_string(&stripped).expect("serialize"))
            .expect("stripped doc");
        let empty = BTreeMap::new();
        let vars = stripped_doc.vars.as_ref().unwrap_or(&empty);
        let resolved =
            resolve_theme_colors(&with_theme_color_fallbacks(&stripped_doc.colors), vars)
                .expect("fallback resolution");
        assert_eq!(
            resolved_to_value(&resolved),
            oracle["fallback_resolved"],
            "fallback resolution diverges"
        );

        // The same fallback doc through the Theme ANSI table (256color mode).
        let mut ansi = serde_json::Map::new();
        for (key, value) in &resolved {
            let rendered = if key.ends_with("Bg") {
                bg_ansi(value, ColorMode::Color256).expect("bg")
            } else {
                fg_ansi(value, ColorMode::Color256).expect("fg")
            };
            ansi.insert(key.clone(), json!(rendered));
        }
        assert_eq!(
            Value::Object(ansi),
            oracle["fallback_ansi_256"],
            "fallback ANSI diverges"
        );
    }

    /// Upstream `getThemeExportColors`: var refs, recursive vars, 256-color
    /// conversion, and the no-export default (the upstream
    /// test/theme-export.test.ts scenarios over explicit documents).
    #[test]
    fn export_colors_match_the_node_oracle() {
        let oracle = oracle();
        let to_export_value = |value: &Value| -> Value {
            let doc = ThemeJson::parse(&serde_json::to_string(value).expect("serialize"))
                .expect("theme doc");
            // JSON.stringify drops `undefined` fields; mirror that shape.
            let export = get_theme_export_colors(&doc);
            let mut rendered = serde_json::Map::new();
            if let Some(page_bg) = export.page_bg {
                rendered.insert("pageBg".to_string(), json!(page_bg));
            }
            if let Some(card_bg) = export.card_bg {
                rendered.insert("cardBg".to_string(), json!(card_bg));
            }
            if let Some(info_bg) = export.info_bg {
                rendered.insert("infoBg".to_string(), json!(info_bg));
            }
            Value::Object(rendered)
        };

        let dark = dark_value();
        let mut with_vars = dark.clone();
        with_vars["name"] = json!("custom-export-vars");
        with_vars["vars"]["pageBgVar"] = json!("#112233");
        with_vars["vars"]["pageBgAlias"] = json!("pageBgVar");
        with_vars["vars"]["infoBgVar"] = json!("#445566");
        with_vars["vars"]["cardBgVar"] = json!("#223344");
        with_vars["export"] = json!({
            "pageBg": "pageBgAlias",
            "cardBg": "cardBgVar",
            "infoBg": "infoBgVar",
        });

        let mut recursive = dark.clone();
        recursive["name"] = json!("custom-export-recursive");
        recursive["vars"]["deepPageBg"] = json!("#abcdef");
        recursive["vars"]["pageBgAlias"] = json!("deepPageBg");
        recursive["vars"]["cardBgAnsi"] = json!(24);
        recursive["export"] = json!({
            "pageBg": "pageBgAlias",
            "cardBg": "cardBgAnsi",
            "infoBg": "",
        });

        let mut none = dark.clone();
        none.as_object_mut()
            .expect("object")
            .remove("export")
            .expect("export key");

        assert_eq!(to_export_value(&dark), oracle["export_dark"]);
        assert_eq!(to_export_value(&with_vars), oracle["export_vars"]);
        assert_eq!(to_export_value(&recursive), oracle["export_recursive"]);
        assert_eq!(to_export_value(&none), oracle["export_none"]);
    }

    /// Upstream `detectTerminalBackgroundFromEnv`, `getThemeForRgbColor`, and
    /// the per-index ANSI luminance classification.
    #[test]
    fn terminal_detection_matches_the_node_oracle() {
        let oracle = oracle();
        let env_cases: [Option<&str>; 7] = [
            Some("0;15"),
            Some("15;0"),
            Some("0;7;15"),
            None,
            Some(""),
            Some("15;bad;300"),
            Some("15;bad"),
        ];
        let detections: Vec<Value> = env_cases
            .iter()
            .map(|case| detection_to_value(&detect_terminal_background_from_env(*case)))
            .collect();
        assert_eq!(json!(detections), oracle["detect_env"]);

        let rgb_cases: [(u8, u8, u8); 5] = [
            (8, 8, 8),
            (250, 250, 250),
            (128, 128, 128),
            (0, 0, 0),
            (255, 255, 255),
        ];
        let themes: Vec<&str> = rgb_cases
            .iter()
            .map(|&(r, g, b)| match get_theme_for_rgb_color((r, g, b)) {
                TerminalTheme::Light => "light",
                TerminalTheme::Dark => "dark",
            })
            .collect();
        assert_eq!(json!(themes), oracle["rgb_themes"]);

        let luminance_themes: Vec<&str> = (0..=255u8)
            .map(|index| {
                if get_rgb_color_luminance(hex_to_rgb(&ansi256_to_hex(index)).expect("ansi hex"))
                    >= 0.5
                {
                    "light"
                } else {
                    "dark"
                }
            })
            .collect();
        assert_eq!(json!(luminance_themes), oracle["ansi_luminance_themes"]);
    }

    /// Upstream `parseAutoThemeSetting` / `resolveThemeSetting`.
    #[test]
    fn theme_setting_helpers_match_the_node_oracle() {
        let oracle = oracle();
        let auto_cases: [Option<&str>; 9] = [
            Some("light/dark"),
            Some(" my-light / my-dark "),
            Some("light/dark/extra"),
            Some("light/"),
            Some("/dark"),
            Some("plain"),
            Some(""),
            None,
            Some("a/b/c"),
        ];
        let auto: Vec<Value> = auto_cases
            .iter()
            .map(|case| match parse_auto_theme_setting(*case) {
                Some((light, dark)) => json!({"lightTheme": light, "darkTheme": dark}),
                None => Value::Null,
            })
            .collect();
        assert_eq!(json!(auto), oracle["auto"]);

        let settings: [Option<&str>; 4] = [
            Some("dark"),
            Some("light/dark"),
            Some("light/dark/extra"),
            None,
        ];
        let resolved: Vec<Value> = settings
            .iter()
            .map(|setting| {
                let pair: Vec<Value> = [TerminalTheme::Light, TerminalTheme::Dark]
                    .iter()
                    .map(
                        |terminal| match resolve_theme_setting(*setting, *terminal) {
                            Some(name) => json!(name),
                            None => Value::Null,
                        },
                    )
                    .collect();
                json!(pair)
            })
            .collect();
        assert_eq!(json!(resolved), oracle["resolve_setting"]);
    }

    /// Upstream `getLanguageFromPath` over the full table and edge inputs.
    #[test]
    fn language_table_matches_the_node_oracle() {
        let paths = [
            "a.ts",
            "B.TSX",
            "x.js",
            "y.mjs",
            "z.cjs",
            "p.py",
            "q.rb",
            "main.rs",
            "m.go",
            "F.java",
            "a.kt",
            "b.swift",
            "c.c",
            "d.h",
            "e.cpp",
            "f.cc",
            "g.cxx",
            "h.hpp",
            "i.cs",
            "j.php",
            "k.sh",
            "l.bash",
            "m.zsh",
            "n.fish",
            "o.ps1",
            "p.sql",
            "q.html",
            "r.htm",
            "s.css",
            "t.scss",
            "u.sass",
            "v.less",
            "w.json",
            "x.yaml",
            "y.yml",
            "z.toml",
            "a.xml",
            "b.md",
            "c.markdown",
            "Dockerfile",
            "Makefile",
            "cmakelists.txt",
            "a.lua",
            "b.perl",
            "c.r",
            "d.scala",
            "e.clj",
            "f.ex",
            "g.exs",
            "h.erl",
            "i.hs",
            "j.ml",
            "k.vim",
            "l.graphql",
            "m.proto",
            "n.tf",
            "o.hcl",
            "no-ext",
            "",
            "a.",
        ];
        let ours: Vec<Value> = paths
            .iter()
            .map(|path| match get_language_from_path(path) {
                Some(language) => json!(language),
                None => Value::Null,
            })
            .collect();
        assert_eq!(json!(ours), oracle()["languages"]);
    }

    /// The full Theme ANSI tables for both built-ins in both color modes
    /// (upstream `Theme` constructor + `getFgAnsi`/`getBgAnsi`).
    #[test]
    fn theme_ansi_tables_match_the_node_oracle() {
        let oracle = oracle();
        let fg_keys = [
            "accent",
            "border",
            "borderAccent",
            "borderMuted",
            "success",
            "error",
            "warning",
            "muted",
            "dim",
            "text",
            "thinkingText",
            "scrollbarTrack",
            "scrollbarThumb",
            "searchMatchText",
            "userMessageText",
            "customMessageText",
            "customMessageLabel",
            "toolTitle",
            "toolOutput",
            "mdHeading",
            "mdLink",
            "mdLinkUrl",
            "mdCode",
            "mdCodeBlock",
            "mdCodeBlockBorder",
            "mdQuote",
            "mdQuoteBorder",
            "mdHr",
            "mdListBullet",
            "toolDiffAdded",
            "toolDiffRemoved",
            "toolDiffContext",
            "syntaxComment",
            "syntaxKeyword",
            "syntaxFunction",
            "syntaxVariable",
            "syntaxString",
            "syntaxNumber",
            "syntaxType",
            "syntaxOperator",
            "syntaxPunctuation",
            "thinkingOff",
            "thinkingMinimal",
            "thinkingLow",
            "thinkingMedium",
            "thinkingHigh",
            "thinkingXhigh",
            "thinkingMax",
            "bashMode",
        ];
        let bg_keys = [
            "selectedBg",
            "searchMatchBg",
            "userMessageBg",
            "customMessageBg",
            "toolPendingBg",
            "toolSuccessBg",
            "toolErrorBg",
        ];
        let cases = [
            ("theme_dark_truecolor", BUILTIN_DARK, ColorMode::Truecolor),
            ("theme_dark_256", BUILTIN_DARK, ColorMode::Color256),
            ("theme_light_truecolor", BUILTIN_LIGHT, ColorMode::Truecolor),
            ("theme_light_256", BUILTIN_LIGHT, ColorMode::Color256),
        ];
        for (key, document, mode) in cases {
            let doc = ThemeJson::parse(document).expect("built-in doc");
            let theme = create_theme(&doc, Some(mode), None).expect("create theme");
            let mut rendered = serde_json::Map::new();
            let fg: serde_json::Map<String, Value> = fg_keys
                .iter()
                .filter_map(|color| {
                    theme
                        .get_fg_ansi(color)
                        .ok()
                        .map(|ansi| ((*color).to_string(), ansi))
                })
                .map(|(color, ansi)| (color, json!(ansi)))
                .collect();
            let bg: serde_json::Map<String, Value> = bg_keys
                .iter()
                .filter_map(|color| {
                    theme
                        .get_bg_ansi(color)
                        .ok()
                        .map(|ansi| ((*color).to_string(), ansi))
                })
                .map(|(color, ansi)| (color, json!(ansi)))
                .collect();
            rendered.insert("fg".to_string(), Value::Object(fg));
            rendered.insert("bg".to_string(), Value::Object(bg));
            let expected = &oracle[key];
            assert_eq!(Value::Object(rendered), *expected, "table {key} diverges");
        }
    }

    /// Upstream `theme color mode` test: explicit color modes select the ANSI
    /// form (the capability probe is the caller's concern).
    #[test]
    fn color_mode_selects_the_ansi_form() {
        let ansi256 = load_builtin_theme("dark", Some(ColorMode::Color256)).expect("dark");
        assert_eq!(ansi256.get_color_mode(), ColorMode::Color256);
        let accent256 = ansi256.get_fg_ansi("accent").expect("accent");
        assert!(accent256.starts_with("\x1b[38;5;") && accent256.ends_with('m'));

        let truecolor = load_builtin_theme("dark", Some(ColorMode::Truecolor)).expect("dark");
        assert_eq!(truecolor.get_color_mode(), ColorMode::Truecolor);
        let accent_true = truecolor.get_fg_ansi("accent").expect("accent");
        assert!(accent_true.starts_with("\x1b[38;2;") && accent_true.ends_with('m'));
    }

    /// Upstream `theme detection from RGB` test.
    #[test]
    fn classifies_rgb_colors_by_luminance() {
        assert_eq!(get_theme_for_rgb_color((8, 8, 8)), TerminalTheme::Dark);
        assert_eq!(
            get_theme_for_rgb_color((250, 250, 250)),
            TerminalTheme::Light
        );
    }

    /// Upstream `theme setting helpers` test.
    #[test]
    fn parses_and_resolves_automatic_theme_settings() {
        assert_eq!(
            parse_auto_theme_setting(Some("light/dark")),
            Some(("light".to_string(), "dark".to_string()))
        );
        assert_eq!(
            resolve_theme_setting(Some("dark"), TerminalTheme::Light),
            Some("dark".to_string())
        );
        assert_eq!(
            resolve_theme_setting(Some("light/dark"), TerminalTheme::Light),
            Some("light".to_string())
        );
        assert_eq!(
            resolve_theme_setting(Some("light/dark"), TerminalTheme::Dark),
            Some("dark".to_string())
        );
        assert_eq!(
            resolve_theme_setting(Some("light/dark/extra"), TerminalTheme::Dark),
            None
        );
    }

    /// Upstream `detectTerminalBackgroundFromEnv` test.
    #[test]
    fn env_detection_uses_the_colorfgbg_background_index() {
        let light = detect_terminal_background_from_env(Some("0;15"));
        assert_eq!(light.theme, TerminalTheme::Light);
        assert_eq!(light.source, DetectionSource::Colorfgbg);
        assert_eq!(light.confidence, Confidence::High);

        let dark = detect_terminal_background_from_env(Some("15;0"));
        assert_eq!(dark.theme, TerminalTheme::Dark);
        assert_eq!(dark.source, DetectionSource::Colorfgbg);
        assert_eq!(dark.confidence, Confidence::High);

        assert_eq!(
            detect_terminal_background_from_env(Some("0;7;15")).theme,
            TerminalTheme::Light,
            "last COLORFGBG field wins"
        );

        let fallback = detect_terminal_background_from_env(None);
        assert_eq!(fallback.theme, TerminalTheme::Dark);
        assert_eq!(fallback.source, DetectionSource::Fallback);
        assert_eq!(fallback.confidence, Confidence::Low);
    }

    /// Upstream `getColorFgBgBackgroundIndex` edge cases.
    #[test]
    fn colorfgbg_index_takes_the_last_valid_field() {
        assert_eq!(get_color_fg_bg_background_index("0;15"), Some(15));
        assert_eq!(get_color_fg_bg_background_index("15;0"), Some(0));
        // 300 is out of range, "bad" is NaN; the last valid field wins.
        assert_eq!(get_color_fg_bg_background_index("15;bad;300"), Some(15));
        assert_eq!(get_color_fg_bg_background_index("15;bad"), Some(15));
        assert_eq!(get_color_fg_bg_background_index(""), None);
    }

    // -- async detection (stub UI, mirrors the upstream vi.fn() UI stubs) --

    struct StubDetector {
        background: Result<Option<(u8, u8, u8)>, String>,
        scheme: Option<Result<Option<TerminalTheme>, String>>,
        captured_timeouts: Arc<Mutex<Vec<u64>>>,
        background_started: Arc<Mutex<bool>>,
    }

    impl StubDetector {
        fn new(background: Result<Option<(u8, u8, u8)>, String>) -> Self {
            Self {
                background,
                scheme: None,
                captured_timeouts: Arc::new(Mutex::new(Vec::new())),
                background_started: Arc::new(Mutex::new(false)),
            }
        }

        fn with_scheme(mut self, scheme: Result<Option<TerminalTheme>, String>) -> Self {
            self.scheme = Some(scheme);
            self
        }
    }

    impl super::super::theme::TerminalBackgroundDetector for StubDetector {
        async fn query_terminal_background_color(
            &self,
            timeout_ms: u64,
        ) -> Result<Option<(u8, u8, u8)>, String> {
            *self.background_started.lock().expect("lock") = true;
            self.captured_timeouts
                .lock()
                .expect("lock")
                .push(timeout_ms);
            self.background.clone()
        }
    }

    impl super::super::theme::TerminalAutoDetector for StubDetector {
        async fn query_terminal_color_scheme(
            &self,
            timeout_ms: u64,
        ) -> Result<Option<TerminalTheme>, String> {
            match &self.scheme {
                Some(result) => {
                    self.captured_timeouts
                        .lock()
                        .expect("lock")
                        .push(timeout_ms);
                    result.clone()
                }
                None => Err("not supported".to_string()),
            }
        }
    }

    /// Upstream `detectTerminalBackgroundTheme` test: the queried terminal
    /// background wins over environment hints, and the env fallback applies
    /// when the query returns nothing or fails.
    #[tokio::test]
    async fn background_query_precedes_env_hints() {
        let detector = StubDetector::new(Ok(Some((250, 250, 250))));
        let detection = detect_terminal_background_theme(&detector, 250, Some("15;0")).await;
        assert_eq!(
            detector.captured_timeouts.lock().expect("lock").last(),
            Some(&250)
        );
        assert_eq!(detection.theme, TerminalTheme::Light);
        assert_eq!(detection.source, DetectionSource::TerminalBackground);
        assert_eq!(detection.confidence, Confidence::High);
        assert_eq!(detection.detail, "OSC 11 background rgb(250, 250, 250)");

        let detector = StubDetector::new(Ok(None));
        let detection = detect_terminal_background_theme(&detector, 250, Some("15;0")).await;
        assert_eq!(detection.theme, TerminalTheme::Dark);
        assert_eq!(detection.source, DetectionSource::Colorfgbg);
        assert_eq!(detection.confidence, Confidence::High);

        let detector = StubDetector::new(Err("terminal write failed".to_string()));
        let detection = detect_terminal_background_theme(&detector, 250, Some("0;15")).await;
        assert_eq!(detection.theme, TerminalTheme::Light);
        assert_eq!(detection.source, DetectionSource::Colorfgbg);
        assert_eq!(detection.confidence, Confidence::High);
    }

    /// Upstream `detectTerminalThemeForAuto` test: the color-scheme result
    /// wins while the background query runs, and the background result applies
    /// when the scheme query fails.
    #[tokio::test]
    async fn auto_detection_prefers_the_color_scheme() {
        let detector = StubDetector::new(Ok(None)).with_scheme(Ok(Some(TerminalTheme::Dark)));
        assert_eq!(
            detect_terminal_theme_for_auto(&detector, 100, None).await,
            TerminalTheme::Dark
        );
        assert!(*detector.background_started.lock().expect("lock"));

        let detector = StubDetector::new(Ok(Some((250, 250, 250))))
            .with_scheme(Err("color-scheme query failed".to_string()));
        assert_eq!(
            detect_terminal_theme_for_auto(&detector, 100, None).await,
            TerminalTheme::Light
        );
    }

    /// Upstream `getThemeByName` registry access for both built-ins.
    #[test]
    fn builtin_themes_load_by_name() {
        assert!(get_builtin_theme_json("dark").is_some());
        assert!(get_builtin_theme_json("light").is_some());
        assert!(get_builtin_theme_json("nope").is_none());
        assert!(load_builtin_theme("dark", None).is_ok());
        assert!(load_builtin_theme("nope", None).is_err());
    }

    /// Upstream `isLightTheme`.
    #[test]
    fn is_light_theme_checks_the_name() {
        assert!(is_light_theme(Some("light")));
        assert!(!is_light_theme(Some("dark")));
        assert!(!is_light_theme(None));
    }

    // -- theme-json.ts (oracle: validate_theme_json_oracle.mjs) ------------

    /// Upstream `validateThemeJson`: the built-in document is accepted.
    #[test]
    fn validation_accepts_the_builtin_document() {
        let dark = dark_value();
        let validated = validate_theme_json("dark.json", &dark).expect("valid");
        assert_eq!(
            validated.name,
            json_oracle()["valid_dark_name"].as_str().expect("name")
        );
    }

    /// Upstream `validateThemeJson`: missing color tokens produce the
    /// byte-exact "Missing required color tokens" message with a sorted list.
    #[test]
    fn validation_lists_missing_colors_byte_for_byte() {
        let mut broken = dark_value();
        let colors = broken
            .get_mut("colors")
            .and_then(Value::as_object_mut)
            .expect("colors");
        for key in ["accent", "thinkingXhigh", "bashMode", "userMessageBg"] {
            colors.remove(key);
        }
        let error = validate_theme_json("broken.json", &broken).expect_err("invalid");
        assert_eq!(
            error,
            json_oracle()["missing_four"].as_str().expect("message")
        );
    }

    /// Upstream `validateThemeJson`: an absent "colors" map lists every
    /// required token, byte for byte.
    #[test]
    fn validation_reports_an_absent_colors_map_byte_for_byte() {
        let mut no_colors = dark_value();
        no_colors
            .as_object_mut()
            .expect("object")
            .remove("colors")
            .expect("colors key");
        let error = validate_theme_json("nocolors.json", &no_colors).expect_err("invalid");
        assert_eq!(
            error,
            json_oracle()["colors_absent"].as_str().expect("message")
        );
    }

    /// Upstream `validateThemeJson`: theme names cannot contain "/".
    #[test]
    fn validation_rejects_slash_names_byte_for_byte() {
        let mut pair = dark_value();
        pair["name"] = json!("light/dark");
        let error = validate_theme_json("pair.json", &pair).expect_err("invalid");
        assert_eq!(
            error,
            json_oracle()["name_slash"].as_str().expect("message")
        );
    }

    /// Upstream `validateThemeJson`: a minimal-but-complete custom theme with
    /// vars, a 256-color index, and an empty value is accepted.
    #[test]
    fn validation_accepts_a_minimal_custom_theme() {
        let required_colors: serde_json::Map<String, Value> =
            super::super::theme_json::REQUIRED_COLORS
                .iter()
                .map(|key| {
                    (
                        (*key).to_string(),
                        if *key == "accent" {
                            json!("ink")
                        } else {
                            json!("#0a0b0c")
                        },
                    )
                })
                .collect();
        let minimal = json!({
            "name": "minimal",
            "vars": { "ink": "#010203" },
            "colors": required_colors,
            "scrollbarTrack": 24,
            "searchMatchText": "",
        });
        let validated = validate_theme_json("minimal.json", &minimal).expect("valid");
        assert_eq!(
            validated.name,
            json_oracle()["valid_minimal"].as_str().expect("name")
        );
    }

    // -- external-editor.ts (upstream test/external-editor.test.ts) --------

    type EditorCaptures = Arc<Mutex<Vec<(PathBuf, String)>>>;

    struct StubRunner {
        exit_code: Option<i32>,
        rewrite: Option<String>,
        captures: EditorCaptures,
    }

    impl StubRunner {
        fn spawn(code: Option<i32>, rewrite: Option<String>) -> (Self, EditorCaptures) {
            let captures = Arc::new(Mutex::new(Vec::new()));
            (
                Self {
                    exit_code: code,
                    rewrite,
                    captures: Arc::clone(&captures),
                },
                captures,
            )
        }
    }

    impl EditorRunner for StubRunner {
        async fn run(&self, editor: &str, editor_args: &[String], file_path: &Path) -> Option<i32> {
            assert_eq!(editor, "stub");
            assert!(
                editor_args.is_empty(),
                "only the file path follows the command"
            );
            let content = std::fs::read_to_string(file_path).expect("prompt readable");
            self.captures
                .lock()
                .expect("captures")
                .push((file_path.to_path_buf(), content));
            if let Some(text) = &self.rewrite {
                std::fs::write(file_path, text).expect("rewrite prompt");
            }
            self.exit_code
        }
    }

    fn stub_options() -> ExternalEditorOptions {
        ExternalEditorOptions {
            command: "stub".to_string(),
            content: "original".to_string(),
        }
    }

    /// Upstream "edits a prompt inside a private temporary directory": the
    /// original content is written to prompt.md under a pi-editor-* temp dir,
    /// the edited content comes back normalized, and the directory is removed.
    #[tokio::test]
    async fn external_editor_edits_a_prompt_in_a_private_temp_directory() {
        let (runner, captures) = StubRunner::spawn(Some(0), Some("edited".to_string()));
        let result = edit_in_external_editor_with(&stub_options(), &runner).await;

        assert_eq!(captures.lock().expect("captures").len(), 1);
        let (file_path, written) = &captures.lock().expect("captures")[0];
        assert_eq!(written, "original");
        assert_eq!(file_path.file_name().expect("name"), "prompt.md");
        let directory = file_path.parent().expect("parent");
        assert_eq!(
            directory.parent().expect("tmp"),
            std::env::temp_dir(),
            "the private directory lives under the system temp dir"
        );
        assert!(
            directory
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("pi-editor-")),
            "the directory name starts with pi-editor-"
        );
        assert!(!directory.exists(), "the private directory is cleaned up");
        assert_eq!(
            result,
            ExternalEditorResult::Complete {
                content: "edited".to_string()
            }
        );
    }

    /// Upstream "keeps the original content when the editor exits
    /// unsuccessfully".
    #[tokio::test]
    async fn external_editor_fails_when_the_editor_exits_unsuccessfully() {
        let (runner, captures) = StubRunner::spawn(Some(1), None);
        let result = edit_in_external_editor_with(&stub_options(), &runner).await;
        let (file_path, _) = &captures.lock().expect("captures")[0];
        assert!(!file_path.parent().expect("parent").exists());
        assert_eq!(result, ExternalEditorResult::Failed);
    }

    /// Upstream "returns empty content when the editor clears the prompt".
    #[tokio::test]
    async fn external_editor_returns_empty_content_for_a_cleared_prompt() {
        let (runner, _) = StubRunner::spawn(Some(0), Some(String::new()));
        let result = edit_in_external_editor_with(&stub_options(), &runner).await;
        assert_eq!(
            result,
            ExternalEditorResult::Complete {
                content: String::new()
            }
        );
    }

    /// A spawn error resolves to `failed` (upstream `child.on("error")`).
    #[tokio::test]
    async fn external_editor_treats_a_spawn_error_as_failure() {
        let (runner, _) = StubRunner::spawn(None, None);
        let result = edit_in_external_editor_with(&stub_options(), &runner).await;
        assert_eq!(result, ExternalEditorResult::Failed);
    }

    /// Real spawn (win32 shell semantics): an editor that truncates the prompt
    /// to empty completes with empty content.
    #[cfg(windows)]
    #[tokio::test]
    async fn real_spawn_truncating_editor_completes_with_empty_content() {
        let result = edit_in_external_editor(&ExternalEditorOptions {
            command: "cmd /c copy /y nul".to_string(),
            content: "original".to_string(),
        })
        .await;
        assert_eq!(
            result,
            ExternalEditorResult::Complete {
                content: String::new()
            }
        );
    }

    /// Real spawn: an unknown editor command resolves to `failed` (upstream
    /// `child.on("error")` / non-zero shell exit).
    #[cfg(windows)]
    #[tokio::test]
    async fn real_spawn_unknown_editor_fails() {
        let result = edit_in_external_editor(&ExternalEditorOptions {
            command: "definitely-not-a-real-editor-xyz-12345".to_string(),
            content: "original".to_string(),
        })
        .await;
        assert_eq!(result, ExternalEditorResult::Failed);
    }

    /// Upstream `hexToRgb`/`hexTo256` error messages.
    #[test]
    fn hex_parsing_error_messages_match_upstream() {
        assert_eq!(
            hex_to_rgb("nothex").expect_err("invalid"),
            "Invalid hex color: nothex"
        );
        assert_eq!(
            hex_to_rgb("#ff00").expect_err("short"),
            "Invalid hex color: #ff00"
        );
        assert_eq!(hex_to_rgb("#ff0000").expect("valid"), (255, 0, 0));
        assert_eq!(hex_to_256("#ff0000").expect("valid"), 196);
    }

    /// The `Theme` text stylers and accessors (upstream `Theme` class; the
    /// chalk level is fixed, see seam D2).
    #[test]
    fn theme_text_stylers_and_unknown_color_errors() {
        let theme = load_builtin_theme("dark", None).expect("dark");
        assert_eq!(theme.bold("x"), "\x1b[1mx\x1b[22m");
        assert_eq!(theme.italic("x"), "\x1b[3mx\x1b[23m");
        assert_eq!(theme.underline("x"), "\x1b[4mx\x1b[24m");
        assert_eq!(theme.inverse("x"), "\x1b[7mx\x1b[27m");
        assert_eq!(theme.strikethrough("x"), "\x1b[9mx\x1b[29m");

        let accent = theme.get_fg_ansi("accent").expect("accent");
        assert_eq!(
            theme.fg("accent", "t").expect("fg"),
            format!("{accent}t\x1b[39m")
        );
        let selected = theme.get_bg_ansi("selectedBg").expect("selectedBg");
        assert_eq!(
            theme.bg("selectedBg", "t").expect("bg"),
            format!("{selected}t\x1b[49m")
        );

        assert_eq!(
            theme.fg("not-a-color", "t").expect_err("unknown fg"),
            "Unknown theme color: not-a-color"
        );
        assert_eq!(
            theme.bg("not-a-bg", "t").expect_err("unknown bg"),
            "Unknown theme background color: not-a-bg"
        );
    }

    /// Upstream `getThinkingBorderColor` / `getBashModeBorderColor`.
    #[test]
    fn thinking_and_bash_mode_border_colors() {
        use super::super::theme::ThinkingLevel;
        let theme = load_builtin_theme("dark", None).expect("dark");
        let levels = [
            (ThinkingLevel::Off, "thinkingOff"),
            (ThinkingLevel::Minimal, "thinkingMinimal"),
            (ThinkingLevel::Low, "thinkingLow"),
            (ThinkingLevel::Medium, "thinkingMedium"),
            (ThinkingLevel::High, "thinkingHigh"),
            (ThinkingLevel::Xhigh, "thinkingXhigh"),
            (ThinkingLevel::Max, "thinkingMax"),
        ];
        for (level, key) in levels {
            let expected = theme.fg(key, "b").expect("border");
            assert_eq!(
                theme.get_thinking_border_color(level, "b").expect("border"),
                expected
            );
        }
        assert_eq!(
            theme.get_bash_mode_border_color("b").expect("bash border"),
            theme.fg("bashMode", "b").expect("bash border")
        );
    }
}
