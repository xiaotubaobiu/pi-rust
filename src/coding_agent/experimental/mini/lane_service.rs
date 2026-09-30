//! Port of upstream `mini/worker/lane-service.ts` + `worker/run.ts` +
//! `worker/models-service.ts`: the worker-side service implementations'
//! deterministic faces. The harness lane and `ModelRuntime` are
//! embedder-owned (D18).

use super::protocol::{CommandResult, ModelRef};

/// Upstream `LaneService.#command`: map a lane outcome to `CommandResult`.
/// `Err` mirrors a thrown harness error; `Ok(None)` mirrors
/// `{ ok: false }` with no error object.
pub fn map_lane_command(
    result: Result<Option<Result<(), Option<String>>>, String>,
) -> CommandResult {
    match result {
        Ok(Some(Ok(()))) => CommandResult::ok(),
        Ok(Some(Err(Some(message)))) => CommandResult::error(message),
        Ok(Some(Err(None))) => CommandResult::error("Command failed"),
        Ok(None) => CommandResult::error("Command failed"),
        Err(message) => CommandResult::error(message),
    }
}

/// Upstream `LaneService.setModel`'s registry guard.
pub fn set_model_guard(known: bool, provider: &str, model_id: &str) -> Option<CommandResult> {
    if !known {
        return Some(CommandResult::error(format!(
            "Unknown model: {provider}/{model_id}"
        )));
    }
    None
}

/// Upstream `LaneService.watch` failure cleanup face: an unknown
/// subscription errors with the exact text.
pub fn unknown_subscription_error(subscription_id: &str) -> String {
    format!("Unknown subscription: {subscription_id}")
}

/// Upstream login prompt cancellation messages.
pub const LOGIN_CANCELLED: &str = "Login cancelled";

/// Upstream `#ask` rejection on a pre-aborted signal.
pub fn ask_aborted() -> String {
    LOGIN_CANCELLED.to_string()
}

/// Upstream `ModelRef` passthrough: the lane stores a durable identity, so
/// the ref passes straight through to `lane.setModel`.
pub fn model_ref_passthrough(reference: &ModelRef) -> ModelRef {
    reference.clone()
}
