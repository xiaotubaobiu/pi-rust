//! Port of upstream `packages/agent` (the `@earendil-works/pi-agent-core`
//! package): stateful agent with tool execution and event streaming.
//!
//! M3a Task 1 ports the shared type surface from
//! `packages/agent/src/types.ts` ([`types`]); M3a Task 2 ports the agent loop
//! core turns ([`agent_loop`]) — prompt list, per-turn context build,
//! streaming, tool execution, and toolResult messages. This module is a
//! sibling of `ai`, not a child: the ai layer is upstream
//! `@earendil-works/pi-ai`.

pub mod agent_loop;
pub mod types;

pub use agent_loop::*;
pub use types::*;
