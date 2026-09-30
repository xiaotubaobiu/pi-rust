# Component mouse dispatch foundations: actual-source oracle

Authority:read-only pi HEAD `5901446094988aa5cd8e11efdaa131c3949106f1`.
Bootstrap copies21 complete actual modules (the earlier20 plus SelectList),uses
Node25.8.2 TypeScript stripping and offline get-east-asian-width1.6.0.No network,
credentials,OS input or source extraction/reimplementation.

## What is actually invoked
- Exported tui.ts dispatchMouseEvent and retargetMouseEvent,with controlled
  component return values as inputs. Expected results are canonicalized only
  for optional flags and object-handle serialization;forwarded targets must be
  the same JS object,checked by the generator before serialization.
- Real TuiAltScreen createMouseEvent and handleMouseEvent event classification.
  There is no current layout or overlay so actual hit helpers return empty;
  only right-click paste and text-selection fallbacks are disabled. The real
  createMouseEvent is observed/wrapped,not replaced with a second normalizer.
- Real applyMouseDispatchResult return/render decision;focus resolution/read/write
  are controlled host seams. The corpus does NOT prove focus/capture side-effect
  integration (the Rust method covers only the render-decision expression).
- Real getComponentClickCount with injected Date.now;clears reset its actual
  lastComponentClick field. Includes500ms/501ms,backward clock,identity/cell changes,
  count cycle1/2/3/1 and explicit resets. All180 actions replay on one tracker.
- Actual Input and SelectList boundary consumers,with inert theme/callback trace.
  Input cursor comparison uses the text prefix (JS UTF16 vs Rust UTF8 offsets),
  not incorrectly comparing incompatible raw indices.
- Three native test files are read+hashed,NOT run. Full native alt-screen tests
  need unavailable offline @xterm/headless. No xterm/OS/full-gesture assertion.

## Corpus / Rust tests
3096 explicit normalized events;512 actual raw classifications;158 dispatch
cases (including12 pre-dispatched targets);216 retarget cases;72 render decisions;
180 click actions;108 signed Input cases;48 SelectList numeric cases:4390 entries.
Eight Rust test functions:seven differential groups (create/raw share one) plus
an explicit Rust ownership/overflow-domain test. The latter is not an upstream
claim. Every dispatch case invokes its callback exactly once without changing
the supplied event;retarget preserves original metadata/optional fields.

## Rust changes and API
- TuiMouseEvent.x/screen_x/screen_y are now i64 (y already was);wheel_delta is
  Option<f64>,preserving fractions/NaN/infinity. The event is PartialEq,not Eq.
- Input clamps x-2 at zero before cell indexing. Actual-source inspection found
  a pre-existing SelectList discrepancy:zero/NaN wheel deltas were incorrectly
  handled as downward selection. JS truthiness now rejects both;nonzero numeric
  directions are retained. No changes to keyboard/CJK behavior or existing tests.
- MouseDispatchTarget<T>/MouseDispatchResult<T> carry exact saved origin/bounds,
  concrete recipient and optional delegating focus target. MouseHandlerResult
  distinguishes direct flags from an already dispatched nested target;the latter
  passes through without recomputing target/focus/flags. Direct capture/focus
  imply handled;render-only does not imply handled.
- dispatch_component_mouse adapts today's Component flag-returning interface;
  dispatch_mouse_event accepts nested forwarding callbacks. retarget_mouse_event
  uses saved origin/bounds,not current geometry (including negative local cells).
- create_mouse_event/decode_mouse_button/mouse_event_type and
  ComponentClickTracker expose tested helpers. wants_render takes the host's
  actual focus-changed decision;explicit false overrides all defaults.

## Identity and domain contracts (not full routing yet)
T must be a stable cloneable host-owned component handle,never a transient array
index/path or an unowned address. An owning handle can keep a detached component
alive while captured;the Rust ownership test exercises this.Generic storage does
NOT automatically discover component identities,resolve paths or retain arbitrary
Box<dyn Component> trees. The host's live arena/registry,Container delegation,
visited-identity routing,gesture capture/press/move/release/click state machine,
focus/overlay/search/selection/paste and OS loop still need integration.

