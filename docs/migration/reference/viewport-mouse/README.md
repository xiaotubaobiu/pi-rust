# Viewport wheel / scrollbar actual-source oracle

Authority: read-only pi HEAD `5901446094988aa5cd8e11efdaa131c3949106f1`.
Bootstrap copies20 COMPLETE actual upstream modules,including TuiAltScreen,
TuiBase,layout,Stack,ScrollView,search/input and their imports. It does not extract
method strings or implement a second reference router. Node25.8.2 TypeScript
stripping and offline get-east-asian-width1.6.0;no network/credentials/OS terminal.

## Runtime seams and scope
- Real TuiAltScreen is constructed with an inert terminal (OS write/start would
  throw),and given real renderLayoutFrame output. Actual private methods are
  callable after TypeScript type stripping;their implementations are unchanged.
- Only setTimeout/clearTimeout,requestRender,hasOverlay and stopSelectionAutoScroll
  are controlled host seams. Time is virtual,render requests/selection-clear
  calls are recorded synchronously. No simplified ScrollView/layout/hit logic.
- Three native test files were read and hashed,NOT executed here. Full
  tui-alt-screen.test.ts/mouse-components.test.ts need @xterm/headless through
  virtual-terminal.ts,which is not in the available offline reference-deps.
  Do not confuse the new differential tests with native end-to-end terminal tests.

## Corpus and tests
- 1800 SGR/X10 parse cases:all256 button codes,press/release,zero/negative decoded
  cells,strict syntax/trailing data,modifiers/horizontal wheels,leading zeros,
  high safe-integer button masks and six UTF-16-code-unit X10 (including lone
  surrogates and surrogate pairs). UTF-8 wrappers are also tested when valid.
- 99 wheel-line normalization/Alt multiplier cases,including fractional,
  negative,NaN and infinities. Rust propagates NaN like Math.max,not f64::max.
- 145 stateful scenarios /6692 action steps. Real trees cover single/side-by-side/
  nested/primaryless/empty layouts,1-column/row edges and viewport resizing.
  Actions include wheel/Alt/outside/nested chain,primary fallback,containment,
  hidden-auto track hit/hover/expiry,thumb/track press and offscreen drag/release,
  no frame,overlay state,bar mode changes and geometry changes while captured.
- Every step compares all scroll states,visible/active/follow state,return value,
  hover identity,drag identity+grab offset,hit geometry and ordered render/selection
  callbacks. Original120 cases/6468 steps,all1800 parse and99 numeric cases stayed
  byte-semantically unchanged when25 numeric/capture cases were appended.
- Four Rust test functions:protocol differential,numeric differential,stateful
  routing differential,and explicit safe-integer-domain rejection/no-overflow.
  The last is a disclosed Rust boundary test,not a claim JS rejects those inputs.

## Rust consumer API
`src/tui/viewport_mouse.rs` exports signed SgrMouseEvent/WheelEvent and raw UTF-16
plus UTF-8 parsers;ViewportScrollMouse stores live implicit/hover/drag handles.
It consumes existing LayoutFrame rather than re-rendering or recreating scrolls.
No changes to proven layout/Stack/ScrollView implementations or prior fixtures.

- route_wheel is called AFTER overlays/components decline the event. has_overlay
  controls track hover discovery,not a global wheel block inside this method.
  Each call requests render,even if no scroll moved. Upstream contain breaks the
  hit chain but still permits a not-yet-visited primary to receive remainder.
- A new valid left-button scrollbar capture invokes the host's selection-clear
  callback before hover/scroll effects. An active drag continues through overlays,
  outside bounds and missing geometry;release ends it without extra scrolling.
  Call update_scrollbar_hover at the same outer-dispatch point as upstream;
  handle_scrollbar_mouse_event does not secretly duplicate that outer update.
- Hosts own terminal-thread scheduling,selection field resets,focus-out/stop
  cleanup and cancellation;call stop_scrollbar_drag/stop_scrollbar_hover explicitly.
  The existing injectable ScrollView scheduler is reused;the earlier default
  thread-per-activity timer is not Node event-loop equivalence.

## Explicit limitations
- New raw mouse coordinates are signed;legacy TuiMouseEvent still has unsigned
  x/screen coordinates. Safe ComponentPath routing,captured component identity,
  normalized press/move/drag/click dispatch,focus/overlay/search/text selection,
  right-click paste and full OS/input/render-loop integration are NOT done here.
