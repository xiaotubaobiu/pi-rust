//! Port of upstream `mini/tui/view.rs` (view.ts) + `tui/session.ts` +
//! `tui/run.ts`: the presentation's deterministic faces — queue text, entry
//! mapping, working state, footer, attach flow, submit routing and continue
//! selection. Draw components and the harness reducer are embedder-owned
//! (D18).

use super::protocol::{ProviderAccount, API_KEY_LOGIN_LABEL, SUBSCRIPTION_LOGIN_LABEL};
use super::server_run::RetireDecision;

/// Upstream `userMessageText`.
pub fn user_message_text(message: &MiniMessage) -> String {
    match message {
        MiniMessage::User { content } => collapse(content.clone()),
        _ => String::new(),
    }
}

/// Upstream message face (only what the view reads).
#[derive(Debug, Clone, PartialEq)]
pub enum MiniMessage {
    User {
        content: String,
    },
    Assistant {
        text: String,
        tool_calls: Vec<(String, String)>,
    },
    ToolResult {
        tool_name: String,
        tool_call_id: String,
    },
}

fn collapse(text: String) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Upstream `#syncQueues` text transform.
pub fn queue_item_text(item: &QueueItem) -> String {
    let text = match item {
        QueueItem::Message { message } => collapse(user_message_text(message)),
        QueueItem::Custom { custom_type } => format!("<{custom_type}>"),
    };
    format!("[{}] {}", item.kind(), text)
}

/// Upstream queue item face.
#[derive(Debug, Clone, PartialEq)]
pub enum QueueItem {
    Message { message: MiniMessage },
    Custom { custom_type: String },
}

impl QueueItem {
    pub fn kind(&self) -> &str {
        match self {
            QueueItem::Message { .. } => "message",
            QueueItem::Custom { .. } => "write",
        }
    }
}

/// Upstream entry face for the view mapping.
#[derive(Debug, Clone, PartialEq)]
pub enum MiniEntry {
    Compaction {
        id: String,
        tokens_before: i64,
        retained_tail: Vec<MiniMessage>,
    },
    BranchSummary {
        id: String,
        summary: String,
    },
    Custom {
        id: String,
        custom_type: String,
    },
    Message {
        id: String,
        message: MiniMessage,
    },
}

impl MiniEntry {
    pub fn id(&self) -> &str {
        match self {
            MiniEntry::Compaction { id, .. }
            | MiniEntry::BranchSummary { id, .. }
            | MiniEntry::Custom { id, .. }
            | MiniEntry::Message { id, .. } => id,
        }
    }
}

/// Upstream `#addEntry` render sequence as text commands.
#[derive(Debug, Clone, PartialEq)]
pub enum MiniDraw {
    Text(String),
    User(String),
    Assistant(String),
    ToolCall(String),
    ToolResult(String),
    Working(bool),
    Clear,
    Rebase,
}

/// Upstream `MiniTui.apply`'s transcript sync (append + divergence rebuild).
pub struct MiniTranscriptSync {
    rendered_entry_ids: Vec<String>,
    working: bool,
}

impl Default for MiniTranscriptSync {
    fn default() -> Self {
        Self::new()
    }
}

impl MiniTranscriptSync {
    pub fn new() -> Self {
        Self {
            rendered_entry_ids: Vec::new(),
            working: false,
        }
    }

    pub fn rendered_entry_ids(&self) -> &[String] {
        &self.rendered_entry_ids
    }

    pub fn is_working(&self) -> bool {
        self.working
    }

    /// Upstream `#syncTranscript` + `#addEntry` + `#addMessage`.
    pub fn sync(&mut self, transcript: &[MiniEntry], draws: &mut Vec<MiniDraw>) {
        let diverged = self
            .rendered_entry_ids
            .iter()
            .enumerate()
            .any(|(index, id)| transcript.get(index).map(|entry| entry.id()) != Some(id.as_str()));
        if diverged {
            draws.push(MiniDraw::Clear);
            self.rendered_entry_ids.clear();
        }
        for entry in transcript.iter().skip(self.rendered_entry_ids.len()) {
            self.add_entry(entry, draws);
            self.rendered_entry_ids.push(entry.id().to_string());
        }
    }

    fn add_entry(&mut self, entry: &MiniEntry, draws: &mut Vec<MiniDraw>) {
        match entry {
            MiniEntry::Compaction {
                tokens_before,
                retained_tail,
                ..
            } => {
                draws.push(MiniDraw::Text(format!(
                    "[compaction] compacted from {tokens_before} tokens"
                )));
                for retained in retained_tail {
                    self.add_message(retained, draws);
                }
            }
            MiniEntry::BranchSummary { summary, .. } => {
                draws.push(MiniDraw::Text("[branch summary]".to_string()));
                draws.push(MiniDraw::Text(summary.clone()));
            }
            MiniEntry::Custom { custom_type, .. } => {
                draws.push(MiniDraw::Text(format!("[{custom_type}]")));
            }
            MiniEntry::Message { message, .. } => self.add_message(message, draws),
        }
    }

