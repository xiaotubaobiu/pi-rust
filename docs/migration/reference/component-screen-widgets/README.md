# Component screen widgets actual-source oracle

Run from the Rust repository root (offline; Node v25.8.2 and the existing local get-east-asian-width 1.6.0 cache):

```text
node docs/migration/reference/component-screen-widgets/run.mjs
python docs/migration/tools/verify_component_screen_widgets_oracle.py
cargo test --offline --lib component_screen_widgets
```

The bootstrap copies 22 complete, hash-pinned upstream modules into ignored target/component-screen-widgets-oracle. No upstream edits or textual algorithm extraction. It hashes four consulted test files; **the full native alt-screen/overlay suite is NOT executed** (offline @xterm/headless remains unavailable). The independent older layout runner still executes 15 real layout tests.

## Accepted corpus (frozen before Rust tests)

| group | cases | steps | authority |
|---|---:|---:|---|
| flashes |141|336|real flash controller/render + compositeFlashes|
| indicator |57|237|real indicator method with manual LayoutFrame tree|
| clicks |51|234|last published rect; real scrollToBottom + live ScrollView|
| composed |13|147|actual renderLayoutFrame over VStack/ScrollView/dock; paint then flash|
| routing |5|20|actual handleMouseEvent, but unrelated services are explicit traced seams|
| signed |30|120|manual negative/overflow geometry, visible rows + named negative-row property|
| total |297|1094|6 differential Rust functions, not 297 test functions|

Every step compares return/error, screen bytes, negative-row property, last indicator rectangle, all three scroll states, flash entries/nextId, layout geometry, and ordered callback/render/flash-timer effects. A rejected label is the only expected error. No expected screen is injected into Rust helpers. Normalized selection bounds are an input seam, not a real mouse-selection integration claim.

Scroll auto-hide timers are deliberately scheduled into a non-delivered mock in both runtimes; their exact scheduling/cancellation trace is outside this slice (older ScrollView oracle owns that contract). Flash timers are separately recorded and explicitly delivered; no timer worker, OS IO, real clipboard or credentials. Gesture search/overlay/layout/scrollbar/paste/selection services log their route and use explicit responses; the scrollbar seam checks real geometry, but does not execute a native drag/selection controller. Real owning ScrollHandles still perform all end-scroll mutations and notifications.

Render stage order is not a full compositor: upstream is search -> indicator -> overlays -> selection -> flashes -> cursor/resets/diff. This corpus tests available stage composition and does not stub a complete doRender host into existence.

## Boundary observations

height=0 in compositeFlashes means slice(-0)=slice(0); all entries remain, without imposing doRender's max(1) wrapper. A missing/empty stack does not pad a short input screen. The label cannot reserve the scrollbar cell. Only drawing clears the last hit rectangle; stale clicks use the current primary/implicit ScrollView and retain the old rectangle until redraw. ScrollView's own render precedes the explicit requestRender (two calls when scroll state changes; one otherwise).

Manual negative origins are observable upstream. Negative columns retain the signed overlay end when extracting base text, not max(0,column). Negative row writes become named JS array properties; Rust IndicatorOutput.negative_row exposes that property separately from screen Vec rows. Rust does not preserve arbitrary input array properties/identity, fractional dimensions, nonfinite numbers or lone UTF-16 surrogates. Render frame dimensions/sizes are representable integer cells. Label errors propagate via Result and clear the rectangle; callbacks must not reenter their owner.

## Construction failures preserved

The initial observer incorrectly assumed LayoutFrame.boxes; upstream uses a root tree. First complete output also exposed an incorrect overlay service response (undefined instead of {hit:false}). Both were fixed before fixture installation/Rust tests, and preserved in validation/component-screen-widgets-initial-oracle-forensics. Initial failure log filename accidentally says 2204; actual timing is before 22:02:29, not inferred from the name. First Rust compile failed for a missing test-only return lifetime, not a production/fixture mismatch; first-test source and corpus are preserved separately. No accepted expected output was changed to pass Rust tests.
