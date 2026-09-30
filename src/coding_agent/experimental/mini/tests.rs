//! Tests for the `mini/` port: pinned to the node oracle captured from the
//! verbatim upstream `rpc.ts` (and verbatim bodies for the rest)
//! (tests/fixtures/experimental_final_oracle/oracle_mini_out.json).

use super::lane_service::{map_lane_command, set_model_guard};
use super::protocol::{
    CommandResult, ModelRef, ModelSummary, ProviderAccount, API_KEY_LOGIN_LABEL,
    SUBSCRIPTION_LOGIN_LABEL,
};
use super::rpc::{
    dispatch_decision, no_host_provides_error, timeout_error, DispatchDecision, RpcPeer,
    CALL_CANCELLED, CANCELLED_BY_CALLER, CONNECTION_CLOSED,
};
use super::server_run::{system_prompt, unknown_session_error, MiniServer, RetireDecision, Route};
use super::transport::{
    validate_server_entry_args, validate_worker_entry_args, JsonFraming, SERVER_START_TIMEOUT_ERROR,
};
use super::tui_session::{AttachedSessionState, ResubscribeDecision};
use super::tui_view::{
    continue_session_id, login_method_labels, login_method_to_auth_type, mini_footer,
    queue_item_text, route_submit, split_model_value, MiniDraw, MiniEntry, MiniMessage,
    MiniSubmitRoute, MiniTranscriptSync, QueueItem,
};
use serde_json::json;
use std::sync::Mutex;

/// Upstream service-object invoke face for the tests.
type TestInvoke = Box<
    dyn Fn(&str, &str, &[serde_json::Value]) -> Result<Option<serde_json::Value>, String> + Send,
>;

/// Upstream service-object face for the tests: `lane.fail` throws,
/// `lane.nothing` returns undefined, everything else returns `true`.
fn test_invoke() -> TestInvoke {
    Box::new(|_service, member, _args| match member {
        "fail" => Err("harness gone".to_string()),
        "nothing" => Ok(None),
        "nope" => Err(super::rpc::unknown_method_error("lane.nope")),
        _ => Ok(Some(serde_json::Value::Bool(true))),
    })
}

#[derive(Default)]
struct RecordingConnection {
    sent: Mutex<Vec<serde_json::Value>>,
    closed: Mutex<bool>,
}

impl RecordingConnection {
    fn json(&self) -> Vec<String> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|frame| frame.to_string())
            .collect()
    }

    fn is_closed(&self) -> bool {
        *self.closed.lock().unwrap()
    }
}

impl super::rpc::Connection for RecordingConnection {
    fn send(&self, message: &serde_json::Value) {
        self.sent.lock().unwrap().push(message.clone());
    }
    fn close(&self) {
        *self.closed.lock().unwrap() = true;
    }
}

#[test]
fn announce_call_and_result_frames_match_the_oracle_bytes() {
    // Oracle: rpc.announce / callRoundTrip.frame / errorFrame.frame.
    let connection = RecordingConnection::default();
    let mut peer = RpcPeer::new(connection, None, test_invoke());
    peer.provide("lane");
    assert_eq!(
        peer.connection().json()[0],
        r#"{"kind":"announce","services":["lane"]}"#.to_string()
    );

    let id = peer.call_with("lane.prompt", &[json!("hi")], None).unwrap();
    assert_eq!(
        peer.connection().json()[1],
        r#"{"kind":"call","id":1,"method":"lane.prompt","args":["hi"]}"#.to_string()
    );

    // The dispatch answers with a result frame (`undefined` -> null).
    let frame = peer.on_call(id, "lane.prompt", &[json!("hi")]);
    assert_eq!(
        frame.to_json().to_string(),
        r#"{"kind":"result","id":1,"result":true}"#.to_string()
    );

    let id = peer.call_with("lane.fail", &[], None).unwrap();
    let frame = peer.on_call(id, "lane.fail", &[]);
    assert_eq!(
        frame.to_json().to_string(),
        r#"{"kind":"error","id":2,"error":"harness gone"}"#.to_string()
    );
}

