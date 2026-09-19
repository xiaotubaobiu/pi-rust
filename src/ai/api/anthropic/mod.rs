//! Anthropic Messages API (upstream `packages/ai/src/api/anthropic-messages.ts`).
//! This M2b stage ports the pure request assembly — message conversion with
//! full-fidelity thinking replay, tools, thinking/effort configs, caching, and
//! headers ([`request`]); the streaming implementation lands with the
//! remaining M2b tasks.

pub mod request;

pub use request::{build_request, options_from_simple, AnthropicOptions, RequestAssembly};
