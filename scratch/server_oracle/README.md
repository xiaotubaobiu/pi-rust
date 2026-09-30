# server_oracle — node oracle for the M6 server slice

Runs the **verbatim copied upstream `packages/server` sources** (`src/`) and
captures deterministic outputs (server wire frames as hex chunks, response
envelopes, hello_error texts, dispatch order, shutdown error texts) that the
Rust port's tests assert byte-for-byte (`src/server/server_tests.rs` and
`conformance_tests.rs` read `oracle.out.txt` at test time).

## Layout

- `src/` — verbatim copy of `pi/packages/server/src/**` (do not edit; the
  SHA256 manifest lives in `src/server/mod.rs`).
- `vendor/pi-protocol/` — verbatim copy of `pi/packages/protocol/src` (real
  cbor / framing / codec).
- `vendor/chord/` — verbatim copy of `pi/packages/chord/src` (real service
  wire validators, delta wire grammar, state codec — the subscription
  scenarios run the real `createServiceStateEncoder`).
- `vendor/agent-core/` — **shim** (`index.mjs`, provenance note inside): the
  `BACKGROUND_CONTEXT` / `TODO_CONTEXT` constants, `withAbortSignal`, and a
  minimal `MemorySessionRepo` (create/open/list/facade-close) — only the
  runtime surface the server package touches. Types are erased by
  `--experimental-strip-types`.
- `vendor/typebox/` — **shim** copied from `client_oracle` (schema descriptor
  evaluator standing in for the TypeBox checker; decode-path error texts are
  fixed strings in the real codec, so no TypeBox error text reaches the
  captured output).
- `hooks.mjs` / `register.mjs` — resolve-hook mapping the bare workspace
  specifiers (`@earendil-works/pi-protocol`, `@earendil-works/chord`,
  `@earendil-works/pi-agent-core`, `typebox`) onto `vendor/`.

## Determinism

- Attachment ids come from `randomUUID`; they are masked on both sides —
  in JSON text via the plain UUID regex, and inside frame hex via the same
  UUID's ASCII-byte-pair form (see `UUID_HEX` in `oracle.mjs`).
- The handshake-timeout scenario keeps the event loop alive with a ref'd
  interval because the upstream timer is `.unref()`ed.
- The ambiguous-session scenario forces duplicate ids at the repo `list`
  boundary (the shim's `MemorySessionRepo.create` would reject duplicates;
  upstream's own conformance test stubs `resolveSession` the same way).
- Verified deterministic across repeated runs (`diff` clean).

## Regenerate

```bash
cd scratch/server_oracle
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  /c/Users/13063/anaconda3/node.exe --import ./register.mjs \
  --experimental-strip-types oracle.mjs > oracle.out.txt 2> oracle.err.txt
```
