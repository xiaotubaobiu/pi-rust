# W3.14 / r14 — native Agent stream adapter (M5 SDK prerequisite)

## Status and scope

This slice removes the hard-wired provider executor from the Agent/low-level loop boundary. It is **not** the SDK, a services factory, a finished CLI, or completion of M1–M6. The last formal checkpoint remains r13 until the r14 external checkpoint receipt verifies the live workspace.

Only three inherited source files change: `src/agent_core/types.rs`, `src/agent_core/agent.rs`, and `src/agent_core/agent_loop.rs`. New source/fixture files are `src/agent_core/stream_adapter_tests.rs` and `src/agent_core/stream_adapter_oracle.json`. The upstream `pi` tree is read-only. Dependency manifests, the original `src/tui/utils.rs` CRLF bytes, and all unrelated inherited changes are protected.

## Native API and execution order

- `StreamFn` receives owned `Model`, normalized `TranscriptContext`, and `SimpleStreamOptions`, returning a boxed async result of a bounded `mpsc::Receiver<AssistantMessageEvent>`. A synchronously available receiver is wrapped in an immediately ready future.
- `GetApiKeyFn` receives the active provider name and returns an async optional string.
- `AgentOptions`/`AgentRuntimeOptions` carry optional stream/key callbacks, process-local `RequestCallbacks`, and transport. Agent transport defaults to `Auto`. Runtime values are snapshotted for each new run, so changes between runs take effect without reconstructing Agent.
- Omission of the stream adapter preserves the supplied per-instance `Arc<Models>` path. This is intentionally **not** the upstream process-global `setDefaultStreamFn` API.
- The low-level `AgentLoopConfig.stream_options` carries the inherited simple request options. No JSON round-trip is used for callback identity or cancellation tokens.

Every request executes in this order:

1. Apply the existing context transform.
2. Await message conversion to LLM messages.
3. Normalize the request transcript, so prompt/tools cannot be passed as shorthand fields to the custom factory.
4. Await `get_api_key` for the **current** `config.model.provider`, including subsequent turns after a model change.
5. Use the non-empty resolved key, otherwise retain the explicit base `api_key` (`resolved || explicit` in upstream JavaScript).
6. Clone base options; overlay present legacy session/retry/budget/thinking fields and replace the signal with the active run signal (including `None`). Explicit `Some(ThinkingLevel::Off)` clears inherited reasoning, including an update between turns.
7. Await the custom factory, or call the existing Models fallback.
8. Consume assistant events through the existing awaited Agent event sink. Listener completion and the final `agent_end` barrier remain part of run/idle settlement.

The base options retain headers (including null deletion entries), environment, timeout/retry, token/sampling, transport/cache/session, metadata, tool choice/deferred settings, reasoning budgets, callbacks and cancellation. A legacy field set to `None` does not clear an inherited value; `Some(Off)` is the explicit reasoning clear. The run signal always wins over the stored signal.

## Failure and cancellation contract

Normal request/provider/callback failures are terminal error/aborted **events**, not factory errors. Factory/key `Err` models an upstream callback that throws or rejects in violation of its normal contract. Raw awaited loops propagate it; Agent's existing outer lifecycle catches it, emits its final error/aborted lifecycle and releases the active run.

Abort is cooperative: the factory sees the same live run token. A pending key/factory future is not silently raced, dropped, or skipped when Agent aborts. It must settle or cooperate; adding an automatic timeout would change upstream plain-await behavior. The native tests release pending gates explicitly and assert that idle remains pending beforehand.

A receiver that closes without a terminal event retains the pre-existing defensive synthetic error, `Assistant stream ended without a terminal event`. This avoids a native hang but is not a claim that a malformed native stream equals JavaScript `EventStream.result()` behavior.

## Actual-source differential oracle

`docs/migration/oracles/capture_agent_stream_adapter.mjs` executes these **complete, unmodified** upstream sources via Node VM and TypeScript stripping:

- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/stream-fn.ts`
- `packages/ai/src/utils/transcript.ts`
- `packages/ai/src/utils/text.ts`
- `packages/ai/src/utils/event-stream.ts`

The synthetic AI barrel only re-exports the actual transcript/text/EventStream code; `validateToolArguments` is a fail-on-use collaborator, since these scenarios execute no tools. Stream/key callbacks are controlled offline test doubles. The capture projects away timestamps, JS object identity and stacks. It is **not** an oracle for an entire Models/SDK/services runtime.

The 16 cases cover configured/default Agent paths, callback and option forwarding, transform→convert order, per-turn credentials, all inherited raw-loop options, absent/empty/overriding keys, Agent/raw-loop key and factory rejection, and terminal error/aborted events with or without a start event. Rust consumes every case. The native omitted-adapter case uses a real Models collection with a faux provider, not another custom adapter.

### Capture correction and provenance

The first capture (`oracle-a`) succeeded as a Node process but was semantically invalid for its six raw-loop cases: the harness passed signal before emit, while upstream `runAgentLoop` takes emit fourth, signal fifth (source lines 101–108). These cases contained empty traces and `emit is not a function`. The second Rust test attempt caught this discrepancy.

The invalid fixture, old script/wrapper and source state are preserved in workspace `.migration-handoff/stream-adapter-r14-0927/oracle-b-failure-source`; original stdout/stderr and failure receipts remain in validation. **Only the harness call order was corrected**; no production behavior or Rust assertion was relaxed. The harness now rejects captures that fail to enter the real loop/factory or report an unexpected error. Capture b explicitly records replacement of invalid fixture SHA256 `94f6078fab3bd37c417aff31a428c76a96dad025cc9faba85a91395a4830c986`. Capture c independently regenerates the corrected output byte-for-byte.

- Corrected fixture/stdout SHA256: `7a8b61fa97acbfb6b5db5586d9cc9629d1ef2ebb973742adc6ddd468621458a5`.
- Corrected capture script SHA256: `a71f1dac88cb40e7927c85a0498f7b20126944607016ae5b01917abcfedd31fd`.
- All six upstream hashes are embedded in the fixture and rechecked by the wrapper/closeout.
- Node's TypeScript stripping/VM experimental warnings are retained, not hidden.

## Native async and integration tests

Fourteen tests supplement the 16-case oracle with:

- callback/stream Arc identity and non-secret Debug output;
- runtime configuration replacement between runs;
- pending factory/key settlement, cooperative abort and late rejection;
- capacity-one channel backpressure while an assistant listener is pending;
- `agent_end` listener as part of idle settlement;
- updated model/provider selection and explicit Off clearing inherited reasoning;
- run signal replacing a stored signal even when absent;
- defensive termination of streams missing a final event;
- reentrant Agent access from stream/key callbacks without a held mutex;
- a real native ModelRuntime and OpenAI-completions adapter to a **loopback wiremock server**, including assembled headers→awaited payload→response ordering, payload replacement and error propagation.

The ModelRuntime tests use in-memory credential/model stores, disable model network refresh, register a native provider and use the explicit fake `offline-test-key-not-a-secret`. The HTTP request must not start before the payload gate releases. Callback rejection must arrive as terminal events, not escape as factory rejection. This helper proves the new adapter boundary can reach ModelRuntime, **not** that a production SDK factory already exists.

All coordination uses actual Notify/Semaphore gates, bounded eight-second test timeouts and joined producer/run tasks rather than sleep-based timing. No real credentials, paid model calls, OS clipboard, unsafe code, detached reload threads, `block_on` navigation or global async mutex were introduced.

## Validation evidence

Validation files have the prefix `docs/migration/validation/stream-adapter-r14-`:

- `fmt-a`/`fmt-b`: scoped rustfmt, exit 0.
- `targeted-a`: genuine Cargo exit 101; an old complete AgentOptions test literal lacked the four new fields, plus an unused import. Source is preserved under `compile-a-source`; the test initializer/import were repaired.
- `targeted-b`: genuine Cargo exit 101; 13 pass/1 fail due to the invalid oracle harness described above.
- `targeted-c`: **14 pass/0 fail**, consuming corrected capture b/c.
- `regression-a`: Agent/loop 90, AgentSessionRuntime 13, Models 128 and request callbacks 2 all pass. Groups overlap and must not be added to claim a full-suite count.
- `acceptance`: all four commands exit 0. `cargo fmt --all -- --check` and offline all-target clippy with `-D warnings` pass; all-target tests **3864 pass = 3828 lib + 27 generator + 9 pirs**, 0 fail, 2 historical ignored; doc tests **5 pass**, 0 fail, 1 historical ignored. Source/build hashes (605 files) are unchanged before/after every gate. Net increase over r13 is 14 tests.
- `closeout`: independently rechecks those original logs/exit codes and inherited ignored lists before publishing handoff. Formal completion of **this slice only** additionally requires workspace `.migration-handoff/stream-adapter-r14-0927-verified.json` with `live_files_status_diff_root_HEADs_and_indices_verified: true` and the matching checkpoint manifest. A missing/failed external receipt leaves r13 as the last formal checkpoint.

Commands (run in `pi-rust`, serially, with full output retained):

```text
cargo test --offline --lib agent_core::agent::stream_adapter_tests:: -- --test-threads=1 --nocapture
cargo test --offline --lib agent_core::agent -- --test-threads=1
cargo test --offline --lib coding_agent::core::agent_session_runtime:: -- --test-threads=1
cargo test --offline --lib ai::models:: -- --test-threads=1
cargo test --offline --lib ai::types::request_callbacks:: -- --test-threads=1
cargo fmt --all -- --check
cargo clippy --offline --all-targets -- -D warnings
cargo test --offline --all-targets -- --test-threads=1
cargo test --offline --doc -- --test-threads=1
```

Each validation receipt freezes source/build hashes, command/exit code and raw log hashes. The independent closeout verifies the original logs, inherited ignored tests, failure snapshots, corrected oracle, scope/protected files, prior checkpoint, Git HEAD/index and upstream status/diff. Four portable handoff entries and WORK_LOG are published only after that verification; WORK_LOG is binary UTF-8 append-only. The new checkpoint must then be externally verified against live files before becoming formal r14.

## Explicit seams and next work

Native futures are poll-driven rather than eager JavaScript Promise/microtask execution. The mpsc stream is bounded and carries terminal owned messages rather than a separate JS `.result()` promise. Native typed/owned messages cannot preserve arbitrary JavaScript identities, throws or stacks. The existing transform/prepare/tool-hook signal/error seams are not expanded here. Only Windows offline validation is claimed. Embedded JS extension hosting, a process-global default factory and full SDK/CLI behavior are not claimed.

Next: use this boundary to implement the **real** SDK ModelRuntime stream wiring. Read live shared SettingsManager values for retries/HTTP idle/WebSocket timeout (idle zero maps to 2147483647; explicit stream options win), apply provider attribution and the **current** extension runner's header/payload/response/context hooks, then implement services construction (loader reload→ordered pending provider registration/diagnostics→offline refresh→flags). Do not cache a stale runner across reload or replace the typed factory with a test-only facade. Pending native provider registration must become typed, not claimed equivalent as JSON.

Preserve r13 lifecycle ordering: replacement abort→final persistence→shutdown→synchronous beforeInvalidate→dispose→create/apply→setup/transcript→rebind→withSession; Runtime.dispose is non-idempotent and does not first await abort; read the live session slot after awaits and never roll back already-applied/disposed state. After SDK/services, connect print (live slot + weak callbacks + output guard/finally), then RPC and M6 server. The overall migration goal stays active.
