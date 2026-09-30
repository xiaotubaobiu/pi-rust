# Owning component / Container / layout mouse routing: actual-source oracle

Authority: read-only pi HEAD `5901446094988aa5cd8e11efdaa131c3949106f1`.
Bootstrap copies 22 complete actual modules, adding `components/mouse-region.ts`
to the previous dispatch bootstrap. Node 25.8.2 strips TypeScript and uses the
offline get-east-asian-width 1.6.0 dependency. No network, credentials, OS input,
source extraction or reimplementation is used to produce expected results.

## Actual execution and controlled inputs
- Real Container.render/handleMouse/add/remove/clear/invalidate and optional
  handleInput presence; real MouseRegion child-first fallback.
- Real HStack/VStack/ScrollView direct rendering and inherited Container handling.
  Real renderLayoutFrame and TuiAltScreen.dispatchMouseToLayout/dispatchMouseToTarget.
- Leaf render/mouse/input/invalidate callbacks and explicit geometry mutations are
  inputs. Aliased boxes are made to overlap by explicit clip/layer mutations;
  those overlap scenarios are NOT claimed to arise naturally from that layout.
- The terminal is inert, with write/start throwing if reached. Timers are inert
  to avoid OS/background work. Full gesture/focus/overlay/search/selection/paste,
  scheduling and OS loops are not exercised.
- Three native test files are consulted and hashed, NOT executed. Complete native
  alt-screen tests still require unavailable offline @xterm/headless. The separate
  existing layout bootstrap executes its actual 15 upstream layout tests.

## Corpus and tests
| Group | Cases | Sequential steps |
|---|---:|---:|
| containers | 8 | 676 |
| layouts | 34 | 728 |
| mutations | 8 | 70 |
| regions | 20 | 60 |
| directLayouts | 7 | 53 |
| Total | 77 | 1,587 |

Each step compares both value and ordered callback trace. Five Rust differential
tests cover every case/step. Eight additional Rust-only contract tests cover:
distinct zero-sized objects/aliases/live hidden paths; retained removed objects
and weak release; Container snapshot lifetime; releasing the parent borrow before
child callbacks and observing current focus delegation; releasing MouseRegion's
borrow before forwarding; ScrollView child replacement; zero-width identity and
borrow-only frame boundaries; sparse hooks and explicit shared render cache IDs.
These eight are not additional JS-number or arbitrary-reentrancy equivalence claims.

The initial 70-case/1,534-step corpus passed before adding directLayouts. All four
initial arrays were equality-checked unchanged when appending that new group;
no expected result was edited to satisfy Rust. The bootstrap scope metadata was
corrected before initial fixture installation. The first cargo check failed with
E0502 (cache ID lookup while passing a mutable component); computing the cache ID
before the call fixed the borrow ordering without changing expectations.

## Rust architecture and caller contract
- `ComponentHandle` is a single-threaded `Rc<RefCell<dyn Component>>` owning handle
  with a monotonic ID. Clone preserves identity; equal IDs never come from paths,
  array indices or unowned addresses. Typed shared constructors, Box unwrapping
  and weak handles are provided. This is distributed ownership, not a global registry.
- To render an interactive frame, pass a ComponentHandle root to
  render_layout_frame. Context borrows the underlying concrete component locally;
  no RefMut escapes as a LayoutNode, no unsafe code is needed, and the existing
  layout/Stack allocation algorithm is unchanged. Every interactive box, including
  zero-width boxes, retains its actual handle. Bare legacy borrow-only boxes have
  `component: None` and the owning dispatcher skips them.
- Explicit existing ComponentCacheId takes precedence over the handle's fallback
  ID. Measurement through a wrapper and layout of its underlying leaf share that
  cache identity. Bare rendering remains supported. Box adapters forward all hooks,
  including sparse lines, cache IDs, focus and key release.
- `resolve_path` walks the CURRENT live tree, including hidden Stack indices,
  Container children, ScrollView child and MouseRegion child. It does not recover
  old identities. Retained frames and saved targets dispatch their owning handles
  with saved geometry, never re-resolve current paths.
- `Component::mouse_action` is the composite-aware companion to the old flag-only
  handler. ComponentHandle::dispatch releases the parent RefCell borrow before
  forwarding; Container checks current input-handler presence after the callback.
  Custom layout-node handlers must explicitly return false from
  uses_container_mouse_handler. The old screen/flag-only dispatcher is not wired
  to this new composite host path and cannot preserve nested target information.
- Container caches owning child/height snapshots on render; add/remove/clear/
  invalidate do not discard them. Width-mismatch dispatch measures ALL current
  children before routing, without replacing the cache. It clips y, not x, stops
  at the selected child even if declined, and can delegate only the focus target.
  Stack/ScrollView direct inherited handlers have no Container render cache and
  measure all children at event.width, even hidden entries; layout routing skips
  these inherited handlers but not custom overrides.
- MouseRegion is opaque to layout, calls its child first, and invokes its own
  callback only on decline/render-only. Child concrete target/focus is retained.

## Remaining boundaries
No integration into the legacy index-based screen host or the complete alt-screen
component capture/press/release/click/focus/overlay/selection/OS loop. Focus/capture
flags are returned, not applied. Wheel/scrollbar primitives remain separate.
Owning handles are not Send/Sync; do not move them into ScrollView worker callbacks.
A host event queue/scheduler is still needed. Own-callback/render reentry of an
already borrowed component is unsupported (RefCell panics); child-mouse-to-parent
mutation is specifically tested, not arbitrary JS reentrancy. Use weak back-links
to avoid strong cycles. Arbitrary JS property getters/dynamic prototype changes,
extra fields/absent-vs-false flags, UTF-16 component strings, non-finite dimensions
and resource-exhausting inputs are not covered. i64 saturation is a safety policy,
not a JS extreme-number equivalence claim.

## Reproduce (from pi-rust)
```powershell
$env:PYTHONIOENCODING='utf-8'
& C:/Users/13063/anaconda3/node.exe docs/migration/reference/component-routing/run.mjs
& C:/Users/13063/anaconda3/python.exe docs/migration/tools/verify_component_routing_oracle.py --previous ../.migration-handoff/checkpoint-2026-09-24-mouse-dispatch-foundations
cargo test --offline --lib tui::tests::component_routing -- --nocapture
```

The generator writes only target; the read-only verifier checks byte identity,
source/generator/reference-test hashes, per-case step counts and prior case
prefixes without installing or updating any expectations. Full gate/protection
logs and authoritative status are in HANDOFF.md and docs/migration/WORK_LOG.md.