#[test]
fn dispatch_errors_match_the_oracle_texts() {
    // Oracle: rpc.dispatchErrors.
    assert_eq!(
        dispatch_decision("models.refresh", false),
        DispatchDecision::NoService("No service provides models.refresh".to_string())
    );
    assert_eq!(
        dispatch_decision("lane.nope", false),
        DispatchDecision::NoService("No service provides lane.nope".to_string())
    );
    // A provided service without the member: unknown method text.
    assert_eq!(
        super::rpc::unknown_method_error("lane.nope"),
        "Unknown method: lane.nope"
    );
    {
        let connection = RecordingConnection::default();
        let mut peer = RpcPeer::new(connection, None, test_invoke());
        peer.provide("lane");
        let id = peer.call_with("lane.nope", &[], None).unwrap();
        let frame = peer.on_call(id, "lane.nope", &[]);
        assert_eq!(
            frame.to_json().to_string(),
            r#"{"kind":"error","id":1,"error":"Unknown method: lane.nope"}"#.to_string()
        );
    }
    // Forward available: the call forwards.
    assert_eq!(
        dispatch_decision("sessions.list", true),
        DispatchDecision::Forward
    );
}

#[test]
fn forward_routing_and_error_match_the_oracle() {
    // Oracle: rpc.forward (forwarded method/args, listed result, error).
    let forwarded = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(
        String,
        Vec<serde_json::Value>,
    )>::new()));
    let forwarded_sink = forwarded.clone();
    let forward = Box::new(move |method: &str, args: &[serde_json::Value]| {
        forwarded_sink
            .lock()
            .unwrap()
            .push((method.to_string(), args.to_vec()));
        if method == "sessions.list" {
            Ok(json!([{ "id": "s1" }]))
        } else {
            Err("forward exploded".to_string())
        }
    });
    let connection = RecordingConnection::default();
    let mut peer = RpcPeer::new(connection, Some(forward), test_invoke());
    let id = peer.call_with("sessions.list", &[], None).unwrap();
    let frame = peer.on_call(id, "sessions.list", &[]);
    assert_eq!(
        frame.to_json().to_string(),
        r#"{"kind":"result","id":1,"result":[{"id":"s1"}]}"#.to_string()
    );
    assert_eq!(
        forwarded.lock().unwrap().clone(),
        vec![("sessions.list".to_string(), Vec::<serde_json::Value>::new())]
    );

    let id = peer
        .call_with(
            "sessions.attach",
            &[json!("s1"), json!("/tmp"), json!("p1")],
            None,
        )
        .unwrap();
    let frame = peer.on_call(
        id,
        "sessions.attach",
        &[json!("s1"), json!("/tmp"), json!("p1")],
    );
    assert_eq!(
        frame.to_json().to_string(),
        r#"{"kind":"error","id":2,"error":"forward exploded"}"#.to_string()
    );
}

#[test]
fn undefined_results_and_events_match_the_oracle_frames() {
    // Oracle: rpc.undefinedResult / events.sent / laneEvents / rawEvents.
    let connection = RecordingConnection::default();
    let mut peer = RpcPeer::new(connection, None, test_invoke());
    peer.provide("lane");
    let id = peer.call_with("lane.nothing", &[], None).unwrap();
    let frame = peer.on_call(id, "lane.nothing", &[]);
    assert_eq!(
        frame.to_json().to_string(),
        r#"{"kind":"result","id":1,"result":null}"#.to_string()
    );

    peer.emit(
        "lane",
        &json!({"subscriptionId":"sub-1","event":{"type":"run_start"}}),
    );
    peer.emit_to(
        "models",
        &json!({"type":"prompt","requestId":"r1"}),
        "presentation-9",
    );
    peer.emit_raw("custom.service", &json!({"n":1}), None);

    let seen = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let seen_events = seen.clone();
    peer.on_event(Box::new(move |service, _payload, to| {
        seen_events.lock().unwrap().push(format!(
            "{service}{}",
            to.map(|to| format!("@{to}")).unwrap_or_default()
        ));
    }));
    peer.on_incoming_event("lane", &json!({"subscriptionId":"sub-1"}), None);
    peer.on_incoming_event("models", &json!({"type":"notice"}), Some("presentation-9"));
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["lane".to_string(), "models@presentation-9".to_string()]
    );
}

