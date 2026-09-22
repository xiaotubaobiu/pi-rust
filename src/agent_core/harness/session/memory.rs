//! Port of `packages/agent/src/harness/session/memory.ts` (453 lines,
//! `MemoryStorage` half): the in-memory [`Storage`] backend over
//! [`InMemoryStorageState`], with the same admission lifecycle (commits
//! admitted before `close` drain; every later operation rejects) and the
//! [`MemoryStorage::fork`] state fork.
//!
//! Disclosed scope cut: `MemorySessionRepo`/`MemorySessionFacade`
//! (`memory.ts:334-453` + `memory.ts:136-332`) are deferred — their oracle
//! coverage (`memory-session-repo.test.ts`, `memory-conformance.test.ts`) is
//! not in this task's assigned oracle set; the JSONL repo carries the
//! repo-lifecycle conformance port. The facade lands with those oracles
//! (M3b Task 11).

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

use futures::future::BoxFuture;

use crate::agent_core::chord_support::Context;

use super::storage_state::InMemoryStorageState;
use super::types::{
    CommitResult, Entry, EntryScan, EntryStructure, ForkOptions, SessionStats, Storage,
    StorageBranchScan, UsageRow, UsageScan, Write,
};
use super::values::{ListElement, ListReadOptions, StoredValue, ValueAddress};

/// Upstream lifecycle literals (`memory.ts:41`).
const OPEN: u8 = 0;
const CLOSING: u8 = 1;
const CLOSED: u8 = 2;

/// Upstream `MemoryStorage` (`memory.ts:37-134`).
pub struct MemoryStorage {
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// The serialized commit/apply region (upstream `commitQueue`).
    inner: tokio::sync::Mutex<InMemoryStorageState>,
    /// Upstream `state: "open" | "closing" | "closed"`.
    lifecycle: AtomicU8,
    /// Upstream `closePromise` — one shared close completion.
    close_gate: tokio::sync::OnceCell<()>,
}

impl std::fmt::Debug for MemoryStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryStorage").finish_non_exhaustive()
    }
}

/// Upstream `MemoryStorageOptions` (`memory.ts:29-31`).
#[derive(Default)]
pub struct MemoryStorageOptions {
    /// Upstream `now?: () => number`. Defaults to the wall clock.
    pub now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
}

impl MemoryStorage {
    /// Upstream `new MemoryStorage(options)` (`memory.ts:44-46`).
    pub fn new(options: MemoryStorageOptions) -> Self {
        MemoryStorage {
            now: options.now.unwrap_or_else(|| Arc::new(crate::ai::now_ms)),
            inner: tokio::sync::Mutex::new(InMemoryStorageState::new()),
            lifecycle: AtomicU8::new(OPEN),
            close_gate: tokio::sync::OnceCell::new(),
        }
    }

    /// Upstream `fork(options)` (`memory.ts:111-124`): construct a
    /// destination storage at one serialized boundary between source commits.
    pub async fn fork(&self, options: &ForkOptions) -> anyhow::Result<MemoryStorage> {
        if self.lifecycle.load(Ordering::SeqCst) != OPEN {
            anyhow::bail!("MemoryStorage is closed");
        }
        // Hold the source lock across the fork, matching the upstream
        // commit-queue boundary ("at one serialized boundary between source
        // commits").
        let source = self.inner.lock().await;
        let forked = source.create_fork(options)?;
        drop(source);
        Ok(MemoryStorage {
            now: Arc::clone(&self.now),
            inner: tokio::sync::Mutex::new(forked),
            lifecycle: AtomicU8::new(OPEN),
            close_gate: tokio::sync::OnceCell::new(),
        })
    }

    fn assert_open(&self) -> anyhow::Result<()> {
        if self.lifecycle.load(Ordering::SeqCst) != OPEN {
            anyhow::bail!("MemoryStorage is closed");
        }
        Ok(())
    }
}

