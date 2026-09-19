use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text { text: String },
    Thinking { thinking: String },
    ToolCall { id: String, name: String, arguments: serde_json::Value },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    Stop,
    Length,
    ToolUse,
    Error,
    Aborted,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    User { content: Vec<ContentBlock> },
    Assistant { content: Vec<ContentBlock>, stop_reason: StopReason, usage: Usage },
    ToolResult { tool_call_id: String, tool_name: String, content: Vec<ContentBlock>, is_error: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

impl Message {
    pub fn user_text(text: impl Into<String>) -> Message {
        Message::User { content: vec![ContentBlock::Text { text: text.into() }] }
    }

    pub fn tool_result(tool_call_id: String, tool_name: String, text: String, is_error: bool) -> Message {
        Message::ToolResult {
            tool_call_id,
            tool_name,
            content: vec![ContentBlock::Text { text }],
            is_error,
        }
    }

    /// Text of all text blocks, joined by newlines.
    pub fn text(&self) -> String {
        let blocks = match self {
            Message::User { content }
            | Message::Assistant { content, .. }
            | Message::ToolResult { content, .. } => content,
        };
        let mut parts = Vec::new();
        for b in blocks {
            if let ContentBlock::Text { text } = b {
                parts.push(text.clone());
            }
        }
        parts.join("\n")
    }

    /// Tool calls requested by an assistant message (empty for other roles).
    pub fn tool_calls(&self) -> Vec<ToolCall> {
        if let Message::Assistant { content, .. } = self {
            content
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::ToolCall { id, name, arguments } => Some(ToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
                    }),
                    _ => None,
                })
                .collect()
        } else {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_round_trip_all_roles() {
        let msgs = vec![
            Message::user_text("hello"),
            Message::Assistant {
                content: vec![
                    ContentBlock::Thinking { thinking: "hmm".into() },
                    ContentBlock::Text { text: "hi".into() },
                    ContentBlock::ToolCall { id: "t1".into(), name: "read_file".into(), arguments: serde_json::json!({"path": "a.txt"}) },
                ],
                stop_reason: StopReason::ToolUse,
                usage: Usage { input_tokens: 10, output_tokens: 5 },
            },
            Message::tool_result("t1".into(), "read_file".into(), "contents".into(), false),
        ];
        for m in msgs {
            let v = serde_json::to_string(&m).unwrap();
            let back: Message = serde_json::from_str(&v).unwrap();
            assert_eq!(back, m);
        }
    }

    #[test]
    fn tool_calls_extracted_only_from_assistant() {
        let a = Message::Assistant {
            content: vec![ContentBlock::ToolCall { id: "t1".into(), name: "bash".into(), arguments: serde_json::json!({}) }],
            stop_reason: StopReason::ToolUse,
            usage: Usage::default(),
        };
        assert_eq!(a.tool_calls().len(), 1);
        assert!(Message::user_text("x").tool_calls().is_empty());
    }
}
