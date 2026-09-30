# AltScreenSearchComponent actual-source oracle and VS16 width correction

## Scope and authority
Upstream HEAD `5901446094988aa5cd8e11efdaa131c3949106f1`, actual complete `packages/tui/src/alt-screen-search.ts:197–327`, actual Input/keybindings/utils plus their imports (22 complete modules copied and hashed). The generator observes private value, UTF16 cursor, focus and navigation bounds; it does not replace rendering/editing or inject expected Input output into Rust.
`run.mjs` builds only under `target/alt-screen-search-component-oracle`, reuses the offline `get-east-asian-width@1.6.0` dependency, and never changes pi. Node v25.8.2 / Unicode17 / ICU78.2. For platform cases, process.platform is explicitly replaced with win32/linux/darwin service values; these are not tests executed on actual macOS/Linux hosts.

1513 scenarios / 11770 operations:

| Group | Cases |
|---|---:|
| render | 953 |
| styles | 84 |
| keys | 169 |
| editing | 35 |
| unicode | 198 |
| paste | 24 |
| sequences | 50 |

Observations include raw rendered rows/cell widths, last-render row2 half-open hit bounds/grid, stale bounds until render, focus on both outer component and real Input, cursor movement/editing/paste/undo, query and style callback order, dynamic first-key selection, Unbound, Option and JS first-UTF16-unit uppercase behavior. Style callbacks may widen or erase controls; unstyled layout bounds and upstream overflow behavior are retained, not silently clipped.
The named native placeholder/right-aligned-controls assertion is reproduced in the actual-source generator and an independent Rust contract. A hash of `tui-alt-screen.test.ts` is provenance, **not execution**: the complete native alt-screen suite has not run because offline `@xterm/headless` is unavailable. The separately reproduced native layout suite has 15 passing tests.

## Frozen reference and first failure
The UI fixture/bootstrap/generator/manifest were frozen at 2026-09-24T23:33:43.729430+09:00, before the Rust implementation/tests, in `validation/search-component-first-test-evidence`. UI fixture: 10045330 bytes, SHA256 `3c5efac334c13952bf5371d5645e115f83ab7c84ebc5321131489de598e15ce8`. They have not changed to accommodate Rust.
First test log `2026-09-24-233849-search-component-test.log`: 10 pass / 4 fail out of14 functions. The unicode group reported five `unicode-8-*` mismatches on `©️⭐️`: inherited RGI generation had omitted independent scalar+VS16 presentation sequences. Existing Rust width for `©️` was1, upstream2, which also changed real Input horizontal scrolling/padding. Frozen formatted source before the fix lives in `search-component-initial-failure-evidence`.
Three other failures were incorrect NEW independent contract assumptions: width8 navigation rectangles are previous2..3 and next4..5, not3..4 and5..6; actual Input paste removes CR/LF, so `a\nb` plus tail `c` yields `abc`, then backspace `ab`, not strings containing a space. Real-source probes in the new width fixture establish these facts. Only those new independent assertions were corrected; no frozen differential expectations, inherited tests, skip or test-thread setting changed.

## General runtime VS16 supplement
`width-vs16.mjs` enumerates all 1112064 Unicode scalars and tests scalar+VS16 against actual Node `/^\p{RGI_Emoji}$/v`. All207 accepted bases form `src/tui/utils/rgi_emoji_vs16.rs`; this is general runtime property data, not a lookup of expected UI rows. Existing3331-entry RGI table is checked first and remains unchanged. Shared utils imports the new supplement through two CRLF-preserving edits; existing Input, search index, raw-width code and old width fixtures remain byte-for-byte unchanged.
1606 new cases compare actual upstream membership/width/truncate0..5/slice0..2, including base/VS15/VS16/repeatedVS16/combining/context and negative samples. These fixtures/table/generator/manifest were frozen at23:45:27.928148+09:00 before corrected Rust tests. This exhausts scalar+VS16 property pairs, not every possible sequence in the inherited ZWJ/tag grammar.
The16 passing Rust test functions comprise7 UI differential groups,7 independent UI contracts,1 width differential group and1 shared raw-width/search-index contract. Fixtures are only in cfg(test); production owns a real Input and computes output independently.

## Validation and replay
From the Rust root:

```powershell
python docs/migration/tools/run_search_component_validation.py test
python docs/migration/tools/run_search_component_validation.py gates --loopback-no-proxy
python docs/migration/tools/run_search_component_validation.py repro
python docs/migration/tools/run_search_component_validation.py handoff
```
`test` runs cargo fmt (writes formatting); only use before sealing. Gates run original fmt-check/clippy-all-targets/all-target-tests/doc-tests serially. NO_PROXY is only a child-process overlay for loopback mocks. All later stages create exclusive new logs. Repro never installs expected data: new UI+VS16 generation and verifier, then all31 prior commands, yields34 commands and44 byte-identical artifacts (5 new+39 previous),30 unchanged ANSI probes and15 actual native layout tests.
Final gates at2026-09-24 23:54:43–23:55:07 passed2505 all-target tests (2469lib+27generator+9CLI),2 historical CJK ignored; docs5pass/1 historical ignored. Initial gates at23:51:46 failed one unchanged Vertex mock test with missing project ID (2468pass/1fail/2ignored); generator/CLI/doc did not run on that attempt. Isolated test then unchanged whole gates passed. Root cause remains unproved, not an AI fix. Both attempts and matching7-file source witnesses remain in acceptance evidence.
`search-component-acceptance.json`, `verify_search_component_oracle.py`, `audit_search_component.py` connect source provenance, frozen files, first failures, final source witnesses, previous archives and reproduction logs. The full history, including416 earlier failures/4 hanging tests/proxy AB, CRLF normalization audit failure and Unicode standard-data HTTPS acquisition, is retained.

## Explicit limits and stop instruction
Valid UTF8 UI only; nonnegative cell widths; result integers promised within JS safe range; no lone-surrogate Input/UI, arbitrary JS numbers or self-reentrant callback API. Raw UTF16 search-index support from the prior slice is not equivalent to raw UTF16 throughout the UI. The new component has not been integrated into the complete TuiAltScreen search host/eventloop/refresh/navigation/highlight/gesture lifecycle. OS clipboard and complete Intl behavior are not added here.
The user requires pausing after this slice is validated/recorded/sealed. **Do not start another slice without explicit user resumption. Full migration is incomplete.** A checkpoint created immediately before pausing may record goal active at creation; it is not permission to resume.
