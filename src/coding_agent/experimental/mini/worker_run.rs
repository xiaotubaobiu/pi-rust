//! Port of upstream `mini/worker/run.ts`: the worker's session open/recovery
//! decisions. The harness, model runtime and storage are embedder-owned
//! (D18).

/// Upstream `systemPrompt`.
pub fn system_prompt(cwd: &str) -> String {
    [
        "You are a coding agent working in a terminal.".to_string(),
        format!("Working directory: {cwd}"),
        "Use the read, write, edit, and bash tools to inspect and change files.".to_string(),
        "Keep answers short and technical.".to_string(),
    ]
    .join("\n")
}

/// Upstream `openSession`: reuse the listed metadata or fail with the exact
/// upstream error.
pub fn open_session<'a>(
    sessions: &'a [(String, String)],
    session_id: Option<&str>,
) -> Result<&'a (String, String), String> {
    match session_id {
        None => Err("__create__".to_string()), // caller creates via repo.create
        Some(session_id) => sessions
            .iter()
            .find(|(id, _)| id == session_id)
            .ok_or_else(|| unknown_session_error(session_id)),
    }
}

/// Upstream `openSession` lookup failure.
pub fn unknown_session_error(session_id: &str) -> String {
    format!("Unknown session: {session_id}")
}

/// Upstream no-model failure (`findInitialModel` returning nothing).
pub const NO_MODEL_ERROR: &str = "No model available. Configure credentials with `pi` first.";

/// Upstream recovery failure log prefix
/// (`Failed to resume ${operation.lane}/${operation.operationId}:`).
pub fn recovery_log_prefix(lane: &str, operation_id: &str) -> String {
    format!("Failed to resume {lane}/{operation_id}:")
}
