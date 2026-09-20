pub mod event;
pub mod faux;
pub mod session;
pub mod tool;
pub mod tools;

use crate::ai::api::ApiImpl;
use crate::ai::transcript::{normalize_context, Context, TranscriptContext};
use crate::ai::types::content::{TextContent, ToolCall};
use crate::ai::types::events::AssistantMessageEvent;
use crate::ai::types::message::{
    AssistantBlock, AssistantMessage, Message, StringOrBlocks, TextOrImageBlock, ToolResultMessage,
    UserMessage,
};
use crate::ai::types::options::SimpleStreamOptions;
use crate::ai::types::tool::Tool;
use crate::ai::{now_ms, Model, ProviderConfig};
use event::AgentEvent;
use std::sync::Arc;
use tool::AgentTool;

/// Application-level message. LLM-visible messages are wrapped in the full
/// upstream `Message`; everything else stays app-only and is filtered out by
/// `convert_to_llm` (mirrors upstream AgentMessage vs LLM message split).
///
/// The Assistant variant of `Message` is intrinsically the largest payload
/// (same reason `types::Message` carries the same allow); boxing it would add
/// indirection at every use site for no functional gain.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentMessage {
    Message(Message),
    Notification { text: String },
}

pub fn convert_to_llm(messages: &[AgentMessage]) -> Vec<Message> {
    messages
        .iter()
        .filter_map(|m| match m {
            AgentMessage::Message(m) => Some(m.clone()),
            AgentMessage::Notification { .. } => None,
        })
        .collect()
}

pub struct Agent {
    pub provider: Arc<dyn ApiImpl>,
    /// Endpoint connection details passed to every provider request.
    pub provider_config: ProviderConfig,
    /// Who is answering: `model.provider`/`model.id` stamp
    /// `AssistantMessage.provider`/`model` inside the API implementation.
    pub model: Model,
    pub tools: Vec<AgentTool>,
    pub system_prompt: String,
    pub messages: Vec<AgentMessage>,
    pub max_turns: usize,
}

impl Agent {
    pub fn new(
        provider: Arc<dyn ApiImpl>,
        provider_config: ProviderConfig,
        model: Model,
        tools: Vec<AgentTool>,
        system_prompt: String,
    ) -> Self {
        Agent {
            provider,
            provider_config,
            model,
            tools,
            system_prompt,
            messages: Vec::new(),
            max_turns: 25,
        }
    }

    /// Full LLM request input; `normalize_context` folds the prompt and tool
    /// declarations into a leading system message, so request bodies derive
    /// from the replayed transcript (upstream `normalizeContext`).
    fn build_context(&self) -> Context {
        Context {
            system_prompt: Some(self.system_prompt.clone()),
            messages: convert_to_llm(&self.messages),
            tools: Some(
                self.tools
                    .iter()
                    .map(|t| Tool {
                        name: t.name.to_string(),
                        description: t.description.to_string(),
                        parameters: t.parameters.clone(),
                        constrained_sampling: None,
                    })
                    .collect(),
            ),
        }
    }

    fn build_transcript(&self) -> TranscriptContext {
        normalize_context(&self.build_context())
    }

    /// Run one user prompt to completion of the tool-call loop.
    pub async fn prompt(
        &mut self,
        text: &str,
        on_event: &mut dyn FnMut(AgentEvent),
    ) -> anyhow::Result<()> {
        self.messages
            .push(AgentMessage::Message(Message::User(UserMessage {
                content: StringOrBlocks::Text(text.to_string()),
                timestamp: now_ms(),
            })));
        on_event(AgentEvent::TurnStart);
        let result = self.run_turns(on_event).await;
        on_event(AgentEvent::AgentEnd);
        result
    }

