pub mod anthropic;
pub mod event;
pub mod message;
pub mod openai_compat;
pub mod transcript;
pub mod types;
pub mod validation;

use event::AiEvent;
use tokio::sync::mpsc;

/// A tool declaration sent to the LLM. `parameters` is a JSON Schema object.
#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Plain, serializable conversation state. Mirrors upstream pi-ai `Context`:
/// pure data, so it can cross providers and be persisted.
#[derive(Debug, Clone)]
pub struct Context {
    pub system_prompt: String,
    pub messages: Vec<message::Message>,
    pub tools: Vec<ToolDef>,
}

/// One provider = its wire protocol implementation.
pub trait Provider: Send + Sync {
    /// Start a streaming request; events flow out of the returned channel.
    fn stream(&self, ctx: &Context) -> mpsc::Receiver<AiEvent>;
}

/// Connection details for one provider endpoint.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u64,
}
