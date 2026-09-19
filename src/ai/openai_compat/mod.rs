use crate::ai::transcript::{content_text, get_current_system_prompt, get_current_tools};
use crate::ai::types::content::{TextContent, ThinkingContent, ToolCall};
use crate::ai::types::events::{AssistantMessageEvent, ErrorReason, SuccessReason};
use crate::ai::types::message::{AssistantBlock, AssistantMessage, Message, TextOrImageBlock};
use crate::ai::types::options::SimpleStreamOptions;
use crate::ai::types::primitives::{StopReason, Usage};
use crate::ai::{now_ms, Provider, ProviderConfig, ProviderIdentity, TranscriptContext};
use eventsource_stream::Eventsource;
use futures::StreamExt;
use tokio::sync::mpsc;

/// This adapter speaks the `openai-completions` API; `AssistantMessage.api`
/// is stamped with it on every emitted message.
const API: &str = "openai-completions";

/// Convert an OpenAI-compat request body from a normalized transcript. The
/// system prompt and tool declarations are the REPLAYED transcript state
/// (`get_current_system_prompt`/`get_current_tools`), not the raw shorthand
/// fields. Thinking blocks are display-only and never replayed; system
/// messages are skipped in the message list because the replay already
/// folded them into the prompt.
pub fn build_request_body(
    ctx: &TranscriptContext,
    identity: &ProviderIdentity,
) -> serde_json::Value {
    let messages_slice = ctx.messages();
    let mut messages = Vec::new();
    let system_prompt = get_current_system_prompt(messages_slice);
    if !system_prompt.is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": system_prompt }));
    }
    for m in messages_slice {
        match m {
            Message::User(user) => {
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": content_text(&user.content)
                }));
            }
            Message::Assistant(assistant) => {
                let text = assistant_text(&assistant.content);
                let tool_calls: Vec<serde_json::Value> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantBlock::ToolCall(call) => Some(serde_json::json!({
                            "id": call.id,
                            "type": "function",
                            "function": { "name": call.name, "arguments": call.arguments.to_string() }
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
            Message::ToolResult(result) => {
                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": result.tool_call_id,
                    "content": tool_result_text(&result.content)
                }));
            }
            Message::System(_) => {}
        }
    }
    let tools: Vec<serde_json::Value> = get_current_tools(messages_slice)
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": { "name": t.name, "description": t.description, "parameters": t.parameters }
            })
        })
        .collect();
    serde_json::json!({
        "model": identity.model,
        "messages": messages,
        "tools": tools,
        "stream": true
    })
}

