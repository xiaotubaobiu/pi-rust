//! Tool declarations from upstream `packages/ai/src/types.ts:593-602`. M2a
//! skeleton: only what `SystemMessage.toolsAdded`/`toolsRemoved` (message.rs)
//! needs. The stream-options task extends the constrained-sampling placeholder
//! into the tagged union.

use serde::{Deserialize, Serialize};

/// Upstream `Tool` (types.ts:593-598): a tool declaration sent to providers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// JSON Schema object describing the tool parameters (upstream TypeBox
    /// `TSchema`).
    pub parameters: serde_json::Value,
    /// Upstream `constrainedSampling?: false | ConstrainedSamplingConfig`
    /// (types.ts:597). Raw JSON placeholder for M2a; the stream-options task
    /// replaces it with the typed `false | json_schema | grammar` union.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constrained_sampling: Option<serde_json::Value>,
}

/// Upstream `ToolReference` (types.ts:600-602): minimal name-only identifier
/// used by `SystemMessage.toolsRemoved`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolReference {
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_round_trips_without_constrained_sampling() {
        let fixture = r#"{"name":"bash","description":"Run a shell command","parameters":{"properties":{"command":{"type":"string"}},"type":"object"}}"#;
        let tool: Tool = serde_json::from_str(fixture).unwrap();
        assert_eq!(tool.name, "bash");
        assert_eq!(tool.description, "Run a shell command");
        assert_eq!(tool.constrained_sampling, None);
        assert_eq!(serde_json::to_string(&tool).unwrap(), fixture);
    }

    #[test]
    fn tool_constrained_sampling_false_round_trips() {
        let fixture = r#"{"name":"bash","description":"Run a shell command","parameters":{"type":"object"},"constrainedSampling":false}"#;
        let tool: Tool = serde_json::from_str(fixture).unwrap();
        assert_eq!(tool.constrained_sampling, Some(serde_json::json!(false)));
        assert_eq!(serde_json::to_string(&tool).unwrap(), fixture);
    }

    #[test]
    fn tool_reference_round_trips() {
        let fixture = r#"{"name":"weather"}"#;
        let reference: ToolReference = serde_json::from_str(fixture).unwrap();
        assert_eq!(reference.name, "weather");
        assert_eq!(serde_json::to_string(&reference).unwrap(), fixture);
    }
}