#[test]
fn cancel_and_timeout_contracts_match_the_oracle() {
    // Oracle: rpc.cancel (frame shape, sawAbort) / timeout (error + cancel
    // frame) / preAborted / closeRejects.
    let connection = RecordingConnection::default();
    let mut peer = RpcPeer::new(connection, None, test_invoke());
    peer.provide("lane");
    let id = peer.call_with("lane.slow", &[json!("x")], None).unwrap();
    // The dispatch registers the inflight controller; the cancel lands while
    // the embedder's async dispatch is still pending.
    let _ = peer.on_call(id, "lane.slow", &[json!("x")]);
    assert_eq!(peer.on_cancel(id), Some(CANCELLED_BY_CALLER));
    // Settlement clears the marker.
    peer.settle_call(id);
    assert_eq!(peer.on_cancel(id), None);
    assert_eq!(peer.on_cancel(999), None);
    // A late result for a cancelled call resolves the waiter (upstream
    // `pending.delete` only happens on settle).
    assert_eq!(peer.on_result(id), Ok(()));
    assert_eq!(CALL_CANCELLED, "Call cancelled");

    let connection = RecordingConnection::default();
    let mut peer = RpcPeer::new(connection, None, test_invoke());
    let id = peer
        .call_with("lane.prompt", &[json!("hi")], Some(20))
        .unwrap();
    let error = peer.on_timeout(id).unwrap_err();
    assert_eq!(error, timeout_error("lane.prompt", 20));
    assert_eq!(
        peer.connection().json(),
        vec![
            r#"{"kind":"call","id":1,"method":"lane.prompt","args":["hi"]}"#.to_string(),
            r#"{"kind":"cancel","id":1}"#.to_string(),
        ]
    );
    // A second timeout fire is a no-op (waiter already gone).
    assert_eq!(peer.on_timeout(id), Ok(()));

    // Close rejects every pending call.
    let connection = RecordingConnection::default();
    let mut peer = RpcPeer::new(connection, None, test_invoke());
    let _ = peer.call_with("lane.prompt", &[], None).unwrap();
    assert_eq!(
        peer.on_connection_closed(),
        vec![CONNECTION_CLOSED.to_string()]
    );
    assert_eq!(CONNECTION_CLOSED, "Connection closed");
    peer.close();
    assert!(peer.connection().is_closed());
}

#[test]
fn liveness_matches_the_upstream_tick_rules() {
    // Upstream liveness: any frame proves life; pings keep it alive.
    assert_eq!(RpcPeer::<RecordingConnection>::default_dead_ms(), 15_000);
    assert_eq!(
        RpcPeer::<RecordingConnection>::liveness_interval_ms(15_000),
        5_000
    );
    assert_eq!(RpcPeer::<RecordingConnection>::liveness_interval_ms(0), 0);
    let connection = RecordingConnection::default();
    let peer = RpcPeer::new(connection, None, test_invoke());
    assert_eq!(
        peer.liveness_tick(15_000, 16_000),
        super::rpc::LivenessAction::Closed
    );
    assert_eq!(
        peer.liveness_tick(15_000, 1_000),
        super::rpc::LivenessAction::Pinged
    );
    assert_eq!(
        peer.liveness_tick(0, 999_999),
        super::rpc::LivenessAction::Disabled
    );
}

