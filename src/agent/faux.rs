use crate::ai::event::AiEvent;
use crate::ai::{Context, Provider};
use std::collections::VecDeque;
use std::sync::Mutex;
use tokio::sync::mpsc;

/// Scripted provider for tests, mirroring upstream fauxProvider:
/// each stream() call dequeues the next script in push order (FIFO).
pub struct FauxProvider {
    scripts: Mutex<VecDeque<Vec<AiEvent>>>,
}

impl FauxProvider {
    pub fn new() -> Self {
        FauxProvider { scripts: Mutex::new(VecDeque::new()) }
    }

    pub fn push_script(&self, script: Vec<AiEvent>) {
        self.scripts.lock().unwrap().push_back(script);
    }
}

impl Provider for FauxProvider {
    fn stream(&self, _ctx: &Context) -> mpsc::Receiver<AiEvent> {
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
