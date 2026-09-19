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

/// This adapter speaks the `anthropic-messages` API; `AssistantMessage.api`
/// is stamped with it on every emitted message.
const API: &str = "anthropic-messages";

/// Build an Anthropic /v1/messages request body from a normalized transcript.
/// The system prompt and tool declarations are the REPLAYED transcript state
/// (`get_current_system_prompt`/`get_current_tools`). Thinking blocks are
/// display-only and never replayed; system messages are skipped in the
/// message list because the replay already folded them into the prompt.
/// Tool results become user messages with tool_result blocks (Anthropic
/// convention).
pub fn build_request_body(
    ctx: &TranscriptContext,
    cfg: &ProviderConfig,
    identity: &ProviderIdentity,
) -> serde_json::Value {
    let messages_slice = ctx.messages();
    let mut messages = Vec::new();
    for m in messages_slice {
        match m {
            Message::User(user) => {
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": text_blocks(&content_text(&user.content))
                }));
            }
            Message::Assistant(assistant) => {
                messages.push(serde_json::json!({
                    "role": "assistant",
                    "content": assistant_blocks(&assistant.content)
                }));
            }
            Message::ToolResult(result) => {
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": result.tool_call_id,
                        "content": tool_result_text(&result.content),
                        "is_error": result.is_error
                    }]
                }));
            }
            Message::System(_) => {}
        }
    }
    let tools: Vec<serde_json::Value> = get_current_tools(messages_slice)
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
        "model": identity.model,
        "max_tokens": cfg.max_tokens,
        "system": get_current_system_prompt(messages_slice),
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

/// Replayable assistant content: text and tool calls only. Thinking blocks
/// are display-only and never replayed (M1 behavior).
fn assistant_blocks(content: &[AssistantBlock]) -> Vec<serde_json::Value> {
    content
        .iter()
        .filter_map(|block| match block {
            AssistantBlock::Text(text) => {
                Some(serde_json::json!({ "type": "text", "text": text.text }))
            }
            AssistantBlock::ToolCall(call) => Some(serde_json::json!({
                "type": "tool_use", "id": call.id, "name": call.name, "input": call.arguments
            })),
            AssistantBlock::Thinking(_) => None,
        })
        .collect()
}