#[test]
fn announce_frames_replace_the_announced_set() {
    // Upstream `case "announce"`: clear + insert.
    let connection = RecordingConnection::default();
    let mut peer = RpcPeer::new(connection, None, test_invoke());
    peer.on_announce(&["lane".to_string(), "models".to_string()]);
    let mut announced = peer.announced();
    announced.sort_unstable();
    assert_eq!(announced, vec!["lane", "models"]);
    peer.on_announce(&["worker".to_string()]);
    assert_eq!(peer.announced(), vec!["worker"]);
}

#[test]
fn json_framing_matches_the_oracle_lines() {
    // Oracle: framing.parsed / writtenBeforeClose / writtenFinal /
    // bufferedTail. The oracle feeds a chunk ending one character short of
    // the JSON ({"c":3 without the closing brace) and the tail ("3}\n") on
    // the next chunk, completing {"c":33}.
    let mut framing = JsonFraming::new();
    let mut parsed: Vec<String> = Vec::new();
    framing.feed(
        &format!("{}\n\n{}\n{}", json!({"a":1}), json!({"b":2}), r#"{"c":3"#),
        |message| parsed.push(message.to_string()),
    );
    assert_eq!(
        parsed,
        vec![json!({"a":1}).to_string(), json!({"b":2}).to_string()]
    );
    // The partial line completes on the next chunk.
    framing.feed("3}\n", |message| parsed.push(message.to_string()));
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[2], json!({"c":33}).to_string());
    assert_eq!(framing.buffered_tail(), "");
    let written_before_close: Vec<String> = {
        framing.send(&json!({"kind": "ping"}));
        let written = framing.written().to_vec();
        written
    };
    framing.notify_closed();
    framing.send(&json!({"kind":"after-close"}));
    assert_eq!(
        written_before_close,
        vec![format!("{}\n", json!({"kind":"ping"}))]
    );
    assert_eq!(
        framing.written(),
        vec![format!("{}\n", json!({"kind":"ping"}))]
    );
    assert!(framing.is_closed());
}

#[test]
fn worker_faces_match_the_oracle() {
    // Oracle: worker.systemPrompt / unknownSession / knownSession /
    // entryValidation.
    assert_eq!(
        system_prompt("/work/demo"),
        "You are a coding agent working in a terminal.\nWorking directory: /work/demo\nUse the read, write, edit, and bash tools to inspect and change files.\nKeep answers short and technical."
    );
    assert_eq!(unknown_session_error("s2"), "Unknown session: s2");
    let sessions = vec![("s1".to_string(), "/sessions/s1".to_string())];
    assert_eq!(
        super::worker_run::open_session(&sessions, Some("s2")).unwrap_err(),
        "Unknown session: s2"
    );
    assert_eq!(
        super::worker_run::open_session(&sessions, Some("s1")).unwrap(),
        &("s1".to_string(), "/sessions/s1".to_string())
    );
    assert_eq!(
        validate_worker_entry_args(&[]).unwrap_err(),
        "Session worker requires <sessionsRoot> <cwd> [sessionId]"
    );
    assert_eq!(
        validate_server_entry_args(&[]).unwrap_err(),
        "Server requires <socketPath> <sessionsRoot>"
    );
}

#[test]
fn lane_command_mapping_matches_the_oracle() {
    // Oracle: laneService.ok / laneError / laneErrorNoMessage / thrown /
    // setModelUnknown.
    assert_eq!(map_lane_command(Ok(Some(Ok(())))), CommandResult::ok());
    assert_eq!(
        map_lane_command(Ok(Some(Err(Some("lane refused".to_string()))))),
        CommandResult::error("lane refused")
    );
    assert_eq!(
        map_lane_command(Ok(Some(Err(None)))),
        CommandResult::error("Command failed")
    );
    assert_eq!(
        map_lane_command(Err("harness gone".to_string())),
        CommandResult::error("harness gone")
    );
    assert_eq!(
        set_model_guard(false, "nope", "missing").unwrap(),
        CommandResult::error("Unknown model: nope/missing")
    );
    assert_eq!(set_model_guard(true, "p", "m"), None);
    assert_eq!(
        super::models_service::refresh_result(&["anthropic".to_string(), "openai".to_string()]),
        CommandResult::error("Some catalogs could not be refreshed: anthropic, openai")
    );
    assert_eq!(
        CommandResult::ok(),
        CommandResult {
            ok: true,
            error: None
        }
    );
}