    fn add_message(&mut self, message: &MiniMessage, draws: &mut Vec<MiniDraw>) {
        match message {
            MiniMessage::User { content } => {
                draws.push(MiniDraw::User(collapse(content.clone())));
            }
            MiniMessage::Assistant { text, tool_calls } => {
                draws.push(MiniDraw::Assistant(text.clone()));
                for (name, id) in tool_calls {
                    draws.push(MiniDraw::ToolCall(format!("{name}:{id}")));
                }
            }
            MiniMessage::ToolResult {
                tool_name,
                tool_call_id,
            } => {
                draws.push(MiniDraw::ToolResult(format!("{tool_name}:{tool_call_id}")));
            }
        }
    }

    /// Upstream `#setWorking`.
    pub fn set_working(&mut self, working: bool, draws: &mut Vec<MiniDraw>) {
        if working == self.working {
            return;
        }
        self.working = working;
        draws.push(MiniDraw::Clear);
        draws.push(MiniDraw::Working(working));
    }
}

/// Upstream `runView` footer line (`render` in tui/view.ts), with the
/// embedder's keybinding labels.
pub fn mini_footer(
    model_provider: &str,
    model_id: &str,
    thinking_level: &str,
    model_key: &str,
    follow_up_key: &str,
    clear_key: &str,
) -> String {
    format!(
        "{model_provider}/{model_id} · thinking:{thinking_level} · {model_key} or /model · /login · /compact · {follow_up_key} follow-up · {clear_key} exit"
    )
}

/// Upstream submit routing (`submit` in runView).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MiniSubmitRoute {
    Ignore,
    SelectModel,
    Login,
    Compact,
    Steer,
    Prompt,
}

/// Upstream submit routing decision (busy = an active lane operation).
pub fn route_submit(trimmed: &str, busy: bool) -> MiniSubmitRoute {
    if trimmed.is_empty() {
        return MiniSubmitRoute::Ignore;
    }
    match trimmed {
        "/model" => MiniSubmitRoute::SelectModel,
        "/login" => MiniSubmitRoute::Login,
        "/compact" => MiniSubmitRoute::Compact,
        _ => {
            if busy {
                MiniSubmitRoute::Steer
            } else {
                MiniSubmitRoute::Prompt
            }
        }
    }
}

/// Upstream login method selector labels + routing.
pub fn login_method_labels() -> [String; 2] {
    [
        SUBSCRIPTION_LOGIN_LABEL.to_string(),
        API_KEY_LOGIN_LABEL.to_string(),
    ]
}

/// Upstream `selectLoginProvider` routing: label -> authType.
pub fn login_method_to_auth_type(label: &str) -> &'static str {
    if label == SUBSCRIPTION_LOGIN_LABEL {
        "oauth"
    } else {
        "api_key"
    }
}

/// Upstream `selectLoginProvider` empty-provider face.
pub const NO_PROVIDERS_MESSAGE: &str = "No providers for that method.";

/// Upstream `runLogin` non-interactive face.
pub fn non_interactive_login_message(method_name: Option<&str>) -> String {
    format!(
        "{} is configured outside pi.",
        method_name.unwrap_or("Authentication")
    )
}

/// Upstream `toAuthSelectorProviders`.
pub fn auth_selector_providers(
    accounts: &[ProviderAccount],
) -> Vec<(String, String, Option<String>)> {
    accounts
        .iter()
        .map(|account| {
            let status = if account.configured {
                Some(
                    account
                        .source
                        .clone()
                        .unwrap_or_else(|| "configured".to_string()),
                )
            } else {
                None
            };
            (account.id.clone(), account.auth_type.clone(), status)
        })
        .collect()
}

/// Upstream selector value split: first slash.
pub fn split_model_value(value: &str) -> (String, String) {
    match value.find('/') {
        Some(separator) => (
            value[..separator].to_string(),
            value[separator + 1..].to_string(),
        ),
        None => (value.to_string(), String::new()),
    }
}

// ---------------------------------------------------------------------------
// tui/run.ts: continue selection
// ---------------------------------------------------------------------------

/// Upstream continue selection: same-cwd sessions sorted by createdAt
/// ascending; the last one wins.
pub fn continue_session_id(sessions: &[(String, String, i64)], cwd: &str) -> Option<String> {
    let mut candidates: Vec<&(String, String, i64)> = sessions
        .iter()
        .filter(|(_, session_cwd, _)| session_cwd == cwd)
        .collect();
    candidates.sort_by_key(|(_, _, created_at)| *created_at);
    candidates.last().map(|(id, _, _)| id.clone())
}

/// Upstream `TuiOptions` parsing (`mini/main.ts` parseArgs).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TuiOptions {
    pub continue_session: bool,
}

/// Upstream `parseArgs`: `--continue`/`-c` flags only.
pub fn parse_mini_args(argv: &[String]) -> Result<TuiOptions, String> {
    let mut options = TuiOptions::default();
    for arg in argv {
        match arg.as_str() {
            "--continue" | "-c" => options.continue_session = true,
            other => return Err(format!("Unknown argument: {other}")),
        }
    }
    Ok(options)
}

/// Upstream idle-retire decision re-export face.
pub fn retire_after_idle() -> RetireDecision {
    RetireDecision::ScheduleAfter(super::protocol::IDLE_SHUTDOWN_MS)
}