    async fn run_turns(&mut self, on_event: &mut dyn FnMut(AgentEvent)) -> anyhow::Result<()> {
        for _turn in 0..self.max_turns {
            let transcript = self.build_transcript();
            let options = SimpleStreamOptions::default();
            let mut rx = self.provider.stream_simple(
                &self.provider_config,
                &self.model,
                &transcript,
                &options,
            );
            let mut assistant: Option<AssistantMessage> = None;
            while let Some(ev) = rx.recv().await {
                match ev {
                    AssistantMessageEvent::Start { .. } => {}
                    AssistantMessageEvent::TextDelta { delta, .. } => {
                        on_event(AgentEvent::AssistantDelta { delta });
                    }
                    AssistantMessageEvent::ThinkingDelta { delta, .. } => {
                        on_event(AgentEvent::ThinkingDelta { delta });
                    }
                    AssistantMessageEvent::Done { message, .. } => assistant = Some(message),
                    AssistantMessageEvent::Error { error, .. } => {
                        let message = error
                            .error_message
                            .clone()
                            .unwrap_or_else(|| "stream failed".to_string());
                        on_event(AgentEvent::AgentError {
                            message: message.clone(),
                        });
                        anyhow::bail!("stream error: {message}");
                    }
                    _ => {}
                }
            }
            let assistant_message =
                assistant.ok_or_else(|| anyhow::anyhow!("stream ended without Done"))?;
            on_event(AgentEvent::MessageEnd);
            self.messages.push(AgentMessage::Message(Message::Assistant(
                assistant_message.clone(),
            )));

            let calls: Vec<ToolCall> = assistant_message
                .content
                .iter()
                .filter_map(|block| match block {
                    AssistantBlock::ToolCall(call) => Some(call.clone()),
                    _ => None,
                })
                .collect();
            if calls.is_empty() {
                on_event(AgentEvent::TurnEnd);
                return Ok(());
            }
            for call in calls {
                on_event(AgentEvent::ToolExecutionStart {
                    tool_call_id: call.id.clone(),
                    tool_name: call.name.clone(),
                    arguments: call.arguments.clone(),
                });
                let (output, is_error) = self.execute_tool(&call.name, call.arguments).await;
                on_event(AgentEvent::ToolExecutionEnd {
                    tool_call_id: call.id.clone(),
                    tool_name: call.name.clone(),
                    is_error,
                });
                self.messages
                    .push(AgentMessage::Message(Message::ToolResult(
                        ToolResultMessage {
                            tool_call_id: call.id,
                            tool_name: call.name,
                            content: vec![TextOrImageBlock::Text(TextContent {
                                text: output,
                                text_signature: None,
                            })],
                            details: None,
                            usage: None,
                            is_error,
                            timestamp: now_ms(),
                        },
                    )));
            }
            on_event(AgentEvent::TurnEnd);
        }
        anyhow::bail!("exceeded max_turns ({})", self.max_turns)
    }