#[test]
fn models_state_matches_the_oracle_shape() {
    // Oracle: modelsService.state (models order preserved, accounts sorted
    // by display name; upstream `label ?? source === undefined` semantics).
    let state = super::models_service::read_state(
        vec![
            ModelSummary {
                provider: "b".to_string(),
                model_id: "m2".to_string(),
                name: "Zeta".to_string(),
            },
            ModelSummary {
                provider: "a".to_string(),
                model_id: "m1".to_string(),
                name: "Alpha".to_string(),
            },
        ],
        &[
            super::models_service::ProviderRuntimeFace {
                id: "p2".to_string(),
                name: "Zeta".to_string(),
                oauth_name: Some("ZLogin".to_string()),
                api_key_name: None,
                api_key_login: false,
                status: super::models_service::ProviderAuthStatusFace {
                    configured: false,
                    label: None,
                    source: Some("environment".to_string()),
                },
            },
            super::models_service::ProviderRuntimeFace {
                id: "p1".to_string(),
                name: "Anthropic".to_string(),
                oauth_name: None,
                api_key_name: Some("KeyLogin".to_string()),
                api_key_login: true,
                status: super::models_service::ProviderAuthStatusFace {
                    configured: true,
                    label: Some("stored".to_string()),
                    source: None,
                },
            },
        ],
        true,
    );
    assert!(state.refreshing);
    let names: Vec<String> = state
        .accounts
        .iter()
        .map(|account| account.name.clone())
        .collect();
    assert_eq!(names, vec!["Anthropic".to_string(), "Zeta".to_string()]);
    assert_eq!(state.accounts[0].source.as_deref(), Some("stored"));
    assert_eq!(state.accounts[1].source.as_deref(), Some("environment"));

    // The oracle's refresh/login error strings.
    assert_eq!(
        super::models_service::refresh_result(&["anthropic".to_string(), "openai".to_string()]),
        CommandResult::error("Some catalogs could not be refreshed: anthropic, openai")
    );
    assert_eq!(
        super::models_service::refresh_result(&[]),
        CommandResult::ok()
    );
    assert_eq!(
        super::models_service::auth_command_result(Err("provider said no".to_string())),
        CommandResult::error("provider said no")
    );

    // authReply: remove the waiter and settle with the answer.
    let mut pending = vec![
        ("r1".to_string(), Some("yes".to_string())),
        ("r2".to_string(), None),
    ];
    assert_eq!(
        super::models_service::auth_reply(&mut pending, "r1", Some("code".to_string())),
        Some(Some("code".to_string()))
    );
    assert_eq!(pending.len(), 1);
    assert_eq!(
        super::models_service::auth_reply(&mut pending, "missing", None),
        None
    );
}

