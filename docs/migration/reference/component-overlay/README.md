# Owning overlay mouse actual-source oracle

Run offline from the pi-rust root:

```powershell
& C:/Users/13063/anaconda3/node.exe docs/migration/reference/component-overlay/run.mjs
& C:/Users/13063/anaconda3/python.exe docs/migration/tools/verify_component_overlay_oracle.py --previous ../.migration-handoff/checkpoint-2026-09-24-component-gesture
cargo test --offline --lib tui::tests::component_overlay -- --nocapture
```

The bootstrap checks upstream HEAD `5901446094988aa5cd8e11efdaa131c3949106f1`, copies 22 complete actual modules into ignored `target/component-overlay-oracle`, and runs the real TuiBase/TuiAltScreen classes using Node25.8.2 type stripping. It never rewrites/extracts the algorithms or edits pi. The pre-cached get-east-asian-width1.6.0 dependency is copied offline; no network, paid API, credentials, terminal IO or real timers. Generators write separate scratch outputs. The verifier only compares bytes/provenance/prefixes and never installs expectations.

## Executed source and controlled inputs

- Actual TuiBase `containsComponent`, `isOverlayVisible`, `resolveMouseFocusTarget`, `dispatchMouseToOverlay` execute unchanged. Real Container/MouseRegion dispatch preserves nested concrete targets. Actual TuiAltScreen `handleMouseEvent`, `applyMouseDispatchResult`, target dispatch and click counting execute in composition cases, using the actual overlay helpers rather than the prior overlay/focus-owner seams.
- Current stack entries, hidden/visibility predicates, explicit rendered rectangles/order, leaf responses and tree edits are INPUTS. Rectangles are not claimed to arise from natural overlay rendering. In particular, negative/zero rectangles and current/rendered ordering mismatches test helper behavior; the full compositor's geometry/focusOrder sorting is not ported here. Show/hide/unfocus APIs and full focus-restore state are not executed in this oracle.
- Visibility predicates log invocation/dimensions and may have controlled values changed between steps. Hidden entries short-circuit them; owner lookup evaluates visibility before structural containment, in reverse current stack order. nonCapturing/focusOrder inputs are deliberately varied because neither affects these helpers. A renderer must supply actual visual-order rectangles separately.
- Gesture composition executes real overlay dispatch/resolution, but `setFocus` is still assignment+trace, not TuiBase's blocked/eligible/resume/ancestor/preFocus/mounted state machine. Search, viewport, paste, selection, render scheduling and clock are explicitly controlled host seams. A layout fallback logs and declines. This is not full legacy screen or OS-loop integration, or click-only selection fallback.
- Three native reference files are hashed, NOT executed: tui-alt-screen.test.ts, mouse-components.test.ts and virtual-terminal.ts. Full native alt-screen tests remain unavailable offline without @xterm/headless. They must not be counted as passed tests.

## Production API

`component_overlay.rs` exports current `ComponentOverlay` entries (owning handle, hidden flag, optional required-on-use visibility callback), retained `RenderedComponentOverlay` rectangles, `contains_component`, `resolve_mouse_focus_target` and `dispatch_mouse_to_overlay`. A host can call the latter two from the existing required ComponentGestureHost methods; the differential host does this and matches actual TS composition.

`Component::is_container_component` explicitly models structural `instanceof Container`, independent from `uses_container_mouse_handler` or layout-node availability. Container, H/VStack and ScrollView opt in, Box/ComponentHandle forward the hook. MouseRegion and arbitrary wrappers do not opt in even though they expose a mouse child. Custom Container subclasses must preserve this marker even if they override mouse handling. Containment is live, includes hidden children, does not render, and releases parent borrows before descending.

Current visible stack order determines focus ownership. Last-rendered rectangle order determines pointer hit. The first hit returns even when its component has no handler or declines; it does not recheck current visibility or membership. For focus=true only, the overlay component replaces focusTarget; concrete target/capture/geometry remain unchanged. Stale frame/capture ownership is released by ordinary Rc lifetimes, with no global registry.

Supported inputs are finite integer cell coordinates/sizes and stable component/entry identities during a helper call. Coordinate retargeting retains the existing i64 saturation boundary. Bounds use i128 intermediates to avoid overflow, not to claim parity for JS extreme/unsafe-number geometry. No cyclic component trees, arbitrary JS getter/prototype/array mutation, mutable entry.component aliasing or self-reentrant RefCell access claim. Callbacks and handles are single-threaded/non-Send; use a host event queue instead of passing handles to ScrollView worker threads.

## Corpus (67 cases / 1507 steps)

| Group | Cases | Steps |
|---|---:|---:|
| ownership | 13 | 310 |
| visibility | 8 | 75 |
| hits | 29 | 958 |
| mutations | 7 | 86 |
| gestures | 10 | 78 |

Five Rust differential functions compare each value, full gesture/focus state projection and ordered callback trace. Five independent Rust contracts cover nested Box/handle structural forwarding, separate current/frame/capture lifetimes, a child removing itself during overlay dispatch, containment without rendering hidden Stack/Scroll children, and safe extreme integer edges (not JS parity).

The first63 cases/1461 steps passed in Rust before append. Four further source-derived cases were appended and all five prior arrays checked as identical prefixes. Initial bootstrap failed because the new harness reversed dispatchMouseToTarget(event,target); this was corrected before any expectations were installed. Initial Rust compilation needed an explicit Objects type for the new test map (E0282); no production/oracle expectations were changed for it. Full command output and exact timings are in docs/migration/validation; final whole-project gate authority is HANDOFF/WORK_LOG.
