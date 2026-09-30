//! # chord — standalone application-composition runtime. Port of
//! `pi/packages/chord` (M6).
//!
//! Upstream sha256 registrations (source of truth for this slice):
//!
//! | Upstream file | sha256 |
//! | --- | --- |
//! | `src/delta/index.ts` | `b026dde11b1b28c696a9a23b4fc8a4b8a1eff5059f89616b50650e3e3e06c797` |
//! | `src/json.ts` | `d94a2f33d6c83fc022580466700d34cd1bca21003d567522f58b38902e1806fa` |
//! | `src/types.ts` | `885283da0e2a60274e3bdfcd503ca15bd66a8a485e0963816684c1ab3586e2be` |
//! | `src/api.ts` | `769a04a5f903bb53cc5b66e7353c69b02f12159d82f196a7894ceea5800ac201` |
//! | `src/context/index.ts` | `0f0925a896cf1e506d9495d929157347639e90da343bf28d7472ea645897e7d3` |
//! | `src/services/provider.ts` | `fe810eaa1eb8418025b2dd0d16bb049c8641fd1b864fbd31c8f8de031c563fcc` |
//! | `src/services/wire.ts` | `84ec6e3362ae3c5239b27b63be8e8377e1cf45c97088bb8d628c5e55458614b8` |
//! | `src/services/state.ts` | `4605021d763b5b82b99ebab783769640e61b19fb8f64082953b3d0c1be717319` |
//! | `src/services/state-codec.ts` | `4bebb2ffc7ed0ffd62933460d5a4a5733e3d7647294476c475cb9431f121f904` |
//! | `src/services/errors.ts` | `487e73b60a1c69dd132cf6f4c4ec625e346b5cecc1cb890da25a5199a43798a8` |
//!
//! ## Slice boundary (M6 chord slice)
//!
//! Ported here with oracle byte-comparison against the upstream sources run
//! under `node --experimental-strip-types`:
//!
//! - [`delta`] — the full `delta/index.ts`: ops, validators, `apply` /
//!   `applyImmutable`, the write-time tracker log (coalescing, folding,
//!   collapse-to-base), the path-interning wire codec, and the diff engine.
//! - [`json`] — `isJsonValue` (depth bound; the other JS-only guards are
//!   unrepresentable over owned JSON trees).
//! - [`types`] — the service value shapes (snapshots, updates, calls).
//! - [`services`] — provider, endpoint, replicated state (mutable + replica),
//!   wire protocol parsing, per-subscription state codecs, error taxonomy.
//! - [`api`] — `defineService` / `replicatedState` constructors.
//! - [`context`] — forwards to the already-ported
//!   `agent_core::chord_support::context` (kept compatible; not deleted).
//!
//! Formerly deferred seams, closed by the consumer-side slice (S1/S2/S3):
//!
//! - **S1 (consumer binding)**, now [`consumer`]/[`handle`]/[`instances`]:
//!   `services/consumer.ts`, `handle.ts`, `instances.ts`,
//!   `loopback.ts`, and the transport surface
//!   (`RemoteServiceTransport`/`RemoteServices`). The upstream async
//!   lifecycle state machine is flattened to the synchronous closure
//!   convention (divergence D2); readiness revisions and rebind
//!   transitions are preserved.
//! - **S2 (facets)**, now [`facets`]: `facets/host.ts`,
//!   `facets/loader.ts`, and `api.ts`'s host/loader constructors
//!   (`create_facet_host`, `create_static_facet_loader`,
//!   `combine_facet_loaders`, plus `create_remote_service_binding`).
//! - **S3 (node/bundler)**, now [`node`]/[`bundler`]: the deterministic
//!   manifest/artifact/package-metadata surface. The esbuild compile pass
//!   and the node:vm CommonJS evaluation are platform seams (divergences
//!   D7/D9), disclosed in the child module docs.
//!
//! ## Canonical serialization note (disclosed divergence D1)
//!
//! Upstream JS objects iterate in insertion order; `serde_json`'s default map
//! sorts keys (BTreeMap). The oracle comparison therefore canonicalizes both
//! sides with recursively sorted object keys (see `tests/fixtures/chord_oracle/`),
//! and oracle scenarios build multi-key objects in sorted key order so
//! diff/iteration orders coincide. Value-level semantics are unaffected:
//! upstream's own contract states object key order is not replicated
//! (`delta/README.md` "Limits").
//!
//! The [`agent_core::chord_support`] subset (context + a diff-at-flush delta
//! tracker) predates this module and stays untouched; `chord_support` can
//! later re-export [`delta`] as its full-fidelity replacement.

pub mod api;
pub mod bundler;
pub mod consumer;
pub mod context;
pub mod delta;
pub mod facets;
pub mod handle;
pub mod instances;
pub mod json;
pub mod node;
pub mod services;
pub mod types;

/// Upstream `JsonValue` (`packages/chord/src/types.ts:21`).
pub use types::JsonValue;
