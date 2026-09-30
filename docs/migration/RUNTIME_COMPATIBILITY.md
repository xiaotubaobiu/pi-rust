# Current runtime status — 2026-09-25 Anthropic callbacks

Updated 2026-09-25T12:51:46+09:00. This section supersedes historical status claims below, without reinterpreting old evidence.

- Real generation uses Lane/Models/execution-assistant, gated hooks, captured converter, progress FIFO/drain and durable publication; orphan-prefix replay does not call the model again.
- Request callbacks now work in Anthropic, OpenAI Completions and Faux normal streaming. Other adapters explicitly reject callback-bearing requests; full multi-provider Harness compatibility is NOT complete.
- Anthropic awaits payload before SDK preparation/HTTP retry and metadata before Start/SSE. SDK 0.124.0 header-only fields, output_format conversion and beta query are bridged; pure build_request API is retained.
- Evidence: anthropic-callbacks-acceptance.json; 14 added Rust tests; 27 actual-source scenarios replayed by normal/simple adapters (54 loopback cases); 2605 project passed, 0 failed, 2 historical ignored; doc 5 passed/1 historical ignored.
- Owned-JSON bridge excludes arbitrary JS objects/in-place undefined mutation and explicitly rejects isolated-surrogate string spread. SDK client/fetch override/full transport/APIError formatting and inherited SSE parser differences remain outside this slice.
- Callable prompts/toolContext, telemetry, remaining drive tools/structural/deferred/reconcile, dispatcher/public AgentHarness and full task11 storage/conformance are still missing. See HANDOFF and oracle README for exact boundaries.

---

## Historical runtime slice records (dated; not current execution instructions)

# Independent AgentHarness runtime compatibility ledger

Upstream: `590144609`, `packages/agent/src/harness/runtime/`. This is **not** pico3. A passing foundation suite does not mean the public AgentHarness is available.

## Implemented surface (latest checkpoint23:21)

| Upstream surface | Rust source | Evidence / limitation |
|---|---|---|
| session/types.ts operation vocabulary | runtime/durable.rs | Thirteen operation leaves, flattened scope, run/compaction/navigation intents, summary boundaries, generation/retry/deferred/tool batch payloads. Round-trip and reachability matrices. Raw stored operation values remain opaque in session storage. |
| runtime/restore.ts | runtime/restore.rs | Single session mutation barrier; absent/plain-branch/complete-lane classification; invariant precedence; operation identity, lane ownership and intent reachability. Does not fetch prompt/trigger/result/pending payloads or dispatch work. Nine test functions. |
| agent-harness.ts snapshot vocabulary | runtime/projection.rs | Typed LaneSnapshot and only the event fields consumed by the reducer. SnapshotEvent is NOT the full native HarnessEvent API. |
| runtime/reducer.ts | runtime/reducer.rs | Pure event fold: streaming, parallel tools, queues, compaction segment, configuration, usage, retries/deferred state, abort, terminal results, fault, navigation rebase. Differential fixtures execute actual upstream source. |
| runtime/transcript.ts (read/event helpers) | runtime/transcript.rs | Entry chaining/events, ordered queue and pending-message reads. Guarded bounded-context readers remain absent. |
| runtime/progress.ts (read side) | runtime/progress.rs | Raw-frame paging with1000-item boundaries. Progress writers require the unported Lane. |
| runtime/drive/terminal.ts | runtime/drive/terminal.rs | Operation-owned cleanup write planning and terminal result records; no commit/dispatch side effects. |
| runtime/types.ts Drive + ProcedureResult | runtime/drive_pass.rs | Process-local first-wins completion/context/abort/close/permit semantics; NOT a drive dispatcher. Config and command decision types remain absent. |

## Differential oracle

Run from the Rust repository:

```powershell
node docs/migration/reference/generate-runtime-reducer-oracles.mjs
cargo test --offline --lib agent_core::harness::runtime -- --nocapture
```

- Node uses built-in stripTypeScriptTypes; no npm modules, network, upstream edits, or paid providers.
- Actual reducer source SHA-256: `f3066a2c4710ecdba1a87befe175330a3f19b87e31d8a2b5be4b237eea16849d`.
- Fixture: `src/agent_core/harness/runtime/fixtures/reducer-oracles.json`.
- Currently 680 step-by-step comparisons, including 20 seeded 30-event sequences. They are **one** Rust test function, not 675 independently registered tests.
- Initial differential run caught explicit JSON null being erased from CustomEntry.data. The same optional JsonValue contract applies to compaction/branch-summary details, staged entries, pending custom payload, operation errors and usage-ledger details. All ten fields now preserve absent as None versus null as Some(Null).
- Added two wire round-trip matrix tests and a real JSONL close/reopen regression for entry and usage details. Initial JSONL test compile errors were fixture API mismatches, corrected without changing production storage APIs.

## Deliberate substitutions / boundaries

- RestoredLanes is an ordered Vec of key/value pairs, preserving the upstream Map/Set scan-union order without exposing randomized HashMap iteration.
- Rust serde validates typed operation payloads earlier than unvalidated TypeScript casts. Unknown extra fields are not retained by typed projections; the original raw stored values are not rewritten by restore.
- Rust snapshots are owned data rather than mutable JS object aliases. Events are read-only projections and cannot be used to imply the missing event subscription/public command API.
- restore_session/restore_lane use the existing session mutation capability, not a pico3 transaction.
- The existing session directory is not missing and must not be rewritten from scratch. MemoryStorage exists; MemorySessionRepo/MemorySessionFacade are explicitly **not ported** in session/memory.rs. Regressions use StorageBackedSession + MemoryStorage.

