use crate::agent::event::AgentEvent;
use crate::agent::session::SessionWriter;
use crate::agent::Agent;
use anyhow::Result;
use rustyline::error::ReadlineError;
use rustyline::DefaultEditor;

pub const SYSTEM_PROMPT: &str = "\
You are a coding agent working in the user's current directory. \
Use the provided tools to read and edit files and run commands. \
Be concise.";

pub async fn run(agent: &mut Agent, session: &mut SessionWriter, model_label: &str) -> Result<()> {
    let mut rl = DefaultEditor::new()?;
    println!("pirs ready. model: {model_label}. commands: /clear /model /quit");
    loop {
        let line = match rl.readline("» ") {
            Ok(line) => line,
            Err(ReadlineError::Interrupted) | Err(ReadlineError::Eof) => break,
            Err(e) => return Err(e.into()),
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let _ = rl.add_history_entry(&line);

        match line.as_str() {
            "/quit" | "/exit" => break,
            "/clear" => {
                agent.messages.clear();
                println!("context cleared");
                continue;
            }
            "/model" => {
                println!("{model_label}");
                continue;
            }
            cmd if cmd.starts_with('/') => {
                println!("unknown command: {cmd}");
                continue;
            }
            text => {
                let start = agent.messages.len();
                let result = agent.prompt(text, &mut |ev: AgentEvent| {
                    crate::cli::render::render_event(&ev);
                }).await;
                if let Err(e) = result {
                    println!("[error] {e}");
                }
                for m in &agent.messages[start..] {
                    session.append(m)?;
                }
            }
        }
    }
    println!("bye");
    Ok(())
}
