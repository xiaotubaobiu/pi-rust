//! The `pi-ai` surface: full upstream type system (re-exported from
//! [`types`]), transcript normalization ([`transcript`]), argument validation
//! ([`validation`]), and the two wire-protocol providers ([`openai_compat`],
//! [`anthropic`]).
//!
//! The M1 mini types (`message.rs`/`event.rs`) are gone: every role, block,
//! event, and provider request now runs on the upstream-compatible types, so
//! request bodies derive from the REPLAYED transcript and session JSONL is
//! upstream wire format.

pub mod anthropic;
pub mod openai_compat;
pub mod transcript;
pub mod types;
pub mod validation;

pub use transcript::{Context, TranscriptContext};
pub use types::*;

use tokio::sync::mpsc;

/// Current Unix time in milliseconds (upstream message timestamps are
/// `number` millis; `i64` here, `0` if the clock is before the epoch).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Who is answering: fills `AssistantMessage.provider`/`model` (the `api`
/// field is fixed by the provider implementation). Provider ids are
/// open-ended strings upstream, so the id is plain data.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderIdentity {
    pub id: String,
    pub model: String,
}

/// Connection details for one provider endpoint. The model id moved to
/// [`ProviderIdentity`] so one endpoint config can serve any model.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub base_url: String,
    pub api_key: String,
    pub max_tokens: u64,
}

/// One provider = its wire protocol implementation. Requests are built from
/// the normalized [`TranscriptContext`] (prompt and tools replayed from the
/// system messages) and events flow out of the returned channel following the
/// upstream `AssistantMessageEvent` protocol: `start` before content, content
/// block start/delta/end sequences, then `done` or `error` as terminal event.
pub trait Provider: Send + Sync {
    fn stream(
        &self,
        ctx: &TranscriptContext,
        options: &SimpleStreamOptions,
        provider: &ProviderIdentity,
    ) -> mpsc::Receiver<AssistantMessageEvent>;
}
