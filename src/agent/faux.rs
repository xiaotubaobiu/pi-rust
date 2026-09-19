use crate::ai::types::events::AssistantMessageEvent;
use crate::ai::types::options::SimpleStreamOptions;
use crate::ai::{Provider, ProviderIdentity, TranscriptContext};
use std::collections::VecDeque;
use std::sync::Mutex;
use tokio::sync::mpsc;

/// Scripted provider for tests, mirroring upstream fauxProvider:
/// each stream() call dequeues the next script in push order (FIFO).
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

impl Provider for FauxProvider {
    fn stream(
        &self,
        _ctx: &TranscriptContext,
        _options: &SimpleStreamOptions,
        _provider: &ProviderIdentity,
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
