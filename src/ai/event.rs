use crate::ai::message::{Message, StopReason};

/// Normalized streaming events, identical for every provider.
/// Mirrors upstream pi-ai: errors are events, not panics.
#[derive(Debug, Clone)]
pub enum AiEvent {
    Start,
    TextDelta {
        delta: String,
    },
    ThinkingDelta {
        delta: String,
    },
    ToolCallEnd {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    Done {
        stop_reason: StopReason,
        message: Message,
    },
    Error {
        message: String,
    },
}