/// Text of all text blocks of a tool result, joined by newlines.
fn tool_result_text(content: &[TextOrImageBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            TextOrImageBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Text of all text blocks, joined by newlines.
fn assistant_text(content: &[AssistantBlock]) -> String {
    let mut parts = Vec::new();
    for block in content {
        if let AssistantBlock::Text(text) = block {
            parts.push(text.text.clone());
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
    fn stream(
        &self,
        ctx: &TranscriptContext,
        _options: &SimpleStreamOptions,
        provider: &ProviderIdentity,
    ) -> mpsc::Receiver<AssistantMessageEvent> {
        let (tx, rx) = mpsc::channel(64);
        let cfg = self.cfg.clone();
        let ctx = ctx.clone();
        let provider = provider.clone();
        tokio::spawn(async move {
            if let Err(e) = run_stream(ctx, cfg, provider.clone(), tx.clone()).await {
                let _ = tx.send(error_event(&provider, e.to_string())).await;
            }
        });
        rx
    }
}

/// The initial assistant message structure carried by the `start` event.
fn initial_message(provider: &ProviderIdentity) -> AssistantMessage {
    AssistantMessage {
        content: vec![],
        api: API.to_string(),
        provider: provider.id.clone(),
        model: provider.model.clone(),
        response_model: None,
        response_id: None,
        provider_thinking_level: None,
        diagnostics: None,
        usage: Usage::default(),
        stop_reason: StopReason::Pending,
        deferred: None,
        error_message: None,
        raw_stop_reason: None,
        end_turn: None,
        timestamp: now_ms(),
    }
}

/// Terminal `error` event for a failed request or stream.
fn error_event(provider: &ProviderIdentity, message: String) -> AssistantMessageEvent {
    let mut message_struct = initial_message(provider);
    message_struct.stop_reason = StopReason::Error;
    message_struct.error_message = Some(message);
    AssistantMessageEvent::Error {
        reason: ErrorReason::Error,
        error: message_struct,
    }
}

fn success_reason(reason: StopReason) -> SuccessReason {
    match reason {
        StopReason::Length => SuccessReason::Length,
        StopReason::ToolUse => SuccessReason::ToolUse,
        _ => SuccessReason::Stop,
    }
}

#[derive(Clone)]
struct ToolCallAcc {
    /// Slot in the emitted message content (not the wire `index`).
    content_index: usize,
    id: String,
    name: String,
    args: String,
}

async fn run_stream(
    ctx: TranscriptContext,
    cfg: ProviderConfig,
    provider: ProviderIdentity,
    tx: mpsc::Sender<AssistantMessageEvent>,
) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let resp = client
        .post(url)
        .bearer_auth(&cfg.api_key)
        .json(&build_request_body(&ctx, &provider))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let _ = tx
            .send(error_event(&provider, format!("HTTP {status}: {body}")))
            .await;
        return Ok(());
    }
    let _ = tx
        .send(AssistantMessageEvent::Start {
            message: initial_message(&provider),
        })
        .await;

    // Content blocks as opened, in event order: one thinking block, one text
    // block (each opened lazily on its first delta), one block per tool call.
    let mut content: Vec<AssistantBlock> = Vec::new();
    let mut thinking_index: Option<usize> = None;
    let mut text_index: Option<usize> = None;
    // Slots for non-tool wire indexes stay None until a fragment arrives.
    let mut tools: Vec<Option<ToolCallAcc>> = Vec::new();
    let mut stop_reason = StopReason::Stop;
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;

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
            let index = match thinking_index {
                Some(index) => index,
                None => {
                    let index = content.len();
                    content.push(AssistantBlock::Thinking(ThinkingContent {
                        thinking: String::new(),
                        thinking_signature: None,
                        redacted: None,
                    }));
                    thinking_index = Some(index);
                    let _ = tx
                        .send(AssistantMessageEvent::ThinkingStart {
                            content_index: index,
                        })
                        .await;
                    index
                }
            };
            if let AssistantBlock::Thinking(thinking) = &mut content[index] {
                thinking.thinking.push_str(t);
            }
            let _ = tx
                .send(AssistantMessageEvent::ThinkingDelta {
                    content_index: index,
                    delta: t.to_string(),
                })
                .await;
        }
        if let Some(t) = delta["content"].as_str() {
            let index = match text_index {
                Some(index) => index,
                None => {
                    let index = content.len();
                    content.push(AssistantBlock::Text(TextContent {
                        text: String::new(),
                        text_signature: None,
                    }));
                    text_index = Some(index);
                    let _ = tx
                        .send(AssistantMessageEvent::TextStart {
                            content_index: index,
                        })
                        .await;
                    index
                }
            };
            if let AssistantBlock::Text(text) = &mut content[index] {
                text.text.push_str(t);
            }
            let _ = tx
                .send(AssistantMessageEvent::TextDelta {
                    content_index: index,
                    delta: t.to_string(),
                })
                .await;
        }
        if let Some(tcs) = delta["tool_calls"].as_array() {
            for tc in tcs {
                let index = tc["index"].as_u64().unwrap_or(0) as usize;
                if tools.len() <= index {
                    tools.resize(index + 1, None);
                }
                if tools[index].is_none() {
                    let content_index = content.len();
                    content.push(AssistantBlock::ToolCall(ToolCall {
                        id: String::new(),
                        name: String::new(),
                        arguments: serde_json::json!({}),
                        thought_signature: None,
                        namespace: None,
                    }));
                    let _ = tx
                        .send(AssistantMessageEvent::ToolcallStart { content_index })
                        .await;
                    tools[index] = Some(ToolCallAcc {
                        content_index,
                        id: String::new(),
                        name: String::new(),
                        args: String::new(),
                    });
                }
                let acc = tools[index].as_mut().unwrap();
                if let Some(id) = tc["id"].as_str() {
                    acc.id = id.to_string();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    acc.name = n.to_string();
                }
                if let Some(a) = tc["function"]["arguments"].as_str() {
                    acc.args.push_str(a);
                    let _ = tx
                        .send(AssistantMessageEvent::ToolcallDelta {
                            content_index: acc.content_index,
                            delta: a.to_string(),
                        })
                        .await;
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
                input_tokens = u["prompt_tokens"].as_u64().unwrap_or(0);
                output_tokens = u["completion_tokens"].as_u64().unwrap_or(0);
            }
        }
    }

    // Close open blocks; the end content is the authoritative accumulated text.
    if let Some(index) = thinking_index {
        let thinking = match &content[index] {
            AssistantBlock::Thinking(thinking) => thinking.thinking.clone(),
            _ => String::new(),
        };
        let _ = tx
            .send(AssistantMessageEvent::ThinkingEnd {
                content_index: index,
                content: thinking,
            })
            .await;
    }
    if let Some(index) = text_index {
        let text = match &content[index] {
            AssistantBlock::Text(text) => text.text.clone(),
            _ => String::new(),
        };
        let _ = tx
            .send(AssistantMessageEvent::TextEnd {
                content_index: index,
                content: text,
            })
            .await;
    }
    let mut ended: Vec<&ToolCallAcc> = tools.iter().flatten().collect();
    ended.sort_by_key(|acc| acc.content_index);
    for acc in ended {
        let arguments = serde_json::from_str(&acc.args).unwrap_or(serde_json::json!({}));
        let call = ToolCall {
            id: acc.id.clone(),
            name: acc.name.clone(),
            arguments,
            thought_signature: None,
            namespace: None,
        };
        content[acc.content_index] = AssistantBlock::ToolCall(call.clone());
        let _ = tx
            .send(AssistantMessageEvent::ToolcallEnd {
                content_index: acc.content_index,
                tool_call: call,
            })
            .await;
    }

    let message = AssistantMessage {
        content,
        api: API.to_string(),
        provider: provider.id.clone(),
        model: provider.model.clone(),
        response_model: None,
        response_id: None,
        provider_thinking_level: None,
        diagnostics: None,
        usage: Usage {
            input: input_tokens,
            output: output_tokens,
            total_tokens: input_tokens + output_tokens,
            ..Usage::default()
        },
        stop_reason,
        deferred: None,
        error_message: None,
        raw_stop_reason: None,
        end_turn: None,
        timestamp: now_ms(),
    };
    let _ = tx
        .send(AssistantMessageEvent::Done {
            reason: success_reason(stop_reason),
            message,
        })
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::transcript::{normalize_context, Context};
    use crate::ai::types::content::TextContent;
    use crate::ai::types::events::PartialAssistant;
    use crate::ai::types::message::{
        StringOrBlocks, TextOrImageBlock, ToolResultMessage, UserMessage,
    };
    use crate::ai::types::tool::Tool;

    const TS: i64 = 1758240000000;

    fn identity() -> ProviderIdentity {
        ProviderIdentity {
            id: "openai".into(),
            model: "glm-4.6".into(),
        }
    }

    fn tool(name: &str, description: &str) -> Tool {
        Tool {
            name: name.into(),
            description: description.into(),
            parameters: serde_json::json!({"type": "object"}),
            constrained_sampling: None,
        }
    }

    fn user_msg(text: &str) -> Message {
        Message::User(UserMessage {
            content: StringOrBlocks::Text(text.into()),
            timestamp: TS,
        })
    }

    fn assistant_msg(content: Vec<AssistantBlock>, stop_reason: StopReason) -> Message {
        Message::Assistant(AssistantMessage {
            content,
            api: API.into(),
            provider: "openai".into(),
            model: "glm-4.6".into(),
            response_model: None,
            response_id: None,
            provider_thinking_level: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason,
            deferred: None,
            error_message: None,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: TS,
        })
    }

    fn text_block(text: &str) -> AssistantBlock {
        AssistantBlock::Text(TextContent {
            text: text.into(),
            text_signature: None,
        })
    }

    fn tool_result_msg(tool_call_id: &str, tool_name: &str, text: &str, is_error: bool) -> Message {
        Message::ToolResult(ToolResultMessage {
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            content: vec![TextOrImageBlock::Text(TextContent {
                text: text.into(),
                text_signature: None,
            })],
            details: None,
            usage: None,
            is_error,
            timestamp: TS,
        })
    }

    fn context(
        system_prompt: Option<&str>,
        messages: Vec<Message>,
        tools: Option<Vec<Tool>>,
    ) -> TranscriptContext {
        normalize_context(&Context {
            system_prompt: system_prompt.map(str::to_string),
            messages,
            tools,
        })
    }

    #[test]
    fn system_prompt_and_user_message() {
        let ctx = context(Some("be brief"), vec![user_msg("hi")], None);
        let body = build_request_body(&ctx, &identity());
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
        let ctx = context(
            None,
            vec![
                user_msg("ls"),
                assistant_msg(
                    vec![AssistantBlock::ToolCall(ToolCall {
                        id: "t1".into(),
                        name: "bash".into(),
                        arguments: serde_json::json!({"command": "ls"}),
                        thought_signature: None,
                        namespace: None,
                    })],
                    StopReason::ToolUse,
                ),
                tool_result_msg("t1", "bash", "out", false),
            ],
            Some(vec![tool("bash", "run")]),
        );
        let body = build_request_body(&ctx, &identity());
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
        let ctx = context(
            None,
            vec![assistant_msg(
                vec![
                    AssistantBlock::Thinking(ThinkingContent {
                        thinking: "secret".into(),
                        thinking_signature: None,
                        redacted: None,
                    }),
                    text_block("answer"),
                ],
                StopReason::Stop,
            )],
            None,
        );
        let body = build_request_body(&ctx, &identity());
        assert_eq!(body["messages"][0]["content"], "answer");
    }

    #[test]
    fn system_messages_are_replayed_into_the_prompt_not_replayed_verbatim() {
        // A mid-conversation system message contributes to the replayed prompt.
        let ctx = context(Some("Base."), vec![user_msg("hi")], None);
        let body = build_request_body(&ctx, &identity());
        assert_eq!(body["messages"][0]["content"], "Base.");
        assert!(body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["role"] != "system" || m == &body["messages"][0]));
    }

    // --- streaming tests (require tokio) ---
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
        provider: &OpenAiCompatProvider,
        ctx: &TranscriptContext,
        identity: &ProviderIdentity,
    ) -> Vec<AssistantMessageEvent> {
        let mut rx = provider.stream(ctx, &SimpleStreamOptions::default(), identity);
        let mut out = Vec::new();
        while let Some(ev) = rx.recv().await {
            out.push(ev);
        }
        out
    }

    fn message_text(message: &AssistantMessage) -> String {
        let mut parts = Vec::new();
        for block in &message.content {
            if let AssistantBlock::Text(text) = block {
                parts.push(text.text.clone());
            }
        }
        parts.join("\n")
    }

    fn message_tool_calls(message: &AssistantMessage) -> Vec<&ToolCall> {
        message
            .content
            .iter()
            .filter_map(|block| match block {
                AssistantBlock::ToolCall(call) => Some(call),
                _ => None,
            })
            .collect()
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
            max_tokens: 8192,
        });
        let ctx = context(None, vec![user_msg("hi")], None);
        let events = collect(&provider, &ctx, &identity()).await;

        // start carries the initial message structure with identity metadata.
        match &events[0] {
            AssistantMessageEvent::Start { message } => {
                assert_eq!(message.api, "openai-completions");
                assert_eq!(message.provider, "openai");
                assert_eq!(message.model, "glm-4.6");
                assert!(message.content.is_empty());
                assert_eq!(message.stop_reason, StopReason::Pending);
            }
            other => panic!("expected Start, got {other:?}"),
        }
        let mut text = String::new();
        for ev in &events {
            if let AssistantMessageEvent::TextDelta { delta, .. } = ev {
                text.push_str(delta);
            }
        }
        assert_eq!(text, "hey");
        match events.last().unwrap() {
            AssistantMessageEvent::Done { reason, message } => {
                assert!(*reason == SuccessReason::Stop);
                assert_eq!(message_text(message), "hey");
            }
            other => panic!("expected Done, got {other:?}"),
        }
        // The whole stream reconstructs through the canonical reducer to
        // exactly the Done message.
        let mut partial = PartialAssistant::new();
        for ev in &events {
            partial.apply(ev).unwrap();
        }
        match events.last().unwrap() {
            AssistantMessageEvent::Done { message, .. } => {
                assert_eq!(partial.message(), Some(message));
            }
            _ => unreachable!(),
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
            max_tokens: 8192,
        });
        let ctx = context(None, vec![user_msg("hi")], None);
        let events = collect(&provider, &ctx, &identity()).await;
        match events.last().unwrap() {
            AssistantMessageEvent::Done { reason, message } => {
                assert!(*reason == SuccessReason::ToolUse);
                let calls = message_tool_calls(message);
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].name, "read_file");
                assert_eq!(calls[0].arguments, serde_json::json!({"path": "a.txt"}));
            }
            other => panic!("expected Done, got {other:?}"),
        }
        // Reducer-valid: the tool call arrives via start/delta/end.
        let mut partial = PartialAssistant::new();
        for ev in &events {
            partial.apply(ev).unwrap();
        }
        assert!(partial.is_terminal());
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
            max_tokens: 8192,
        });
        let ctx = context(None, vec![user_msg("hi")], None);
        let events = collect(&provider, &ctx, &identity()).await;
        match events.last().unwrap() {
            AssistantMessageEvent::Error { reason, error } => {
                assert!(*reason == ErrorReason::Error);
                let message = error.error_message.as_deref().unwrap_or_default();
                assert!(message.contains("401"), "got: {message}");
                assert_eq!(error.api, "openai-completions");
                assert_eq!(error.provider, "openai");
                assert_eq!(error.model, "glm-4.6");
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }
}
