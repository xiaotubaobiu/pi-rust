# Harness execution tools checkpoint

Verified: 2026-09-23 22:17 +09:00, upstream 590144609.

## Implemented surface
- New `src/agent_core/harness/tools/`: read/write/edit/bash factories and typed options/details, custom HasExecutionEnv contexts, path normalization/read fallbacks, image signature detection/base64, per-environment canonical file mutation FIFO, edit argument preparation/fuzzy matching, display diffs and unified patches. This is separate from the minimal CLI tool implementation.
- Shell timeouts now accept fractional seconds (ShellExecOptions/ShellCaptureOptions use Option<f64>); Node timer range validation and positive sub-millisecond rounding are preserved.
- ICU normalizer is pinned to the already-cached 2.3.0 with default features disabled and compiled_data enabled, so builds remain offline.

## Evidence
- 23 Rust test functions cover the 24 named upstream tools.test.ts scenarios, grouped by read/image, write/edit/canonical aliases, cancellation, shell preparation/output/timeouts/checkpoints; extra registration-order/error-release/environment-isolation cases are included. Windows symlink tests actually executed and passed; they were not skipped.
- 388 line-diff/patch +97 edit/error fixtures run inside one of those test functions, not485 extra project tests. Generator: docs/migration/reference/generate-tools-oracles.mjs, fixture: src/agent_core/harness/tools/fixtures/edit-oracles.json.
- Oracle executes actual read-only upstream edit-diff.ts with Node stripTypeScriptTypes and cached jsdiff8.0.4. Source SHA-256: 70f486d5d5e54a76913d96597e792fc3e2c0938813b01595824a63b2300800db.
- Cached package extracted outside pi at ../.migration-handoff/reference-deps/diff-8.0.4/package. Generator accepts an alternate local package directory. No upstream edits or network installs. MIT attribution retained in reference/jsdiff-LICENSE.
- Full gates: validation/2026-09-23-harness-tools-checkpoint-gates.log: fmt, strict offline Clippy, 2015 project tests (1979 lib +27 generator +9 CLI), 4 compile-fail doctests; one historical ignored example.

## Substitutions and remaining work
- Checkpoint cadence uses Tokio monotonic time instead of Date.now; nominal two-second cadence/deduplication is tested. Wall-clock jumps are not reproduced.
- Custom contexts use a Rust trait rather than TS structural extends. Rust byte offsets are internal; published diff line numbers are compared to upstream.
- Rust signal cancellation is checked around the settled write; dropping an entire caller future is not the same operation as signaling cancellation.
- Tools are not yet connected to the missing full AgentHarness runtime/adapter. Do not claim M3b Task10 or full migration is complete.
- Text/image editing fixtures and generic processor tests do not substitute for all downstream coding-agent integrations or every real image codec.
