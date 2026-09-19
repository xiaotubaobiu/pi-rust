/// Agent-level events consumed by the UI. Mirrors upstream pi-agent-core.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    TurnStart,
    AssistantDelta {
        delta: String,
    },
    ThinkingDelta {
        delta: String,
    },
    MessageEnd,
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        arguments: serde_json::Value,
    },
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        is_error: bool,
    },
    TurnEnd,
    AgentEnd,
    AgentError {
        message: String,
    },
}
