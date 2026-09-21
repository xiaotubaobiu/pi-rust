//! Port of upstream `packages/agent` (the `@earendil-works/pi-agent-core`
//! package): stateful agent with tool execution and event streaming.
//!
//! M3a Task 1 ports the shared type surface from
//! `packages/agent/src/types.ts` ([`types`]); the agent loop and `Agent`
//! land in later M3a tasks. This module is a sibling of `ai`, not a child:
//! the ai layer is upstream `@earendil-works/pi-ai`.

pub mod types;

pub use types::*;
