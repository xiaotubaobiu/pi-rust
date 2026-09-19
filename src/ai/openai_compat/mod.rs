use crate::ai::message::{ContentBlock, Message};
use crate::ai::{Context, ProviderConfig};

/// Convert an OpenAI-compat request body from a Context.
/// Thinking blocks are display-only and never replayed.
pub fn build_request_body(ctx: &Context, cfg: &ProviderConfig) -> serde_json::Value {
    let mut messages = Vec::new();
    if !ctx.system_prompt.is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": ctx.system_prompt }));
    }
    for m in &ctx.messages {
        match m {
            Message::User { content } => {
                messages.push(serde_json::json!({ "role": "user", "content": text_of(content) }));
            }
            Message::Assistant { content, .. } => {
                let text = text_of(content);
                let tool_calls: Vec<serde_json::Value> = content
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::ToolCall { id, name, arguments } => Some(serde_json::json!({
                            "id": id,
                            "type": "function",
                            "function": { "name": name, "arguments": arguments.to_string() }
                        })),
                        _ => None,
                    })
                    .collect();
                let mut msg = serde_json::json!({ "role": "assistant", "content": if text.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(text) } });
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = serde_json::Value::Array(tool_calls);
                }
                messages.push(msg);
            }
            Message::ToolResult { tool_call_id, content, .. } => {
                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": text_of(content)
                }));
            }
        }
    }
    let tools: Vec<serde_json::Value> = ctx
        .tools
        .iter()
        .map(|t| serde_json::json!({
            "type": "function",
            "function": { "name": t.name, "description": t.description, "parameters": t.parameters }
        }))
        .collect();
    serde_json::json!({ "model": cfg.model, "messages": messages, "tools": tools, "stream": true })
}

fn text_of(content: &[ContentBlock]) -> String {
    let mut parts = Vec::new();
    for b in content {
        if let ContentBlock::Text { text } = b {
            parts.push(text.clone());
        }
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::message::Message;
    use crate::ai::{ProviderConfig, ToolDef};

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            base_url: "http://localhost:1234/v1".into(),
            api_key: "sk-test".into(),
            model: "glm-4.6".into(),
            max_tokens: 8192,
        }
    }

    #[test]
    fn system_prompt_and_user_message() {
        let ctx = Context {
            system_prompt: "be brief".into(),
            messages: vec![Message::user_text("hi")],
            tools: vec![],
        };
        let body = build_request_body(&ctx, &cfg());
        assert_eq!(body["model"], "glm-4.6");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "be brief");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "hi");
        assert!(body["tools"].as_array().unwrap().is_empty());
    }

    #[test]
    fn assistant_tool_call_and_tool_result_replay() {
        let ctx = Context {
            system_prompt: String::new(),
            messages: vec![
                Message::user_text("ls"),
                Message::Assistant {
                    content: vec![ContentBlock::ToolCall {
                        id: "t1".into(),
                        name: "bash".into(),
                        arguments: serde_json::json!({"command": "ls"}),
                    }],
                    stop_reason: crate::ai::message::StopReason::ToolUse,
                    usage: Default::default(),
                },
                Message::tool_result("t1".into(), "bash".into(), "out".into(), false),
            ],
            tools: vec![ToolDef {
                name: "bash".into(),
                description: "run".into(),
                parameters: serde_json::json!({"type": "object"}),
            }],
        };
        let body = build_request_body(&ctx, &cfg());
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[1]["tool_calls"][0]["function"]["name"], "bash");
        // arguments must be a JSON-encoded string on the wire
        assert_eq!(msgs[1]["tool_calls"][0]["function"]["arguments"], r#"{"command":"ls"}"#);
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[2]["tool_call_id"], "t1");
        assert_eq!(body["tools"][0]["function"]["name"], "bash");
    }

    #[test]
    fn thinking_blocks_not_replayed() {
        let ctx = Context {
            system_prompt: String::new(),
            messages: vec![Message::Assistant {
                content: vec![
                    ContentBlock::Thinking { thinking: "secret".into() },
                    ContentBlock::Text { text: "answer".into() },
                ],
                stop_reason: crate::ai::message::StopReason::Stop,
                usage: Default::default(),
            }],
            tools: vec![],
        };
        let body = build_request_body(&ctx, &cfg());
        assert_eq!(body["messages"][0]["content"], "answer");
    }
}
