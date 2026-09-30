//! Port of upstream `mini/tui/session.ts`: the presentation half of a
//! session — attach flow, subscription ids and the rebase decision. The
//! harness fold (`reduceLaneSnapshot`) and the transport are embedder-owned
//! (D18).

use super::protocol::ATTACH_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// tui/session.ts: attach flow
// ---------------------------------------------------------------------------

/// Upstream `connect`'s subscribe/rebase flow. The fold result (whether the
/// harness reducer returned "rebase") is caller-supplied.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AttachedSessionState {
    pub snapshot: Option<String>,
    pub subscription_id: Option<String>,
}

impl AttachedSessionState {
    /// Upstream `fold`: rebase triggers a resubscribe; other events just
    /// publish.
    pub fn fold(&mut self, is_rebase: bool) -> ResubscribeDecision {
        if self.snapshot.is_none() {
            return ResubscribeDecision::None;
        }
        if is_rebase {
            ResubscribeDecision::Resubscribe
        } else {
            ResubscribeDecision::Publish
        }
    }

    /// Upstream `resubscribe`: take a new subscription, drop the old one.
    pub fn resubscribed(&mut self, subscription_id: &str, snapshot: &str) -> Option<String> {
        let previous = self.subscription_id.take();
        self.subscription_id = Some(subscription_id.to_string());
        self.snapshot = Some(snapshot.to_string());
        previous
    }

    /// Upstream lane-event guard: a superseded subscription id is discarded.
    pub fn accepts_event(&self, subscription_id: &str) -> bool {
        self.subscription_id.as_deref() == Some(subscription_id)
    }
}

/// Upstream fold decision face.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResubscribeDecision {
    None,
    Publish,
    Resubscribe,
}

/// Upstream attach timeout constant.
pub fn attach_timeout_ms() -> u64 {
    ATTACH_TIMEOUT_MS
}
