//! Port of upstream `mini/shared/transport.ts`: the newline JSON framing
//! algorithm over an embedder-owned duplex (D18).

use serde_json::Value;

/// Upstream `jsonConnection`'s buffered line parser. Feed raw chunks;
/// complete non-empty lines dispatch to the handler, partial lines buffer.
pub struct JsonFraming {
    buffered: String,
    closed: bool,
    written: Vec<String>,
}

impl Default for JsonFraming {
    fn default() -> Self {
        Self::new()
    }
}

impl JsonFraming {
    pub fn new() -> Self {
        Self {
            buffered: String::new(),
            closed: false,
            written: Vec::new(),
        }
    }

    /// Upstream `input.on("data")`: accumulate, split on `\n`, skip empty
    /// lines, dispatch parsed messages.
    pub fn feed(&mut self, chunk: &str, mut on_message: impl FnMut(Value)) {
        self.buffered.push_str(chunk);
        while let Some(newline) = self.buffered.find('\n') {
            let line = self.buffered[..newline].to_string();
            self.buffered = self.buffered[newline + 1..].to_string();
            if !line.is_empty() {
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    on_message(message);
                }
            }
        }
    }

    /// Upstream `send`: writes are suppressed after close.
    pub fn send(&mut self, message: &Value) {
        if !self.closed {
            self.written.push(format!(
                "{}\n",
                serde_json::to_string(message).unwrap_or_default()
            ));
        }
    }

    /// Upstream `end`/`error`/`close` notifications.
    pub fn notify_closed(&mut self) {
        self.closed = true;
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn written(&self) -> &[String] {
        &self.written
    }

    pub fn buffered_tail(&self) -> &str {
        &self.buffered
    }
}

/// Upstream entry argument validation:
/// worker `node worker/entry.ts <sessionsRoot> <cwd> [sessionId]`.
pub fn validate_worker_entry_args(
    args: &[String],
) -> Result<(String, String, Option<String>), String> {
    let sessions_root = args.first().map(String::as_str).unwrap_or_default();
    let cwd = args.get(1).map(String::as_str).unwrap_or_default();
    if sessions_root.is_empty() || cwd.is_empty() {
        return Err("Session worker requires <sessionsRoot> <cwd> [sessionId]".to_string());
    }
    Ok((
        sessions_root.to_string(),
        cwd.to_string(),
        args.get(2).cloned(),
    ))
}

/// Upstream entry argument validation:
/// server `node server/entry.ts <socketPath> <sessionsRoot>`.
pub fn validate_server_entry_args(args: &[String]) -> Result<(String, String), String> {
    let socket_path = args.first().map(String::as_str).unwrap_or_default();
    let sessions_root = args.get(1).map(String::as_str).unwrap_or_default();
    if socket_path.is_empty() || sessions_root.is_empty() {
        return Err("Server requires <socketPath> <sessionsRoot>".to_string());
    }
    Ok((socket_path.to_string(), sessions_root.to_string()))
}

/// Upstream `tui/run.ts` socket layout:
/// `<agentDir>/experimental/mini.sock` and `.../mini-sessions`.
pub fn mini_socket_path(agent_dir: &str) -> String {
    std::path::Path::new(agent_dir)
        .join("experimental")
        .join("mini.sock")
        .to_string_lossy()
        .to_string()
}

/// Upstream `tui/run.ts` sessions root.
pub fn mini_sessions_root(agent_dir: &str) -> String {
    std::path::Path::new(agent_dir)
        .join("experimental")
        .join("mini-sessions")
        .to_string_lossy()
        .to_string()
}

/// Upstream `tui/run.ts` ensureServer timeout failure.
pub const SERVER_START_TIMEOUT_ERROR: &str = "Timed out waiting for the mini session server";