- SGR decimal fields are accepted only through JS MAX_SAFE_INTEGER;greater values
  are deliberately rejected rather than rounded/wrapped. Arbitrary JS number
  dimensions,invalid frames,resource-exhausting inputs and callback/tree mutation
  remain outside this finite evidence. X10 counts raw UTF-16 units,not UTF-8 bytes.
- The actual-source fixture has no image/OS/xterm renderer assertions. This is a
  viewport-scroll consumer subset,not full M4 or full TuiAltScreen parity.

## Reproduce (Rust root)
```powershell
& C:/Users/13063/anaconda3/node.exe docs/migration/reference/viewport-mouse/run.mjs
& C:/Users/13063/anaconda3/python.exe docs/migration/tools/verify_viewport_mouse_oracle.py --previous ../.migration-handoff/checkpoint-2026-09-24-layout-viewport
cargo test --offline --lib tui::tests::viewport_mouse:: -- --nocapture
```
Generator writes target scratch only;read-only verifier compares both artifacts,
fixture size/count/hash,generator hash,20 source+3 consulted test hashes,and
optional prior fixture prefixes. It never installs/overwrites stored expectations.

Fixture6,566,877 bytes,SHA-256
`8064e2b06c05345296ad9a1941070471c52e59ea59c926f7d1b6338cc0f8ac78`.
Manifest3,021 bytes,SHA-256
`f80b25f49d07aad3fe4e3accaab314b48d3230e576488bf00348301275c97440`.

## Evidence
- 2026-09-24-1629-viewport-mouse-entry.log:actual entry16:25:58;398 prior files
  and evidence verified against layout-viewport snapshot;no prior source changes.
- 2026-09-24-1633-viewport-mouse-first-oracle.log:actual16:29:10,120 scenarios.
- 2026-09-24-1635-viewport-mouse-final-oracle.log:actual16:30:45,145 scenarios,
  all initial prefixes retained before installing the new corpus.
- 2026-09-24-1640-viewport-mouse-first-differential.log:actual16:35:13–16:35:47,
  initial compile error was a test passing Option<RequestRender> to a required
  RequestRender parameter. Fixed only the new harness call;oracle unchanged.
- 2026-09-24-1641-viewport-mouse-focused.log:four focused tests pass;strict Clippy
  follows in the same log. Exact times inside logs override filename labels.
- Whole-project gates,reproduction/protection and final checkpoint metadata are
  recorded in HANDOFF/WORK_LOG and external immutable manifest/verification.

## Final verification 2026-09-24T16:49:41+09:00
2026-09-24 16:42:50–16:43:42 +09:00: four strict gates PASS. `cargo fmt --all -- --check`, `cargo clippy --offline --all-targets -- -D warnings` exit0; all-targets **2388 passed = 2352 lib +27 generate-models +9 pirs,0 failed,2 historical CJK ignored**; doctests **5 passed,0 failed,1 historical ignored**. Full output:`validation/2026-09-24-1643-viewport-mouse-full-gates.log`. Whole-project total,not2388 new tests;this slice adds4 test functions.

At16:44:09–16:45:18 all18 artifacts (2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX) reproduce byte-identically;20 mouse source+3 consulted native-test hashes verified;all15 actual upstream layout tests pass. Native full alt-screen tests were NOT executed (@xterm/headless unavailable offline). New verify_viewport_mouse_oracle.py was actually run. Log:`validation/2026-09-24-1647-viewport-mouse-oracle-repro.log`. At16:46:13–16:46:14 protection audit verified prior398 files/evidence/supplemental,163 unrelated inherited source/build files,HEADs,empty index and old WORK_LOG prefix;30 independent ANSI-width probes unchanged. Log:`validation/2026-09-24-1648-viewport-mouse-protection-audit.log`.

Focused log strict Clippy exit0 at16:37:54. Initial test-only compile failure remains
recorded;no expectation changes were made to obtain green. This slice's immutable
checkpoint is ../.migration-handoff/checkpoint-2026-09-24-viewport-mouse (from Rust
root);previous layout-viewport has398 present files and manifest
0c16c15740ea17b11001eb23b2b733ad3f17fbebf42be892a6f7cbb06a0672bc.
Read external manifest/verification for current count,time and hash;do not modify
snapshots. Only inherited source edits are module registration in mod.rs/tests.rs.
Next:safe component dispatch/capture/focus,not rewriting validated scroll logic.
