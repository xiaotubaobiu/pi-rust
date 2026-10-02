// Oracle stub for packages/coding-agent/src/config.ts: bug-report.ts reads
// only `VERSION` from it, and the full config.ts closure is far outside this
// module's surface. The placeholder is substituted with the port's crate
// version before the Rust-side byte comparison (the release pipeline keeps
// the crate version authoritative, like crash-log's `version` field).
export const VERSION = "ORACLE-VERSION";
