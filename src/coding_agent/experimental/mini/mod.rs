//! Port of upstream `experimental/mini/` — the subprocess session-server
//! architecture:
//! - `shared/protocol.ts` (sha256 f0f34fbb10c01514f3bb5d6fafee93848bbcd5f392ecca194b183f66928b8869)
//! - `shared/rpc.ts` (sha256 7f85079d32670b96619adfeba914c118477a64f1f984d9c93f2b9592b1e066e2)
//! - `shared/transport.ts` (sha256 90ac3a280be3469b6911ee89339ca67b60660752076d590c08282d58e85d2bdb)
//! - `server/run.ts` (sha256 f5fed2f24494ebf7429287e8fcf9257a67eb6d6061fffc9d8af6e6f51b6b6197)
//! - `server/entry.ts` (sha256 6dc333e3fce73814da56afd2e70397d52b1bf1f49cf1e8a7122342315f3a39cc)
//! - `worker/run.ts` (sha256 fc5ae86711d55d05a7a13690139ea4380c5d29dce67dbad62e805a10fa92a324)
//! - `worker/entry.ts` (sha256 c70dc5132b9923e3486c65bfc1c8bf0eeda991137cfad8677745d30a92d58a31)
//! - `worker/lane-service.ts` (sha256 fd528140bbd0af1a96f2a81d0a8b0347fae902b247568e24a1bd15a568d4d264)
//! - `worker/models-service.ts` (sha256 a9757453fd7a45425adc316c1b9c71305ba40248ead2250c7b2b1fde4cd6d095)
//! - `tui/session.ts` (sha256 72995da0986ce0074279b58cd134b19c203eb60a68c332855134e4e5644d4350)
//! - `tui/view.ts` (sha256 9467789d00830b0f198dc1b08d7474c0e66ca3cdd13525e5871783b2f9dd1a42)
//! - `tui/run.ts` (sha256 d4813570a77f540348162b33839d486c0895cb9c4e9b60d43ed42b883e4ae500)
//! - `main.ts` (sha256 18d6a400c706ef80a1f9b836ea2f2246a6b6fa08036720ebb0770e7f4011bfba)
//!
//! Ported: the JSON-RPC frame shapes and key order (`call`/`result`/`error`/
//! `cancel`/`event`/`announce`/`ping`), the dispatch routing rules with
//! exact error strings ("No service provides <method>", "Unknown method:
//! <method>"), the `undefined`->`null` result coalescing, cancel-abort
//! semantics, the callWith timeout/cancel contract with exact messages,
//! the newline JSON framing buffer algorithm, the server's attach
//! bookkeeping (one worker per session, subscriber moves, last-subscriber
//! stop, idle retire decision), the forward rule with the exact
//! "No host provides <service>: server has [...], worker has [...]" text,
//! the worker's system prompt and open-session errors, the lane command
//! mapping, the models service state/error shapes, the presentation's
//! snapshot fold/rebase flow and queue/footer text, and every argument
//! parser.
//!
//! D18 seam (disclosed in this module's docs): the live Node transports (unix socket
//! listener, spawned worker stdio), the pico3/`AgentHarness` lane and model
//! runtime, `reduceLaneSnapshot`, the auth prompt transport and all draw
//! components are embedder-owned; the port exposes the wire codec, the
//! routing/decision logic and the view data model over the [`Connection`]
//! trait.

pub mod lane_service;
pub mod main;
pub mod models_service;
pub mod protocol;
pub mod rpc;
pub mod server_run;
pub mod transport;
pub mod tui_run;
pub mod tui_session;
pub mod tui_view;
pub mod worker_run;

#[cfg(test)]
mod tests;
