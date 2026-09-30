# Actual-source Selection paint oracle

## Authority and scope
`run.mjs` copies22 complete upstream modules from the pinned read-only `pi` HEAD `5901446094988aa5cd8e11efdaa131c3949106f1`, uses the already-offline `get-east-asian-width@1.6.0`, and invokes actual `TuiAltScreen.applySelectionHighlight/applySelection/getSelectionColumns`. It does not translate those reference algorithms into handwritten JavaScript. Four upstream test files are hashed as consulted references, **not executed** by this oracle. Native full alt-screen tests require the unavailable offline `@xterm/headless`.

The new test-only host/scenario scaffold is derived from the previously verified component-selection harness; that harness, its194 cases/1707 steps, and all old30 oracle artifacts remain byte-identical. This independent namespace deliberately avoids changing shared test scaffolding or production algorithms in the previous slice. Its complete module/bootstrap/generator hashes are recorded by source-manifest.json.

## Input seams versus actual behavior
- `paintBounds` injects an explicitly normalized bounds value into `getSelectionBounds` for the duration of the real paint call, restoring the method afterwards. Rust receives the identical bounds input through `apply_selection`. This is a paint-stage test, not a substitute for testing normalization.
- `paint` uses actual Selection state from actual mouse events. `renderFrame` uses real `renderLayoutFrame`, owning Container/ScrollView, and original content. Both actual source and Rust compare full Selection/Focus/Gesture/scroll state and ordered traces after every operation. Paint must not change the screen input, state or frame.
- Frames designated `frame` are explicit geometry seams; renderer-produced `renderFrame` cases are distinguished. Saved-frame cases ensure the supplied next/saved layout is used instead of blindly looking at the current host layout; the scroll handle remains live.
- Intl word segments are external input-service recordings; they are not expected bounds fed back to Rust, and not proof of a Rust ICU engine. Time, timers, URL/clipboard initiation, screen/frame publication and unrelated search/scrollbar handlers are controlled host seams. No real URLs, credentials, clipboard, OS terminal or network calls occur.

## Corpus
295 cases /1266 steps: highlights30/30, screen131/132, scroll106/322, composed20/118, sequences8/664. Includes ANSI reset/27m/repeated SGR, OSC8 BEL/ST/APC, permissive/incomplete escapes, unrecognized DCS copied according to actual extractAnsiCode, Kitty/iTerm2 marker lines (including embedded markers), empty/zero-width text, CJK/combining/ZWJ/flags, tabs, strict clipped wide cells, negative rows/columns, empty/disjoint rect/clip, screen length versus terminal height, scroll identity/missing layout/content, live scrollTop, saved frame, actual event-built character/word/line selection, repaint/clear/resize/autoscroll and deterministic interleavings.

Fixture2332991 bytes, SHA256 `ef3635debddac6df619bff16c3acc7128d183b5c88919479a1ac6a97e029dbc5`. Test functions and results are recorded in the slice WIP/validated record and full command logs; corpus size is not a count of independent Rust test functions.

## Offline reproduction (from pi-rust)
```powershell
C:/Users/13063/anaconda3/node.exe docs/migration/reference/component-selection-paint/run.mjs
C:/Users/13063/anaconda3/python.exe docs/migration/tools/verify_component_selection_paint_oracle.py --previous ../.migration-handoff/checkpoint-2026-09-24-component-selection
cargo test --offline --lib tui::tests::component_selection_paint -- --nocapture
```
The bootstrap writes only `target/component-selection-paint-oracle` by default and refuses scratch paths inside pi. The verifier is read-only; it never installs a fixture or rewrites an expected value.

## Representation and remaining work
Paint consumes valid UTF-8 and finite integer cells. Internal signed i128 projection preserves all native i64/usize endpoints without intermediate clamping; it does not claim arbitrary JS-number/lone-surrogate equality. Rust returns Vec content rather than exposing JS array identity. Normalized bounds are required for the pure function; the controller convenience method obtains its own bounds. Missing frames/scroll boxes and image rows remain byte-for-byte unchanged.

Actual doRender order is search → indicator → overlays → selection → flashes, followed by cursor/line resets/differential render. Completing this paint stage does **not** integrate that compositor, full input loop/lifecycle, async clipboard success/flash/OSC52, native alt-screen suite, or OS host. Full M4/full migration remain incomplete.
