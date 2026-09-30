# Owning focus / overlay lifecycle actual-source oracle

This directory is an offline probe of the pinned **complete upstream modules**, not a hand-written reference implementation. Source authority: `pi` HEAD `5901446094988aa5cd8e11efdaa131c3949106f1`.

## Run (from pi-rust)

```powershell
& C:/Users/13063/anaconda3/node.exe docs/migration/reference/component-focus/run.mjs
& C:/Users/13063/anaconda3/python.exe docs/migration/tools/verify_component_focus_oracle.py --previous ../.migration-handoff/checkpoint-2026-09-24-component-overlay
cargo test --offline --lib tui::tests::component_focus -- --nocapture
```

`run.mjs` copies 22 unchanged source modules and the already cached get-east-asian-width 1.6.0 into `target/component-focus-oracle`. It refuses scratch paths inside upstream, checks the pinned HEAD/dependency version, executes Node's TypeScript stripping, and generates fixture + source-manifest **only in scratch**. The verifier is read-only; it never installs expected output. No network, credentials, provider calls or OS-terminal IO. Four consulted upstream test-file hashes are provenance, **not execution** of those test suites. `@xterm/headless` remains unavailable offline.

## Actual behavior under test

- TuiBase `setFocus`/`setFocusInternal`, eligible/blocked/restore-overlay/focus-target, temporary visibility projection, mounted/ancestor checks, direct preFocus retargeting and independent entry identity.
- Real showOverlay returned handles: hide, setHidden, focus, unfocus, isHidden/isFocused/getBounds; hideOverlay, hasOverlay/isOverlayFocused. Old focused=false and new focused=true execute in source order even for identical targets. NonFocusable keyboard handlers and Focusable without keyboard handlers stay independent.
- Base handleTerminalInput's restoration block (1042–1068), exercised through the **entire unmodified method** using plain strings. TuiAltScreen's constructor adds handleViewportInput: its line725 isOverlayFocused query also runs before the base focus block. The Rust test host explicitly calls this public controller query first. This is **not** an extra query inside ComponentFocus::restore_before_input and **not** a port of all input prefilters.
- Real TuiAltScreen handleMouseEvent + component gesture + rendered-overlay dispatch + live focus ownership + real focus lifecycle. Focus methods are **not stubbed to assignment** as in the previous mouse-helper slice. Captured concrete child, current entry and stale rendered rectangle can outlive/remain independent of each other.
- Per-operation results, current focus/flags, insertion stack, **every retained entry** (including removed), raw restore state, focus counter, last bounds, gesture state and ordered setter/visibility/dimension/host traces. Visibility callbacks include changing sequences and live dimensions; hidden/no-predicate and nonCapturing short-circuiting are observable.

## Explicit seams / representation boundaries

The oracle controls mounted roots, synchronous cursor/render requests, bounds/frame publication, clock, search/viewport/selection/paste helpers. It does not run the compositor or native terminal loop. The Rust plain-input test bridge releases the component borrow, executes the scripted callback commands synchronously and only then requests immediate render; arbitrary self-reentrant RefCell input callbacks are **not supported**. ComponentFocus's required host hooks have no inert defaults, but the real legacy screen/OS host and full filters still need binding.

Rust handles explicitly take an originating controller; a foreign controller is rejected before effects (JS closures cannot express this misuse). A removed same-owner handle is **not foreign** and retains upstream method-specific behavior. `setHidden(false)` may focus/increment/render on a removed entry. Handle/component/entry identity is not collapsed. Focus counter uses f64 like JS numbers; cell bounds/dimensions use existing nonnegative Rust cell geometry. JS options-object alias mutation and arbitrary getter/array mutation are not modeled. Cyclic preFocus walks are guarded; cyclic child trees and self-reentrant callbacks are not supported. No claim that the legacy `overlay.rs` simplified focus policy is fixed.

## Failure evidence

Initial source oracle generation succeeded; all six initial Rust groups failed on extra upstream plain-input visibility probes. Diagnosis: the test host omitted TuiAltScreen's constructor-installed viewport listener query. Only the Rust test adapter was corrected; no production focus algorithm, generator, or expected fixture was changed to erase failures. See `2026-09-24-192825-component-focus-initial-tests.log` and WORK_LOG. Final evidence is recorded below; this file is not proof that M4 is complete.


## Validated evidence — 2026-09-24T19:51:12+09:00

104 cases/1768 steps: lifecycle23/198,restore25/189,visibility14/132,identity8/86,composed10/94,sequences24/1069. Six differential groups plus four Rust-only owning/foreign-owner/borrow tests passed. Initial98/1702 passed first; six additions preserved all six old array prefixes before install.

2026-09-24 19:38:22–19:39:54 +09:00四门禁全部exit0：`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。all-targets **2438 passed =2402 lib+27 generate-models+9 pirs，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本切片新增10函数，不是2438个新测试。日志：`docs/migration/validation/2026-09-24-193822-component-focus-full-gates.log`。

19:41:07–19:42:16，20串行命令全部exit0；**28产物**（2 Focus+2 Overlay+2 Gesture+2 ComponentRouting+2 Dispatch+2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX）逐字节复现，旧26与component-overlay快照字节不变。30 ANSI-width probes一致，真实layout.test.ts的15测试通过。完整native overlay/alt-screen tests仍未执行，离线缺@xterm/headless；4个focus参考测试文件只读/哈希不算运行。日志：`docs/migration/validation/2026-09-24-194107-component-focus-oracle-repro.log`。

19:42:46–19:42:47新focus-specific保护审计PASS：前493 archive/evidence/supplemental不变，180个非allow-list继承source/build不变，两个HEAD不变、index空、历史删除保留，新/变更源码无unsafe。两项继承源码diff严格只有module declaration；旧26产物、6个passed前缀证明、失败/重试日志均核验。命令`python docs/migration/tools/audit_component_focus.py`；日志`docs/migration/validation/2026-09-24-194246-component-focus-protection-audit.log`。文档收尾后再审计，以最终收据和快照verification为准。

Checkpoint target:component-focus;previous:component-overlay. See HANDOFF for exact replay commands and manifest/verification authority. Full migration incomplete.