Coordinates/dimensions are representable integer cells,not arbitrary JS numbers.
Differences saturate outside i64's representable range instead of overflowing;
that extreme-domain behavior is explicitly a Rust safety policy,not JS parity.
SGR parser retains its earlier MAX_SAFE_INTEGER boundary. Default ScrollView
worker timers remain distinct from Node single-loop scheduling.Semantics of
arbitrary object aliasing/tree mutation/reentrant callbacks are not proved.
The existing bool flag vocabulary collapses absent/false flags;arbitrary untyped
return objects,extra JS properties and property-presence introspection are not
represented. The typed forwarding variant preserves its full supported payload.

## Reproduce from Rust root
```powershell
& C:/Users/13063/anaconda3/node.exe docs/migration/reference/mouse-dispatch/run.mjs
& C:/Users/13063/anaconda3/python.exe docs/migration/tools/verify_mouse_dispatch_oracle.py --previous ../.migration-handoff/checkpoint-2026-09-24-viewport-mouse
cargo test --offline --lib tui::tests::mouse_dispatch:: -- --nocapture
```
Generator writes target/mouse-dispatch-oracle only.Verifier is read-only,checks
both artifacts,fixture counts/bytes/hash,generator and21 source+3 reference-test
hashes,and optional old case prefixes;never installs stored expectations.

Fixture 1,937,126 bytes SHA256 `5e85b83e9e121d42bd11e47c5a55798eb4e41714a8cdbe60f24600b2d7f10fde`.
Manifest 3,230 bytes SHA256 `6c7b2a3708a83fcb4ca2b4aa504e95f8b0024338c133b3234847a182861def43`.

## Evidence and status
- Entry2026-09-24-1656-mouse-dispatch-entry.log:actual16:53:05,415 archive/live
  files and evidence verified against viewport-mouse snapshot.
- 1701-mouse-dispatch-first-oracle.log:actual16:57:11,generator syntax error caused
  by authoring a literal newline inside the JS output-string literal.Fixed only
  new generator escaping before installing any expected fixtures.
- 1702-mouse-dispatch-oracle.log:actual16:57:28,generation success4390 entries.
- 1705-mouse-dispatch-first-focused.log:actual16:59:38–17:00:42,7/8 passed.
  The failure was harness JSON equality of0.0 vs actual JS JSON0,not behavior.
  Only the new event serializer now emits safe integral wheel values as JSON
  integers;oracle/expected values unchanged.1707-mouse-dispatch-focused.log
  retains the rerun and strict Clippy outcomes. All filenames have prefix2026-09-24.
- 2026-09-24T17:02:44+09:00 focused8/8 passed;strictClippy17:03:21 exit0.
- 2026-09-24 17:03:39–17:04:30 +09:00：四项严格门禁全部exit0。`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`通过；all-targets **2396 passed = 2360 lib +27 generate-models +9 pirs，0 failed，2项历史CJK ignored**；doctests **5 passed，0 failed，1项历史ignored**。完整输出：`validation/2026-09-24-1710-mouse-dispatch-full-gates.log`。这是全项目总数，本轮新增8个测试函数，不是2396个新测试。
- 17:09:39–17:10:45全部20产物（2 Dispatch+2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX）逐字节复现，前18产物未变；新验证器实际执行，21 dispatch源文件+3参考测试哈希通过；实际layout.test.ts的15个测试通过。完整alt-screen原生终端测试未执行（离线缺@xterm/headless）。30个独立ANSI-width probes与前快照一致。日志：`validation/2026-09-24-1712-mouse-dispatch-oracle-repro.log`。
- 17:12:22–17:12:23保护审计核验前415个归档文件及evidence/supplemental、163个无关继承source/build、原WORK_LOG的117062字节前缀、两个HEAD及空index；历史markdown_debug.rs删除保留，新/变更源码未引入unsafe。日志：`validation/2026-09-24-1714-mouse-dispatch-protection-audit.log`。
- Immutable checkpoint target ../.migration-handoff/checkpoint-2026-09-24-mouse-dispatch-foundations;previous
  viewport-mouse. Read external manifest.sha256/verification.json for exact
  completion/time/count/hash;do not self-embed this checkpoint's hash in files.
  Full M4 and full pi migration remain incomplete. The old viewport README's
  unsigned legacy event statement is historical,superseded by this signed API.
