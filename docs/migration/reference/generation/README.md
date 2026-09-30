# M3b generation: actual-source oracle and Rust integration coverage

## Authority and reproduction

`oracle.mjs` executes the checked-in sibling `pi` TypeScript business functions after Node's `stripTypeScriptTypes` removes types. It removes module imports/exports and injects explicit dependency seams; it is not a handwritten JavaScript copy of the algorithm. `oracle.json` records SHA-256 for each loaded upstream source. The reference tree is read-only.

Loaded functions:
- `packages/agent/src/harness/session/types.ts`: `operationScopeOf`.
- `packages/agent/src/harness/hooks.ts`: `applyStreamOptionsPatch`.
- `packages/agent/src/harness/runtime/drive/generation.ts`: `prepareGeneration`, `publishGenerationIntent`, `runRetryWait`.

Run from the Rust repository (Node v25.8.2 is available locally):

```powershell
& 'C:\Users\13063\anaconda3\node.exe' docs/migration/reference/generation/oracle.mjs --check
& 'C:\Users\13063\anaconda3\python.exe' docs/migration/tools/run_generation_validation.py targeted
& 'C:\Users\13063\anaconda3\python.exe' docs/migration/tools/run_generation_validation.py gates
```

`--check` compares the entire generated fixture byte-for-byte and does not overwrite expected data. Without `--check` the oracle writes the fixture; use that mode only for an intentional, reviewed oracle update. No npm installation, network request, credential, provider service, or OS clipboard is needed. Node's experimental type-stripping warning is retained in the logs.

## Twelve bounded differential scenarios

- Eight preparations: missing model; missing/partially missing tools with duplicates; empty config; duplicated tool ordering and last definition wins; static prompt; stream option patch; durable cancellation.
- Two intents: first vs retry attempt; current rather than stale scope; distinct reserved IDs sharing one time; output/context limits; TurnStart only on first attempt.
- Two retry decisions: future deadline without permission to wait vs elapsed deadline; preserved scope, attempt and run/step identity.

The source oracle uses a fixed clock, a mocked lane planner, deterministic ID generator, mocked bounded transcript read and hook results. Its JSON intentionally normalizes identity/timing relations and selected fields. It does **not** prove complete Lane durability, real UUID generation, every hook patch combination, callable prompts, the waiting/abort race, or exact scheduler timing.

## Complementary real Rust integration tests

`src/agent_core/harness/runtime/drive/generation/tests.rs` builds a real MemoryStorage/StorageBackedSession, restores a named Lane, admits a prompt, starts a run and reaches a checkpoint. Tests fail if expected operations are missing; they do not silently return. They use real Models routing with a Faux provider or a loopback HTTP mock.

Coverage includes preparation/configuration failures, captured converter, current scope, UUIDv7 time relationship, gated transform/payload/response hooks, retry and cancellation, real stream observer error propagation, drained durable frames, local OpenAI Completions wire payload replacement/response headers, final response publication, retry/tool continuation scope, and orphan recovery without a second provider call. Lifecycle tests also pin normal/recovery `runId` and omitted/true `recovery` wire fields.

Additional tests live in the AI request callback, OpenAI Completions, Models, execution assistant, response lifecycle, and progress-channel modules. Progress tests block the Lane queue and verify 128 FIFO writes, seal rejection, repeatable drain and retained failure. The targeted runner explicitly rejects zero-matching filters (an earlier zero-match run remains as historical evidence).

## Deliberate limits

`performGeneration` is **not** executed inside the TypeScript oracle; that path is tested by real Rust integration. Callback capability is currently implemented only by OpenAI Completions and Faux normal streaming. Other API adapters reject callback-bearing requests explicitly, while callback-free routes retain their prior behavior. This is a migration boundary, not full multi-provider Harness support. Faux's separate deferred-handle path is not bridged.

Callable system prompt/tool context, telemetry context, drive tools execution, structural completion, full deferred execution, dispatcher and public AgentHarness integration remain work. Do not translate module counts or total passing tests into a compatibility percentage.
