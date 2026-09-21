use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use std::future::Future;
use std::pin::Pin;

pub type BoxToolFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
pub type ToolFn = dyn Fn(serde_json::Value) -> BoxToolFuture + Send + Sync;

/// An executable tool: declaration (sent to the LLM) + executor.
#[derive(Clone)]
pub struct AgentTool {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: serde_json::Value,
    pub execute: std::sync::Arc<ToolFn>,
}

/// Build an AgentTool from a typed args struct. The struct's JSON Schema
/// (schemars) is sent to the LLM; incoming arguments are validated by
/// deserialization (mirrors upstream validateToolCall).
pub fn make_tool<T, F>(name: &'static str, description: &'static str, execute: F) -> AgentTool
where
    T: DeserializeOwned + JsonSchema + Send + 'static,
    F: Fn(T) -> BoxToolFuture + Send + Sync + 'static,
{
    AgentTool {
        name,
        description,
        parameters: serde_json::to_value(schemars::schema_for!(T)).expect("schema serializes"),
        execute: std::sync::Arc::new(move |value| match serde_json::from_value::<T>(value) {
            Ok(args) => execute(args),
            Err(e) => Box::pin(async move { Err(format!("invalid arguments: {e}")) }),
        }),
    }
}
