use crate::ai::event::AiEvent;
use crate::ai::message::{ContentBlock, Message, StopReason, Usage};
use crate::ai::{Context, Provider, ProviderConfig};
use eventsource_stream::Eventsource;
use futures::StreamExt;
use tokio::sync::mpsc;

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
                messages
                    .push(serde_json::json!({ "role": "assistant", "content": blocks(content) }));
            }
            Message::ToolResult {
                tool_call_id,
                content,
                is_error,
                ..
            } => {
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
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters
            })
        })
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
            ContentBlock::Text { text } => {
                Some(serde_json::json!({ "type": "text", "text": text }))
            }
            ContentBlock::ToolCall {
                id,
                name,
                arguments,
            } => Some(serde_json::json!({
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

pub struct AnthropicProvider {
    cfg: ProviderConfig,
}

impl AnthropicProvider {
    pub fn new(cfg: ProviderConfig) -> Self {
        AnthropicProvider { cfg }
    }
}

impl Provider for AnthropicProvider {
    fn stream(&self, ctx: &Context) -> mpsc::Receiver<AiEvent> {
        let (tx, rx) = mpsc::channel(64);
        let cfg = self.cfg.clone();
        let ctx = ctx.clone();
        tokio::spawn(async move {
            if let Err(e) = run_stream(ctx, cfg, tx.clone()).await {
                let _ = tx
                    .send(AiEvent::Error {
                        message: e.to_string(),
                    })
                    .await;
            }
        });
        rx
    }
}

struct ToolAcc {
    id: String,
    name: String,
    json: String,
}

async fn run_stream(
    ctx: Context,
    cfg: ProviderConfig,
    tx: mpsc::Sender<AiEvent>,
) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/messages", cfg.base_url.trim_end_matches('/'));
    let resp = client
        .post(url)
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&build_request_body(&ctx, &cfg))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let _ = tx
            .send(AiEvent::Error {
                message: format!("HTTP {status}: {body}"),
            })
            .await;
        return Ok(());
    }
    let _ = tx.send(AiEvent::Start).await;

    let mut text = String::new();
    let mut thinking = String::new();
    let mut tool: Option<ToolAcc> = None;
    let mut stop_reason = StopReason::Stop;
    let mut usage = Usage::default();

    let mut es = resp.bytes_stream().eventsource();
    while let Some(item) = es.next().await {
        let ev = item?;
        let data: serde_json::Value = serde_json::from_str(&ev.data)?;
        match ev.event.as_str() {
            "message_start" => {
                usage.input_tokens = data["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .unwrap_or(0);
            }
            "content_block_start" => {
                let block = &data["content_block"];
                if block["type"] == "tool_use" {
                    tool = Some(ToolAcc {
                        id: block["id"].as_str().unwrap_or_default().to_string(),
                        name: block["name"].as_str().unwrap_or_default().to_string(),
                        json: String::new(),
                    });
                }
            }
            "content_block_delta" => {
                let delta = &data["delta"];
                match delta["type"].as_str().unwrap_or_default() {
                    "text_delta" => {
                        if let Some(t) = delta["text"].as_str() {
                            text.push_str(t);
                            let _ = tx
                                .send(AiEvent::TextDelta {
                                    delta: t.to_string(),
                                })
                                .await;
                        }
                    }
                    "thinking_delta" => {
                        if let Some(t) = delta["thinking"].as_str() {
                            thinking.push_str(t);
                            let _ = tx
                                .send(AiEvent::ThinkingDelta {
                                    delta: t.to_string(),
                                })
                                .await;
                        }
                    }
                    "input_json_delta" => {
                        if let Some(t) = delta["partial_json"].as_str() {
                            if let Some(acc) = tool.as_mut() {
                                acc.json.push_str(t);
                            }
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                stop_reason = match data["delta"]["stop_reason"].as_str().unwrap_or_default() {
                    "tool_use" => StopReason::ToolUse,
                    "max_tokens" => StopReason::Length,
                    _ => StopReason::Stop,
                };
                if let Some(o) = data["usage"]["output_tokens"].as_u64() {
                    usage.output_tokens = o;
                }
            }
            "message_stop" => break,
            "error" => {
                let msg = data["error"]["message"]
                    .as_str()
                    .unwrap_or("unknown error")
                    .to_string();
                let _ = tx.send(AiEvent::Error { message: msg }).await;
                return Ok(());
            }
            _ => {}
        }
    }

    let mut content = Vec::new();
    if !thinking.is_empty() {
        content.push(ContentBlock::Thinking { thinking });
    }
    if !text.is_empty() {
        content.push(ContentBlock::Text { text });
    }
    if let Some(acc) = tool {
        let arguments = serde_json::from_str(&acc.json).unwrap_or(serde_json::json!({}));
        content.push(ContentBlock::ToolCall {
            id: acc.id,
            name: acc.name,
            arguments,
        });
    }
    let message = Message::Assistant {
        content,
        stop_reason,
        usage,
    };
    let _ = tx
        .send(AiEvent::Done {
            stop_reason,
            message,
        })
        .await;
    Ok(())
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
            tools: vec![ToolDef {
                name: "bash".into(),
                description: "run".into(),
                parameters: serde_json::json!({"type": "object"}),
            }],
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
                    content: vec![ContentBlock::ToolCall {
                        id: "t1".into(),
                        name: "bash".into(),
                        arguments: serde_json::json!({"command": "ls"}),
                    }],
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
                    ContentBlock::Thinking {
                        thinking: "secret".into(),
                    },
                    ContentBlock::Text {
                        text: "answer".into(),
                    },
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

    // --- streaming tests ---
    use crate::ai::event::AiEvent;
    use crate::ai::Provider;

    fn sse(body: &str) -> wiremock::ResponseTemplate {
        wiremock::ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string(body.to_string())
    }

    fn ev(name: &str, data: serde_json::Value) -> String {
        format!("event: {name}\ndata: {}\n\n", data)
    }

    async fn collect(provider: &AnthropicProvider, ctx: &crate::ai::Context) -> Vec<AiEvent> {
        let mut rx = provider.stream(ctx);
        let mut out = Vec::new();
        while let Some(ev) = rx.recv().await {
            out.push(ev);
        }
        out
    }

    fn text_stream_body() -> String {
        format!(
            "{}{}{}{}{}{}{}",
            ev(
                "message_start",
                serde_json::json!({"message": {"usage": {"input_tokens": 10}}})
            ),
            ev(
                "content_block_start",
                serde_json::json!({"index": 0, "content_block": {"type": "text"}})
            ),
            ev(
                "content_block_delta",
                serde_json::json!({"index": 0, "delta": {"type": "text_delta", "text": "he"}})
            ),
            ev(
                "content_block_delta",
                serde_json::json!({"index": 0, "delta": {"type": "text_delta", "text": "y"}})
            ),
            ev("content_block_stop", serde_json::json!({"index": 0})),
            ev(
                "message_delta",
                serde_json::json!({"delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}})
            ),
            ev("message_stop", serde_json::json!({})),
        )
    }

    #[tokio::test]
    async fn streams_text_and_done() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/messages"))
            .respond_with(sse(&text_stream_body()))
            .mount(&server)
            .await;
        let provider = AnthropicProvider::new(ProviderConfig {
            base_url: server.uri(),
            api_key: "k".into(),
            model: "m".into(),
            max_tokens: 8192,
        });
        let ctx = crate::ai::Context {
            system_prompt: String::new(),
            messages: vec![Message::user_text("hi")],
            tools: vec![],
        };
        let events = collect(&provider, &ctx).await;
        let mut text = String::new();
        for e in &events {
            if let AiEvent::TextDelta { delta } = e {
                text.push_str(delta);
            }
        }
        assert_eq!(text, "hey");
        match events.last().unwrap() {
            AiEvent::Done {
                stop_reason,
                message,
            } => {
                assert!(*stop_reason == StopReason::Stop);
                assert_eq!(message.text(), "hey");
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn streams_tool_use_with_input_json_delta() {
        let body = format!(
            "{}{}{}{}{}{}{}",
            ev(
                "message_start",
                serde_json::json!({"message": {"usage": {"input_tokens": 10}}})
            ),
            ev(
                "content_block_start",
                serde_json::json!({"index": 0, "content_block": {"type": "tool_use", "id": "t1", "name": "read_file"}})
            ),
            ev(
                "content_block_delta",
                serde_json::json!({"index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"pa"}})
            ),
            ev(
                "content_block_delta",
                serde_json::json!({"index": 0, "delta": {"type": "input_json_delta", "partial_json": "th\": \"a.txt\"}"}})
            ),
            ev("content_block_stop", serde_json::json!({"index": 0})),
            ev(
                "message_delta",
                serde_json::json!({"delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 3}})
            ),
            ev("message_stop", serde_json::json!({})),
        );
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(sse(&body))
            .mount(&server)
            .await;
        let provider = AnthropicProvider::new(ProviderConfig {
            base_url: server.uri(),
            api_key: "k".into(),
            model: "m".into(),
            max_tokens: 8192,
        });
        let ctx = crate::ai::Context {
            system_prompt: String::new(),
            messages: vec![Message::user_text("hi")],
            tools: vec![],
        };
        let events = collect(&provider, &ctx).await;
        match events.last().unwrap() {
            AiEvent::Done {
                stop_reason,
                message,
            } => {
                assert!(*stop_reason == StopReason::ToolUse);
                let calls = message.tool_calls();
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].id, "t1");
                assert_eq!(calls[0].arguments, serde_json::json!({"path": "a.txt"}));
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn http_error_becomes_error_event() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(wiremock::ResponseTemplate::new(401).set_body_string("bad key"))
            .mount(&server)
            .await;
        let provider = AnthropicProvider::new(ProviderConfig {
            base_url: server.uri(),
            api_key: "k".into(),
            model: "m".into(),
            max_tokens: 8192,
        });
        let ctx = crate::ai::Context {
            system_prompt: String::new(),
            messages: vec![Message::user_text("hi")],
            tools: vec![],
        };
        let events = collect(&provider, &ctx).await;
        match events.last().unwrap() {
            AiEvent::Error { message } => assert!(message.contains("401"), "got: {message}"),
            other => panic!("expected Error, got {other:?}"),
        }
    }
}
