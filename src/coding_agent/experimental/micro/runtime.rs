//! Port of upstream `micro/runtime.ts` deterministic faces: the usage
//! accumulator, the usage view math, the event->notice fold and the
//! thinking-level cycling. The pico3 `Harness` runtime is embedder-owned
//! (D17).

use super::api::{
    CompactionState, GenerationState, MicroNotice, MicroUsageView, MicroView, ModelRef, NoticeLevel,
};

/// Upstream `OpenMicroOptions`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenMicroOptions {
    pub cwd: Option<String>,
    pub continue_session: bool,
}

/// Upstream `UsageAccumulator`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageAccumulator {
    seen: Vec<u64>,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub total_cost: f64,
    pub last_assistant_id: u64,
    pub last_cache_hit_rate: Option<f64>,
}

/// Upstream entry face for usage folding.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageEntry {
    pub id: u64,
    /// `entry.model` role==="assistant" message.
    pub assistant: Option<AssistantUsage>,
    /// `entry.data.usage` fallback record.
    pub usage_record: Option<UsageRecord>,
}

/// Upstream assistant message usage face.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AssistantUsage {
    pub stop_reason: String,
    pub usage: UsageRecord,
}

/// Upstream `Usage` record.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageRecord {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    /// `totalTokens` (0 falls through to the field sum).
    pub total_tokens: f64,
    pub cost_total: f64,
}

impl UsageRecord {
    fn prompt_tokens(&self) -> f64 {
        self.input + self.cache_read + self.cache_write
    }

    /// Upstream `contextTokenCount`.
    pub fn context_token_count(&self) -> f64 {
        if self.total_tokens != 0.0 {
            self.total_tokens
        } else {
            self.input + self.output + self.cache_read + self.cache_write
        }
    }
}

impl UsageAccumulator {
    /// Upstream `accumulateUsage`: first-seen entries only; assistant
    /// messages with a non-aborted/error stop reason update the cache-hit
    /// watermark.
    pub fn accumulate(&mut self, entry: &UsageEntry) {
        if self.seen.contains(&entry.id) {
            return;
        }
        self.seen.push(entry.id);
        let usage = entry
            .assistant
            .as_ref()
            .map(|assistant| &assistant.usage)
            .or(entry.usage_record.as_ref());
        if let Some(usage) = usage {
            self.input += usage.input;
            self.output += usage.output;
            self.cache_read += usage.cache_read;
            self.cache_write += usage.cache_write;
            self.total_cost += usage.cost_total;
        }
        if let Some(assistant) = &entry.assistant {
            let not_failed = assistant.stop_reason != "aborted" && assistant.stop_reason != "error";
            if not_failed && entry.id > self.last_assistant_id {
                self.last_assistant_id = entry.id;
                let prompt_tokens = assistant.usage.prompt_tokens();
                self.last_cache_hit_rate = if prompt_tokens > 0.0 {
                    Some(assistant.usage.cache_read / prompt_tokens * 100.0)
                } else {
                    None
                };
            }
        }
    }
}

/// Conversation entries face for [`usage_view`].
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ConversationEntryView {
    pub id: u64,
    /// `entry.kind === "pi.summary"`.
    pub is_summary: bool,
    pub assistant: Option<AssistantUsage>,
}

/// Upstream `usageView`.
pub fn usage_view(
    cumulative: &UsageAccumulator,
    _config_model: Option<&ModelRef>,
    entries: &[ConversationEntryView],
    context_window: u64,
) -> MicroUsageView {
    let newest_summary = entries
        .iter()
        .filter(|entry| entry.is_summary)
        .map(|entry| entry.id)
        .max();
    let context_assistant = entries.iter().rev().find(|entry| {
        let Some(assistant) = &entry.assistant else {
            return false;
        };
        let not_failed = assistant.stop_reason != "aborted" && assistant.stop_reason != "error";
        not_failed && newest_summary.is_none_or(|newest| entry.id > newest)
    });
    let context_usage =
        context_assistant.and_then(|entry| entry.assistant.as_ref().map(|a| &a.usage));
    let context_tokens = context_usage.map(|usage| usage.context_token_count());
    let context_percent = match context_tokens {
        Some(tokens) if context_window > 0 => Some(tokens / context_window as f64 * 100.0),
        _ => None,
    };
    MicroUsageView {
        input: cumulative.input,
        output: cumulative.output,
        cache_read: cumulative.cache_read,
        cache_write: cumulative.cache_write,
        total_cost: cumulative.total_cost,
        last_cache_hit_rate: cumulative.last_cache_hit_rate,
        context_tokens,
        context_window,
        context_percent,
    }
}

