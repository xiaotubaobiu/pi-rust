# Component selection actual-source oracle

Runs the real `TuiAltScreen` selection and mouse methods, real `TuiBase` focus/overlay methods and real layout/ScrollView/MouseRegion/Container classes from sibling pi at `5901446094988aa5cd8e11efdaa131c3949106f1`. The bootstrap copies22 complete source modules; it does not rewrite their algorithms or mutate pi. Node v25.8.2 executes TypeScript via --experimental-strip-types. The only offline npm dependency is get-east-asian-width1.6.0, copied from the workspace reference-deps cache (or existing scratch fallback as checked by run.mjs).

## Run and verify

From pi-rust, invoke the configured Node/Python binaries (this workstation: C:/Users/13063/anaconda3/node.exe and python.exe):

```text
node docs/migration/reference/component-selection/run.mjs
python docs/migration/tools/verify_component_selection_oracle.py --previous ../.migration-handoff/checkpoint-2026-09-24-component-focus
cargo test --offline --lib tui::tests::component_selection -- --nocapture
python docs/migration/tools/audit_component_selection.py
```

`run.mjs [pi-root] [reference-deps-root] [scratch-root]` writes only generated scratch output; scratch inside pi is rejected. The default scratch is target/component-selection-oracle. The verifier is read-only: it checks source/generator/test hashes, counts and both artifacts byte-for-byte against accepted repo files. It never installs expectations. Optional --previous compares older selection arrays when present. The audit also checks independent initial175/193 passed forensic prefixes, protected source/build files, gate/repro logs, HEAD/index and WORK_LOG prefixes. Do not rerun install scripts blindly.

## Cases and host seams

| Group | Cases | Steps |
|---|---:|---:|
| basic |29|123|
| ranges |89|326|
| scroll |26|219|
| urls |13|55|
| composed |21|152|
| sequences |16|832|
| Total |194|1707|

Snapshots include returned values, selection state/ranges/granularity/click history/timer/pointer, selected text/bounds, scroll state, focused flags, gesture target/capture/history and ordered calls. Rust executes the same operations through its real Selection/Focus/Overlay/Gesture/layout/ScrollView/MouseRegion/Container implementations. Three extra Rust tests check retained owning scroll state, release capture through the same live gesture (including negative handled-release control and subsequent frame replacement), and controller/timer/history isolation.

- Word segmentation is an **external Intl-equivalent service**, not implemented by Rust here. The actual Node Intl.Segmenter output is recorded for20 input strings; Rust receives text segments/isWordLike, not expected ranges or click counts. It computes joiners, cell widths, ranges and selections itself. This is not a Rust ICU parity claim.
- Most frames are explicit publication seams; appended cases also invoke actual renderLayoutFrame and publish its real boxes/scrollContentLines/scrollView identities. Selection events and scrollBy remain actual methods. Empty/missing frame, clipped scrolls and frame replacement are covered. No complete compositor is claimed.
- The mock scheduler records actual50ms interval start/cancel and invokes real autoscroll callbacks serially. The real source's unref semantics are represented, not Node worker scheduling. Rust host must queue to the owning thread and cancel stale deliveries/drop timers.
- Source clipboard method is replaced by a record of initiating delivery of the actual selected text; success/failure, await, flash and OSC52 are deliberately out of scope. Rust request_copy_active_selection means initiated, not delivered.
- URL opener records URLs and can fail; source catches JS throw, Rust ignores Result::Err (not Rust panic). Gesture search, indicator, scrollbar and paste are unrelated host seams. Overlay hit/order, selection release click dispatch, focus and capture use actual controllers.
- Four reference files (tui-alt-screen, overlay-non-capturing, mouse-components and virtual-terminal) are read/hashed, **not executed as native suites**. Full alt-screen tests need unavailable offline @xterm/headless. Separate layout oracle ran15 actual upstream tests.
- Finite integer cell geometry, UTF-8 component text, no arbitrary JS callback reentrancy/object-alias semantics. Range/text/selection state only; no selection painting, complete OS/terminal lifecycle or event loop.

## Failure evidence and append-only history

1. `2026-09-24-201410-component-selection-initial-tests.log`：新Rust harness E0282 registry类型推断、E0596 indexed mutable render。只修显式类型和短with_mut借用，production/generator/expected不变。
2. `2026-09-24-201507-component-selection-tests-compile-retry.log`：3组通过、3组失败。新JS手工frame发布漏了actual LayoutBox独立scrollView字段；对照layout.ts:23–34/152–161/427–450后仅修新frame seam，重新运行真实源码。未改Rust production或手写expected。初始通过basic/ranges/composed保持相等，scroll/urls/sequences输入保持相等。`2026-09-24-201735-component-selection-frame-schema-retry.log`：175/1619、6组通过。
3. `2026-09-24-202005-component-selection-append-writer-diagnostic.log`：追加writer标记在node builder和step中各命中一次导致AssertionError；之前已保存初始通过备份/追加generator/两行doc，未安装fixture/写Rust test。缩小至fn step后完成。该文件是诊断记录，不伪称原始工具transcript。
4. `2026-09-24-202116-component-selection-appended-tests.log`：193/1698全部差分+2契约通过，第三契约错误假设普通handled release仍会进入selection click回退，unwrap失败。原名actual-renderer-owning-capture-after-fallback场景保留不改，作为“release拦截”反例；追加click-only真正回退+frame替换场景，再验证正反对照。`2026-09-24-202633-component-selection-capture-contract-retry.log`：194/1707与全部9函数通过，所有旧passed前缀/segments不变。production未因这次错误契约改动。
5. 初次只读定位误猜工作区根AGENTS（不存在），随后使用真实pi-rust/AGENTS；未写文件。历史focus及更早失败记录仍在WORK_LOG/validation/不可覆盖快照，不抹除。

Selection fixture：3219396 bytes，SHA256 `78d9eb63d98493b1b84cafc800f9697a44f87367f5dd42e48a975c691f9bd2ae`。source-manifest：3639 bytes，SHA256 `30315b8042c9e13586ac52a5920f4f51f359eb295f5e996189b68321b62ba836`。

The deterministic gzip forensic copies in docs/migration/validation retain the invalid frame corpus/manifest, corrected initial175 passed corpus/manifest, and193 passed corpus/manifest. The invalid generator is retained as .mjs.txt. audit_component_selection.py verifies decoded hashes, the3 originally passing groups unchanged after schema fix, all failed-group inputs unchanged, and every175/193 passed array prefix plus segmentation inputs. The original misnamed owning-capture case intentionally remains unchanged; it now serves as a negative ordinary-release-interception control. Positive capture uses the appended click-only case, not edited expected output.
