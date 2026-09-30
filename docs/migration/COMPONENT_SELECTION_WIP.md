# Component selection — 已验证切片记录

更新时间：2026-09-24T20:36:36+09:00（Asia/Seoul）。**goal active；全量迁移未完成。** 2026-09-24 11:30截止已履行并封存，后来获授权继续，目前没有新截止。

此文件名中的WIP仅为历史入口。本切片代码与测试已通过；最终封存只认checkpoint manifest/verification及外部独立收据。它不是全量迁移完成声明。

- 新 `ComponentSelection` owning控制器：anchor/focus/range/scroll身份、character/word/line粒度、500ms click cycle、pressActive/dragged/URL、drag pointer/direction/50ms interval。controller不可Clone，避免复制timer token。
- 已移植scroll/content/clip坐标、word与`/`/`-`连接、line range、granularity focus更新、反向选择、grapheme-cell边界、ANSI剥离与JS trimEnd、active text、自动滚动start/stop/tick（真实ScrollHandle::scroll_by）。clear保留selection click history；完整start/stop/focus-out重置仍需host接线。
- 完整press/move/release分支，URL激活优先，URL Result::Err忽略。click回退先Overlay，hit+decline不穿透layout；有result时真实apply_dispatch_result→clear→条件render，无result时copyOnSelect启动投递→render。普通release已被组件处理时不会到selection回退，这不是异常。
- Gesture的必需selection回调新增`&mut ComponentGesture`，使release-click capture在同一个live controller中同步保留。只改此signature/call/2行doc及三个旧测试host的unused参数；原算法/旧expected不变。宿主测试用Option::take短暂拥有Selection，避免跨callback借用；不支持自身重入。
- `ComponentSelectionHost`无默认空实现；外部服务包括frame/screen/live hasOverlay、Intl-equivalent分词、unreferenced interval调度/取消、URL opener、开始clipboard投递。`request_copy_active_selection`的bool仅表示已发起投递，不是系统剪贴板成功。宿主必须在drop前停止timer，取消过期队列tick；不能在ScrollView worker上操作ComponentHandle。
- 实际完整TuiAltScreen/TuiBase/ScrollView/Layout/MouseRegion/Container源码oracle，22模块与4参考测试文件哈希。**194场景/1707步**：basic29/123、ranges89/326、scroll26/219、urls13/55、composed21/152、sequences16/832。逐步比较return、全部Selection状态、bounds/text、scroll top/follow、Focus flags、Gesture capture/history与有序trace。
- Rust真实复用Focus/Overlay/Gesture/layout/scroll，不以id路由或flags模拟替代。6差分函数+3ownership契约=9项；含scroll anchor脱离registry/frame仍owning、同一live gesture回退capture及真实frame替换、独立controller timer/history。20个Intl segment输入是外部服务输入，不是从expected selection ranges反喂答案，更不是Rust ICU引擎已移植。
- 初始175/1619及随后193/1698已通过的全部6组都是最终fixture相等前缀，19→20个外部分词输入也保留。初始错误frame fixture/generator及已通过175/193两版fixture+manifest都已留portable forensic备份。