#[test]
fn view_routing_and_labels_match_the_oracle() {
    // Oracle: miniTui.queue / submit / loginLabels / continueSelection /
    // modelValueSplit / notAttached / noHostProvides.
    assert_eq!(
        queue_item_text(&QueueItem::Message {
            message: MiniMessage::User {
                content: "a  b".to_string(),
            },
        }),
        "[message] a b"
    );
    assert_eq!(
        queue_item_text(&QueueItem::Custom {
            custom_type: "pi.memory".to_string(),
        }),
        "[write] <pi.memory>"
    );

    assert_eq!(route_submit("", false), MiniSubmitRoute::Ignore);
    assert_eq!(route_submit("/model", false), MiniSubmitRoute::SelectModel);
    assert_eq!(route_submit("/login", false), MiniSubmitRoute::Login);
    assert_eq!(route_submit("/compact", false), MiniSubmitRoute::Compact);
    assert_eq!(route_submit("hello", true), MiniSubmitRoute::Steer);
    assert_eq!(route_submit("hello", false), MiniSubmitRoute::Prompt);

    assert_eq!(
        login_method_labels(),
        [
            SUBSCRIPTION_LOGIN_LABEL.to_string(),
            API_KEY_LOGIN_LABEL.to_string()
        ]
    );
    assert_eq!(login_method_to_auth_type(SUBSCRIPTION_LOGIN_LABEL), "oauth");
    assert_eq!(login_method_to_auth_type(API_KEY_LOGIN_LABEL), "api_key");

    assert_eq!(
        continue_session_id(
            &[
                ("old".to_string(), "/w".to_string(), 1),
                ("new".to_string(), "/w".to_string(), 9),
                ("other".to_string(), "/elsewhere".to_string(), 100),
            ],
            "/w"
        ),
        Some("new".to_string())
    );
    assert_eq!(
        continue_session_id(&[("only".to_string(), "/x".to_string(), 5)], "/w"),
        None
    );

    assert_eq!(
        split_model_value("provider/model-id"),
        ("provider".to_string(), "model-id".to_string())
    );

    assert_eq!(super::rpc::NOT_ATTACHED_ERROR, "Not attached to a session");
    assert_eq!(
        no_host_provides_error(
            "lane",
            &["sessions".to_string()],
            &[
                "lane".to_string(),
                "models".to_string(),
                "worker".to_string()
            ]
        ),
        "No host provides lane: server has [sessions], worker has [lane, models, worker]"
    );
}

#[test]
fn mini_server_routing_matches_the_oracle() {
    // Oracle: miniServer.attachBookkeeping / idleRetire.
    let mut server = MiniServer::default();
    server.connect_presentation();
    // Attach a and b; reattach a moves the slot (never duplicates).
    server.attach("s1", "presentation-a").unwrap();
    server.attach("s1", "presentation-b").unwrap();
    server.attach("s1", "presentation-a").unwrap();
    let route = server.route("s1").unwrap();
    assert_eq!(
        route.subscribers,
        vec!["presentation-b".to_string(), "presentation-a".to_string()]
    );
    assert!(!route.stopped);

    // Detaching one subscriber keeps the worker.
    assert_eq!(server.detach("s1", "presentation-a"), Some(false));
    // Detaching the last stops it.
    assert_eq!(server.detach("s1", "presentation-b"), Some(true));
    assert!(server.route("s1").unwrap().stopped);

    // Idle retire: held while routes exist, scheduled when empty.
    assert_eq!(server.consider_retiring(), RetireDecision::Hold);
    server.worker_closed("s1");
    server.disconnect_presentation();
    assert_eq!(
        server.consider_retiring(),
        RetireDecision::ScheduleAfter(10_000)
    );
    assert!(server.idle_timer_fired(true));
    assert!(server.is_retired());
}

