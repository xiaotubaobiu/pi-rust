use crate::agent::event::AgentEvent;

/// Pure formatting helpers; the REPL prints their results.
pub fn tool_start_line(tool_name: &str, arguments: &serde_json::Value) -> String {
    format!("[tool] {tool_name}({arguments})")
}

pub fn tool_end_line(tool_name: &str, is_error: bool, output: &str) -> String {
    let first_line = output.lines().next().unwrap_or("").to_string();
    let tag = if is_error { "error" } else { "ok" };
    format!("[{tag}] {tool_name}: {first_line}")
}

/// Print one agent event to stdout. Returns nothing; deltas print inline.
pub fn render_event(ev: &AgentEvent) {
    match ev {
        AgentEvent::TurnStart => {}
        AgentEvent::AssistantDelta { delta } => {
            use std::io::Write;
            print!("{delta}");
            let _ = std::io::stdout().flush();
        }
        AgentEvent::ThinkingDelta { .. } => {}
        AgentEvent::MessageEnd => println!(),
        AgentEvent::ToolExecutionStart {
            tool_name,
            arguments,
            ..
        } => {
            println!("{}", tool_start_line(tool_name, arguments));
        }
        AgentEvent::ToolExecutionEnd {
            tool_name,
            is_error,
            ..
        } => {
            // preview line only; the full result text lives in the conversation context
            println!("{}", tool_end_line(tool_name, *is_error, ""));
        }
        AgentEvent::TurnEnd => {}
        AgentEvent::AgentEnd => {}
        AgentEvent::AgentError { message } => println!("[error] {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_tool_lines() {
        let start = tool_start_line("bash", &serde_json::json!({"command": "ls"}));
        assert_eq!(start, r#"[tool] bash({"command":"ls"})"#);

        let end = tool_end_line("bash", false, "file1\nfile2");
        assert_eq!(end, "[ok] bash: file1");

        let err = tool_end_line("bash", true, "boom\nmore");
        assert_eq!(err, "[error] bash: boom");

        let empty = tool_end_line("bash", false, "");
        assert_eq!(empty, "[ok] bash: ");
    }
}
