//! Port of `packages/agent/src/harness/pico3/` — the harness-v3 chord-
//! transactional storage engine (M3b Task 8, amended): the strict-JSON record
//! and document vocabulary ([`types`]), the revocable document membrane
//! ([`membrane`]), the model-context projection ([`context`]), the in-memory
//! reference backend ([`memory`]), the durable JSONL backend ([`jsonl`]), the
//! line-serialized Session with capability-checked transactions ([`session`]),
//! the commit-granular conversation view ([`view`]), and the chord-glue pure
//! subset ([`chord`]).
//!
//! Extra upstream files ported here as dependencies of `session.ts`, which
//! imports them directly: `pico3/membrane.ts` and `pico3/context.ts`
//! (`deriveContext`). Both are small and have no other consumers in scope.
//!
//! # Task-8 scope (disclosed)
//!
//! The amended brief lands the pico3 core: types, session, jsonl, memory,
//! chord glue, view. The remaining pico3 files upstream are Task 9/10
//! material and are NOT ported here: `harness.ts` (812), `scheduler.ts`
//! (486), `system.ts` (376), `kinds/*` (the built-in turn kinds),
//! `bounded.ts`, `bash.ts`, `hooks.ts`, and `index.ts` (a re-export barrel).
//! The kind-execution surface of the erased kind ([`types::AnyKind`]'s
//! `initial`/`phases`/`abort` handlers and [`types::Runtime`],
//! [`types::Models`], [`types::ToolDeclaration`], [`types::ProcessHost`],
//! hook bindings) lands with the scheduler/harness task; this module carries
//! exactly the metadata surface the storage engine reads (`name`, `turn`,
//! `config`, `slot`, `describe`, `inflight`).
//!
//! # Disclosed substitutions (module docs carry the per-item notes)
//!
//! - Numeric ids: upstream `Id`/`Seq` are JS numbers; the port uses `i64`
//!   ([`types::Id`], [`types::Seq`]) — all upstream ids are safe integers.
//! - Documents are strict JSON objects ([`crate::agent_core::JsonValue`]);
//!   the "typed" document shapes (`RewindableState`, `StickyState`,
//!   `SessionState`, `ToolSlot`, ...) are accessed through typed accessor
//!   helpers over the same JSON trees, preserving the upstream wire format
//!   and the `[key: string]: JsonValue` open-index behavior.
//! - Upstream hands transactions out as JS `Proxy` capability surfaces
//!   (`callbackSurface()`) and wraps documents in a revocable [`membrane::Membrane`].
//!   Rust has no proxies: capability separation is API visibility (the
//!   callback receives `&mut Tx`; core-only operations are `pub(crate)`),
//!   handle revocation is the explicit liveness flag checked by every
//!   document access, and "a handle cannot outlive its transaction" is the
//!   borrow checker. See [`membrane`] module docs.
//! - Upstream serializes operations on an async promise tail (`Session#enter`)
//!   with reentrancy detection through a context value; the port uses a
//!   tokio mutex for the tail plus the same context-value check
//!   ([`session::NestedLineOperation`]).
//! - `Session::commit` takes the invoker explicitly ([`types::Invoker`]);
//!   upstream's tests reach it through `Harness` conversation handles, whose
//!   commit is a thin host-invoker wrapper. The oracle tests ported here
//!   drive `Session` directly with host/kernel/task invokers and stub kinds —
//!   the same objects upstream's scheduler would construct (disclosed in the
//!   test module docs).

pub mod chord;
pub mod context;
pub mod jsonl;
pub mod membrane;
pub mod memory;
pub mod session;
pub mod types;
pub mod view;

#[cfg(test)]
mod tests;

pub use chord::*;
pub use context::*;
pub use jsonl::*;
pub use membrane::*;
pub use memory::*;
pub use session::*;
pub use types::*;
pub use view::*;