#[test]
fn ensure_route_and_event_targets_follow_upstream() {
    // Upstream ensureRoute: existing -> Existing; pending -> JoinSpawn;
    // otherwise Spawn.
    let mut server = MiniServer::default();
    let (outcome, id) = server.ensure_route(Some("s1"));
    assert_eq!(outcome, super::server_run::EnsureRouteOutcome::Spawn);
    assert_eq!(id.as_deref(), Some("s1"));
    let (outcome, _) = server.ensure_route(Some("s1"));
    assert_eq!(outcome, super::server_run::EnsureRouteOutcome::JoinSpawn);
    server.route_spawned("s1");
    let (outcome, _) = server.ensure_route(Some("s1"));
    assert_eq!(outcome, super::server_run::EnsureRouteOutcome::Existing);
    let (outcome, id) = server.ensure_route(None);
    assert_eq!(outcome, super::server_run::EnsureRouteOutcome::Spawn);
    assert_eq!(id, None);

    // Addressed events reach one presentation; shared events fan out.
    server.attach("s1", "a").unwrap();
    server.attach("s1", "b").unwrap();
    assert_eq!(server.route_event_targets("s1", Some("a")), vec!["a"]);
    assert_eq!(server.route_event_targets("s1", None), vec!["a", "b"]);
    assert_eq!(
        server.route_event_targets("missing", None),
        Vec::<&str>::new()
    );

    // Forward guard: attached + announced passes; otherwise the exact error.
    assert_eq!(
        server.forward_decision(
            Some("s1"),
            "lane.prompt",
            &["sessions".to_string()],
            &["lane".to_string()]
        ),
        Ok(())
    );
    assert_eq!(
        server
            .forward_decision(
                Some("s1"),
                "sessions.list",
                &["sessions".to_string()],
                &["lane".to_string()]
            )
            .unwrap_err(),
        "No host provides sessions: server has [sessions], worker has [lane]"
    );
    assert_eq!(
        server
            .forward_decision(None, "lane.prompt", &[], &[])
            .unwrap_err(),
        "Not attached to a session"
    );
}

#[test]
fn session_attach_flow_matches_upstream() {
    // Upstream tui/session.ts connect + resubscribe + fold.
    let mut state = AttachedSessionState::default();
    assert_eq!(state.fold(false), ResubscribeDecision::None);
    let previous = state.resubscribed("sub-1", "snapshot-1");
    assert_eq!(previous, None);
    assert!(state.accepts_event("sub-1"));
    assert!(!state.accepts_event("sub-0"));
    assert_eq!(state.fold(false), ResubscribeDecision::Publish);
    assert_eq!(state.fold(true), ResubscribeDecision::Resubscribe);
    let previous = state.resubscribed("sub-2", "snapshot-2");
    assert_eq!(previous.as_deref(), Some("sub-1"));
    assert!(state.accepts_event("sub-2"));
    assert_eq!(super::tui_session::attach_timeout_ms(), 60_000);
}

#[test]
fn transcript_sync_and_footer_match_upstream() {
    let mut sync = MiniTranscriptSync::new();
    let mut draws = Vec::new();
    sync.sync(
        &[
            MiniEntry::Compaction {
                id: "c1".to_string(),
                tokens_before: 900,
                retained_tail: vec![MiniMessage::User {
                    content: "kept".to_string(),
                }],
            },
            MiniEntry::BranchSummary {
                id: "b1".to_string(),
                summary: "did things".to_string(),
            },
            MiniEntry::Custom {
                id: "u1".to_string(),
                custom_type: "pi.notice".to_string(),
            },
            MiniEntry::Message {
                id: "m1".to_string(),
                message: MiniMessage::User {
                    content: "hi".to_string(),
                },
            },
            MiniEntry::Message {
                id: "m2".to_string(),
                message: MiniMessage::Assistant {
                    text: "hey".to_string(),
                    tool_calls: vec![("read".to_string(), "call-1".to_string())],
                },
            },
            MiniEntry::Message {
                id: "m3".to_string(),
                message: MiniMessage::ToolResult {
                    tool_name: "read".to_string(),
                    tool_call_id: "call-1".to_string(),
                },
            },
        ],
        &mut draws,
    );
    assert_eq!(
        draws,
        vec![
            MiniDraw::Text("[compaction] compacted from 900 tokens".to_string()),
            MiniDraw::User("kept".to_string()),
            MiniDraw::Text("[branch summary]".to_string()),
            MiniDraw::Text("did things".to_string()),
            MiniDraw::Text("[pi.notice]".to_string()),
            MiniDraw::User("hi".to_string()),
            MiniDraw::Assistant("hey".to_string()),
            MiniDraw::ToolCall("read:call-1".to_string()),
            MiniDraw::ToolResult("read:call-1".to_string()),
        ]
    );
    // Diverged (shorter) transcript: rebuild from scratch.
    let mut draws = Vec::new();
    sync.sync(
        &[MiniEntry::Custom {
            id: "u1".to_string(),
            custom_type: "pi.notice".to_string(),
        }],
        &mut draws,
    );
    assert_eq!(
        draws,
        vec![MiniDraw::Clear, MiniDraw::Text("[pi.notice]".to_string()),]
    );

    // Working indicator transitions only on change.
    let mut draws = Vec::new();
    sync.set_working(true, &mut draws);
    sync.set_working(true, &mut draws);
    assert_eq!(draws, vec![MiniDraw::Clear, MiniDraw::Working(true)]);

    assert_eq!(
        mini_footer("p", "m", "off", "(ctrl+p)", "(alt+enter)", "(ctrl+c)"),
        "p/m · thinking:off · (ctrl+p) or /model · /login · /compact · (alt+enter) follow-up · (ctrl+c) exit"
    );
}

