pub mod agent_core;
pub mod ai;
// M6 chord slice: port of `pi/packages/chord`.
pub mod chord;
pub mod cli;
// M6 client slice: port of `pi/packages/client`.
pub mod client;
pub mod coding_agent;
pub mod config;
// M6 evals slice: port of `pi/packages/evals`.
pub mod evals;
// M6 first slice: port of `pi/packages/protocol` (server/client/evals leaf).
pub mod protocol;
// M6 server slice: port of `pi/packages/server`.
pub mod server;
pub mod tui;

pub(crate) mod serde_support;
