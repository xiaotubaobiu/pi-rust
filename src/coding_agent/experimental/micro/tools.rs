//! Port of upstream `micro/tools.ts`: the execution-tool adaptation table
//! (declaration order, replay classes, output policies, constrained-sampling
//! metadata) and the progress-flush timing rule. The tool implementations
//! themselves are the harness tool face, embedder-owned (D17).

use super::models::ModelToolMetadata;
use std::collections::HashMap;

/// Upstream `ToolDeclaration.output` policies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputPolicy {
    pub max_bytes: usize,
    pub max_lines: usize,
    pub retain: Retain,
}

/// Upstream `retain: "head" | "tail"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retain {
    Head,
    Tail,
}

/// Upstream `adaptTool` declaration face.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolDeclaration {
    pub name: &'static str,
    pub replay: Replay,
    pub output: OutputPolicy,
}

/// Upstream `replay: "safe" | "unsafe"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replay {
    Safe,
    Unsafe,
}

/// Upstream `createMicroTools`: the four execution tools in source order
/// (read, bash, edit, write) with upstream's exact policies.
pub fn micro_tool_declarations() -> Vec<ToolDeclaration> {
    vec![
        ToolDeclaration {
            name: "read",
            replay: Replay::Safe,
            output: OutputPolicy {
                max_bytes: 128 * 1024,
                max_lines: 2500,
                retain: Retain::Head,
            },
        },
        ToolDeclaration {
            name: "bash",
            replay: Replay::Unsafe,
            output: OutputPolicy {
                max_bytes: 128 * 1024,
                max_lines: 2500,
                retain: Retain::Tail,
            },
        },
        ToolDeclaration {
            name: "edit",
            replay: Replay::Unsafe,
            output: OutputPolicy {
                max_bytes: 128 * 1024,
                max_lines: 2500,
                retain: Retain::Head,
            },
        },
        ToolDeclaration {
            name: "write",
            replay: Replay::Unsafe,
            output: OutputPolicy {
                max_bytes: 128 * 1024,
                max_lines: 2500,
                retain: Retain::Head,
            },
        },
    ]
}

/// Upstream `modelMetadata`: one `constrainedSampling` entry per source tool
/// (the embedder supplies each tool's constrained-sampling config; the port
/// records the shape).
pub fn micro_tool_metadata(
    per_tool: impl Fn(&str) -> Option<bool>,
) -> HashMap<String, ModelToolMetadata> {
    micro_tool_declarations()
        .iter()
        .map(|declaration| {
            (
                declaration.name.to_string(),
                ModelToolMetadata {
                    constrained_sampling: per_tool(declaration.name),
                },
            )
        })
        .collect()
}

/// Upstream `selectedTools`: the declaration name list the harness config
/// pins.
pub fn selected_tool_names() -> Vec<String> {
    micro_tool_declarations()
        .iter()
        .map(|declaration| declaration.name.to_string())
        .collect()
}

/// Upstream `flushProgress` timing: a progress flush fires on a checkpoint
/// or at a >=100ms cadence (`Date.now() - lastProgressAt >= 100`).
pub const PROGRESS_FLUSH_INTERVAL_MS: u64 = 100;

/// Upstream `flushProgress` decision.
pub fn should_flush_progress(checkpoint: bool, last_progress_at_ms: u64, now_ms: u64) -> bool {
    checkpoint || now_ms.saturating_sub(last_progress_at_ms) >= PROGRESS_FLUSH_INTERVAL_MS
}

/// Upstream error-result content face: a failed invocation returns a single
/// text block with the error message and `isError: true` (abort rethrows).
pub fn failure_result_text(message: &str) -> String {
    message.to_string()
}

/// Upstream terminate-control face: `result.terminate` becomes
/// `control: { terminate: true }`.
pub fn terminate_control(terminated: bool) -> Option<bool> {
    terminated.then_some(true)
}