#[test]
fn server_start_probe_and_constants_match_upstream() {
    assert_eq!(
        super::tui_run::ensure_server_tick(true, 0, false),
        super::tui_run::EnsureServerProbe::Connected
    );
    assert_eq!(
        super::tui_run::ensure_server_tick(false, 0, false),
        super::tui_run::EnsureServerProbe::StartServer
    );
    assert_eq!(
        super::tui_run::ensure_server_tick(false, 3, false),
        super::tui_run::EnsureServerProbe::RetryAfter(50)
    );
    assert_eq!(
        super::tui_run::ensure_server_tick(false, 3, true),
        super::tui_run::EnsureServerProbe::TimedOut
    );
    assert_eq!(
        SERVER_START_TIMEOUT_ERROR,
        "Timed out waiting for the mini session server"
    );
    assert_eq!(super::protocol::WORKER_START_TIMEOUT_MS, 30_000);
    assert_eq!(super::protocol::IDLE_SHUTDOWN_MS, 10_000);
    assert_eq!(super::protocol::CATALOG_REFRESH_TIMEOUT_MS, 15_000);
    assert_eq!(super::protocol::SERVER_START_TIMEOUT_MS, 10_000);
    assert_eq!(
        super::tui_view::parse_mini_args(&["--continue".to_string()]).unwrap(),
        super::tui_view::TuiOptions {
            continue_session: true
        }
    );
    assert_eq!(
        super::tui_view::parse_mini_args(&["--bogus".to_string()]).unwrap_err(),
        "Unknown argument: --bogus"
    );
    assert_eq!(
        super::main::parse_args(&["-c".to_string()]).unwrap(),
        super::tui_view::TuiOptions {
            continue_session: true
        }
    );
}

#[test]
fn model_ref_passthrough_matches_upstream() {
    let reference = ModelRef {
        provider: "p".to_string(),
        model_id: "m".to_string(),
    };
    assert_eq!(
        super::lane_service::model_ref_passthrough(&reference),
        reference
    );
    let account = ProviderAccount {
        id: "p1".to_string(),
        name: "Anthropic".to_string(),
        auth_type: "oauth".to_string(),
        configured: true,
        source: Some("stored".to_string()),
        interactive: true,
        method_name: Some("Claude account".to_string()),
    };
    assert_eq!(
        super::tui_view::auth_selector_providers(&[account])[0],
        (
            "p1".to_string(),
            "oauth".to_string(),
            Some("stored".to_string())
        )
    );
    assert_eq!(
        super::tui_view::non_interactive_login_message(Some("AWS profile")),
        "AWS profile is configured outside pi."
    );
    assert_eq!(
        super::tui_view::non_interactive_login_message(None),
        "Authentication is configured outside pi."
    );
}

#[test]
fn route_summary_type_is_upstream_shaped() {
    // Upstream Route default face.
    let route = Route::default();
    assert!(route.session_id.is_empty());
    assert!(route.subscribers.is_empty());
    assert!(!route.stopped);
}
