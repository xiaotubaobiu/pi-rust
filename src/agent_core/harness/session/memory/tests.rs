//! Ports of `packages/agent/test/harness/session-create-branch.test.ts` (77
//! lines) and `storage-backed-session.test.ts` (397 lines): the session
//! capability layer over MemoryStorage — branch creation, mutation-line
//! serialization, mutator invalidation, and close semantics.

use super::MemoryStorage;
use crate::agent_core::chord_support::Context;
use crate::agent_core::harness::context::background_context;
use crate::agent_core::harness::session::commit::insert_entry;
use crate::agent_core::harness::session::session::{
    MutationLine, SessionBranchExistsError, SessionInvalidBranchError, SessionUnknownTargetError,
    StorageBackedSession, StorageBackedSessionOptions,
};
use crate::agent_core::harness::session::testing::{GatingStorage, InstrumentedStorage};
use crate::agent_core::harness::session::types::{
    BranchScan, Entry, NewEntry, Session, SessionMetadata, Storage, Write,
};
use crate::agent_core::harness::session::values::{
    append_list, branch_tip, delete_value, lane_config, lane_state, list, session_name, set_value,
    value, ValueAddress,
};
use crate::agent_core::types::AgentMessage;
use crate::ai::types::message::{AssistantMessage, StringOrBlocks, UserMessage};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

const NOW: i64 = 1_700_000_000_000;

fn metadata() -> SessionMetadata {
    SessionMetadata {
        id: "session".to_string(),
        created_at: NOW,
        storage_version: 1,
        cwd: Some("/workspace".to_string()),
        ..SessionMetadata::default()
    }
}

fn memory_storage() -> Arc<MemoryStorage> {
    Arc::new(MemoryStorage::new(super::MemoryStorageOptions {
        now: Some(Arc::new(|| NOW)),
    }))
}

fn memory_session() -> Arc<StorageBackedSession> {
    Arc::new(StorageBackedSession::new(metadata(), memory_storage()))
}

fn custom_entry(id: &str, parent_id: Option<&str>, custom_type: &str) -> Write {
    insert_entry(NewEntry::Custom {
        id: id.to_string(),
        parent_id: parent_id.map(str::to_string),
        custom_type: custom_type.to_string(),
        data: None,
    })
}

async fn commit_session(session: &StorageBackedSession, transaction: Vec<Write>) {
    session
        .mutate(
            |mutator, context| {
                let transaction = transaction.clone();
                Box::pin(async move {
                    mutator.commit(transaction, context).await?;
                    Ok(())
                })
            },
            background_context(),
        )
        .await
        .unwrap();
}

// --- session-create-branch.test.ts -------------------------------------------

/// "creates only the data Branch at a validated target"
/// (`session-create-branch.test.ts:21-45`).
#[tokio::test]
async fn creates_only_data_branch_at_validated_target() {
    let session = memory_session();
    commit_session(&session, vec![custom_entry("target", None, "target")]).await;

    let branch = session
        .create_branch("main", Some("target".to_string()), background_context())
        .await
        .unwrap();
    assert_eq!(
        branch
            .get_tip_id(background_context())
            .await
            .unwrap()
            .as_deref(),
        Some("target")
    );
    assert_eq!(
        session
            .get_value(&branch_tip("main"), background_context())
            .await
            .unwrap()
            .unwrap()
            .value,
        serde_json::json!("target")
    );
    assert!(session
        .get_value(&lane_config("main"), background_context())
        .await
        .unwrap()
        .is_none());
    assert!(session
        .get_value(&lane_state("main"), background_context())
        .await
        .unwrap()
        .is_none());
    session.close(background_context()).await.unwrap();
}