    async fn execute_tool(&self, name: &str, arguments: serde_json::Value) -> (String, bool) {
        match self.tools.iter().find(|t| t.name == name) {
            None => (format!("unknown tool: {name}"), true),
            Some(t) => match (t.execute)(arguments).await {
                Ok(out) => (out, false),
                Err(e) => (e, true),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::faux::FauxProvider;
    use crate::ai::api::anthropic::AnthropicMessages;
    use crate::ai::api::openai_completions::OpenAiCompletions;
    use crate::ai::types::events::{ErrorReason, SuccessReason};
    use crate::ai::types::primitives::{StopReason, Usage};
    use crate::ai::types::{ModelCost, ModelInput};

    const TS: i64 = 1758240000000;

    fn assistant(content: Vec<AssistantBlock>, stop_reason: StopReason) -> AssistantMessage {
        AssistantMessage {
            content,
            api: "faux-api".into(),
            provider: "faux".into(),
            model: "faux-model".into(),
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
        }
    }

    fn text_block(text: &str) -> AssistantBlock {
        AssistantBlock::Text(TextContent {
            text: text.to_string(),
            text_signature: None,
        })
    }

    fn text_done(text: &str) -> AssistantMessageEvent {
        AssistantMessageEvent::Done {
            reason: SuccessReason::Stop,
            message: assistant(vec![text_block(text)], StopReason::Stop),
        }
    }

    fn faux_model() -> Model {
        Model {
            id: "faux-model".into(),
            name: "Faux Model".into(),
            api: "faux-api".into(),
            provider: "faux".into(),
            base_url: "https://faux.invalid".into(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: ModelCost::default(),
            context_window: 200_000,
            max_tokens: 8192,
            sampling_params: None,
            headers: None,
            compat: None,
        }
    }

    fn faux_cfg() -> ProviderConfig {
        ProviderConfig {
            base_url: "https://faux.invalid".into(),
            api_key: "k".into(),
            max_tokens: 8192,
        }
    }

    fn faux_agent(faux: Arc<FauxProvider>, tools: Vec<AgentTool>) -> Agent {
        Agent::new(faux, faux_cfg(), faux_model(), tools, "sys".into())
    }

    #[tokio::test]
    async fn single_turn_no_tools() {
        let faux = Arc::new(FauxProvider::new());
        faux.push_script(vec![
            AssistantMessageEvent::Start {
                message: assistant(vec![], StopReason::Pending),
            },
            AssistantMessageEvent::TextStart { content_index: 0 },
            AssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "he".into(),
            },
            AssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "y".into(),
            },
            AssistantMessageEvent::TextEnd {
                content_index: 0,
                content: "hey".into(),
            },
            text_done("hey"),
        ]);
        let mut agent = faux_agent(faux.clone(), vec![]);

        let mut events = Vec::new();
        agent
            .prompt("hello", &mut |ev| events.push(format!("{ev:?}")))
            .await
            .unwrap();

        assert_eq!(agent.messages.len(), 2);
        let deltas: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                s if s.starts_with("AssistantDelta") => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(deltas.len(), 2);
        assert!(events.iter().any(|e| e.starts_with("AgentEnd")));

        // the assistant message is stored as a full upstream Message
        match &agent.messages[1] {
            AgentMessage::Message(Message::Assistant(a)) => {
                assert_eq!(a.api, "faux-api");
                assert_eq!(a.provider, "faux");
                assert_eq!(a.model, "faux-model");
                assert_eq!(a.stop_reason, StopReason::Stop);
            }
            other => panic!("expected assistant message, got {other:?}"),
        }

        // notification messages are filtered from LLM context
        agent.messages.push(AgentMessage::Notification {
            text: "ui only".into(),
        });
        let ctx = agent.build_context();
        assert_eq!(ctx.messages.len(), 2);
        assert_eq!(ctx.system_prompt.as_deref(), Some("sys"));
    }

    use crate::agent::tool::make_tool;
    use schemars::JsonSchema;
    use serde::Deserialize;

    #[derive(Deserialize, JsonSchema)]
    struct EchoArgs {
        text: String,
    }

    fn echo_tool() -> AgentTool {
        make_tool("echo", "echo text back", |a: EchoArgs| {
            Box::pin(async move { Ok(format!("echo: {}", a.text)) })
        })
    }

    fn tool_call_event(
        id: &str,
        name: &str,
        arguments: serde_json::Value,
    ) -> AssistantMessageEvent {
        AssistantMessageEvent::Done {
            reason: SuccessReason::ToolUse,
            message: assistant(
                vec![AssistantBlock::ToolCall(ToolCall {
                    id: id.into(),
                    name: name.into(),
                    arguments,
                    thought_signature: None,
                    namespace: None,
                })],
                StopReason::ToolUse,
            ),
        }
    }

    #[tokio::test]
    async fn tool_call_loop_two_turns() {
        let faux = Arc::new(FauxProvider::new());
        // turn 1: model requests echo tool
        faux.push_script(vec![tool_call_event(
            "t1",
            "echo",
            serde_json::json!({"text": "hi"}),
        )]);
        // turn 2: model answers using the tool result
        faux.push_script(vec![text_done("echo said hi")]);

        let mut agent = faux_agent(faux.clone(), vec![echo_tool()]);

        let mut tool_events: Vec<String> = Vec::new();
        agent
            .prompt("run echo", &mut |ev| {
                if let AgentEvent::ToolExecutionEnd {
                    tool_name,
                    is_error,
                    ..
                } = ev
                {
                    tool_events.push(format!("{tool_name} error={is_error}"));
                }
            })
            .await
            .unwrap();

        assert_eq!(tool_events, vec!["echo error=false".to_string()]);
        assert_eq!(agent.messages.len(), 4); // user, assistant(toolcall), toolresult, assistant(final)
        match &agent.messages[2] {
            AgentMessage::Message(Message::ToolResult(result)) => {
                assert!(!result.is_error);
                assert_eq!(result.tool_call_id, "t1");
                assert_eq!(result.tool_name, "echo");
                assert!(result.timestamp > 0);
                match &result.content[0] {
                    TextOrImageBlock::Text(text) => assert_eq!(text.text, "echo: hi"),
                    other => panic!("unexpected block {other:?}"),
                }
            }
            other => panic!("expected tool result message, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn invalid_args_and_unknown_tool_become_error_results() {
        let faux = Arc::new(FauxProvider::new());
        faux.push_script(vec![tool_call_event(
            "t1",
            "echo",
            serde_json::json!({"wrong": "arg"}),
        )]);
        faux.push_script(vec![tool_call_event("t2", "nope", serde_json::json!({}))]);
        faux.push_script(vec![text_done("done")]);

        let mut agent = faux_agent(faux.clone(), vec![echo_tool()]);

        let mut errors: Vec<bool> = Vec::new();
        agent
            .prompt("go", &mut |ev| {
                if let AgentEvent::ToolExecutionEnd { is_error, .. } = ev {
                    errors.push(is_error);
                }
            })
            .await
            .unwrap();

        assert_eq!(errors, vec![true, true]); // invalid args, then unknown tool; final turn has no tool
        assert_eq!(agent.messages.len(), 6); // user, asst, toolresult, asst, toolresult, asst
        match agent.messages.last().unwrap() {
            AgentMessage::Message(Message::Assistant(a)) => match &a.content[0] {
                AssistantBlock::Text(text) => assert_eq!(text.text, "done"),
                other => panic!("unexpected block {other:?}"),
            },
            other => panic!("expected final assistant message, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn stream_error_is_reported() {
        let faux = Arc::new(FauxProvider::new());
        let mut failed = assistant(vec![], StopReason::Error);
        failed.error_message = Some("boom".into());
        faux.push_script(vec![AssistantMessageEvent::Error {
            reason: ErrorReason::Error,
            error: failed,
        }]);
        let mut agent = faux_agent(faux.clone(), vec![]);

        let mut got_error = false;
        let result = agent
            .prompt("hi", &mut |ev| {
                if let AgentEvent::AgentError { message } = ev {
                    assert_eq!(message, "boom");
                    got_error = true;
                }
            })
            .await;
        assert!(result.is_err());
        assert!(got_error);
    }

    // ---- Task 9 integration: the loop against the real ApiImpls (wiremock) ----

    fn wire_model(api: &str, provider: &str, id: &str, base_url: &str) -> Model {
        Model {
            id: id.into(),
            name: id.into(),
            api: api.into(),
            provider: provider.into(),
            base_url: base_url.into(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: ModelCost::default(),
            context_window: 200_000,
            max_tokens: 8192,
            sampling_params: None,
            headers: None,
            compat: None,
        }
    }

    fn wire_cfg(base_url: &str) -> ProviderConfig {
        ProviderConfig {
            base_url: base_url.into(),
            api_key: "k".into(),
            max_tokens: 8192,
        }
    }

    fn data_line(json: serde_json::Value) -> String {
        format!("data: {json}\n\n")
    }

    fn content_chunk(text: &str) -> serde_json::Value {
        serde_json::json!({"choices": [{"delta": {"content": text}}]})
    }

    fn finish_chunk(finish_reason: &str) -> serde_json::Value {
        serde_json::json!({"choices": [{"delta": {}, "finish_reason": finish_reason}]})
    }

    fn sse(body: &str) -> wiremock::ResponseTemplate {
        wiremock::ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string(body.to_string())
    }

    /// One full agent prompt (text turn only) over `openai-completions`:
    /// the loop must call `stream_simple` with the agent's config/model, the
    /// wire body must replay the system prompt and model id, and the stored
    /// assistant message must carry the Model-stamped metadata.
    #[tokio::test]
    async fn agent_runs_text_turn_on_openai_completions_api() {
        let server = wiremock::MockServer::start().await;
        let body = format!(
            "{}{}{}",
            data_line(content_chunk("he")),
            data_line(content_chunk("y")),
            data_line(finish_chunk("stop"))
        );
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/chat/completions"))
            .respond_with(sse(&format!("{body}\ndata: [DONE]\n\n")))
            .mount(&server)
            .await;

        let base = format!("{}/v1", server.uri());
        let mut agent = Agent::new(
            Arc::new(OpenAiCompletions),
            wire_cfg(&base),
            wire_model("openai-completions", "openai", "gpt-test", &base),
            vec![],
            "sys".into(),
        );

        let mut deltas = String::new();
        agent
            .prompt("hello", &mut |ev| {
                if let AgentEvent::AssistantDelta { delta } = ev {
                    deltas.push_str(&delta);
                }
            })
            .await
            .unwrap();

        assert_eq!(deltas, "hey");
        assert_eq!(agent.messages.len(), 2);
        match &agent.messages[1] {
            AgentMessage::Message(Message::Assistant(a)) => {
                assert_eq!(a.api, "openai-completions");
                assert_eq!(a.provider, "openai");
                assert_eq!(a.model, "gpt-test");
                assert_eq!(a.stop_reason, StopReason::Stop);
            }
            other => panic!("expected assistant message, got {other:?}"),
        }

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        let sent: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(sent["model"], "gpt-test");
        assert_eq!(sent["messages"][0]["role"], "system");
        assert_eq!(sent["messages"][0]["content"], "sys");
        assert_eq!(sent["messages"][1]["role"], "user");
        assert_eq!(sent["messages"][1]["content"], "hello");
    }

    /// Two-turn tool loop over `openai-completions`: streamed tool-call
    /// fragments with split JSON arguments must execute the tool and feed
    /// the result back as a replayed tool message on turn 2.
    #[tokio::test]
    async fn agent_runs_tool_loop_on_openai_completions_api() {
        let server = wiremock::MockServer::start().await;
        let turn1 = format!(
            "{}{}{}",
            data_line(serde_json::json!({"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "t1", "type": "function", "function": {"name": "echo", "arguments": "{\"text\":"}}
            ]}}]})),
            data_line(serde_json::json!({"choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": "\"hi\"}"}}
            ]}}]})),
            data_line(finish_chunk("tool_calls")),
        );
        let turn2 = format!(
            "{}{}",
            data_line(content_chunk("echo said hi")),
            data_line(finish_chunk("stop"))
        );
        let served_turn1 = std::sync::atomic::AtomicBool::new(true);
        struct Alternate {
            turn1: String,
            turn2: String,
            served_turn1: std::sync::atomic::AtomicBool,
        }
        impl wiremock::Respond for Alternate {
            fn respond(&self, _req: &wiremock::Request) -> wiremock::ResponseTemplate {
                let first = self
                    .served_turn1
                    .swap(false, std::sync::atomic::Ordering::SeqCst);
                let body = if first { &self.turn1 } else { &self.turn2 };
                sse(&format!("{body}\ndata: [DONE]\n\n"))
            }
        }
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(Alternate {
                turn1,
                turn2,
                served_turn1,
            })
            .mount(&server)
            .await;

        let base = format!("{}/v1", server.uri());
        let mut agent = Agent::new(
            Arc::new(OpenAiCompletions),
            wire_cfg(&base),
            wire_model("openai-completions", "openai", "gpt-test", &base),
            vec![echo_tool()],
            "sys".into(),
        );

        agent.prompt("run echo", &mut |_| {}).await.unwrap();

        assert_eq!(agent.messages.len(), 4); // user, asst(toolcall), toolresult, asst(final)
        match &agent.messages[1] {
            AgentMessage::Message(Message::Assistant(a)) => {
                assert_eq!(a.stop_reason, StopReason::ToolUse);
            }
            other => panic!("expected assistant message, got {other:?}"),
        }
        match &agent.messages[2] {
            AgentMessage::Message(Message::ToolResult(result)) => {
                assert_eq!(result.tool_call_id, "t1");
                match &result.content[0] {
                    TextOrImageBlock::Text(text) => assert_eq!(text.text, "echo: hi"),
                    other => panic!("unexpected block {other:?}"),
                }
            }
            other => panic!("expected tool result, got {other:?}"),
        }
        // Turn 2 replays the assistant tool call and the tool result.
        let requests = server.received_requests().await.unwrap();
        let second: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
        let roles: Vec<&str> = second["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["system", "user", "assistant", "tool"]);
    }

    /// Same loop, `anthropic-messages` API: stamps and SSE parsing must hold
    /// at the agent level for the second wire protocol too.
    #[tokio::test]
    async fn agent_runs_text_turn_on_anthropic_messages_api() {
        let server = wiremock::MockServer::start().await;
        // Event data carries the upstream `type` field; the impl dispatches
        // on it (upstream parses `{type: eventName, ...}`).
        let ev = |name: &str, data: serde_json::Value| {
            let mut data = data;
            data["type"] = serde_json::json!(name);
            format!("event: {name}\ndata: {data}\n\n")
        };
        let body = format!(
            "{}{}{}{}{}{}",
            ev(
                "message_start",
                serde_json::json!({"message": {"id": "msg_test", "usage": {"input_tokens": 1}}})
            ),
            ev(
                "content_block_start",
                serde_json::json!({"index": 0, "content_block": {"type": "text", "text": ""}})
            ),
            ev(
                "content_block_delta",
                serde_json::json!({"index": 0, "delta": {"type": "text_delta", "text": "hey"}})
            ),
            ev("content_block_stop", serde_json::json!({"index": 0})),
            ev(
                "message_delta",
                serde_json::json!({"delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}})
            ),
            ev("message_stop", serde_json::json!({})),
        );
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/messages"))
            .respond_with(sse(&body))
            .mount(&server)
            .await;

        let base = server.uri();
        let mut agent = Agent::new(
            Arc::new(AnthropicMessages),
            wire_cfg(&base),
            wire_model("anthropic-messages", "anthropic", "claude-test", &base),
            vec![],
            "sys".into(),
        );

        let mut deltas = String::new();
        agent
            .prompt("hello", &mut |ev| {
                if let AgentEvent::AssistantDelta { delta } = ev {
                    deltas.push_str(&delta);
                }
            })
            .await
            .unwrap();

        assert_eq!(deltas, "hey");
        match &agent.messages[1] {
            AgentMessage::Message(Message::Assistant(a)) => {
                assert_eq!(a.api, "anthropic-messages");
                assert_eq!(a.provider, "anthropic");
                assert_eq!(a.model, "claude-test");
                assert_eq!(a.stop_reason, StopReason::Stop);
            }
            other => panic!("expected assistant message, got {other:?}"),
        }
    }

    /// Third wire protocol at the agent level: `openai-responses` streams a
    /// text turn and stamps the Model metadata into the stored message.
    #[tokio::test]
    async fn agent_runs_text_turn_on_openai_responses_api() {
        use crate::ai::api::openai_responses::OpenAiResponses;

        let server = wiremock::MockServer::start().await;
        let data = |value: serde_json::Value| format!("data: {value}\n\n");
        let body = format!(
            "{}{}{}{}{}",
            data(serde_json::json!({
                "type": "response.created",
                "response": {"id": "resp_ok"}
            })),
            data(serde_json::json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {"type": "message", "id": "msg_1", "role": "assistant", "content": []}
            })),
            data(serde_json::json!({
                "type": "response.output_text.delta",
                "output_index": 0,
                "item_id": "msg_1",
                "delta": "hey"
            })),
            data(serde_json::json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {"type": "message", "id": "msg_1", "role": "assistant",
                          "content": [{"type": "output_text", "text": "hey", "annotations": []}]}
            })),
            data(serde_json::json!({
                "type": "response.completed",
                "response": {"id": "resp_ok", "status": "completed",
                              "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
            })),
        );
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/responses"))
            .respond_with(sse(&body))
            .mount(&server)
            .await;

        let base = format!("{}/v1", server.uri());
        let mut agent = Agent::new(
            Arc::new(OpenAiResponses),
            wire_cfg(&base),
            wire_model("openai-responses", "openai", "gpt-test", &base),
            vec![],
            "sys".into(),
        );

        let mut deltas = String::new();
        agent
            .prompt("hello", &mut |ev| {
                if let AgentEvent::AssistantDelta { delta } = ev {
                    deltas.push_str(&delta);
                }
            })
            .await
            .unwrap();

        assert_eq!(deltas, "hey");
        match &agent.messages[1] {
            AgentMessage::Message(Message::Assistant(a)) => {
                assert_eq!(a.api, "openai-responses");
                assert_eq!(a.provider, "openai");
                assert_eq!(a.model, "gpt-test");
                assert_eq!(a.stop_reason, StopReason::Stop);
            }
            other => panic!("expected assistant message, got {other:?}"),
        }
        let requests = server.received_requests().await.unwrap();
        let sent: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(sent["model"], "gpt-test");
    }
}
