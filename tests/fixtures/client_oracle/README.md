# client_oracle — node oracle for the M6 client slice

Runs the **verbatim copied upstream `packages/client` sources** (`src/`,
`test/support.ts`) and captures deterministic outputs (wire frames, state
sequences, error texts) that the Rust port's tests assert byte-for-byte
(`src/client/client_tests.rs` reads `oracle.out.txt` at test time).

## Layout

- `src/` — verbatim copy of `pi/packages/client/src/*.ts` (do not edit; the
  SHA256 manifest lives in `src/client/mod.rs`).
- `test/support.ts` — verbatim copy of `pi/packages/client/test/support.ts`
  (`MemoryByteServer`).
- `vendor/pi-protocol/` — verbatim copy of `pi/packages/protocol/src` (real
  cbor / framing / codec).
- `vendor/chord/` — verbatim copy of `pi/packages/chord/src` (real service
  wire validators, delta wire grammar, state codec, context).
- `vendor/typebox/` — **shim**. Node refuses type-stripping inside
  `node_modules` and the offline environment has no TypeBox install, so this
  minimal descriptor evaluator stands in for the TypeBox schema checker used
  by the protocol package. Every oracle scenario uses schema-valid messages,
  so the captured client/connection behavior is upstream's own; message
  codec validation itself was pinned in the M6 protocol slice.
- `hooks.mjs` / `register.mjs` — resolve-hook mapping the bare workspace
  specifiers (`@earendil-works/pi-protocol`, `@earendil-works/chord`,
  `@earendil-works/chord/context`, `typebox`) onto `vendor/`.

## Regenerate

```bash
cd scratch/client_oracle
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  /c/Users/13063/anaconda3/node.exe --import ./register.mjs \
  --experimental-strip-types oracle.mjs > oracle.out.txt 2> oracle.err.txt
```

The output is deterministic (verified by repeated runs and `diff`).
