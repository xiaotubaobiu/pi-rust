//! Port of `packages/agent/src/harness/session/types.ts` entry vocabulary
//! (`types.ts:16-64`): the durable transcript entries plus the reader
//! surfaces the branch summarization walks.
//!
//! This is the used-surface subset the compaction module (M3b Task 5)
//! needs; the full session types (storage, operation state, values) land
//! with the pico3 session port (M3b Tasks 7-9).
//!
//! Wire format: entries are tagged by `type` with the upstream snake_case
//! literals (`message`, `compaction`, `branch_summary`, `custom`) and
//! camelCase fields; `parentId`/`fromId` serialize `null` like the upstream
//! `string | null` always-present fields, and optional fields are omitted
//! (upstream `undefined`).
//!
//! Disclosed substitutions:
//! - Upstream `Entry` is a union of interfaces sharing `EntryBase`; the port
//!   is a closed enum with the shared fields inlined per variant.
//!   `customType` only ever carries a value on `custom` entries upstream, so
//!   it lives on [`Entry::Custom`] alone.
//! - [`BranchScan`] carries only `start` (`types.ts:421-430`): it is the one
//!   field on the branch-summarization used surface. The full scan options
//!   (`stopAtType`, `stopAtId`, `type`, `customType`, `order`, `limit`,
//!   `cursor`) arrive with the session port.
//! - [`BranchReader`]/[`SessionReader`] are the upstream `Pick<Branch,
//!   "findEntries">` / `Pick<Session, "getEntry">` capability projections
//!   (`types.ts:521-533`) as object-safe traits; the full `Branch`/`Session`
//!   interfaces land with the session port. Handler-thrown errors (upstream
//!   `throw new Error(...)`) are the `Err` channel.

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::agent_core::chord_support::Context;
use crate::agent_core::types::AgentMessage;
use crate::ai::types::primitives::Usage;

/// Upstream `Entry` (`types.ts:18-64`): one durable transcript record,
/// tagged by `type`.
///
/// The Message variant is intrinsically the largest payload (every entry
/// carries the full `AgentMessage`); boxing it would add indirection at every
/// use site for no functional gain (same precedent as `AgentMessage`).
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Entry {
    /// Upstream `MessageEntry` (`types.ts:27-31`).
    Message {
        id: String,
        parent_id: Option<String>,
        seq: i64,
        timestamp: i64,
        message: AgentMessage,
        /// Upstream `terminate?: true` — hints the run should stop after this
        /// entry. Only serialized when set.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminate: Option<bool>,
    },
    /// Upstream `CompactionEntry` (`types.ts:33-41`).
    Compaction {
        id: String,
        parent_id: Option<String>,
        seq: i64,
        timestamp: i64,
        summary: String,
        retained_tail: Vec<AgentMessage>,
        tokens_before: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        from_hook: bool,
    },
    /// Upstream `BranchSummaryEntry` (`types.ts:43-50`).
    BranchSummary {
        id: String,
        parent_id: Option<String>,
        seq: i64,
        timestamp: i64,
        /// Upstream `fromId: string | null` — always present on the wire.
        from_id: Option<String>,
        summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        from_hook: bool,
    },
    /// Upstream `CustomEntry` (`types.ts:52-56`).
    Custom {
        id: String,
        parent_id: Option<String>,
        seq: i64,
        timestamp: i64,
        custom_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
    },
}

impl Entry {
    /// The entry's upstream `id`.
    pub fn id(&self) -> &str {
        match self {
            Entry::Message { id, .. }
            | Entry::Compaction { id, .. }
            | Entry::BranchSummary { id, .. }
            | Entry::Custom { id, .. } => id,
        }
    }

    /// The entry's upstream `parentId`.
    pub fn parent_id(&self) -> Option<&str> {
        match self {
            Entry::Message { parent_id, .. }
            | Entry::Compaction { parent_id, .. }
            | Entry::BranchSummary { parent_id, .. }
            | Entry::Custom { parent_id, .. } => parent_id.as_deref(),
        }
    }

    /// The entry's upstream `seq`.
    pub fn seq(&self) -> i64 {
        match self {
            Entry::Message { seq, .. }
            | Entry::Compaction { seq, .. }
            | Entry::BranchSummary { seq, .. }
            | Entry::Custom { seq, .. } => *seq,
        }
    }

    /// The entry's upstream `timestamp`.
    pub fn timestamp(&self) -> i64 {
        match self {
            Entry::Message { timestamp, .. }
            | Entry::Compaction { timestamp, .. }
            | Entry::BranchSummary { timestamp, .. }
            | Entry::Custom { timestamp, .. } => *timestamp,
        }
    }

    /// The message payload of a `message` entry.
    pub fn message(&self) -> Option<&AgentMessage> {
        match self {
            Entry::Message { message, .. } => Some(message),
            _ => None,
        }
    }
}

/// Upstream `BranchScan` (`types.ts:421-430`) at the compaction used
/// surface: walk a branch's ancestry starting at `start` (a tip id). See the
/// module docs for the deferred scan options.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchScan {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
}

/// Upstream `Pick<Branch, "findEntries">` (`types.ts:521-528`): read a
/// branch's ancestry. See the module docs for the trait projection.
pub trait BranchReader: Send + Sync {
    /// Upstream `Branch.findEntries(query, context)`: entries along the
    /// branch ancestry described by the scan, in the storage's order.
    fn find_entries<'a>(
        &'a self,
        query: Option<&BranchScan>,
        context: Context,
    ) -> BoxFuture<'a, anyhow::Result<Vec<Entry>>>;
}

/// Upstream `Pick<Session, "getEntry">` (`types.ts:530-533`): fetch one
/// entry by id. See the module docs for the trait projection.
pub trait SessionReader: Send + Sync {
    /// Upstream `Session.getEntry(id, context)`.
    fn get_entry<'a>(
        &'a self,
        id: &str,
        context: Context,
    ) -> BoxFuture<'a, anyhow::Result<Option<Entry>>>;
}

#[cfg(test)]
mod tests;
