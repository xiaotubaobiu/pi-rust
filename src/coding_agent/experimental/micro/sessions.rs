//! Port of upstream `micro/sessions.ts`: the micro-session path scheme and
//! newest-session selection. The filesystem walk and `proper-lockfile` lock
//! are embedder-owned (D17); the port owns the naming scheme, the filter and
//! the sort.

use sha2::{Digest, Sha256};

/// Upstream `cwdKey`: `sha256(cwd).hex[0..24]`.
pub fn cwd_key(cwd: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(cwd.as_bytes());
    let digest = hasher.finalize();
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Upstream micro session root:
/// `<agentDir>/experimental/micro-sessions/<cwdKey>`.
pub fn micro_session_root(agent_dir: &str, cwd: &str) -> String {
    std::path::Path::new(agent_dir)
        .join("experimental")
        .join("micro-sessions")
        .join(cwd_key(cwd))
        .to_string_lossy()
        .to_string()
}

/// Upstream entry-name filter:
/// `/^\d{13}-[0-9a-f-]{36}$/u` and directory-only.
pub fn is_micro_session_directory_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.len() != 13 + 1 + 36 {
        return false;
    }
    if !bytes[..13].iter().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    if bytes[13] != b'-' {
        return false;
    }
    bytes[14..]
        .iter()
        .all(|byte| byte.is_ascii_hexdigit() || *byte == b'-')
}

/// Upstream continue-session selection: lexicographically sorted names pick
/// the last (newest timestamp prefix sorts last).
pub fn newest_micro_session(entries: &[String]) -> Option<&String> {
    let mut candidates: Vec<&String> = entries
        .iter()
        .filter(|name| is_micro_session_directory_name(name))
        .collect();
    candidates.sort();
    candidates.last().copied()
}

/// Upstream create path: `<13-digit zero-padded ms>-<uuid>`.
pub fn new_micro_session_path(root: &str, timestamp_ms: u64, uuid: &str) -> String {
    std::path::Path::new(root)
        .join(format!("{timestamp_ms:013}-{uuid}"))
        .to_string_lossy()
        .to_string()
}

/// Upstream `selectSession` continue failure: no session for this cwd.
pub fn no_micro_session_error(cwd: &str) -> String {
    format!("No micro session exists for {cwd}")
}

/// Upstream lock failure: the session is already open.
pub fn already_open_error(path: &str) -> String {
    format!("Micro session is already open: {path}")
}

/// Upstream `selectSession` result face.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicroSessionLocation {
    pub id: String,
    pub path: String,
    pub cwd: String,
    pub created: bool,
}

/// Decide the location for one `selectSession` call (the mkdir/lock/readdir
/// I/O is embedder-owned, D17). `newest` is the readdir result when
/// continuing.
pub fn select_session_location(
    cwd: &str,
    continue_session: bool,
    timestamp_ms: u64,
    uuid: &str,
    newest: Option<&str>,
    root: &str,
) -> Result<MicroSessionLocation, String> {
    if continue_session {
        let Some(newest) = newest else {
            return Err(no_micro_session_error(cwd));
        };
        let path = std::path::Path::new(root)
            .join(newest)
            .to_string_lossy()
            .to_string();
        Ok(MicroSessionLocation {
            id: newest.to_string(),
            path,
            cwd: cwd.to_string(),
            created: false,
        })
    } else {
        let path = new_micro_session_path(root, timestamp_ms, uuid);
        Ok(MicroSessionLocation {
            id: std::path::Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default(),
            path,
            cwd: cwd.to_string(),
            created: true,
        })
    }
}
