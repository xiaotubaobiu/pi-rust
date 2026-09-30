# Upstream inventory (snapshot, not completion percentages)

Inspected 2026-09-23, upstream `590144609`. Counts include only `.ts`/`.tsx` under each `src/`, using newline-split physical line counts (including blank/comment/generated lines). They are sizing evidence, not proof of behavioral coverage. No `pisper` files were inspected.

| Package | TS/TSX files | Physical lines | Rust scope today |
|---|---:|---:|---|
| agent | 119 | 33966 | Core + partial harness; tools and runtime foundation added; public AgentHarness/Lane/drive dispatcher missing; session subtree exists (Task 7) |
| ai | 179 | 24986 | Existing implementation; prior documented scope cuts need audit |
| chord | 24 | 6276 | Only harness-support shim |
| client | 8 | 1143 | Pending / only incidental support |
| coding-agent | 265 | 72110 | Minimal CLI slice, not full package |
| evals | 5 | 1451 | Pending / only incidental support |
| protocol | 8 | 877 | Pending / only incidental support |
| server | 16 | 1982 | Pending / only incidental support |
| telemetry | 6 | 941 | Pending / only incidental support |
| tui | 42 | 18156 | Pending |

## Agent harness subtrees

| Subtree | TS/TSX files | Physical lines | Status |
|---|---:|---:|---|
| compaction | 3 | 1300 | Existing Rust counterpart |
| env | 1 | 925 | Existing Rust counterpart |
| execution | 3 | 447 | Existing Rust counterpart |
| pico3 | 24 | 8018 | Storage/view + in-flight scheduler/runtime/kinds (this session) |
| runtime | 21 | 7494 | Partial Rust subtree23:15: durable/restore/reducer, transcript/progress reads, drive/terminal, process-local Drive; Lane/dispatcher/harness still missing |
| session | 29 | 7137 | Existing Task 7 Rust subtree including memory/session/JSONL/repo/v3 migration; MemorySessionRepo/Facade not ported; audit coverage, do not rewrite as missing |
| tools | 10 | 1219 | Implemented22:17 checkpoint:23 tests +485 differential cases; full AgentHarness integration still pending |
| utils | 5 | 827 | Audit individual utilities; not assumed complete |

The old M3b Task 10 description (`agent-harness.ts` + `telemetry.ts`) is insufficient by itself. `agent-harness.ts` imports the separate `harness/runtime/harness.ts`, not pico3. Port the real dependency tree and its `test/harness/runtime/` suite; do not substitute type stubs and claim parity.

## Pico3 oracle sizing

Counts below are static top-level `test(` declarations, not pass counts or parameterized test expansion. See `ORACLE_COVERAGE.md` for mapped coverage.

| Upstream oracle | Declarations |
|---|---:|
| atomicity.test.ts | 7 |
| authority.test.ts | 9 |
| busy.test.ts | 8 |
| chord.test.ts | 3 |
| hardening.test.ts | 7 |
| kinds.test.ts | 27 |
| membrane.test.ts | 5 |
| reads.test.ts | 9 |
| recovery.test.ts | 11 |
| retention.test.ts | 1 |
| spec-context-capabilities.test.ts | 4 |
| spec-plugins-lifecycle.test.ts | 17 |
| spec-scheduler-process.test.ts | 10 |
| spec-storage-history.test.ts | 12 |
| spec-transactions.test.ts | 8 |
| spec-view-events.test.ts | 10 |
| subagent.test.ts | 6 |
| tool-bounds.test.ts | 4 |
| turn.test.ts | 17 |
| view.test.ts | 5 |
| waiters.test.ts | 3 |
| watch.test.ts | 6 |

Correction at 20:59: the earlier 20:38 inventory misclassified `harness/session` as absent. `src/agent_core/harness/session/mod.rs` and committed Task 7 files prove it exists; commits b5adb87/f3b182c and passing session/jsonl tests are evidence. Runtime/tools remain genuinely absent as top-level subtrees.

Update at22:17: top-level harness/tools now exists and passed strict gates. The historical20:59 absence statement above remains a chronological note, not current status. Separate runtime remains unimplemented at this checkpoint.

Update at23:06: independent runtime leaves now exist and pass gates; see RUNTIME_COMPATIBILITY. Historical absence notes above do not describe the latest checkpoint.