2026-09-24 20:27:16–20:28:44 +09:00四门禁全部exit0：`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。all-targets **2447 passed =2411 lib+27 generate-models+9 pirs，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本切片新增9个函数，不是2447个新测试。日志：`docs/migration/validation/2026-09-24-202716-component-selection-full-gates.log`。

20:28:54–20:30:06，22串行oracle命令全部exit0；**30产物**（2 Selection+2 Focus+2 Overlay+2 Gesture+2 ComponentRouting+2 Dispatch+2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX）逐字节复现，旧28与component-focus快照字节相等；30 ANSI-width probes一致，真实layout.test.ts的15测试通过。完整native overlay/alt-screen suite仍未执行，离线缺@xterm/headless；4个selection参考测试文件只读/哈希不算执行。完整命令与输出：`docs/migration/validation/2026-09-24-202854-component-selection-oracle-repro.log`。

20:31:42–20:31:43新selection-specific保护审计PASS：前514 archive/evidence/supplemental不变，179个非allow-list继承source/build不变，两个HEAD不变、两个index空、历史删除保留、新/变更源码无unsafe。6项继承源码逻辑diff严格受限；旧28产物、两版passed prefixes、失败修复前已通过3组及失败3组输入不变均核验。命令`python docs/migration/tools/audit_component_selection.py`；日志`docs/migration/validation/2026-09-24-203142-component-selection-protection-audit.log`。文档收尾后再审计，以最终收据和快照verification为准。

1. `2026-09-24-201410-component-selection-initial-tests.log`：新Rust harness E0282 registry类型推断、E0596 indexed mutable render。只修显式类型和短with_mut借用，production/generator/expected不变。
2. `2026-09-24-201507-component-selection-tests-compile-retry.log`：3组通过、3组失败。新JS手工frame发布漏了actual LayoutBox独立scrollView字段；对照layout.ts:23–34/152–161/427–450后仅修新frame seam，重新运行真实源码。未改Rust production或手写expected。初始通过basic/ranges/composed保持相等，scroll/urls/sequences输入保持相等。`2026-09-24-201735-component-selection-frame-schema-retry.log`：175/1619、6组通过。
3. `2026-09-24-202005-component-selection-append-writer-diagnostic.log`：追加writer标记在node builder和step中各命中一次导致AssertionError；之前已保存初始通过备份/追加generator/两行doc，未安装fixture/写Rust test。缩小至fn step后完成。该文件是诊断记录，不伪称原始工具transcript。
4. `2026-09-24-202116-component-selection-appended-tests.log`：193/1698全部差分+2契约通过，第三契约错误假设普通handled release仍会进入selection click回退，unwrap失败。原名actual-renderer-owning-capture-after-fallback场景保留不改，作为“release拦截”反例；追加click-only真正回退+frame替换场景，再验证正反对照。`2026-09-24-202633-component-selection-capture-contract-retry.log`：194/1707与全部9函数通过，所有旧passed前缀/segments不变。production未因这次错误契约改动。
5. 初次只读定位误猜工作区根AGENTS（不存在），随后使用真实pi-rust/AGENTS；未写文件。历史focus及更早失败记录仍在WORK_LOG/validation/不可覆盖快照，不抹除。

- 当前checkpoint入口/目标：`../.migration-handoff/checkpoint-2026-09-24-component-selection/`；是否封存以实际manifest.json、manifest.sha256、verification.json及外部独立收据为准；缺文件即未封存。不把本次manifest hash写入其自身收录文档。
- 本轮previous为**component-focus**：2026-09-24T19:54:08+09:00，514 present files，manifest SHA256 `d1f94a38d70f8d01ac2159d0757c6b413f295a7a5838e5f23bf563d826f0c138`；独立收据`../.migration-handoff/component-focus-independent-verification-20260924-195513.json`。不可覆盖它。
- 本轮6项继承source allow-list：`src/tui/mod.rs`、`src/tui/tests.rs`仅module声明；`src/tui/component_gesture.rs`仅selection callback signature/call/2行doc；`src/tui/tests/component_gesture.rs`、`component_overlay.rs`、`component_focus.rs`仅接收unused live-gesture参数。179项非allow-list继承source/build逐字节不变。
- 新源码仅`src/tui/component_selection.rs`、`src/tui/component_selection/fixtures.json`、`src/tui/tests/component_selection.rs`；新reference/component-selection四文件、verifier/audit、validation日志/forensics与交接文档。未改Cargo/依赖、旧算法/fixtures、legacy host或pi。
- WORK_LOG只能binary UTF-8 append；本轮188843-byte保护前缀SHA256 `aab4eb10280fb41045bc29c024ea288501fd9eea796c59ad1e6eabf129743ce9`；171829/155716/143371/128257历史前缀也已核验。WORK_LOG与TUI账本各4个历史U+FFFD保留。
- 必须关闭会变化的日志再建checkpoint，不能把checkpoint命令tee进repo log；之后独立核验archive/live/evidence/supplemental/root/HEAD/index，收据只写workspace .migration-handoff。快照是dirty-worktree backup不是完整仓库；干净tracked docs/ROADMAP.md不在archive，不能盲用patch恢复。根交接仅workspace/MIGRATION_HANDOFF.md。

下一切片优先**selection paint/highlight**，先读真实`tui-alt-screen.ts:1383–1422、1553–1617、1658–1673`及对应测试，复用已验证Selection bounds/columns、ScrollHandle身份与layout。实现实际applySelectionHighlight/applySelection，保留ANSI SGR后重新inverse、OSC/DCS/图片行、grapheme/clip/scroll投影语义；scroll投影可能是负screen row/col，不能直接塞回usize selection point而提前clamp。用真实源码新oracle与renderLayoutFrame组合验证，不能以style flag或identity返回冒充paint完成。完整compositor仍另算；clipboard异步成功/flash/OSC52在后续独立切片。详见NEXT_SLICE_PLAN.md。

## 原始进入记录（历史，不是当前WIP）

# Component selection WIP

Entry 2026-09-24T20:03:00+09:00; previous component-focus snapshot is authoritative until new gates and checkpoint exist.



### 2026-09-24T20:03:00+09:00 — component-selection entry / WIP (not yet validated)
Previous authoritative checkpoint: component-focus, manifest d1f94a38d70f8d01ac2159d0757c6b413f295a7a5838e5f23bf563d826f0c138. Reverified all514 archive/live files, evidence/supplemental/root, both HEADs and empty indices. WORK_LOG protected prefix188843 bytes SHA256 aab4eb10280fb41045bc29c024ea288501fd9eea796c59ad1e6eabf129743ce9. 179 non-allow-list inherited source/build files will remain unchanged.
Serial only; pi read-only; pisper untouched; no Git mutation, paid API or unsafe. Original11:30 cutoff historical; continuation active without new cutoff per AGENTS.
Scope: owning selection points/scroll identity, press/move/release, range/granularity/click cycling, scroll geometry/autoscroll tick, text extraction, URL priority and actual Gesture/Overlay/Focus composition. Word segmentation is a required external host service (Intl segment corpus in tests, not a claim that ICU segmentation is ported); timer scheduling, URL launcher and async clipboard delivery/flash/OSC52 remain explicit required host seams. No default empty callbacks.
Minimal inherited source allow-list: src/tui/component_gesture.rs, src/tui/mod.rs, src/tui/tests.rs, src/tui/tests/component_focus.rs, src/tui/tests/component_gesture.rs, src/tui/tests/component_overlay.rs. Gesture selection callback gains access to the live gesture controller for synchronous release focus/capture effects; three old test hosts accept the parameter without changing expected behavior. mod/tests only add declarations. No old algorithms/fixtures or dependency changes. New namespace actual full source oracle; old28 artifacts preserved.
Read-only discovery correction: first command guessed workspace-root AGENTS.md, which does not exist; subsequently read actual pi-rust/AGENTS.md. PowerShell missing-file error did not write files. Some combined read outputs truncated; important source sections were re-read in smaller ranges before implementation.
Next: implement, differential fixtures/tests, four gates, all old oracles, protected-source audit, Markdown handoff, immutable snapshot and independent verification. Do not present this WIP as accepted.


### 2026-09-24T20:39:13+09:00 — final handoff/source audit receipt
Final document/source protection audit PASS 2026-09-24T20:38:32+09:00. All9 source-scope raw-byte hashes remain identical to the first passing protection audit; all501 non-allow-list inherited source/build/docs/validation files remain byte-identical. UTF-8/history/root-path checks passed; AGENTS archive unchanged and clean tracked ROADMAP matches HEAD (not a dirty-snapshot file). Log: docs/migration/validation/2026-09-24-203831-component-selection-final-audit.log. Reproducible read-only wrapper: docs/migration/tools/audit_component_selection_handoff.py. Only this receipt is appended after those checks; no production/test/fixture changes. A final-state read-only audit will run on these receipts before checkpoint creation; all logs must be closed, and checkpoint must run without tee. Component-selection manifest/verification and external independent receipt remain sealing authority; full migration incomplete, goal active.
