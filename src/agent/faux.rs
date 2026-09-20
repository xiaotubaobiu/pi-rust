use crate::ai::api::ApiImpl;
use crate::ai::types::events::AssistantMessageEvent;
use crate::ai::types::options::{SimpleStreamOptions, StreamOptions};
use crate::ai::{Model, ProviderConfig, TranscriptContext};
use std::collections::VecDeque;
use std::sync::Mutex;
use tokio::sync::mpsc;

/// Scripted provider for tests, mirroring upstream fauxProvider:
/// each stream call dequeues the next script in push order (FIFO).
/// The endpoint config, model, and options are ignored — scripts carry
/// fully-formed events, so tests pin exact message metadata themselves.
pub struct FauxProvider {
    scripts: Mutex<VecDeque<Vec<AssistantMessageEvent>>>,
}

impl FauxProvider {
    pub fn new() -> Self {
        FauxProvider {
            scripts: Mutex::new(VecDeque::new()),
        }
    }

    pub fn push_script(&self, script: Vec<AssistantMessageEvent>) {
        self.scripts.lock().unwrap().push_back(script);
    }
}

impl Default for FauxProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl ApiImpl for FauxProvider {
    fn stream(
        &self,
        cfg: &ProviderConfig,
        model: &Model,
        ctx: &TranscriptContext,
        _options: &StreamOptions,
    ) -> mpsc::Receiver<AssistantMessageEvent> {
        self.stream_simple(cfg, model, ctx, &SimpleStreamOptions::default())
    }

    fn stream_simple(
        &self,
        _cfg: &ProviderConfig,
        _model: &Model,
        _ctx: &TranscriptContext,
        _options: &SimpleStreamOptions,
    ) -> mpsc::Receiver<AssistantMessageEvent> {
        let (tx, rx) = mpsc::channel(64);
        let script = self.scripts.lock().unwrap().pop_front().unwrap_or_default();
        tokio::spawn(async move {
            for ev in script {
                let _ = tx.send(ev).await;
            }
        });
        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::types::message::{AssistantBlock, AssistantMessage};
    use crate::ai::types::primitives::{StopReason, Usage};
    use crate::ai::types::{ModelCost, ModelInput, TextContent};
    use std::sync::Arc;

    const TS: i64 = 1758240000000;

    fn model() -> Model {
        Model {
            id: "faux-model".to_string(),
            name: "Faux Model".to_string(),
            api: "faux-api".to_string(),
            provider: "faux".to_string(),
            base_url: "https://faux.invalid".to_string(),
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

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            base_url: "https://faux.invalid".to_string(),
            api_key: "k".to_string(),
            max_tokens: 8192,
        }
    }

    fn scripted_message(stop_reason: StopReason, text: &str) -> AssistantMessage {
        AssistantMessage {
            content: if text.is_empty() {
                vec![]
            } else {
                vec![AssistantBlock::Text(TextContent {
                    text: text.into(),
                    text_signature: None,
                })]
            },
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

    fn start_done(text: &str) -> Vec<AssistantMessageEvent> {
        vec![
            AssistantMessageEvent::Start {
                message: scripted_message(StopReason::Pending, ""),
            },
            AssistantMessageEvent::Done {
                reason: crate::ai::types::events::SuccessReason::Stop,
                message: scripted_message(StopReason::Stop, text),
            },
        ]
    }

    async fn drain(rx: mpsc::Receiver<AssistantMessageEvent>) -> Vec<AssistantMessageEvent> {
        let mut rx = rx;
        let mut out = Vec::new();
        while let Some(ev) = rx.recv().await {
            out.push(ev);
        }
        out
    }

    fn event_names(events: &[AssistantMessageEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|ev| match ev {
                AssistantMessageEvent::Start { .. } => "start",
                AssistantMessageEvent::Done { .. } => "done",
                _ => "other",
            })
            .collect()
    }

    fn done_text(events: &[AssistantMessageEvent]) -> String {
        match events.last().unwrap() {
            AssistantMessageEvent::Done { message, .. } => match &message.content[0] {
                AssistantBlock::Text(text) => text.text.clone(),
                other => panic!("unexpected block {other:?}"),
            },
            other => panic!("expected Done, got {other:?}"),
        }
    }

    /// FauxProvider must be usable as `Arc<dyn ApiImpl>` (the Agent field
    /// type) and `stream_simple` replays the pushed script verbatim.
    #[tokio::test]
    async fn stream_simple_replays_script_as_dyn_api_impl() {
        let faux = Arc::new(FauxProvider::new());
        faux.push_script(start_done("hey"));
        let api: Arc<dyn ApiImpl> = faux;
        let options = SimpleStreamOptions::default();
        let events =
            drain(api.stream_simple(&cfg(), &model(), &TranscriptContext::default(), &options))
                .await;
        assert_eq!(event_names(&events), ["start", "done"]);
        assert_eq!(done_text(&events), "hey");
    }

    /// `stream` delegates to `stream_simple` (upstream fauxProvider has one
    /// script queue): both entry points draw from the same FIFO, in order.
    #[tokio::test]
    async fn stream_delegates_to_stream_simple_shared_fifo() {
        let faux = Arc::new(FauxProvider::new());
        faux.push_script(start_done("first"));
        faux.push_script(start_done("second"));
        let api: Arc<dyn ApiImpl> = faux;

        let options = StreamOptions::default();
        let first =
            drain(api.stream(&cfg(), &model(), &TranscriptContext::default(), &options)).await;
        let options = SimpleStreamOptions::default();
        let second =
            drain(api.stream_simple(&cfg(), &model(), &TranscriptContext::default(), &options))
                .await;

        assert_eq!(done_text(&first), "first");
        assert_eq!(done_text(&second), "second");
    }
}
