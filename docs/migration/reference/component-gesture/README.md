# Component gesture actual-source oracle

Run from the pi-rust root (offline):

```powershell
& C:/Users/13063/anaconda3/node.exe docs/migration/reference/component-gesture/run.mjs
& C:/Users/13063/anaconda3/python.exe docs/migration/tools/verify_component_gesture_oracle.py --previous ../.migration-handoff/checkpoint-2026-09-24-component-routing
cargo test --offline --lib tui::tests::component_gesture -- --nocapture
```

The bootstrap checks upstream HEAD `5901446094988aa5cd8e11efdaa131c3949106f1`, copies 22 complete source modules to ignored `target/component-gesture-oracle`, and executes the **real** `TuiAltScreen` class under Node 25.8.2 type stripping. It does not extract/rewrite the algorithm or edit `pi`. One pre-cached dependency, get-east-asian-width 1.6.0, is copied offline. Generated output is separate from committed/working-tree expectations; the verifier is read-only and checks bytes, hashes, source provenance, counts and any inherited prefix. Test files listed as references are hashed, **not executed**. Full native alt-screen tests still require unavailable @xterm/headless.

## Executed behavior vs controlled inputs

- Actual `handleMouseEvent`, `applyMouseDispatchResult`, `dispatchMouseToTarget`, `createMouseEvent`, click counting and gesture clearing execute unchanged. Real Container/renderLayoutFrame/dispatchMouseToLayout and dispatchMouseEvent supply nested owning targets, stale-frame geometry and parent focus delegation.
- Leaf callbacks are input probes returning flags or explicit forwarded dispatch results. Search, overlay hit/result, focus resolution/application, indicator/scrollbar/hover, paste and selection callbacks are controlled host seams. Traces record their invocation and event data; they are not the full implementations of those features. A deliberately adversarial hit=false+result overlay seam tests expression/control-flow ordering and is not a naturally rendered overlay claim.
- Lifecycle cases execute actual `handleViewportInput(FOCUS_OUT)`, `beforeTerminalStart` and `beforeTerminalStop`, but compare **only the component-gesture state projection**; non-gesture lifecycle effects are disabled/suppressed. No terminal start/stop/OS IO, real timers, pixel operations or lifecycle completeness claim. Stop preserves component click history, while focus-out/start clear it. The actual source, not the previous broad plan, defines this distinction.
- Time is injected through Date.now with a finally-restored override. All timers are controlled; no sleeping, network, credentials or paid API calls. Callback order and state snapshots are compared after every step, including control input changes.

## Production API boundary

`ComponentGesture` owns capture, press target/point/moved and click history, and executes required synchronous `ComponentGestureHost` callbacks in source order. Active gestures pre-empt host routes. Capture wins over press target. Concrete target and old geometry survive removal; paths are never identities. Release dispatch precedes click counting/dispatch, their render results OR together, click flags are never short-circuited, and clear happens before scheduling render. Explicit render=false overrides focus changes/defaults. Overlay hit+decline blocks layout but still reaches paste/selection fallback. Scrollbar hover is tested after current drag state, not a stale pre-call snapshot.

This API is not wired into the existing index-based screen/alt_screen/OS loop. Host methods have no default no-op implementations: integration must supply the actual focus/overlay/search/selection/paste/viewport state. Feed non-wheel parsed SGR here; the real viewport dispatcher routes wheels separately and can reuse apply_dispatch_result. Lifecycle hooks clear only gesture state, not host timers/selection/terminal resources. Rc/RefCell ownership is single-threaded and non-Send; do not capture it in ScrollView worker callbacks. Arbitrary JS reentrancy, mutable JS target-object aliasing/getters/prototype edits, non-boolean flags, absent-vs-false, unbounded/non-finite geometry and i64 overflow are not new equivalence claims. Existing UTF-8, timer, Kitty and legacy-host boundaries remain.

## Verified input coverage (157 cases / 553 steps)

| Group | Cases | Steps |
|---|---:|---:|
| gestures | 70 | 227 |
| routes | 66 | 181 |
| clicks | 8 | 75 |
| retained | 9 | 43 |
| lifecycle | 4 | 27 |

Five Rust differential test functions compare every value, gesture snapshot and ordered callback trace. Four additional Rust contracts verify that press/capture/click history hold removed components for exactly their documented lifetime, dropping the controller releases active ownership without a global registry, and a callback may edit its parent and still receive release/click after removal. The first 143 cases/498 steps passed before append; their five arrays were verified to be unchanged prefixes when 14 more cases were generated from actual source.

Native source tests at tui-alt-screen.test.ts:1693–1775 were read as behavioral references (nested click-only region, focus/capture drag, consecutive click counts); they were **not run**. Important remaining behavior: a control that declines press and only accepts click is reached through **handleSelectionMouseEvent** (tui-alt-screen.ts:1303–1347), not this controller's component-owned press branch. Since selection is a seam here, this slice does NOT implement or prove click-only selection fallback, drag-to-copy, URL opening or clipboard integration. Next integration must preserve that distinction.
