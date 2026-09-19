use crate::agent::AgentMessage;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Append-only JSONL transcript: one AgentMessage per line.
pub struct SessionWriter {
    file: std::fs::File,
    path: PathBuf,
}

impl SessionWriter {
    pub fn create(dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        let path = dir.join(format!("session-{ts}.jsonl"));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        Ok(SessionWriter { file, path })
    }

    pub fn append(&mut self, message: &AgentMessage) -> anyhow::Result<()> {
        let line = serde_json::to_string(message)?;
        writeln!(self.file, "{line}")?;
        self.file.flush()?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::message::Message;

    #[test]
    fn appends_parsable_lines() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = SessionWriter::create(dir.path()).unwrap();
        s.append(&AgentMessage::Message(Message::user_text("hello")))
            .unwrap();
        s.append(&AgentMessage::Notification { text: "ui".into() })
            .unwrap();

        let content = std::fs::read_to_string(s.path()).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        match serde_json::from_str::<AgentMessage>(lines[0]).unwrap() {
            AgentMessage::Message(m) => assert_eq!(m.text(), "hello"),
            other => panic!("expected message line, got {other:?}"),
        }
        match serde_json::from_str::<AgentMessage>(lines[1]).unwrap() {
            AgentMessage::Notification { text } => assert_eq!(text, "ui"),
            other => panic!("expected notification line, got {other:?}"),
        }
    }
}
