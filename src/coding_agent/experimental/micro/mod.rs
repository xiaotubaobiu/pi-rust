//! Port of upstream `experimental/micro/` — the pico3-backed micro
//! presentation:
//! - `api.ts` (sha256 3f0ea3b127ae3fb6602c8728fe1ffb0cf2738eb7b02b8302705caabb00452621)
//! - `main.ts` (sha256 b38e844f64b0082541d949cb331c7ed3c1d0426c940ab7cdf0e4dc3dff263dc1)
//! - `models.ts` (sha256 7bd6a3c3770112582ee5be032355e8ea7de03532f2b2b200b9dd5386b0e5fc88)
//! - `runtime.ts` (sha256 0e77b46306e73967fef27600ff3f3e340025824d9e8d526c50e98c9577b0c729)
//! - `sessions.ts` (sha256 0d3a548b56b6b94f5b1377ce0b2c44168478a32a966d71fedeca61641403f3be)
//! - `tools.ts` (sha256 78394a8b0afc5eb31a9317ad8a484d2076f7674047a65f30190d02fc2b8a4ca1)
//! - `tui.ts` (sha256 5163bf2fec900bd70a0034900a63f81781440f2a07df5d4f56dc0acb709a8bc6)
//!
//! Ported: the `MicroView`/controller data model, the usage accumulator and
//! view math (byte-equal floats), the notice/fault folding rules, the
//! thinking-level cycling, the `toAiContext` request grouping, the
//! `readModelsView` catalog/account construction and ordering, the
//! micro-session path scheme (sha256 cwd key, 13-digit-ms + uuid directory,
//! newest-session regex), the tool declaration adaptation table (names,
//! replay classes, output policies, constrained-sampling metadata), the TUI
//! status/footer/queue/notice text state machines, the model-selector
//! current-first ordering, and the `--continue` argument parser.
//!
//! D17 seam (disclosed in this module's docs): the pico3 `Harness`/`JsonlStorage`/`Watch`
//! runtime, `ModelRuntime`, `proper-lockfile` session locking, the login
//! prompt transport and every draw component are embedder-owned; the port
//! exposes the deterministic decisions and transforms with the same
//! parameters upstream passes.

pub mod api;
pub mod main;
pub mod models;
pub mod runtime;
pub mod sessions;
pub mod tools;
pub mod tui;

#[cfg(test)]
mod tests;
