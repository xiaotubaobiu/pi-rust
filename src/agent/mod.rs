pub mod event;
pub mod faux;
pub mod session;
pub mod tool;
pub mod tools;

use crate::ai::transcript::{normalize_context, Context, TranscriptContext};
use crate::ai::types::content::{TextContent, ToolCall};
use crate::ai::types::events::AssistantMessageEvent;
use crate::ai::types::message::{
    AssistantBlock, AssistantMessage, Message, StringOrBlocks, TextOrImageBlock, ToolResultMessage,
    UserMessage,
};
use crate::ai::types::options::SimpleStreamOptions;
use crate::ai::types::tool::Tool;
use crate::ai::{now_ms, Provider, ProviderIdentity};
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
    pub provider: Arc<dyn Provider>,
    /// Fills `AssistantMessage.provider`/`model` for provider-emitted messages.
    pub identity: ProviderIdentity,
    pub tools: Vec<AgentTool>,
    pub system_prompt: String,
    pub messages: Vec<AgentMessage>,
    pub max_turns: usize,
}

impl Agent {
    pub fn new(
        provider: Arc<dyn Provider>,
        identity: ProviderIdentity,
        tools: Vec<AgentTool>,
        system_prompt: String,
    ) -> Self {
        Agent {
            provider,
            identity,
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
            let mut rx =
                self.provider
                    .stream(&transcript, &SimpleStreamOptions::default(), &self.identity);
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
    use crate::ai::types::events::{ErrorReason, SuccessReason};
    use crate::ai::types::primitives::{StopReason, Usage};

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

    fn identity() -> ProviderIdentity {
        ProviderIdentity {
            id: "faux".into(),
            model: "faux-model".into(),
        }
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
        let mut agent = Agent::new(faux.clone(), identity(), vec![], "sys".into());

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

        let echo_tool = make_tool("echo", "echo text back", |a: EchoArgs| {
            Box::pin(async move { Ok(format!("echo: {}", a.text)) })
        });
        let mut agent = Agent::new(faux.clone(), identity(), vec![echo_tool], String::new());

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

        let echo_tool = make_tool("echo", "echo text back", |a: EchoArgs| {
            Box::pin(async move { Ok(format!("echo: {}", a.text)) })
        });
        let mut agent = Agent::new(faux.clone(), identity(), vec![echo_tool], String::new());

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
        let mut agent = Agent::new(faux.clone(), identity(), vec![], String::new());

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
}
