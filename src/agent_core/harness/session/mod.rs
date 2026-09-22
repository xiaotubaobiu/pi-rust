//! Partial port of `packages/agent/src/harness/session/` (M3b Task 5): the
//! entry vocabulary ([`types`]) and the context builders ([`context`]) the
//! compaction module consumes. The remaining session surface — the storage
//! envelope (`pico3/session.ts`), jsonl, memory, branches/sessions — lands
//! with the pico3 tasks (M3b Tasks 7-9), which will grow this module.

pub mod context;
pub mod types;

pub use context::*;
pub use types::*;
