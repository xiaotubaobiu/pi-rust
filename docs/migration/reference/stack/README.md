# Stack/HStack/VStack actual-source oracle

Validated 2026-09-24T15:33:59+09:00. Authority: upstream `5901446094988aa5cd8e11efdaa131c3949106f1`.
This oracle runs complete upstream modules rather than a reimplemented allocator,
Container, or compositor. It does not invoke the viewport layout engine or OS terminal.

## Provenance and inputs
- `run.mjs` reads9 actual pi sources: stack/h-stack/v-stack,layout-node,tui,keys,terminal-colors,terminal-image,utils. Hashes are retained in source-manifest.json.
- Uses Node25.8.2 native TypeScript stripping and offline get-east-asian-width1.6.0 from `.migration-handoff/reference-deps`. No marked dependency and no network calls.
- Scratch defaults to `target/stack-oracle`; optional arguments are pi root,dependency cache,scratch root. The bootstrap rejects scratch paths inside pi and verifies the expected pi HEAD before copying.
- `generate-fixtures.mjs` supplies fake leaf components only; all Stack/lifecycle/composition/allocation behavior is the actual upstream implementation.

## Coverage (five Rust test functions)
| Section | Cases | Assertions |
|---|---:|---|
| allocations |4169|4096 seeded+3 explicit+70 numeric edge inputs; exact sizes including encoded NaN/±Infinity; no helper-side normalization |
| normalizations |49|undefined/negative/fractional/nonfinite gap and entry fields; basis remains untouched and optional field presence is retained |
| renders |952|17 scenarios×2 axes×4 aligns×7 widths; exact first/second/after-invalidate lines and render/visible/invalidate trace |
| composites |2691|ANSI/OSC8/wide glyphs/emoji/image lines,zero widths,overflow/padding; exact bytes and visible width |
| lifecycles |48×20 steps|add/remove including missing index,clear,re-add,hidden invalidation,stateful call order,normalized node metadata |

Renders cover hidden entries,zero basis,grow/min/max/overflow,gaps,empty,nested,
wrap,Unicode,ANSI,hyperlinks,image lines,fractional options and stateful render counts.
The lifecycle oracle selects the actual upstream child object at the given index;
unique identities only. Cases are not independent test-function or unique-user-input totals.

## Reproduce (from Rust root)
```powershell
& C:/Users/13063/anaconda3/node.exe docs/migration/reference/stack/run.mjs
& C:/Users/13063/anaconda3/python.exe docs/migration/tools/verify_stack_oracle.py --previous ../.migration-handoff/checkpoint-2026-09-24-markdown-mask-coordinates
cargo test --offline --lib tui::tests::stack -- --nocapture
cargo test --offline --lib tui::tests::overlay -- --nocapture
```
Generator writes scratch only. The verifier byte-compares fixture/manifest,checks
fixture length/hash/counts,generator hash and9 current actual source hashes,then
preserves prior Stack case sections as prefixes if supplied. It never installs files.
The previous Markdown checkpoint has no Stack corpus; future runs can use stack-direct.

Fixture: `src/tui/components/stack/fixtures.json`,6,024,141 bytes,
SHA-256 `15708e1d636013193834d864987156206781f1cffd27759666a0f4cf58960340`.
All4 pre-lifecycle case sections were retained exactly when48 lifecycle cases were appended.

## Evidence and limits
- First compositor test reproduced2691 differences (`validation/2026-09-24-151246-stack-compositor-red.log`). Final implementation passes all2691 without skips. The first3 cases are also independent legacy overlay smoke regressions; their formerly non-upstream expectations were corrected.
- Final full gates:`validation/2026-09-24-152743-stack-direct-full-gates.log` (2378 whole-project passed;5 new Rust tests); focused:`validation/2026-09-24-152632-stack-focused.log`.
- Reproduction:`validation/2026-09-24-152910-stack-oracle-repro.log`:2 Stack+12 Markdown/LaTeX artifacts byte-identical,9 source hashes and30 independent width probes validated. No Cargo or prior Markdown/LaTeX code changes.
- Standalone HStack always measures visible children before actual rendering,including fixed-basis children. Viewport layout.ts has different cache/fixed-basis behavior and is not exercised here.
- Rust boundary is UTF-8 Component/usize dimensions; non-finite/unrepresentable/resource-exhausting render dimensions,arbitrary JS object aliasing/direct children mutation/live node references are not claimed equivalent. Numeric helper finite corpus is not exhaustive proof of all JS numbers.
- Box-owned children use current-index deletion; concrete borrowed layout_node is not yet trait-object discovery. Viewport layout/scroll/clipping/mouse/Kitty image crop/terminal integration remain a separate slice.

## Later viewport-core slice (2026-09-24)
The scope limits above describe the original standalone checkpoint. Mutable trait-object layout discovery,viewport frame caching,scroll/clipping and Kitty crop are now implemented and tested separately; see reference/layout/README.md. Direct Stack behavior and this oracle remain unchanged. Arbitrary JS identity/mutation and full mouse/OS/host integration remain outside these slices.