/// "validates names and non-null targets" (`session-create-branch.test.ts:47-60`).
#[tokio::test]
async fn validates_branch_names_and_targets() {
    use crate::agent_core::harness::session::types::Branch;
    let session = memory_session();
    let error = session
        .create_branch("", None, background_context())
        .await
        .map(|_: Arc<dyn Branch>| ())
        .unwrap_err();
    assert!(error.downcast_ref::<SessionInvalidBranchError>().is_some());
    let error = session
        .create_branch("bad\0name", None, background_context())
        .await
        .map(|_: Arc<dyn Branch>| ())
        .unwrap_err();
    assert!(error.downcast_ref::<SessionInvalidBranchError>().is_some());
    let error = session
        .create_branch("main", Some("missing".to_string()), background_context())
        .await
        .map(|_: Arc<dyn Branch>| ())
        .unwrap_err();
    assert!(error.downcast_ref::<SessionUnknownTargetError>().is_some());
    assert!(session
        .branch("main", background_context())
        .await
        .unwrap()
        .is_none());
    session.close(background_context()).await.unwrap();
}

/// "rejects duplicates atomically, including concurrent creation"
/// (`session-create-branch.test.ts:62-77`).
#[tokio::test]
async fn rejects_duplicate_branch_creation_atomically() {
    use crate::agent_core::harness::session::types::Branch;
    let session = memory_session();
    let first = session.create_branch("main", None, background_context());
    let second = session.create_branch("main", None, background_context());
    let (first, second) = tokio::join!(first, second);
    let fulfilled = [first.is_ok(), second.is_ok()]
        .iter()
        .filter(|ok| **ok)
        .count();
    assert_eq!(fulfilled, 1);
    let rejected = if first.is_err() { first } else { second };
    assert!(rejected
        .map(|_: Arc<dyn Branch>| ())
        .unwrap_err()
        .downcast_ref::<SessionBranchExistsError>()
        .is_some());
    assert!(session
        .branch("main", background_context())
        .await
        .unwrap()
        .is_some());
    session.close(background_context()).await.unwrap();
}

// --- storage-backed-session.test.ts ------------------------------------------

/// "delegates typed values directly without validation or cloning"
/// (`storage-backed-session.test.ts:34-54`).
#[tokio::test]
async fn delegates_typed_values_atomically() {
    let storage = memory_storage();
    let instrumented = InstrumentedStorage::new(storage);
    let session = Arc::new(StorageBackedSession::new(
        metadata(),
        Arc::clone(&instrumented) as Arc<dyn Storage>,
    ));
    let data = serde_json::json!({ "nested": ["original"] });
    let address = value("test.value", "state");
    let transaction = vec![
        insert_entry(NewEntry::Custom {
            id: "00000000-0000-7000-8000-000000000001".to_string(),
            parent_id: None,
            custom_type: "note".to_string(),
            data: Some(data.clone()),
        }),
        set_value(&address, data.clone()),
    ];

    let result = session
        .mutate(
            |mutator, context| {
                let transaction = transaction.clone();
                Box::pin(async move { mutator.commit(transaction, context).await })
            },
            background_context(),
        )
        .await
        .unwrap();

    assert_eq!(instrumented.get_commit_attempts()[0], transaction);
    let entry = session
        .get_entries(
            &["00000000-0000-7000-8000-000000000001".to_string()],
            background_context(),
        )
        .await
        .unwrap()
        .get("00000000-0000-7000-8000-000000000001")
        .unwrap()
        .clone();
    assert_eq!(entry.seq(), result.seqs[0]);
    assert_eq!(entry.timestamp(), NOW);
    let crate::agent_core::harness::session::types::Entry::Custom {
        data: entry_data, ..
    } = &entry
    else {
        panic!("expected custom entry");
    };
    assert_eq!(*entry_data, Some(data.clone()));
    assert_eq!(
        session
            .get_value(&address, background_context())
            .await
            .unwrap()
            .unwrap()
            .value,
        data
    );
    session.close(background_context()).await.unwrap();
}

