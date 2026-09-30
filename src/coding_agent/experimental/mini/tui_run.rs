//! Port of upstream `mini/tui/run.ts`'s command surface (the `runTui`
//! assembly is embedder-owned, D18).

use super::tui_view::TuiOptions;

/// Upstream `TuiOptions` (cwd stays the process's).
pub type RunTuiOptions = TuiOptions;

/// Upstream server-start wait loop decision: retry every 50ms until the
/// deadline (`SERVER_START_TIMEOUT_MS`), then fail with the exact text.
pub const SERVER_START_RETRY_MS: u64 = 50;

/// Upstream ensureServer failure.
pub use super::transport::SERVER_START_TIMEOUT_ERROR;

/// Upstream `ensureServer` connect-probe decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureServerProbe {
    Connected,
    StartServer,
    RetryAfter(u64),
    TimedOut,
}

/// Upstream `ensureServer` decision for one probe tick.
pub fn ensure_server_tick(
    connected: bool,
    attempts: u64,
    deadline_reached: bool,
) -> EnsureServerProbe {
    if connected {
        return EnsureServerProbe::Connected;
    }
    if attempts == 0 {
        return EnsureServerProbe::StartServer;
    }
    if deadline_reached {
        return EnsureServerProbe::TimedOut;
    }
    EnsureServerProbe::RetryAfter(SERVER_START_RETRY_MS)
}
