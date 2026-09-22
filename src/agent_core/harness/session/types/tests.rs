//! Wire-format and accessor tests for the session entry vocabulary. The
//! upstream `types.test.ts` cases covering this subset are type-level only,
//! so these pin the serde contract the module docs disclose: upstream JSONL
//! entry objects (`type`-tagged, camelCase fields, `null` for the
//! always-present `parentId`/`fromId`, optional fields omitted) round-trip
//! unchanged.

use super::*;
use crate::agent_core::types::CustomAgentMessage;

#[test]
fn message_entry_round_trips_upstream_wire() {
    let wire = r#"{"type":"message","id":"e1","parentId":null,"seq":1,"timestamp":1700000000000,"message":{"role":"user","content":"hi","timestamp":1700000000000}}"#;
    let entry: Entry = serde_json::from_str(wire).unwrap();
    match &entry {
        Entry::Message {
            id,
            parent_id,
            seq,
            timestamp,
            terminate,
            ..
        } => {
            assert_eq!(id, "e1");
            assert_eq!(*parent_id, None);
            assert_eq!(*seq, 1);
            assert_eq!(*timestamp, 1_700_000_000_000);
            assert_eq!(*terminate, None);
        }
        other => panic!("expected message entry, got {other:?}"),
    }
    assert_eq!(serde_json::to_string(&entry).unwrap(), wire);
    assert_eq!(entry.id(), "e1");
    assert_eq!(entry.parent_id(), None);
    assert_eq!(entry.seq(), 1);
    assert_eq!(entry.timestamp(), 1_700_000_000_000);
    assert_eq!(
        entry
            .message()
            .map(crate::agent_core::types::AgentMessage::role),
        Some("user")
    );
}

#[test]
fn message_entry_optional_fields_round_trip() {
    // `parentId` may reference a parent, and `terminate: true` serializes when
    // set (upstream `terminate?: true`).
    let wire = r#"{"type":"message","id":"e2","parentId":"e1","seq":2,"timestamp":1700000000001,"message":{"role":"user","content":"go","timestamp":1700000000001},"terminate":true}"#;
    let entry: Entry = serde_json::from_str(wire).unwrap();
    assert_eq!(entry.parent_id(), Some("e1"));
    match &entry {
        Entry::Message {
            terminate, message, ..
        } => {
            assert_eq!(*terminate, Some(true));
            assert!(matches!(
                message,
                crate::agent_core::types::AgentMessage::User(_)
            ));
        }
        other => panic!("expected message entry, got {other:?}"),
    }
    assert_eq!(serde_json::to_string(&entry).unwrap(), wire);
}

#[test]
fn compaction_entry_round_trips_upstream_wire() {
    let wire = r#"{"type":"compaction","id":"c1","parentId":null,"seq":3,"timestamp":1700000000002,"summary":"summary","retainedTail":[{"role":"user","content":"kept","timestamp":1700000000002}],"tokensBefore":1234,"usage":{"input":3,"output":2,"cacheRead":1,"cacheWrite":4,"totalTokens":10,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"fromHook":false}"#;
    let entry: Entry = serde_json::from_str(wire).unwrap();
    match &entry {
        Entry::Compaction {
            id,
            summary,
            retained_tail,
            tokens_before,
            details,
            usage,
            from_hook,
            ..
        } => {
            assert_eq!(id, "c1");
            assert_eq!(summary, "summary");
            assert_eq!(retained_tail.len(), 1);
            assert_eq!(*tokens_before, 1234);
            assert_eq!(*details, None);
            assert_eq!(usage.as_ref().map(|usage| usage.total_tokens), Some(10));
            assert!(!*from_hook);
        }
        other => panic!("expected compaction entry, got {other:?}"),
    }
    assert_eq!(serde_json::to_string(&entry).unwrap(), wire);

    // Optional `details` serializes when present and the minimal shape omits
    // both `details` and `usage` (upstream `undefined`).
    let minimal = Entry::Compaction {
        id: "c2".to_string(),
        parent_id: Some("c1".to_string()),
        seq: 4,
        timestamp: 1_700_000_000_003,
        summary: "s".to_string(),
        retained_tail: vec![],
        tokens_before: 1,
        details: Some(serde_json::json!({"readFiles": ["a.ts"]})),
        usage: None,
        from_hook: true,
    };
    let json = serde_json::to_string(&minimal).unwrap();
    assert!(
        json.contains(r#""details":{"readFiles":["a.ts"]}"#),
        "{json}"
    );
    assert!(!json.contains("usage"), "{json}");
    let back: Entry = serde_json::from_str(&json).unwrap();
    assert_eq!(back, minimal);
}

#[test]
fn branch_summary_entry_round_trips_upstream_wire() {
    // `fromId: string | null` is always present on the wire.
    let wire = r#"{"type":"branch_summary","id":"b1","parentId":null,"seq":5,"timestamp":1700000000004,"fromId":null,"summary":"branch summary","fromHook":false}"#;
    let entry: Entry = serde_json::from_str(wire).unwrap();
    match &entry {
        Entry::BranchSummary {
            from_id, summary, ..
        } => {
            assert_eq!(*from_id, None);
            assert_eq!(summary, "branch summary");
        }
        other => panic!("expected branch_summary entry, got {other:?}"),
    }
    assert_eq!(serde_json::to_string(&entry).unwrap(), wire);
}

#[test]
fn custom_entry_round_trips_upstream_wire() {
    let wire = r#"{"type":"custom","id":"x1","parentId":null,"seq":6,"timestamp":1700000000005,"customType":"note","data":{"text":"hello"}}"#;
    let entry: Entry = serde_json::from_str(wire).unwrap();
    match &entry {
        Entry::Custom {
            custom_type, data, ..
        } => {
            assert_eq!(custom_type, "note");
            assert_eq!(data.as_ref(), Some(&serde_json::json!({"text": "hello"})));
        }
        other => panic!("expected custom entry, got {other:?}"),
    }
    assert_eq!(serde_json::to_string(&entry).unwrap(), wire);

    // Unknown `type` discriminants are rejected, not captured loosely.
    assert!(serde_json::from_str::<Entry>(
        r#"{"type":"unknown","id":"u","parentId":null,"seq":0,"timestamp":0}"#
    )
    .is_err());
}

#[test]
fn branch_scan_round_trips_upstream_wire() {
    let wire = r#"{"start":"entry-1"}"#;
    let scan: BranchScan = serde_json::from_str(wire).unwrap();
    assert_eq!(scan.start.as_deref(), Some("entry-1"));
    assert_eq!(serde_json::to_string(&scan).unwrap(), wire);
    assert_eq!(serde_json::to_string(&BranchScan::default()).unwrap(), "{}");
}

#[test]
fn entry_helpers_expose_shared_base_fields() {
    let custom = Entry::Custom {
        id: "x".to_string(),
        parent_id: None,
        seq: 7,
        timestamp: 8,
        custom_type: "note".to_string(),
        data: None,
    };
    assert_eq!(custom.message(), None);
    let _ = CustomAgentMessage::new("unused");
}