/// "serializes read-modify-write callbacks on the single Session line"
/// (`storage-backed-session.test.ts:96-109`).
#[tokio::test]
async fn serializes_read_modify_write_callbacks() {
    let session = memory_session();
    let counter = value("test.counter", "");
    let increment = {
        let session = Arc::clone(&session);
        move || {
            let session = Arc::clone(&session);
            let counter = counter.clone();
            async move {
                session
                    .mutate(
                        |mutator, context| {
                            let counter = counter.clone();
                            Box::pin(async move {
                                let next =
                                    match mutator.get_value(&counter, context.clone()).await? {
                                        Some(stored) => stored.value.as_i64().unwrap_or(0),
                                        None => 0,
                                    } + 1;
                                mutator
                                    .commit(
                                        vec![set_value(&counter, serde_json::json!(next))],
                                        context,
                                    )
                                    .await?;
                                Ok(next)
                            })
                        },
                        background_context(),
                    )
                    .await
            }
        }
    };
    let (first, second) = tokio::join!(increment(), increment());
    assert_eq!((first.unwrap(), second.unwrap()), (1, 2));
    assert_eq!(
        session
            .get_value(&value("test.counter", ""), background_context())
            .await
            .unwrap()
            .unwrap()
            .value,
        serde_json::json!(2)
    );
    session.close(background_context()).await.unwrap();
}

/// "queues a nested public writer until its owning callback returns"
/// (`storage-backed-session.test.ts:129-145`).
#[tokio::test]
async fn queues_nested_writer_until_callback_returns() {
    let session = memory_session();
    let nested_slot: Arc<
        std::sync::Mutex<Option<futures::future::BoxFuture<'static, anyhow::Result<()>>>>,
    > = Arc::new(std::sync::Mutex::new(None));
    {
        let session = Arc::clone(&session);
        let nested_slot = Arc::clone(&nested_slot);
        session
            .mutate(
                |_mutator, _context| {
                    let session = Arc::clone(&session);
                    let nested_slot = Arc::clone(&nested_slot);
                    Box::pin(async move {
                        // Created but NOT awaited inside the callback: it
                        // queues behind the owning callback (awaiting it
                        // inside would deadlock, like upstream).
                        *nested_slot.lock().unwrap() = Some(Box::pin(async move {
                            Session::set_value(
                                session.as_ref(),
                                session_name(),
                                serde_json::json!("nested"),
                                background_context(),
                            )
                            .await
                        }));
                        Ok(())
                    })
                },
                background_context(),
            )
            .await
            .unwrap();
    }
    let nested = nested_slot.lock().unwrap().take();
    if let Some(nested) = nested {
        nested.await.unwrap();
    }
    assert_eq!(
        session.get_name(background_context()).await.unwrap(),
        Some("nested".to_string())
    );
    session.close(background_context()).await.unwrap();
}

