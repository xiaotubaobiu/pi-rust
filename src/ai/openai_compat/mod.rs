use crate::ai::event::AiEvent;
use crate::ai::message::{ContentBlock, Message, StopReason, Usage};
use crate::ai::{Context, Provider, ProviderConfig};
use eventsource_stream::Eventsource;
use futures::StreamExt;
use tokio::sync::mpsc;

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
                        ContentBlock::ToolCall {
                            id,
                            name,
                            arguments,
                        } => Some(serde_json::json!({
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
            Message::ToolResult {
                tool_call_id,
                content,
                ..
            } => {
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

pub struct OpenAiCompatProvider {
    cfg: ProviderConfig,
}

impl OpenAiCompatProvider {
    pub fn new(cfg: ProviderConfig) -> Self {
        OpenAiCompatProvider { cfg }
    }
}

impl Provider for OpenAiCompatProvider {
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

#[derive(Clone)]
struct ToolCallAcc {
    id: String,
    name: String,
    args: String,
}

async fn run_stream(
    ctx: Context,
    cfg: ProviderConfig,
    tx: mpsc::Sender<AiEvent>,
) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let resp = client
        .post(url)
        .bearer_auth(&cfg.api_key)
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
    let mut tool_calls: Vec<ToolCallAcc> = Vec::new();
    let mut stop_reason = StopReason::Stop;
    let mut usage = Usage::default();

    let mut es = resp.bytes_stream().eventsource();
    while let Some(item) = es.next().await {
        let ev = item?;
        if ev.data.trim() == "[DONE]" {
            break;
        }
        let chunk: serde_json::Value = serde_json::from_str(&ev.data)?;
        let choice = &chunk["choices"][0];
        let delta = &choice["delta"];

        if let Some(t) = delta["reasoning_content"].as_str() {
            thinking.push_str(t);
            let _ = tx
                .send(AiEvent::ThinkingDelta {
                    delta: t.to_string(),
                })
                .await;
        }
        if let Some(t) = delta["content"].as_str() {
            text.push_str(t);
            let _ = tx
                .send(AiEvent::TextDelta {
                    delta: t.to_string(),
                })
                .await;
        }
        if let Some(tcs) = delta["tool_calls"].as_array() {
            for tc in tcs {
                let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                if tool_calls.len() <= idx {
                    tool_calls.resize(
                        idx + 1,
                        ToolCallAcc {
                            id: String::new(),
                            name: String::new(),
                            args: String::new(),
                        },
                    );
                }
                let acc = &mut tool_calls[idx];
                if let Some(id) = tc["id"].as_str() {
                    acc.id = id.to_string();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    acc.name = n.to_string();
                }
                if let Some(a) = tc["function"]["arguments"].as_str() {
                    acc.args.push_str(a);
                }
            }
        }
        if let Some(fr) = choice["finish_reason"].as_str() {
            stop_reason = match fr {
                "tool_calls" | "function_call" => StopReason::ToolUse,
                "length" => StopReason::Length,
                _ => StopReason::Stop,
            };
        }
        if let Some(u) = chunk.get("usage") {
            if !u.is_null() {
                usage = Usage {
                    input_tokens: u["prompt_tokens"].as_u64().unwrap_or(0),
                    output_tokens: u["completion_tokens"].as_u64().unwrap_or(0),
                };
            }
        }
    }

    let mut content = Vec::new();
    if !thinking.is_empty() {
        content.push(ContentBlock::Thinking { thinking });
    }
    if !text.is_empty() {
        content.push(ContentBlock::Text { text });
    }
    for tc in tool_calls {
        let arguments = serde_json::from_str(&tc.args).unwrap_or(serde_json::json!({}));
        content.push(ContentBlock::ToolCall {
            id: tc.id,
            name: tc.name,
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
        assert_eq!(
            msgs[1]["tool_calls"][0]["function"]["arguments"],
            r#"{"command":"ls"}"#
        );
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
                    ContentBlock::Thinking {
                        thinking: "secret".into(),
                    },
                    ContentBlock::Text {
                        text: "answer".into(),
                    },
                ],
                stop_reason: crate::ai::message::StopReason::Stop,
                usage: Default::default(),
            }],
            tools: vec![],
        };
        let body = build_request_body(&ctx, &cfg());
        assert_eq!(body["messages"][0]["content"], "answer");
    }

    // --- streaming tests (require tokio) ---
    use crate::ai::event::AiEvent;
    use crate::ai::Provider;

    fn sse(body: &str) -> wiremock::ResponseTemplate {
        wiremock::ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string(body.to_string())
    }

    fn chunk(delta: serde_json::Value) -> String {
        format!(
            "data: {}\n\n",
            serde_json::json!({"choices": [{"delta": delta}]})
        )
    }

    async fn collect(
        provider: &crate::ai::openai_compat::OpenAiCompatProvider,
        ctx: &crate::ai::Context,
    ) -> Vec<AiEvent> {
        let mut rx = provider.stream(ctx);
        let mut out = Vec::new();
        while let Some(ev) = rx.recv().await {
            out.push(ev);
        }
        out
    }

    #[tokio::test]
    async fn streams_text_and_done() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/chat/completions"))
            .respond_with(sse(&format!(
                "{}{}{}",
                chunk(serde_json::json!({"content": "he"})),
                chunk(serde_json::json!({"content": "y"})),
                "data: [DONE]\n\n"
            )))
            .mount(&server)
            .await;
        let provider = OpenAiCompatProvider::new(ProviderConfig {
            base_url: format!("{}/v1", server.uri()),
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
        assert!(matches!(events[0], AiEvent::Start));
        let mut text = String::new();
        for ev in &events {
            if let AiEvent::TextDelta { delta } = ev {
                text.push_str(delta);
            }
        }
        assert_eq!(text, "hey");
        match events.last().unwrap() {
            AiEvent::Done {
                stop_reason,
                message,
            } => {
                assert!(*stop_reason == crate::ai::message::StopReason::Stop);
                assert_eq!(message.text(), "hey");
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn streams_tool_call_with_split_arguments() {
        let server = wiremock::MockServer::start().await;
        let body = format!(
            "{}{}{}{}",
            chunk(
                serde_json::json!({"tool_calls": [{"index": 0, "id": "t1", "type": "function", "function": {"name": "read_file", "arguments": "{\"pa"}}]})
            ),
            chunk(
                serde_json::json!({"tool_calls": [{"index": 0, "function": {"arguments": "th\": \"a.txt\"}"}}]})
            ),
            chunk(serde_json::json!({})),
            "data: [DONE]\n\n"
        );
        // finish_reason arrives in a choice-level field; add it to the empty chunk instead:
        let body = body.replace(
            &chunk(serde_json::json!({})),
            &format!(
                "data: {}\n\n",
                serde_json::json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
            ),
        );
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/chat/completions"))
            .respond_with(sse(&body))
            .mount(&server)
            .await;
        let provider = OpenAiCompatProvider::new(ProviderConfig {
            base_url: format!("{}/v1", server.uri()),
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
                assert!(*stop_reason == crate::ai::message::StopReason::ToolUse);
                let calls = message.tool_calls();
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].name, "read_file");
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
        let provider = OpenAiCompatProvider::new(ProviderConfig {
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
