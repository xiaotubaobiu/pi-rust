use crate::agent::tool::{make_tool, AgentTool};
use schemars::JsonSchema;
use serde::Deserialize;
use std::process::Stdio;
use std::time::Duration;

fn default_timeout_ms() -> u64 {
    30_000
}

#[derive(Deserialize, JsonSchema)]
pub struct BashArgs {
    /// Shell command to run.
    pub command: String,
    /// Kill the command after this many milliseconds. Default 30000.
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

pub fn tool() -> AgentTool {
    make_tool(
        "bash",
        "Run a shell command and return its combined stdout and stderr",
        |a: BashArgs| {
            Box::pin(async move {
                let mut cmd = if cfg!(windows) {
                    let mut c = tokio::process::Command::new("cmd");
                    c.arg("/C").arg(&a.command);
                    c
                } else {
                    let mut c = tokio::process::Command::new("sh");
                    c.arg("-c").arg(&a.command);
                    c
                };
                cmd.stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);

                let child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
                let output = match tokio::time::timeout(
                    Duration::from_millis(a.timeout_ms),
                    child.wait_with_output(),
                )
                .await
                {
                    Ok(Ok(o)) => o,
                    Ok(Err(e)) => return Err(format!("command failed: {e}")),
                    Err(_) => return Err(format!("command timed out after {} ms", a.timeout_ms)),
                };

                let mut out = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr);
                if !stderr.is_empty() {
                    if !out.is_empty() && !out.ends_with('\n') {
                        out.push('\n');
                    }
                    out.push_str(&stderr);
                }
                if out.len() > 10_000 {
                    out.truncate(10_000);
                    out.push_str("\n... (truncated)");
                }
                if !output.status.success() {
                    return Ok(format!(
                        "exit code: {}\n{out}",
                        output.status.code().unwrap_or(-1)
                    ));
                }
                Ok(out)
            })
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    const ECHO: &str = "echo pirs_test_ok";
    #[cfg(not(windows))]
    const ECHO: &str = "echo pirs_test_ok";

    #[tokio::test]
    async fn runs_command() {
        let t = tool();
        let out = (t.execute)(serde_json::json!({"command": ECHO}))
            .await
            .unwrap();
        assert!(out.contains("pirs_test_ok"), "got: {out}");
    }

    #[tokio::test]
    async fn timeout_kills() {
        let t = tool();
        #[cfg(windows)]
        let slow = "ping -n 10 127.0.0.1 >nul";
        #[cfg(not(windows))]
        let slow = "sleep 10";
        let err = (t.execute)(serde_json::json!({"command": slow, "timeout_ms": 300})).await;
        assert!(err.unwrap_err().contains("timed out"));
    }
}