/// User content as text blocks (M1 shape).
fn text_blocks(text: &str) -> Vec<serde_json::Value> {
    serde_json::json!([{ "type": "text", "text": text }])
        .as_array()
        .cloned()
        .unwrap_or_default()
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
struct ToolAcc {
    /// Slot in the emitted message content (not the wire block index).
    content_index: usize,
    id: String,
    name: String,
    json: String,
}

async fn run_stream(
    ctx: TranscriptContext,
    cfg: ProviderConfig,
    provider: ProviderIdentity,
    tx: mpsc::Sender<AssistantMessageEvent>,
) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/messages", cfg.base_url.trim_end_matches('/'));
    let resp = client
        .post(url)
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&build_request_body(&ctx, &cfg, &provider))
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
    // block (each opened lazily on its first delta; Anthropic can interleave
    // several wire blocks of the same kind, which merge like M1's output),
    // one block per tool_use. Block indices in events are positions in this
    // vec, self-consistent for the reducer even when the wire index differs.
    let mut content: Vec<AssistantBlock> = Vec::new();
    let mut thinking_index: Option<usize> = None;
    let mut text_index: Option<usize> = None;
    // Wire content-block index -> accumulator; non-tool blocks stay None.
    let mut tools: Vec<Option<ToolAcc>> = Vec::new();
    let mut stop_reason = StopReason::Stop;
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;

    let mut es = resp.bytes_stream().eventsource();
    while let Some(item) = es.next().await {
        let ev = item?;
        let data: serde_json::Value = serde_json::from_str(&ev.data)?;
        match ev.event.as_str() {
            "message_start" => {
                input_tokens = data["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .unwrap_or(0);
            }
            "content_block_start" => {
                let block = &data["content_block"];
                if block["type"] == "tool_use" {
                    let index = data["index"].as_u64().unwrap_or(0) as usize;
                    if tools.len() <= index {
                        tools.resize(index + 1, None);
                    }
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
                    tools[index] = Some(ToolAcc {
                        content_index,
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
                    }
                    "thinking_delta" => {
                        if let Some(t) = delta["thinking"].as_str() {
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
                    }
                    "input_json_delta" => {
                        if let Some(t) = delta["partial_json"].as_str() {
                            let index = data["index"].as_u64().unwrap_or(0) as usize;
                            if let Some(Some(acc)) = tools.get_mut(index) {
                                acc.json.push_str(t);
                                let _ = tx
                                    .send(AssistantMessageEvent::ToolcallDelta {
                                        content_index: acc.content_index,
                                        delta: t.to_string(),
                                    })
                                    .await;
                            }
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = data["index"].as_u64().unwrap_or(0) as usize;
                if let Some(Some(acc)) = tools.get_mut(index) {
                    let arguments =
                        serde_json::from_str(&acc.json).unwrap_or(serde_json::json!({}));
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
            }
            "message_delta" => {
                stop_reason = match data["delta"]["stop_reason"].as_str().unwrap_or_default() {
                    "tool_use" => StopReason::ToolUse,
                    "max_tokens" => StopReason::Length,
                    _ => StopReason::Stop,
                };
                if let Some(o) = data["usage"]["output_tokens"].as_u64() {
                    output_tokens = o;
                }
            }
            "message_stop" => break,
            "error" => {
                let msg = data["error"]["message"]
                    .as_str()
                    .unwrap_or("unknown error")
                    .to_string();
                let _ = tx.send(error_event(&provider, msg)).await;
                return Ok(());
            }
            _ => {}
        }
    }

    // Close open text/thinking blocks; the end content is the authoritative
    // accumulated text.
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
    use crate::ai::types::events::PartialAssistant;
    use crate::ai::types::message::{
        StringOrBlocks, TextOrImageBlock, ToolResultMessage, UserMessage,
    };
    use crate::ai::types::tool::Tool;

    const TS: i64 = 1758240000000;

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            base_url: "https://api.anthropic.com".into(),
            api_key: "k".into(),
            max_tokens: 8192,
        }
    }

    fn identity() -> ProviderIdentity {
        ProviderIdentity {
            id: "anthropic".into(),
            model: "claude-sonnet-4-5".into(),
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
            provider: "anthropic".into(),
            model: "claude-sonnet-4-5".into(),
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
    fn system_is_top_level_and_tools_use_input_schema() {
        let ctx = context(
            Some("be brief"),
            vec![user_msg("hi")],
            Some(vec![tool("bash", "run")]),
        );
        let body = build_request_body(&ctx, &cfg(), &identity());
        assert_eq!(body["system"], "be brief");
        assert_eq!(body["max_tokens"], 8192);
        assert_eq!(body["model"], "claude-sonnet-4-5");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn tool_use_and_tool_result_shapes() {
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
                tool_result_msg("t1", "bash", "out", true),
            ],
            None,
        );
        let body = build_request_body(&ctx, &cfg(), &identity());
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[1]["content"][0]["type"], "tool_use");
        assert_eq!(msgs[1]["content"][0]["input"]["command"], "ls");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][0]["is_error"], true);
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
                    AssistantBlock::Text(TextContent {
                        text: "answer".into(),
                        text_signature: None,
                    }),
                ],
                StopReason::Stop,
            )],
            None,
        );
        let body = build_request_body(&ctx, &cfg(), &identity());
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
    }

    // --- streaming tests ---
    use crate::ai::Provider;

    fn sse(body: &str) -> wiremock::ResponseTemplate {
        wiremock::ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string(body.to_string())
    }

    fn ev(name: &str, data: serde_json::Value) -> String {
        format!("event: {name}\ndata: {}\n\n", data)
    }

    async fn collect(
        provider: &AnthropicProvider,
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

    fn assert_reducer_valid(events: &[AssistantMessageEvent]) {
        let mut partial = PartialAssistant::new();
        for ev in events {
            partial.apply(ev).unwrap();
        }
        assert!(partial.is_terminal());
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
            max_tokens: 8192,
        });
        let ctx = context(None, vec![user_msg("hi")], None);
        let events = collect(&provider, &ctx, &identity()).await;

        match &events[0] {
            AssistantMessageEvent::Start { message } => {
                assert_eq!(message.api, "anthropic-messages");
                assert_eq!(message.provider, "anthropic");
                assert_eq!(message.model, "claude-sonnet-4-5");
                assert_eq!(message.stop_reason, StopReason::Pending);
            }
            other => panic!("expected Start, got {other:?}"),
        }
        let mut text = String::new();
        for e in &events {
            if let AssistantMessageEvent::TextDelta { delta, .. } = e {
                text.push_str(delta);
            }
        }
        assert_eq!(text, "hey");
        match events.last().unwrap() {
            AssistantMessageEvent::Done { reason, message } => {
                assert!(*reason == SuccessReason::Stop);
                assert_eq!(message_text(message), "hey");
                assert_eq!(message.usage.input, 10);
                assert_eq!(message.usage.output, 3);
                assert_eq!(message.usage.total_tokens, 13);
            }
            other => panic!("expected Done, got {other:?}"),
        }
        assert_reducer_valid(&events);
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
            max_tokens: 8192,
        });
        let ctx = context(None, vec![user_msg("hi")], None);
        let events = collect(&provider, &ctx, &identity()).await;
        match events.last().unwrap() {
            AssistantMessageEvent::Done { reason, message } => {
                assert!(*reason == SuccessReason::ToolUse);
                let calls = message_tool_calls(message);
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].id, "t1");
                assert_eq!(calls[0].arguments, serde_json::json!({"path": "a.txt"}));
            }
            other => panic!("expected Done, got {other:?}"),
        }
        assert_reducer_valid(&events);
    }

    #[tokio::test]
    async fn streams_multiple_parallel_tool_use_blocks() {
        // Two tool_use blocks (plus a leading text block) with input_json
        // split across fragments. Regression test: the accumulator used to
        // keep only the last tool_use block, dropping parallel calls.
        let body = format!(
            "{}{}{}{}{}{}{}{}{}{}{}{}{}{}",
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
                serde_json::json!({"index": 0, "delta": {"type": "text_delta", "text": "running both"}})
            ),
            ev("content_block_stop", serde_json::json!({"index": 0})),
            ev(
                "content_block_start",
                serde_json::json!({"index": 1, "content_block": {"type": "tool_use", "id": "t1", "name": "read_file"}})
            ),
            ev(
                "content_block_delta",
                serde_json::json!({"index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"pa"}})
            ),
            ev(
                "content_block_delta",
                serde_json::json!({"index": 1, "delta": {"type": "input_json_delta", "partial_json": "th\": \"a.txt\"}"}})
            ),
            ev("content_block_stop", serde_json::json!({"index": 1})),
            ev(
                "content_block_start",
                serde_json::json!({"index": 2, "content_block": {"type": "tool_use", "id": "t2", "name": "bash"}})
            ),
            ev(
                "content_block_delta",
                serde_json::json!({"index": 2, "delta": {"type": "input_json_delta", "partial_json": "{\"comm"}})
            ),
            ev(
                "content_block_delta",
                serde_json::json!({"index": 2, "delta": {"type": "input_json_delta", "partial_json": "and\": \"ls\"}"}})
            ),
            ev("content_block_stop", serde_json::json!({"index": 2})),
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
            max_tokens: 8192,
        });
        let ctx = context(None, vec![user_msg("hi")], None);
        let events = collect(&provider, &ctx, &identity()).await;
        match events.last().unwrap() {
            AssistantMessageEvent::Done { reason, message } => {
                assert!(*reason == SuccessReason::ToolUse);
                assert_eq!(message_text(message), "running both");
                let calls = message_tool_calls(message);
                assert_eq!(calls.len(), 2, "got: {calls:?}");
                assert_eq!(calls[0].id, "t1");
                assert_eq!(calls[0].name, "read_file");
                assert_eq!(calls[0].arguments, serde_json::json!({"path": "a.txt"}));
                assert_eq!(calls[1].id, "t2");
                assert_eq!(calls[1].name, "bash");
                assert_eq!(calls[1].arguments, serde_json::json!({"command": "ls"}));
            }
            other => panic!("expected Done, got {other:?}"),
        }
        assert_reducer_valid(&events);
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
            max_tokens: 8192,
        });
        let ctx = context(None, vec![user_msg("hi")], None);
        let events = collect(&provider, &ctx, &identity()).await;
        match events.last().unwrap() {
            AssistantMessageEvent::Error { reason, error } => {
                assert!(*reason == ErrorReason::Error);
                let message = error.error_message.as_deref().unwrap_or_default();
                assert!(message.contains("401"), "got: {message}");
                assert_eq!(error.api, "anthropic-messages");
                assert_eq!(error.provider, "anthropic");
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }
}
