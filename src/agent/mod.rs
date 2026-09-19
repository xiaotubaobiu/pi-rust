pub mod event;
pub mod faux;
pub mod tool;

use crate::ai::event::AiEvent;
use crate::ai::message::Message;
use crate::ai::{Context, Provider, ToolDef};
use event::AgentEvent;
use std::sync::Arc;
use tool::AgentTool;

/// Application-level message. LLM-visible messages are wrapped in
/// `Message`; everything else stays app-only and is filtered out by
/// `convert_to_llm` (mirrors upstream AgentMessage vs LLM message split).
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
    pub tools: Vec<AgentTool>,
    pub system_prompt: String,
    pub messages: Vec<AgentMessage>,
    pub max_turns: usize,
}

impl Agent {
    pub fn new(provider: Arc<dyn Provider>, tools: Vec<AgentTool>, system_prompt: String) -> Self {
        Agent { provider, tools, system_prompt, messages: Vec::new(), max_turns: 25 }
    }

    fn build_context(&self) -> Context {
        Context {
            system_prompt: self.system_prompt.clone(),
            messages: convert_to_llm(&self.messages),
            tools: self
                .tools
                .iter()
                .map(|t| ToolDef {
                    name: t.name.to_string(),
                    description: t.description.to_string(),
                    parameters: t.parameters.clone(),
                })
                .collect(),
        }
    }

    /// Run one user prompt to completion of the tool-call loop.
    pub async fn prompt(&mut self, text: &str, on_event: &mut dyn FnMut(AgentEvent)) -> anyhow::Result<()> {
        self.messages.push(AgentMessage::Message(Message::user_text(text)));
        on_event(AgentEvent::TurnStart);
        let result = self.run_turns(on_event).await;
        on_event(AgentEvent::AgentEnd);
        result
    }

    async fn run_turns(&mut self, on_event: &mut dyn FnMut(AgentEvent)) -> anyhow::Result<()> {
        for _turn in 0..self.max_turns {
            let ctx = self.build_context();
            let mut rx = self.provider.stream(&ctx);
            let mut assistant: Option<Message> = None;
            while let Some(ev) = rx.recv().await {
                match ev {
                    AiEvent::Start => {}
                    AiEvent::TextDelta { delta } => on_event(AgentEvent::AssistantDelta { delta }),
                    AiEvent::ThinkingDelta { delta } => on_event(AgentEvent::ThinkingDelta { delta }),
                    AiEvent::ToolCallEnd { .. } => {}
                    AiEvent::Done { message, .. } => assistant = Some(message),
                    AiEvent::Error { message } => {
                        on_event(AgentEvent::AgentError { message: message.clone() });
                        anyhow::bail!("stream error: {message}");
                    }
                }
            }
            let msg = assistant.ok_or_else(|| anyhow::anyhow!("stream ended without Done"))?;
            on_event(AgentEvent::MessageEnd);
            self.messages.push(AgentMessage::Message(msg.clone()));

            let calls = msg.tool_calls();
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
                on_event(AgentEvent::ToolExecutionEnd { tool_call_id: call.id.clone(), tool_name: call.name.clone(), is_error });
                self.messages.push(AgentMessage::Message(Message::tool_result(call.id, call.name, output, is_error)));
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
    use crate::ai::message::{ContentBlock, StopReason};

    fn text_done(text: &str) -> AiEvent {
        AiEvent::Done {
            stop_reason: StopReason::Stop,
            message: Message::Assistant {
                content: vec![ContentBlock::Text { text: text.to_string() }],
                stop_reason: StopReason::Stop,
                usage: Default::default(),
            },
        }
    }

    #[tokio::test]
    async fn single_turn_no_tools() {
        let faux = Arc::new(FauxProvider::new());
        faux.push_script(vec![AiEvent::Start, AiEvent::TextDelta { delta: "he".into() }, AiEvent::TextDelta { delta: "y".into() }, text_done("hey")]);
        let mut agent = Agent::new(faux.clone(), vec![], "sys".into());

        let mut events = Vec::new();
        agent.prompt("hello", &mut |ev| events.push(format!("{ev:?}"))).await.unwrap();

        assert_eq!(agent.messages.len(), 2);
        let deltas: Vec<&str> = events.iter().filter_map(|e| match e {
            s if s.starts_with("AssistantDelta") => Some(s.as_str()),
            _ => None,
        }).collect();
        assert_eq!(deltas.len(), 2);
        assert!(events.iter().any(|e| e.starts_with("AgentEnd")));

        // notification messages are filtered from LLM context
        agent.messages.push(AgentMessage::Notification { text: "ui only".into() });
        let ctx = agent.build_context();
        assert_eq!(ctx.messages.len(), 2);
        assert_eq!(ctx.system_prompt, "sys");
    }
}