## Still missing

- runtime/types.ts Config, LaneCommand and OperationCommand; runtime/lane.ts: serialized admission/commands, operation capability identity, projection publication, lifecycle, continuation and close barriers.
- runtime/drive.ts and the remaining eleven drive/* modules (terminal.ts leaf is ported): generation, deferred responses, checkpoints, retries, recovery, structural effects, terminalization and tool placement.
- runtime/harness.ts, native AgentHarness/Resources/events/options, tools integration, telemetry and public integration tests.
- Transcript bounded context readers and progress writers must wait for a real Lane capability/command implementation; do not replace them with unguarded reads/writes.
- The foundation has no create_harness stub and starts no background work.

## Validation

22:48 full gates passed: fmt, strict offline Clippy, 2028 project tests (1992 lib +27 generator +9 CLI), 4 compile-fail doctests; 1 historical ignored example. Log: validation/2026-09-23-runtime-foundation-checkpoint-gates.log. This checkpoint adds13 test functions over22:17; cumulative105 over baseline1923. See WORK_LOG for preserved failures.

## 23:06 read-side and terminal leaves

- runtime/transcript.rs: chain_entries, entry_lifecycle_events, committed_entry_events, read_lane_queues and read_pending_messages. EntryLifecycleEvent is only the native event subset these helpers publish, not the complete HarnessEvent API. Input order, duplicate IDs, optional null payloads and upstream invariant errors are preserved. Commit offsets use actual noncontiguous commit sequences.
- runtime/progress.rs: read_assistant_frames, ascending pages of1000 with last-sequence cursors. Returns raw JSON, preserving unknown fields/null; 0/1/999/1000/1001/2000/2003 boundaries and foreign list isolation tested.
- runtime/drive/terminal.rs: complete upstream terminal.ts leaf; cleanup write order, owned family scans, live-frame selection, outcome-ready pending dedup and result-record error/status invariants. No writes committed or events dispatched by helpers.
- Seven transcript/progress functions and four terminal functions added. Expanded reducer fixture now680 steps exposed details:null loss in AgentToolResult, AfterToolCallResult and ToolResultMessage; one additional three-type wire matrix tests absent/null/false/object. present_json is now private shared serde_support.
- Deliberate substitutions: malformed commit-offset input returns SessionInvariantError rather than producing an undefined JS seq; borrowed Rust read futures can be dropped on early Promise.all-equivalent error (success/error values audited, relative read completion timing not audited). Result clock has an injected deterministic helper plus the actual wall-clock wrapper.
- Bounded context reads and progress writers remain unimplemented until real Lane capability/serialized commands exist.
- Full gates passed23:06: fmt, strict offline Clippy,2040project tests(2004+27+9),4compile-fail docs,1historical ignored. Log validation/2026-09-23-runtime-leaves-checkpoint-gates.log. +12 since22:48, cumulative117overbaseline1923.

## 23:15 process-local Drive checkpoint

- runtime/drive_pass.rs ports Drive from runtime/types.ts, plus DriveOptions/DriveOutcome wire vocabulary and ProcedureResult. No Lane, provider, dispatcher, background task or harness constructor is started.
- Completion is replayable and first-wins across settle/fail/close; no-waiter settlement persists. Each waiter can be dropped independently; a completion handle outlives its Drive without turning a pending JS promise into an invented rejection. Context values retain shared identity while the caller abort signal is explicitly detached.
- begin_abort denies future admission without immediately signalling; signal_abort is distinct from close_gate. close_gate closes admission and signals a separate close token while preserving a prior completion. First close reason and first completion error identities are separately retained.
- Eight tests cover option matrices, cancelled parent contexts, all3 native wire outcomes, first-wins/replay, waiter cancellation, owner drop, failure/close identity, abort phases,16-thread completion contention and deferred-permit consumption.
- New native wire matrix exposed another existing optional JsonValue bug: DeferredHandle.data:null was erased. Corrected src/ai/types/options.rs with shared present_json. Initial failing log retained. This is not a completed repository-wide optional-JSON audit.
- Rust substitutions: shared watch-backed completion instead of Promise; Arc<dyn Error> instead of arbitrary JS rejection values; CancellationToken notification plus close_reason accessor instead of AbortSignal.reason; atomic bounded consume method instead of mutating deferredPermits number. It must be invoked only at the successful deferred-effect commit boundary when the dispatcher is ported.
- Full gates23:15: fmt, strict offline Clippy,2048project tests(2012lib+27generator+9CLI),4compile-fail docs,1historicalignored. Log validation/2026-09-23-runtime-drive-checkpoint-gates.log. Runtime subset29functions; cumulative125newprojectfunctions above baseline1923.

Final23:21 verification: the same2048project+4doc result passed again after byte-identical oracle regeneration (final-gates.log). Runtime subset29passed under both1and16test threads; pico3 oracle_runtime75passed under8and32test threads (final-runtime-repeat.log). No new source changes after23:15.