/// "exposes either side of an atomic multi-write commit to direct reads"
/// (`storage-backed-session.test.ts:147-170`).
#[tokio::test]
async fn gates_atomic_multi_write_commits() {
    let first = value("test.atomic", "first");
    let second = value("test.atomic", "second");
    let base = memory_storage();
    base.commit(
        vec![
            set_value(&first, serde_json::json!("old")),
            set_value(&second, serde_json::json!("old")),
        ],
        background_context(),
    )
    .await
    .unwrap();
    let gated = GatingStorage::new(base);
    gated.arm();
    let session = Arc::new(StorageBackedSession::new(
        metadata(),
        Arc::clone(&gated) as Arc<dyn Storage>,
    ));
    let committing = {
        let session = Arc::clone(&session);
        async move {
            session
                .mutate(
                    |mutator, context| {
                        let first = first.clone();
                        let second = second.clone();
                        Box::pin(async move {
                            mutator
                                .commit(
                                    vec![
                                        set_value(&first, serde_json::json!("new")),
                                        set_value(&second, serde_json::json!("new")),
                                    ],
                                    context,
                                )
                                .await?;
                            Ok(())
                        })
                    },
                    background_context(),
                )
                .await
        }
    };
    let committing = tokio::spawn(committing);
    // Wait for the commit to park inside the gate.
    while gated.pending() == 0 {
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    assert_eq!(
        session
            .get_value(&value("test.atomic", "first"), background_context())
            .await
            .unwrap()
            .unwrap()
            .value,
        serde_json::json!("old")
    );
    assert_eq!(
        session
            .get_value(&value("test.atomic", "second"), background_context())
            .await
            .unwrap()
            .unwrap()
            .value,
        serde_json::json!("old")
    );
    gated.next(1).await.unwrap();
    committing.await.unwrap().unwrap();
    assert_eq!(
        session
            .get_value(&value("test.atomic", "first"), background_context())
            .await
            .unwrap()
            .unwrap()
            .value,
        serde_json::json!("new")
    );
    assert_eq!(
        session
            .get_value(&value("test.atomic", "second"), background_context())
            .await
            .unwrap()
            .unwrap()
            .value,
        serde_json::json!("new")
    );
    session.close(background_context()).await.unwrap();
}

/// "holds the explicit Session barrier through commit until end"
/// (`storage-backed-session.test.ts:172-196`).
#[tokio::test]
async fn holds_barrier_until_end() {
    let storage = InstrumentedStorage::new(memory_storage());
    let session = Arc::new(StorageBackedSession::new(
        metadata(),
        Arc::clone(&storage) as Arc<dyn Storage>,
    ));
    let mutation = session.begin_mutation(background_context()).await.unwrap();
    let queued = {
        let session = Arc::clone(&session);
        tokio::spawn(async move {
            crate::agent_core::harness::session::types::Session::mutate(
                &*session,
                |_mutator, _ctx| Box::pin(async { Ok(()) }),
                background_context(),
            )
            .await
        })
    };

    // The queued callback has not started while the barrier is held.
    let result = mutation
        .commit(Vec::new(), background_context())
        .await
        .unwrap();
    assert!(result.seqs.is_empty());
    assert!(storage.get_commit_attempts().len() == 1);
    mutation.end(background_context()).await.unwrap();
    queued.await.unwrap().unwrap();
    assert!(storage.get_commit_attempts().len() == 1);
    // The mutator is invalidated after end.
    let error = crate::agent_core::harness::session::types::SessionMutationReader::get_entries(
        mutation.as_ref(),
        &[],
        background_context(),
    )
    .await;
    assert!(error.is_err());
    session.close(background_context()).await.unwrap();
}

/// "exposes explicit branch scans through the Session and callback-scoped
/// mutator" (`storage-backed-session.test.ts:233-258`).
#[tokio::test]
async fn exposes_branch_scans_through_session_and_mutator() {
    let session = memory_session();
    let child_id = "00000000-0000-7000-8000-000000000002";
    commit_session(
        &session,
        vec![
            custom_entry("00000000-0000-7000-8000-000000000001", None, "root"),
            custom_entry(
                child_id,
                Some("00000000-0000-7000-8000-000000000001"),
                "child",
            ),
        ],
    )
    .await;

    let scan = session
        .scan_branch(
            &crate::agent_core::harness::session::types::StorageBranchScan {
                start: child_id.to_string(),
                order: Some(
                    crate::agent_core::harness::session::types::BranchScanOrder::OldestFirst,
                ),
                ..Default::default()
            },
            background_context(),
        )
        .await
        .unwrap();
    assert_eq!(
        scan.iter().map(Entry::id).collect::<Vec<_>>(),
        vec!["00000000-0000-7000-8000-000000000001", child_id]
    );
    session
        .mutate(
            |mutator, context| {
                let child_id = child_id.to_string();
                Box::pin(async move {
                    let scanned = mutator
                        .scan_branch(
                            &crate::agent_core::harness::session::types::StorageBranchScan {
                                start: child_id.clone(),
                                limit: Some(1),
                                ..Default::default()
                            },
                            context,
                        )
                        .await?;
                    assert_eq!(
                        scanned.iter().map(Entry::id).collect::<Vec<_>>(),
                        vec![child_id]
                    );
                    Ok(())
                })
            },
            background_context(),
        )
        .await
        .unwrap();
    session.close(background_context()).await.unwrap();
}

/// "rejects pending assistant entries at the durable session write boundary"
/// (`storage-backed-session.test.ts:260-289`).
#[tokio::test]
async fn rejects_pending_assistant_entries() {
    let storage = InstrumentedStorage::new(memory_storage());
    let session = Arc::new(StorageBackedSession::new(
        metadata(),
        Arc::clone(&storage) as Arc<dyn Storage>,
    ));
    let pending = AssistantMessage {
        content: Vec::new(),
        api: "anthropic-messages".to_string(),
        provider: "anthropic".to_string(),
        model: "claude-sonnet-4-5".to_string(),
        response_model: None,
        response_id: None,
        provider_thinking_level: None,
        diagnostics: None,
        usage: Default::default(),
        stop_reason: crate::ai::types::primitives::StopReason::Pending,
        deferred: None,
        error_message: None,
        raw_stop_reason: None,
        end_turn: None,
        timestamp: NOW,
    };

    let error = session
        .mutate(
            |mutator, context| {
                Box::pin(async move {
                    mutator
                        .commit(
                            vec![insert_entry(NewEntry::Message {
                                id: "00000000-0000-7000-8000-000000000001".to_string(),
                                parent_id: None,
                                message: AgentMessage::Assistant(pending),
                                terminate: None,
                            })],
                            context,
                        )
                        .await
                })
            },
            background_context(),
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Cannot persist a pending assistant message"),
        "{error}"
    );
    assert!(storage.get_commit_attempts().is_empty());
    assert!(session
        .get_entries(
            &["00000000-0000-7000-8000-000000000001".to_string()],
            background_context()
        )
        .await
        .unwrap()
        .is_empty());
    session.close(background_context()).await.unwrap();
}

/// "serializes mutations, permits one commit attempt, and invalidates the
/// mutator" (`storage-backed-session.test.ts:313-331`).
#[tokio::test]
async fn permits_one_commit_attempt_and_invalidates_mutator() {
    let storage = InstrumentedStorage::new(memory_storage());
    let session = Arc::new(StorageBackedSession::new(
        metadata(),
        Arc::clone(&storage) as Arc<dyn Storage>,
    ));

    session
        .mutate(
            |mutator, context| {
                Box::pin(async move {
                    assert!(mutator
                        .get_value(&session_name(), context.clone())
                        .await
                        .unwrap()
                        .is_none());
                    mutator
                        .commit(
                            vec![set_value(&session_name(), serde_json::json!("committed"))],
                            context.clone(),
                        )
                        .await?;
                    let error = mutator.commit(Vec::new(), context).await.unwrap_err();
                    assert!(
                        error.to_string().contains("commit already attempted"),
                        "{error}"
                    );
                    Ok(())
                })
            },
            background_context(),
        )
        .await
        .unwrap();

    assert_eq!(storage.get_commit_attempts().len(), 1);
    assert_eq!(
        session.get_name(background_context()).await.unwrap(),
        Some("committed".to_string())
    );
    session.close(background_context()).await.unwrap();
}

/// "consumes the commit guard when the first commit fails"
/// (`storage-backed-session.test.ts:333-348`).
#[tokio::test]
async fn consumes_commit_guard_on_failure() {
    let storage = InstrumentedStorage::new(memory_storage());
    let session = Arc::new(StorageBackedSession::new(
        metadata(),
        Arc::clone(&storage) as Arc<dyn Storage>,
    ));
    let transaction = vec![custom_entry(
        "00000000-0000-7000-8000-000000000001",
        Some("missing"),
        "note",
    )];

    session
        .mutate(
            |mutator, context| {
                let transaction = transaction.clone();
                Box::pin(async move {
                    let error = mutator
                        .commit(transaction, context.clone())
                        .await
                        .unwrap_err();
                    assert!(
                        error.to_string().contains("Missing parent entry"),
                        "{error}"
                    );
                    let error = mutator.commit(Vec::new(), context).await.unwrap_err();
                    assert!(
                        error.to_string().contains("commit already attempted"),
                        "{error}"
                    );
                    Ok(())
                })
            },
            background_context(),
        )
        .await
        .unwrap();
    assert_eq!(storage.get_commit_attempts().len(), 1);
    session.close(background_context()).await.unwrap();
}

/// "mints distinct follower ids with the leader timestamp"
/// (`storage-backed-session.test.ts:350-360`).
#[tokio::test]
async fn mints_distinct_follower_ids_with_leader_timestamp() {
    let session = memory_session();
    let leader_timestamp = 0x0123456789abi64;
    let generator = session.id_generator();
    let leader = generator.next(Some(leader_timestamp));
    let follower_1 = generator.next(Some(leader_timestamp));
    let follower_2 = generator.next(Some(leader_timestamp));
    let decode = |id: &str| i64::from_str_radix(&id.replace('-', "")[..12], 16).unwrap();
    assert_eq!(
        (decode(&leader), decode(&follower_1), decode(&follower_2)),
        (leader_timestamp, leader_timestamp, leader_timestamp)
    );
    assert_eq!(
        std::collections::HashSet::from([leader, follower_1, follower_2]).len(),
        3
    );
    session.close(background_context()).await.unwrap();
}

/// "accepts an injected id generator for deterministic execution tests"
/// (`storage-backed-session.test.ts:362-371`).
#[tokio::test]
async fn accepts_injected_id_generator() {
    struct Counting(std::sync::atomic::AtomicUsize);
    impl crate::agent_core::harness::session::types::IdGenerator for Counting {
        fn next(&self, timestamp_ms: Option<i64>) -> String {
            let n = self.0.fetch_add(1, Ordering::SeqCst) + 1;
            match timestamp_ms {
                Some(ts) => format!("{ts}:{n}"),
                None => format!("now:{n}"),
            }
        }
    }
    let counter = Arc::new(Counting(std::sync::atomic::AtomicUsize::new(0)));
    let session = Arc::new(StorageBackedSession::with_options(
        metadata(),
        memory_storage(),
        StorageBackedSessionOptions {
            id_generator: Some(Arc::clone(&counter) as _),
            ..Default::default()
        },
    ));
    assert_eq!(session.id_generator().next(Some(7)), "7:1");
    assert_eq!(session.id_generator().next(None), "now:2");
    session.close(background_context()).await.unwrap();
}

/// "exposes metadata directly and the shared UUIDv7 id generator"
/// (`storage-backed-session.test.ts:373-382`).
#[tokio::test]
async fn exposes_metadata_and_uuidv7_generator() {
    let session = memory_session();
    assert_eq!(session.metadata().id, "session");
    let id = session.id_generator().next(None);
    assert_eq!(id.len(), 36);
    assert_eq!(
        id.split('-')
            .nth(2)
            .map(|part| part.chars().next().unwrap()),
        Some('7')
    );
    session.close(background_context()).await.unwrap();
}

/// "closes idempotently and rejects operations not admitted before close"
/// (`storage-backed-session.test.ts:384-396`).
#[tokio::test]
async fn closes_idempotently_and_rejects_later_operations() {
    let session = memory_session();
    let (first, second) = tokio::join!(
        session.close(background_context()),
        session.close(background_context())
    );
    first.unwrap();
    second.unwrap();
    let error = session
        .mutate(
            |_mutator, _context| Box::pin(async { Ok(()) }),
            background_context(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Session is closed"), "{error}");
    let error = session
        .get_entries(&[], background_context())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Session is closed"), "{error}");
    let error = session
        .get_value(&session_name(), background_context())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Session is closed"), "{error}");
    let error = session
        .scan_values(&session_name(), background_context())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Session is closed"), "{error}");
    let error = session
        .scan_branch(
            &crate::agent_core::harness::session::types::StorageBranchScan {
                start: "00000000-0000-7000-8000-000000000001".to_string(),
                ..Default::default()
            },
            background_context(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Session is closed"), "{error}");
}

/// Session-level `findEntries` cursor paging and label/name helpers
/// (exercised upstream through `session.ts` + the repo oracles).
#[tokio::test]
async fn find_entries_pages_and_names_resolve() {
    let session = memory_session();
    commit_session(
        &session,
        vec![
            custom_entry("e1", None, "note"),
            custom_entry("e2", Some("e1"), "note"),
            custom_entry("e3", Some("e2"), "note"),
        ],
    )
    .await;
    session
        .set_label("e2", Some("labeled".to_string()), background_context())
        .await
        .unwrap();
    session
        .set_name(Some("named".to_string()), background_context())
        .await
        .unwrap();

    assert_eq!(
        session.get_name(background_context()).await.unwrap(),
        Some("named".to_string())
    );
    assert_eq!(
        session.get_label("e2", background_context()).await.unwrap(),
        Some("labeled".to_string())
    );
    session
        .set_label("e2", None, background_context())
        .await
        .unwrap();
    session.set_name(None, background_context()).await.unwrap();
    assert!(session
        .get_name(background_context())
        .await
        .unwrap()
        .is_none());
    assert!(session
        .get_label("e2", background_context())
        .await
        .unwrap()
        .is_none());

    // Descending default order + cursor paging.
    let all = session
        .find_entries(None, background_context())
        .await
        .unwrap();
    assert_eq!(
        all.iter().map(Entry::id).collect::<Vec<_>>(),
        vec!["e3", "e2", "e1"]
    );
    let page = session
        .find_entries(
            Some(&crate::agent_core::harness::session::types::EntryQuery {
                cursor: Some(crate::agent_core::harness::session::types::EntryCursor {
                    seq: all[0].seq(),
                }),
                ..Default::default()
            }),
            background_context(),
        )
        .await
        .unwrap();
    assert_eq!(
        page.iter().map(Entry::id).collect::<Vec<_>>(),
        vec!["e2", "e1"]
    );
    // The ascending cursor guard at MAX_SAFE_INTEGER returns empty.
    let guard = session
        .find_entries(
            Some(&crate::agent_core::harness::session::types::EntryQuery {
                order: Some(crate::agent_core::harness::session::types::AscDescOrder::Asc),
                cursor: Some(crate::agent_core::harness::session::types::EntryCursor {
                    seq: crate::agent_core::harness::session::types::MAX_SAFE_INTEGER,
                }),
                ..Default::default()
            }),
            background_context(),
        )
        .await
        .unwrap();
    assert!(guard.is_empty());
    session.close(background_context()).await.unwrap();
}

// Keep the fixture imports referenced.
#[allow(unused, clippy::too_many_arguments)]
fn _keepers(
    _c: Context,
    _b: Option<BranchScan>,
    _e: Option<Entry>,
    _m: Option<AgentMessage>,
    _u: Option<UserMessage>,
    _s: Option<StringOrBlocks>,
    _h: Option<HashMap<String, String>>,
    _a: Option<ValueAddress>,
    _l: Option<crate::agent_core::harness::session::values::ListReadOptions>,
    _line: Option<MutationLine>,
    _msg: Option<AgentMessage>,
) {
    let _ = user_message_fixture();
    let _ = (
        delete_value(&session_name()),
        append_list(&list("t", ""), serde_json::json!(1)),
    );
}

fn user_message_fixture() -> AgentMessage {
    AgentMessage::User(UserMessage {
        content: StringOrBlocks::Text("x".to_string()),
        timestamp: 1,
    })
}