impl Storage for MemoryStorage {
    fn commit<'a>(
        &'a self,
        writes: Vec<Write>,
        _context: Context,
    ) -> BoxFuture<'a, anyhow::Result<CommitResult>> {
        Box::pin(async move {
            self.assert_open()?;
            let timestamp = (self.now)();
            let mut state = self.inner.lock().await;
            let prepared = state.prepare_commit(writes, timestamp)?;
            let stats = state.apply_validated(prepared.writes);
            Ok(prepared.result.with_stats(stats))
        })
    }

    fn get_entries<'a>(
        &'a self,
        ids: &[String],
        _context: Context,
    ) -> BoxFuture<'a, anyhow::Result<std::collections::HashMap<String, Entry>>> {
        let ids = ids.to_vec();
        Box::pin(async move {
            self.assert_open()?;
            let state = self.inner.lock().await;
            Ok(state.get_entries(&ids))
        })
    }

    fn get_value<'a>(
        &'a self,
        address: &ValueAddress,
        _context: Context,
    ) -> BoxFuture<'a, anyhow::Result<Option<StoredValue>>> {
        let address = address.clone();
        Box::pin(async move {
            self.assert_open()?;
            let state = self.inner.lock().await;
            Ok(state.get_value(&address))
        })
    }

    fn scan_values<'a>(
        &'a self,
        prefix: &ValueAddress,
        _context: Context,
    ) -> BoxFuture<'a, anyhow::Result<Vec<StoredValue>>> {
        let prefix = prefix.clone();
        Box::pin(async move {
            self.assert_open()?;
            let state = self.inner.lock().await;
            Ok(state.scan_values(&prefix))
        })
    }

    fn read_list<'a>(
        &'a self,
        address: &ValueAddress,
        options: Option<&ListReadOptions>,
        _context: Context,
    ) -> BoxFuture<'a, anyhow::Result<Vec<ListElement>>> {
        let address = address.clone();
        let options = options.copied();
        Box::pin(async move {
            self.assert_open()?;
            let state = self.inner.lock().await;
            state.read_list(&address, options.as_ref())
        })
    }

    fn scan_branch<'a>(
        &'a self,
        query: &StorageBranchScan,
        _context: Context,
    ) -> BoxFuture<'a, anyhow::Result<Vec<Entry>>> {
        let query = query.clone();
        Box::pin(async move {
            self.assert_open()?;
            let state = self.inner.lock().await;
            state.scan_branch(&query)
        })
    }

    fn scan_branch_structure<'a>(
        &'a self,
        query: &StorageBranchScan,
        _context: Context,
    ) -> BoxFuture<'a, anyhow::Result<Vec<EntryStructure>>> {
        let query = query.clone();
        Box::pin(async move {
            self.assert_open()?;
            let state = self.inner.lock().await;
            state.scan_branch_structure(&query)
        })
    }

    fn scan_entries<'a>(
        &'a self,
        query: &EntryScan,
        _context: Context,
    ) -> BoxFuture<'a, anyhow::Result<Vec<Entry>>> {
        let query = query.clone();
        Box::pin(async move {
            self.assert_open()?;
            let state = self.inner.lock().await;
            Ok(state.scan_entries(&query))
        })
    }

    fn scan_usage<'a>(
        &'a self,
        query: &UsageScan,
        _context: Context,
    ) -> BoxFuture<'a, anyhow::Result<Vec<UsageRow>>> {
        let query = query.clone();
        Box::pin(async move {
            self.assert_open()?;
            let state = self.inner.lock().await;
            Ok(state.scan_usage(&query))
        })
    }

    fn get_stats<'a>(&'a self, _context: Context) -> BoxFuture<'a, anyhow::Result<SessionStats>> {
        Box::pin(async move {
            self.assert_open()?;
            let state = self.inner.lock().await;
            Ok(state.get_stats())
        })
    }

    fn close<'a>(&'a self, _context: Context) -> BoxFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            // Upstream: the first close() sets "closing", chains behind the
            // commit queue, then sets "closed"; every caller shares one
            // completion. Committed-but-undrained commits are impossible
            // here because admission is checked before the queue.
            self.close_gate
                .get_or_init(|| async move {
                    self.lifecycle.store(CLOSING, Ordering::SeqCst);
                    let _drain = self.inner.lock().await;
                    self.lifecycle.store(CLOSED, Ordering::SeqCst);
                })
                .await;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests;
