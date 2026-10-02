//! # durable — port of `@earendil-works/pi-durable` (`pi/packages/durable`,
//! version 0.99.1, upstream HEAD `2bbfcca43`).
//!
//! A standalone durable-execution library: sessions of atomic commits over a
//! pluggable [`storage`](crate::durable::storage) backend, JSON documents
//! tracked through the already-ported [`chord`](crate::chord) delta engine,
//! and (in a later slice) a harness that schedules durable task state
//! machines.
//!
//! ## Slice boundary
//!
//! Ported here (dependency-first, per the upstream import graph):
//!
//! - [`ids`], [`errors`], [`entries`], [`json`], [`util`] — leaf modules.
//! - [`types`] — the shared record/query/write shapes (`src/types.ts`).
//! - [`documents`] — document definitions, address resolution, and
//!   materialization (`src/documents.ts`).
//! - [`storage`] — the [`storage::Storage`] contract, the in-memory reference
//!   backend (`storage/memory.ts`), and the JSONL backend
//!   (`storage/jsonl/**`).
//! - [`session`] — the Session kernel, transactions, fork copies, and the
//!   committed-state observers (`src/session/**`).
//!
//! Remaining upstream files (env/, harness/, tasks.ts, index.ts re-exports,
//! storage/memory+jsonl siblings sqlite/, tools/, testing/, truncate.ts) are
//! ported in later slices; `mod.rs` re-exports only what exists.
//!
//! ## Disclosed divergences
//!
//! - **D1 (number identity).** Upstream `Id`/`Seq` are erased nominal number
//!   brands; the port uses plain `i64` aliases ([`ids`]). All allocation and
//!   decoding boundaries are the same trusted sites, so the brand functions
//!   are identities.
//! - **D2 (JSON key order).** Upstream records are built by object literals
//!   and spreads, so their JSON key order is the construction-site order; the
//!   port reproduces exactly that order with `serde` struct field order,
//!   hand-written wire forms where spreads append keys
//!   (`SubmissionRecord`), and `serde_json`'s `preserve_order` maps — verified
//!   byte-for-byte by the `tests/fixtures/durable_oracle` fixtures.
//! - **D3 (sync storage).** Upstream every `Storage` method is `async` because
//!   all IO flows through the Node `ExecutionEnv` seam; the port's backends
//!   are in-process (memory) or `std::fs` (JSONL), so the trait is
//!   synchronous. Commit ordering, atomicity, and every read/write semantic
//!   are unchanged.
//! - **D4 (error channel).** Upstream throws `Error` subclasses; the port
//!   returns `Result` with [`errors::PlainError`] / [`errors::ReadAfterWrite`]
//!   / [`errors::StorageRejected`] / [`storage::StorageError`], whose
//!   `Display` text matches the upstream `error.message` byte-for-byte
//!   (asserted by the oracle fixtures).
//! - **D5 (sync transaction).** Upstream `Tx` operations are `async` and
//!   tracked via a pending-promise set drained at settlement; the port's
//!   transaction operations are synchronous, so settlement only seals.
//! - **D6 (mutation line).** Upstream serializes jobs through a promise tail
//!   (`#enqueue`); the port holds one fair `tokio::sync::Mutex`.
//! - **D7 (Session extension).** Upstream the Harness subclasses `SessionImpl`
//!   and overrides protected hooks; the port composes an optional
//!   [`session::SessionHooks`] object.
//! - **D8 (commit callbacks).** `Session::commit` takes an async closure over
//!   a shared `Arc<Transaction>` — the port-idiomatic resolution of the
//!   upstream `T | Promise<T>` union.
//! - **D9 (documentState).** The `Session.documentState()` detached
//!   replicated-state surface is deferred to the harness slice (its consumers
//!   live there); `watchDoc` / `snapshot` / `snapshotAsOf` are ported.
//!
//! Per-file divergences are documented in the child modules
//! ([`storage::jsonl`] std-fs shim, [`session::observation`] scheduling).

pub mod documents;
pub mod entries;
pub mod errors;
pub mod ids;
pub mod json;
pub mod session;
pub mod storage;
pub mod types;
pub mod util;

// Facade re-exports mirroring the subset of upstream `index.ts` whose source
// modules exist in this slice; the rest follow with the env/harness slices.
pub use documents::{define_doc, define_doc_family, DocDefinition, DocToken};
pub use entries::{
    assistant_entry, define_entry, reset_entry, system_entry, tool_result_entry, user_entry, Entry,
    ASSISTANT_ENTRY_KIND, RESET_ENTRY_KIND, SYSTEM_ENTRY_KIND, TOOL_RESULT_ENTRY_KIND, USER_ENTRY_ENTRY_KIND,
};
pub use errors::{ConversationBusy, ReadAfterWrite, StorageRejected};
pub use session::session::{create_session, Session, SessionHooks};
pub use session::transaction::{LoadedDocument, Transaction, TransactionScope};
pub use storage::memory::MemoryStorage;
pub use storage::jsonl::{JsonlStorage, JsonlStorageOptions};
pub use types::{
    CheckpointInfo, CommitChange, CommitPublication, ConversationOwnership, ConversationQuery, ConversationRecord,
    ContextEdit, Cursor, DocumentAddress, DocumentCommitChange, DocumentContent, DocumentCopySource, DocumentCreate,
    DocumentHistory, DocumentFork, DocumentPoint, DocumentQuery, DocumentRecord, DocumentScope, EntryDraft,
    EntryQuery, EntryRecord, JoinPolicy, JsonObject, JsonValue, Page, StorageWrite, StoredDocument, SubmissionRecord,
    SubmissionSettlement, TableCommitChange, TaskOptions, TaskOutcome, TaskOutcomeError, TaskOwnership, TaskQuery,
    TaskRecord, TaskState, TaskStatus,
};
pub use util::{closed_error, scan_all, Waiters};
pub use ids::ROOT_CONVERSATION_ID;
