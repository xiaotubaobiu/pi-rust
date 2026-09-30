# Anthropic request lifecycle oracle (2026-09-25)

Run from `pi-rust` with Node 25.8.2, without installing npm packages:

```powershell
& 'C:\Users\13063\anaconda3\node.exe' docs/migration/reference/anthropic-callbacks/oracle.mjs --check
& 'C:\Users\13063\anaconda3\python.exe' docs/migration/tools/run_anthropic_callbacks_validation.py targeted
& 'C:\Users\13063\anaconda3\python.exe' docs/migration/tools/run_anthropic_callbacks_validation.py gates
```

## Authority and reproducibility

`oracle.mjs` erases TypeScript types using Node `stripTypeScriptTypes` and executes:

1. The entire **actual exported `stream` function** from the pinned sibling `pi/packages/ai/src/api/anthropic-messages.ts` (not a hand-rewritten callback algorithm).
2. Actual `utils/provider-retry.ts` functions.
3. Actual `Messages.create` method and `transformOutputFormat` function from **@anthropic-ai/sdk 0.124.0**, plus its actual `buildHeaders` implementation.

The SDK tarball was fetched only as source reference from the **upstream lockfile's exact registry URL**. Its complete SHA512 was verified against `pi/package-lock.json` before selecting source files. No packages were installed, no upstream files were written, and no models or external API endpoints were called. The vendored `messages.ts`, `headers.ts`, `LICENSE`, and `provenance.json` support completely offline replay. The source hashes appear in the fixture, and the oracle checks vendored hashes against provenance. A GitHub raw lookup returned no content and is not evidence for the implementation.

The fixture lives in `src/ai/api/anthropic/stream/callback_oracle.json`. `--check` regenerates in memory and compares **complete fixture bytes**; no artifact is silently rewritten. Running without `--check` is an explicit fixture update, not acceptance validation.

## Exactly what is and is not executed

The upstream stream function retains its payload replacement, retry placement, metadata callback, Start/Done/Error and catch/abort logic unchanged. The SDK method retains header-only parameter separation, empty-beta semantics, output_format conversion and the `/v1/messages?beta=true` URL unchanged.

Controlled seams: transcript/tool lookup, request `buildParams`, client construction/auth check, HTTP transport/statuses, SSE iterator, cost/stop-reason reduction, the event-stream container and time. SDK helper headers for special parser/tool wrappers are stubbed (none occur in these JSON cases). **This is not execution of the entire Anthropic package or full SDK transport.** HTTP error messages in the transport seam are canned `status: denied` values; exact SDK APIError formatting is not claimed.

27 bounded lifecycle scenarios cover callback-free and undefined/None, object/null/array/BMP-string/scalar replacement, forced `stream:true`, beta override/removal/client-default restoration, SDK-only headers, output_format success/conflict, both callback failures, non-2xx, retry success/exhaustion, cancellation at three phases and mid-body errors. Rust tests replay each scenario through **real normal and simple Anthropic adapters with loopback HTTP** (54 executions); those tests use the real Rust request builder and inspect actual HTTP bodies/headers. Additional Rust-only tests exercise asynchronous hook gates, OAuth identity/tool normalization, header-owned/Copilot auth, missing auth, and Models/Harness integration.

## Compatibility boundaries

- `build_request` preserves its historical pure `params + computed headers` contract; its `body` retains SDK params. The stream path now materializes SDK-only fields *after* the payload callback. This fixes inherited wire issues: beta params previously leaked into JSON, and the beta query flag was absent.
- Hooks are process-local fallible async functions, skipped by serde. `None` maps to JS undefined; `Some(null)` maps to `{stream:true}` for Anthropic (unlike Completions, where the replacement remains null).
- Hook futures are awaited, not force-cancelled when the signal changes. Cancellation is then observed at the upstream-equivalent request or body boundary. Hook failures are not HTTP-retried.
- JSON objects are sorted by serde, not JS insertion order (inherited). Rust strings cannot represent isolated UTF-16 surrogate property values produced by spreading a **top-level non-BMP string**. That malformed-as-params callback value explicitly errors before send instead of silently corrupting it. Ordinary object payloads may contain emoji normally. Arbitrary JS objects, inherited properties, symbols, custom toString and in-place mutation with an undefined return are outside the typed owned-JSON callback bridge; TS extension execution is still M5 work.
- Native SDK client/fetch overrides, full SDK transport helpers/error formatting and legacy SSE parser differences are not implemented by this slice. Those limitations do not get erased merely because the adapter now advertises process-local callbacks.
- Generation is still missing other provider callback bridges, full deferred/structural/tools dispatch, callable prompts/toolContext and public AgentHarness. This slice is not full M2/M3b or full migration acceptance.
