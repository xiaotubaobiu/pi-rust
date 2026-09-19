use crate::ai::message::{ContentBlock, Message};
use crate::ai::{Context, ProviderConfig};

/// Build an Anthropic /v1/messages request body from a Context.
/// Thinking blocks are display-only and never replayed.
/// Tool results become user messages with tool_result blocks (Anthropic convention).
pub fn build_request_body(ctx: &Context, cfg: &ProviderConfig) -> serde_json::Value {
    let mut messages = Vec::new();
    for m in &ctx.messages {
        match m {
            Message::User { content } => {
                messages.push(serde_json::json!({ "role": "user", "content": blocks(content) }));
            }
            Message::Assistant { content, .. } => {
                messages.push(serde_json::json!({ "role": "assistant", "content": blocks(content) }));
            }
            Message::ToolResult { tool_call_id, content, is_error, .. } => {
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": text_of(content),
                        "is_error": is_error
                    }]
                }));
            }
        }
    }
    let tools: Vec<serde_json::Value> = ctx
        .tools
        .iter()
        .map(|t| serde_json::json!({
            "name": t.name,
            "description": t.description,
            "input_schema": t.parameters
        }))
        .collect();
    serde_json::json!({
        "model": cfg.model,
        "max_tokens": cfg.max_tokens,
        "system": ctx.system_prompt,
        "messages": messages,
        "tools": tools,
        "stream": true
    })
}

fn blocks(content: &[ContentBlock]) -> Vec<serde_json::Value> {
    content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(serde_json::json!({ "type": "text", "text": text })),
            ContentBlock::ToolCall { id, name, arguments } => Some(serde_json::json!({
                "type": "tool_use", "id": id, "name": name, "input": arguments
            })),
            ContentBlock::Thinking { .. } => None,
        })
        .collect()
}

fn text_of(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::message::{Message, StopReason};
    use crate::ai::ToolDef;

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            base_url: "https://api.anthropic.com".into(),
            api_key: "k".into(),
            model: "claude-sonnet-4-5".into(),
            max_tokens: 8192,
        }
    }

    #[test]
    fn system_is_top_level_and_tools_use_input_schema() {
        let ctx = Context {
            system_prompt: "be brief".into(),
            messages: vec![Message::user_text("hi")],
            tools: vec![ToolDef { name: "bash".into(), description: "run".into(), parameters: serde_json::json!({"type": "object"}) }],
        };
        let body = build_request_body(&ctx, &cfg());
        assert_eq!(body["system"], "be brief");
        assert_eq!(body["max_tokens"], 8192);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn tool_use_and_tool_result_shapes() {
        let ctx = Context {
            system_prompt: String::new(),
            messages: vec![
                Message::user_text("ls"),
                Message::Assistant {
                    content: vec![ContentBlock::ToolCall { id: "t1".into(), name: "bash".into(), arguments: serde_json::json!({"command": "ls"}) }],
                    stop_reason: StopReason::ToolUse,
                    usage: Default::default(),
                },
                Message::tool_result("t1".into(), "bash".into(), "out".into(), true),
            ],
            tools: vec![],
        };
        let body = build_request_body(&ctx, &cfg());
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[1]["content"][0]["type"], "tool_use");
        assert_eq!(msgs[1]["content"][0]["input"]["command"], "ls");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][0]["is_error"], true);
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
                stop_reason: StopReason::Stop,
                usage: Default::default(),
            }],
            tools: vec![],
        };
        let body = build_request_body(&ctx, &cfg());
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
    }
}
