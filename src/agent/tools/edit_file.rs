use crate::agent::tool::{make_tool, AgentTool};
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Deserialize, JsonSchema)]
pub struct EditFileArgs {
    /// Path to the file to edit.
    pub path: String,
    /// Exact text to replace. Must appear exactly once in the file.
    pub old_string: String,
    /// Replacement text.
    pub new_string: String,
}

pub fn tool() -> AgentTool {
    make_tool(
        "edit_file",
        "Replace an exact, unique occurrence of text in a file",
        |a: EditFileArgs| {
            Box::pin(async move {
                let content =
                    std::fs::read_to_string(&a.path).map_err(|e| format!("read failed: {e}"))?;
                let count = content.matches(&a.old_string).count();
                if count == 0 {
                    return Err("old_string not found in file".into());
                }
                if count > 1 {
                    return Err(format!(
                        "old_string appears {count} times; it must be unique"
                    ));
                }
                let updated = content.replacen(&a.old_string, &a.new_string, 1);
                std::fs::write(&a.path, updated).map_err(|e| format!("write failed: {e}"))?;
                Ok(format!("edited {}", a.path))
            })
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn edit_requires_unique_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "one two two").unwrap();
        let t = tool();

        let dup = (t.execute)(serde_json::json!({
            "path": path.to_str().unwrap(), "old_string": "two", "new_string": "three"
        }))
        .await;
        assert!(dup.unwrap_err().contains("2 times"));

        let ok = (t.execute)(serde_json::json!({
            "path": path.to_str().unwrap(), "old_string": "one", "new_string": "uno"
        }))
        .await;
        assert!(ok.is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "uno two two");
    }
}