/// Upstream `foldEvent` notice outcomes.
#[derive(Debug, Clone, PartialEq)]
pub enum FoldOutcome {
    /// `entry.added` — the caller accumulates usage.
    Accumulate,
    /// Any other event folded (optionally emitting notices).
    Folded(Vec<(NoticeLevel, String)>),
}

/// Upstream `foldEvent`: map one watch event to notices.
pub fn fold_event(
    event: &WatchEvent,
    previous_compaction: Option<&CompactionState>,
) -> FoldOutcome {
    match event {
        WatchEvent::EntryAdded => FoldOutcome::Accumulate,
        WatchEvent::Warning { message } => {
            FoldOutcome::Folded(vec![(NoticeLevel::Warning, message.clone())])
        }
        WatchEvent::GenerationFailed { reason, detail } => FoldOutcome::Folded(vec![(
            if reason == "overflow" {
                NoticeLevel::Info
            } else {
                NoticeLevel::Error
            },
            detail.clone(),
        )]),
        WatchEvent::CompactionFailed { detail } => FoldOutcome::Folded(vec![(
            NoticeLevel::Error,
            format!("Compaction failed: {detail}"),
        )]),
        WatchEvent::CompactionFinished => {
            if previous_compaction.is_some_and(|compaction| compaction.reason == "threshold") {
                FoldOutcome::Folded(vec![(
                    NoticeLevel::Info,
                    "Automatic compaction completed.".to_string(),
                )])
            } else {
                FoldOutcome::Folded(Vec::new())
            }
        }
    }
}

/// Upstream watch event face (only the kinds `foldEvent` reads).
#[derive(Debug, Clone, PartialEq)]
pub enum WatchEvent {
    EntryAdded,
    Warning { message: String },
    GenerationFailed { reason: String, detail: String },
    CompactionFailed { detail: String },
    CompactionFinished,
}

/// Upstream `notice` bookkeeping: append with a rolling id and keep the last
/// 50.
pub fn push_notice(
    notices: &mut Vec<MicroNotice>,
    next_id: &mut u64,
    level: NoticeLevel,
    message: &str,
) {
    notices.push(MicroNotice {
        id: *next_id,
        level,
        message: message.to_string(),
    });
    *next_id += 1;
    let excess = notices.len().saturating_sub(50);
    notices.drain(..excess);
}

/// Upstream `fail`: Faulted errors become the fatal view field; everything
/// else (and every error) becomes an error notice.
pub fn fail(view: &mut MicroView, next_id: &mut u64, error_name: Option<&str>, message: &str) {
    if error_name == Some("Faulted") {
        view.fatal = Some(message.to_string());
    }
    push_notice(&mut view.notices, next_id, NoticeLevel::Error, message);
}

/// Upstream `cycleThinking`: advance through the model's supported levels.
pub fn cycle_thinking(current: Option<&str>, levels: &[&str]) -> String {
    let current = current.unwrap_or("off");
    let index = levels.iter().position(|level| *level == current);
    match index {
        Some(index) => levels
            .get((index + 1) % levels.len())
            .map(|level| level.to_string())
            .unwrap_or_else(|| "off".to_string()),
        None => levels
            .first()
            .map(|level| level.to_string())
            .unwrap_or_else(|| "off".to_string()),
    }
}

/// Upstream `command` wrapper: nothing runs once the view is fatal.
pub fn command_gate(view_fatal: bool) -> bool {
    !view_fatal
}

/// Upstream generation state reuse.
pub type GenerationStateAlias = GenerationState;
