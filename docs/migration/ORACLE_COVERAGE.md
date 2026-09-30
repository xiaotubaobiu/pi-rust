# Pico3 oracle coverage ledger

Checkpoint: 2026-09-23 23:21 +09:00; upstream `packages/agent/test/harness/pico3/` at `590144609`.

This is a scope ledger, not a claim of complete equivalence. “Ported” means the listed Rust cases execute locally. Session-only invokers are **not** substitutes for scheduler/provider/recovery behavior. No live providers or delegated agents are used; upstream “subagent” tests refer to simulated child conversations only.

| Upstream source | Existing Rust coverage | Remaining / caveat |
|---|---|---|
| turn.test.ts | oracle_runtime_turn + oracle_runtime_queue: real scheduler, tool turns, memory/JSONL reopen, queue modes/grouping, retry/failure, controls, reset, continuation, abort partial, overflow | Named-case differential audit still required; no full public AgentHarness adapter |
| waiters.test.ts | oracle_runtime_waiters: all 3 upstream scenarios; 200 task + 50 input/idle registration iterations, cancellation isolation, undispatched work idle check | CancellationToken has no JS custom reason value; extra Gate race/cancellation/drop regression |
| spec-plugins-lifecycle.test.ts | oracle_session namespace/config cases; oracle_runtime_lifecycle: runtime defaults, running config authority after unregister, pending replacement, idempotent/stale unsubscribe | runtime_hooks adds tool/hook memo (absent/null), safe recovery, waiting/emit/throw/abort/suspend, namespace isolation, duplicate subscription, expired approval API; lifecycle adds private describe projection. Remaining named cases require audit |
| spec-scheduler-process.test.ts | runtime_process + runtime_scheduler: 17 tests, fake host lifecycle/recovery/abort/recurring/notify, nested hold, suspend/quiescent, admission singleton/overlap, terminal failure drain | Full named-case audit remains; no real OS process integration in this fixture |
| busy.test.ts | oracle_session prospective busy; runtime phase-map contract | Audit complete busy/writable/reset matrix under scheduler |
| recovery.test.ts / retention.test.ts | runtime_recovery: 10 tests, requesting/prepared/retrying/started-safe-unsafe/approval/postTools/collapse/marked-task, memory-vs-JSONL ordering, 150 retained tasks + failed outcomes + no sidecars | runtime_process adds spawning/running/unknown/rerun/missing-host; close/suspend-reopen, not actual OS process-kill fault injection |
| tool-bounds.test.ts | Bounded units + runtime_tool_bounds stream limits/progress identity/final flush, aggregate head/tail mixed content, throwing approval (hooks) | Flush-storage-failure injection and full stream envelope audit remain |
| subagent.test.ts | Owned-conversation Session primitives | Real faux tool child-conversation flows remain |
| authority.test.ts | oracle_session token/scope matrix; runtime kind token/unsubscribe cases | Captured BeforeToolApi expiry and hook registration identity now ported; runtime_authority checks live/retained foreign abort, source-conversation rejection, allowed owned subtree, phase expiry, captured child handle |
| kinds.test.ts | oracle_kinds types/defaults/validators | Job fake-host integration now covered; collapse/fork/section/plugin named cases remain |
| reads.test.ts / spec-context-capabilities.test.ts | oracle_session read-your-writes, line/scope, forged metadata, captured config | Runtime phase expiry now checked through both commit and scheduler ops; full 17-operation live runtime scope matrix still needs audit |
| spec-transactions.test.ts | oracle_session transaction/rollback/preload cases | Real runtime task slot/checkpoint/flush overlays remaining |
| spec-storage-history.test.ts / atomicity.test.ts / hardening.test.ts | oracle_storage: snapshots, staging, recovery tails, sidecars, scan ordering across memory + JSONL | Tool crash/effect halves remain; non-monotonic ID scan-order regression newly added |
| membrane.test.ts | oracle_membrane + borrow-checker substitution | JS proxy lifetime/clone identity have no direct Rust runtime equivalent |
| spec-view-events.test.ts / view.test.ts / watch.test.ts | oracle_view snapshots/revisions/buffering/fold/listener isolation | Hook waiting/start/finish and namespaced emit envelopes now checked via public watch; streaming/progress remains |
| chord.test.ts | oracle_chord published shape/delta roundtrip | Full bridge/services depend on M6 |
| types.compile.ts | Rust structural types + runtime authority tests | 4 compile-fail Rustdoc checks cover raw ToolApi/Runtime/Tx escapes; remaining upstream negative assertions need audit |

## Latest gate
- `cargo fmt --all -- --check`: pass.
- `cargo clippy --offline --all-targets -- -D warnings`: pass.
- `cargo test --offline --all-targets`: **2048 passed** (2012 lib + 27 model generator + 9 CLI), zero failures.
- `cargo test --offline --doc`: 4 compile-fail tests passed; 1 existing ignored example, not counted as passed.
- Combined log: `validation/2026-09-23-final-gates.log`.

These totals cover the entire existing Rust project, not 2048 new migration tests. This session added 125 test functions so far; the 27 dirty baseline files remain preserved separately.

## Separate harness/tools
23 Rust tests pass, including485 reference cases inside one test. See TOOLS_COMPATIBILITY.md for source mapping, offline provenance, substitutions and integration gaps.

## Independent runtime foundation (not pico3)
- 9 restore/type tests cover all13 leaves, identity/intent reachability, partial storage/error precedence, no payload fetches, no writes and coherent mutation-barrier reads.
- 1 reducer differential test executes680 step-by-step fixtures from actual upstream source. Additional3 session tests pin optional null wire preservation and JSONL reopen.
- Full runtime public command/drive/progress/watch integration is not ported. See RUNTIME_COMPATIBILITY.md.

- 23:06:7 transcript/progress tests +4 terminal tests +1 tool-details null wire matrix. Runtime subset is21 functions; source-null matrices outside it remain selected by full gates. All13 operation cleanup phases, ordered pending dedup, noncontiguous commit sequences and raw-frame page boundaries are checked.

- 23:15:8 process-local Drive lifecycle/wire tests added; independent runtime subset29functions. DeferredHandle.data:null wire regression failed before the shared-serde fix and now passes. These source-driven lifecycle tests do not execute a full upstream dispatcher; no full public AgentHarness equivalence claimed.

## Historical whole-project gate and separate TUI oracle — 2026-09-24T19:03:11+09:00

2026-09-24 18:53:29–18:54:16 +09:00四门禁全部exit0：`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。all-targets **2428 passed =2392 lib+27 generate-models+9 pirs，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本切片新增10函数，不是2428个新测试。完整日志：`docs/migration/validation/2026-09-24-1853-component-overlay-full-gates.log`。

18:55:06–18:56:13，18串行命令全部exit0，**26产物**（2 Overlay+2 Gesture+2 ComponentRouting+2 Dispatch+2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX）逐字节复现，旧24产物与component-gesture快照字节不变；30 ANSI-width probes一致，实际layout.test.ts的15测试通过。完整native alt-screen tests仍未执行，离线缺@xterm/headless；3个参考测试文件只读/哈希不算执行。日志：`docs/migration/validation/2026-09-24-1856-component-overlay-oracle-repro.log`；文件名部分为预留时分，真实时间以内容为准。

- 新 `ComponentOverlay` 保留当前owning组件、hidden及可选visibility predicate；`RenderedComponentOverlay` 独立保留上次渲染组件与signed row/col、width/height。公开contains_component、resolve_mouse_focus_target、dispatch_mouse_to_overlay。
- **当前visible overlay stack逆序决定focus owner；上次rendered rectangles逆序决定hit。** hidden短路predicate，否则每次以当前terminal尺寸调用，先visibility再contains。nonCapturing/focusOrder不影响这两个helpers；真正compositor需另行按visual order提供矩形。
- 命中即返回：无handler或decline也不穿透下层；不重查当前hidden/removal/visibility，stale frame仍能派发。只有focus=true才把focusTarget换成overlay组件；concrete target/capture/geometry不变。
- 新 `Component::is_container_component` 独立表达结构Container身份，不等同mouse override或layout node。Container/HStack/VStack/ScrollView opt-in，Box/ComponentHandle完整转发；MouseRegion/任意只暴露mouse_child的wrapper不自动成为Container。containment查live树及hidden children、不render，递归前释放父borrow。
- Actual-source bootstrap复制22完整模块，执行真实TuiBase四个helpers，并与真实TuiAltScreen gesture流程组合。67场景/1507步：ownership13/310、visibility8/75、hits29/958、mutations7/86、gestures10/78。5差分函数比较逐步值/状态/有序trace，另5 Rust契约覆盖adapter marker、current/frame/capture分离寿命、child移除自身、hidden Stack/Scroll不render、极值矩形安全。
- 初始63场景/1461步已通过，之后只追加4场景，五旧数组均核验为完全相等前缀。旧gesture157/553及其余既有oracle未改。

新fixture 2279777 bytes，SHA256 `d547a421bfd80848858d4599066809c11af42834bb4fb7af757ab70f734b4063`；source-manifest 3354 bytes，SHA256 `4438e92588c5b295586840373a332c07de9b8cecd757717dfd8d38cadd665a25`。来源/边界见docs/migration/reference/component-overlay/README.md。

Overlay dispatch/focus-owner helpers now execute actual source, including gesture composition; focus setter, other host seams/compositor/OS integration remain open. Full native alt-screen tests NOT executed. This separate TUI coverage does not complete Pico3/AgentHarness.

下一切片优先owning focus/overlay restore状态机，再绑定真实host，不重复本轮helpers或gesture。复读tui.ts:550–679、685–870、1042–1080以及overlay-non-capturing.test.ts的focus/blocked/unfocus/visibility/cyclic preFocus场景。overlay entry身份不能合并为component身份；getVisibleOverlayFocusRestore返回inactive不等于擦除保存状态；最高focusOrder capturing候选不等于stack最后一项。随后实现selection-release click-only回退。详见NEXT_SLICE_PLAN.md；这些仍是计划，不是完成声明。


## Current whole-project gate / owning focus oracle — 2026-09-24T19:51:12+09:00

2026-09-24 19:38:22–19:39:54 +09:00四门禁全部exit0：`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。all-targets **2438 passed =2402 lib+27 generate-models+9 pirs，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本切片新增10函数，不是2438个新测试。日志：`docs/migration/validation/2026-09-24-193822-component-focus-full-gates.log`。

19:41:07–19:42:16，20串行命令全部exit0；**28产物**（2 Focus+2 Overlay+2 Gesture+2 ComponentRouting+2 Dispatch+2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX）逐字节复现，旧26与component-overlay快照字节不变。30 ANSI-width probes一致，真实layout.test.ts的15测试通过。完整native overlay/alt-screen tests仍未执行，离线缺@xterm/headless；4个focus参考测试文件只读/哈希不算运行。日志：`docs/migration/validation/2026-09-24-194107-component-focus-oracle-repro.log`。

- 新 `ComponentFocus` owning控制器和独立 `ComponentOverlayHandle` entry身份，保存focused、insertion stack、preFocus、hidden/nonCapturing、f64 focusOrder、last bounds、raw restore。组件身份不替代entry身份，同一组件可有多个entry。
- 已移植setFocus、show/hide/hideOverlay/setHidden/focus/unfocus、isFocused/getBounds/hasOverlay/isOverlayFocused、cycle-safe ancestry、mounted树查找、直接preFocus retarget、eligible/blocked与restore-overlay/focus-target(含显式null)。same-target仍按old=false→new=true执行setter；highest focusOrder capturing候选不等于reverse insertion mouse owner。
- visibility有predicate才按columns→rows→predicate执行；hidden或无predicate不读尺寸。临时不可见的inactive投影不擦除raw restore。foreign controller在effects前拒绝；同owner removed handle按不同方法保留源码语义，不统一拒绝。
- `restore_before_input`只移植tui.ts:1042–1068焦点块，返回owning target。测试host额外重现TuiAltScreen plain-input viewport listener的isOverlayFocused查询；随后释放组件borrow再同步执行scripted input commands，最后immediate-render。不是完整keyboard filters或任意self-reentrant callback支持。
- 必需同步 `ComponentFocusHost` 提供terminal尺寸、mounted roots、hideCursor、requestRender，没有默认空实现。组合测试真实连接Gesture/Overlay/Focus，不再只赋值模拟focus。set_rendered_bounds只是发布值的seam，不是compositor。
- Actual-source bootstrap复制22完整模块，调用真实TuiBase/TuiAltScreen methods；104场景/1768步：lifecycle23/198、restore25/189、visibility14/132、identity8/86、composed10/94、sequences24/1069。逐步比较value、focused flags、所有retained entries(含removed)、preFocus、raw restore、counter、bounds、gesture、有序trace。
- 6差分函数+4 Rust契约（foreign-owner/stale、脱离registry的owning寿命、setter借用顺序、mounted查树释放父borrow/不render）共10项。初始98/1702通过后仅追加6场景；6组旧数组均为相等前缀，旧26产物未改。

19:28:25–19:29:35最初6个差分函数失败：真实TuiAltScreen constructor安装的viewport input listener比测试host多一次isOverlayFocused查询。只在新Rust测试host的restore_before_input之前补该查询；production/generator/expected未因此改动。19:31:20–19:32:01全部10项通过；随后6case追加先核验旧prefix再安装，19:37:51–19:38:09 verifier及10项再次通过。失败`2026-09-24-192825-component-focus-initial-tests.log`、重试`2026-09-24-193120-component-focus-tests-retry.log`、追加`2026-09-24-193751-component-focus-append-install-verify.log`均保留。19:47:53还记录了一次文档writer传输层Python嵌套引号SyntaxError；发生在解析阶段，未修改源码或文档；改直接here-string后重试。

Focus methods now execute actual source, not assignment stubs. Four consulted hashes are not executed tests. Full input/selection/compositor/legacy OS host remain separate. This TUI slice does not complete AgentHarness/Pico3.

下一切片优先selection-release click-only回退及真实selection host，复读tui-alt-screen.ts:1303–1385和test:1693起nested MouseRegion/drag-selection；复用ComponentGesture::apply_dispatch_result和已验证Overlay/Focus，不重写焦点状态机。URL先于组件click，overlay.hit+decline阻止layout穿透；结果存在时apply→clear selection→条件render，否则copyOnSelect→render。保留clickCount与point的scrollView身份。先定义owning selection state和必需host接口，再实际源码oracle；不能用空callback冒充接通。granularity/autoscroll/clipboard/OS若未覆盖需明示。详见NEXT_SLICE_PLAN.md。


Final document/source protection audit PASS 2026-09-24T19:53:20+09:00; all5 source-scope raw-byte hashes remain identical to the first protection audit. UTF-8/history/root-path checks passed; AGENTS archive unchanged and clean tracked ROADMAP matches HEAD (not a dirty-snapshot file). Log: docs/migration/validation/2026-09-24-195319-component-focus-final-audit-retry.log. Earlier failed wrapper log retained. Only this receipt is appended after those checks; no production/test/fixture changes. All logs are closed before checkpoint creation without tee. Component-focus manifest/verification and external independent receipt remain the sealing authority; full migration incomplete, goal active.


## Component selection actual-source oracle — 2026-09-24T20:36:36+09:00

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

Selection fixture：3219396 bytes，SHA256 `78d9eb63d98493b1b84cafc800f9697a44f87367f5dd42e48a975c691f9bd2ae`。source-manifest：3639 bytes，SHA256 `30315b8042c9e13586ac52a5920f4f51f359eb295f5e996189b68321b62ba836`。

1. `2026-09-24-201410-component-selection-initial-tests.log`：新Rust harness E0282 registry类型推断、E0596 indexed mutable render。只修显式类型和短with_mut借用，production/generator/expected不变。
2. `2026-09-24-201507-component-selection-tests-compile-retry.log`：3组通过、3组失败。新JS手工frame发布漏了actual LayoutBox独立scrollView字段；对照layout.ts:23–34/152–161/427–450后仅修新frame seam，重新运行真实源码。未改Rust production或手写expected。初始通过basic/ranges/composed保持相等，scroll/urls/sequences输入保持相等。`2026-09-24-201735-component-selection-frame-schema-retry.log`：175/1619、6组通过。
3. `2026-09-24-202005-component-selection-append-writer-diagnostic.log`：追加writer标记在node builder和step中各命中一次导致AssertionError；之前已保存初始通过备份/追加generator/两行doc，未安装fixture/写Rust test。缩小至fn step后完成。该文件是诊断记录，不伪称原始工具transcript。
4. `2026-09-24-202116-component-selection-appended-tests.log`：193/1698全部差分+2契约通过，第三契约错误假设普通handled release仍会进入selection click回退，unwrap失败。原名actual-renderer-owning-capture-after-fallback场景保留不改，作为“release拦截”反例；追加click-only真正回退+frame替换场景，再验证正反对照。`2026-09-24-202633-component-selection-capture-contract-retry.log`：194/1707与全部9函数通过，所有旧passed前缀/segments不变。production未因这次错误契约改动。
5. 初次只读定位误猜工作区根AGENTS（不存在），随后使用真实pi-rust/AGENTS；未写文件。历史focus及更早失败记录仍在WORK_LOG/validation/不可覆盖快照，不抹除。

Source/seams/reproduction: `reference/component-selection/README.md`; finite integer cell/UTF-8 scope, external Intl service, clipboard-initiation only. Native full suite NOT executed. No complete M4/AgentHarness claim. Next: actual selection paint; see NEXT_SLICE_PLAN.


## 2026-09-24T21:14:57+09:00 — Actual-source Selection Paint oracle

- 新独立模块 `src/tui/component_selection_paint.rs`，对应真实 `tui-alt-screen.ts:1553–1617`：`apply_selection_highlight`、纯函数`apply_selection`、`ComponentSelection::apply_selection`便捷入口。便捷入口用既有`bounds()`；纯函数输入必须是已规范化bounds。
- highlight开头inverse，保留真实extract_ansi_code识别的token，并在每个以m结尾的ANSI token后重新inverse，尾部inverse-off；不能仅首尾加样式。图片标记行（包括嵌入Kitty/iTerm2）不改。
- rect/clip/screen长度/terminal columns裁切；scroll内容坐标以signed i128投影，负screen row/col不能提前clamp；沿用真实grapheme-cell边界和三段strict slice_by_column。缺bounds/frame/scroll box保持内容不变。传入saved frame与live scrollTop正确配合，无Selection/Focus/Gesture/scroll/layout/timer副作用。
- 新实际完整源码oracle复制22模块、哈希4参考测试文件；调用真实paint/columns/highlight而非手抄JS算法。`paintBounds`是明确normalized-bounds seam；`paint`由真实事件形成Selection；`renderFrame`使用实际Container/ScrollView/renderLayoutFrame。每步比较结果、完整Selection/Focus/Gesture/scroll状态和有序trace。
- **295场景/1266步**：highlights30/30、screen131/132、scroll106/322、composed20/118、sequences8/664。**8个新增Rust测试函数=5差分+3独立契约**（ANSI/OSC原样与reset重施inverse；脱离registry/current frame后的owning scroll+saved frame；负起始行不能限制首个可见行起始列）。2个Intl segment输入是外部服务输入，不是Rust ICU引擎。
- 旧Selection194场景/1707步、Focus/Overlay/Gesture及全部旧30产物、前轮forensics保持字节一致。仅两个继承源码增加module声明：`src/tui/mod.rs`、`src/tui/tests.rs`。新源码仅paint module、fixture与test三个文件；未改Cargo/依赖、旧算法/tests/fixtures或legacy host。

2026-09-24 **21:01:31–21:01:52 +09:00** 原样四标准门禁全部exit0：
`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。
all-targets **2455 passed =2419 lib+27 generator+9 CLI，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本轮只新增8个测试函数，不是2455个新测试。未改测试线程数、跳过或放宽测试；日志`docs/migration/validation/2026-09-24-210131-component-selection-paint-full-gates-retry.log`。

21:02:13–21:03:24，24串行oracle命令全部exit0；**32产物**逐字节复现（新paint2+旧30），旧30与component-selection快照相等；30 ANSI probes一致，真实layout.test.ts的15测试通过。完整native alt-screen/overlay suite仍离线缺`@xterm/headless`而未执行；4个参考测试文件只读/哈希不算执行。完整顺序/命令/输出在`2026-09-24-210213-component-selection-paint-oracle-repro.log`。

21:05:32–21:05:34首次保护审计及previous archive-only独立验证通过；21:10:44–21:10:46接续保护审计再次通过：545旧archive、evidence/supplemental保持；**186个非allow-list继承source/build、536个所有非allow-list继承文件**保持字节不变；两个HEAD不变、两个index空。全部5个源码scope hash等于通过门禁时witness；历史WORK_LOG前缀保留。日志`2026-09-24-210532-component-selection-paint-protection-audit.log`、`2026-09-24-211044-component-selection-paint-handoff-resume-protection.log`。文档收尾后还须`audit_component_selection_paint.py --handoff`，以实际关闭日志为准。

1. `2026-09-24-205312-component-selection-paint-initial-oracle.log`：初次真实oracle成功；fixture此后从未改写，没有expected迎合修复。
2. `2026-09-24-205335-component-selection-paint-initial-tests.log`：fmt成功；新production调用不存在的`ScrollHandle::scroll_top()`而E0599。仅改用既有`scroll.snapshot().scroll_top`，未改旧源码或fixture。`2026-09-24-205541-component-selection-paint-accessor-retry.log`：fmt和8个新增测试全过。
3. `2026-09-24-205750-component-selection-paint-full-gates.log`：fmt/clippy过，all-targets exit101；lib2418 passed/1 failed/2 ignored。未修改的`ai::api::google_vertex::tests::default_budgets_follow_the_vertex_model_families`在`google_vertex/mod.rs:2661`失败：flash-lite Medium actual24576/expected8192。runner fail-fast，所以当次generator/CLI/doc未跑。
4. `2026-09-24-210119-component-selection-paint-vertex-diagnostic-repeats.log`：该既有Vertex测试5次isolated全过；之后原样四门禁重试全过，期间未改production/test/expected/env/线程策略。`capture_simple`读取received_requests().last()且不验证新请求或Done，24576又是前一case值，这**仅是诊断线索，根因未证明**。不声称已修复，不认定环境/并发race；完整失败、诊断、重试均保留。

Authority/seams/reproduction: `reference/component-selection-paint/README.md`. New fixture SHA256 `ef3635debddac6df619bff16c3acc7128d183b5c88919479a1ac6a97e029dbc5`; manifest SHA256 `c7a097a4cfd270d23fbed2ea893c7584cd874b92ae534baee5f98aacc2d8e89d`. Saved/current frames and actual renderer scenarios are distinguished from geometry seams;2 Intl segment recordings are external inputs, not selection-range expected values. Full native suite NOT executed. Next:clipboard async delivery/result,flash,OSC52. No full M4/AgentHarness completion claim.


## 2026-09-24T21:51:29+09:00 — actual clipboard/flash oracle
- 新 `src/tui/component_clipboard.rs`：注入service在调用时立即开始，返回owned non-Send Future；pending期间不持有可变host/Selection借用。仅Boolean(true)成功；string（含空串）原样失败消息，其他值Copy failed；失败提示5000ms，不走fallback；同步throw/异步reject/terminal或flash错误用Result传播。无注入时立即写UTF-8标准base64 OSC52+BEL、flash Copied!并返回ready true；这不是OS送达核验。
- `ComponentSelection::copy_active_selection_to_clipboard`在调用时抓取真实active_text，空/缺选择返回false；既有request_copy_active_selection的bool仍仅代表initiated。Host必须保留/poll待完成Future，丢弃Future取消continuation，与丢弃JS Promise不同；release任务队列尚需完整host接线。
- 新 `src/tui/components/alt_screen_flash.rs`：真实stack/render/invalidate、递增id、setTimeout→unref→entry插入→requestRender、到期按id删除、dispose清timer/entries但不render/重置id。FlashId有owning container identity，避免跨container同numeric id误删。Math.max(0,duration)保留NaN，Node timer coercion仍是host服务；timer须同线程queue，drop前dispose。render严格复用truncate_to_width及inverse样式。
- 新真实完整源码oracle复制22modules、哈希4参考test文件（不算native执行）；**355场景/1881步**：delivery35/151、osc52 97/291、selection85/501、flashes128/748、sequences10/190。每步严格比较result/beforeDrain/settled状态、Selection字段与有序trace。5差分+3独立契约=8个新Rust测试函数。
- 原297场景/1533步expected冻结，58个新空白回归仅追加：25JS trim whitespace+4non-trim codepoints、注入/OSC52双路径和leading whitespace保留；所有原case及5个原Intl输入前缀不变。现在34个Intl服务输入，不是Rust ICU。实际Selection事件用于empty-tree/no-overlay/non-scroll；不能说本切片已验证ScrollView/layout clipboard组合或完整eventloop。
- 新差分发现继承Selection真实trimEnd缺陷：is_js_space_unicode仅Zs/Zl/Zp，漏TAB等。只把utils.rs已有js_trim_end暴露pub(crate)，Selection import/call复用它；其算法未变。旧Selection194/1707、Paint295/1266及全部32旧产物仍字节不变。本轮不是“所有旧production不变”：这个精确修正是明确例外。
- 继承source allow-list共5文件：`src/tui/mod.rs`、`src/tui/tests.rs`、`src/tui/components/mod.rs`仅各增module声明；`src/tui/utils.rs`仅helper可见性；`src/tui/component_selection.rs`仅import与trim调用。新production/test/fixture共4文件；全部9source-scope hash有gate witness。未改Cargo/依赖/旧tests/fixtures或legacy host。

### Reproduction and gates
2026-09-24 **21:42:25–21:43:44 +09:00** 原样四标准门禁全部exit0：
`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。
all-targets **2463 passed =2427 lib+27 generator+9 CLI，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。只新增8个Rust测试函数，不是2463个新测试；未改线程数、skip或测试标准。日志`2026-09-24-214225-component-clipboard-full-gates.log`另含1次先行只读oracle verifier，因此合计5条exit0。

21:44:25–21:45:37，26串行oracle命令全exit0；**34产物**逐字节复现（新2+旧32），旧32与previous paint快照一致；30 ANSI probes一致，真实layout.test.ts的15测试通过。完整native alt-screen/overlay suite仍缺离线`@xterm/headless`而未执行；4参考文件只读/哈希不等于执行。日志`2026-09-24-214425-component-clipboard-oracle-repro.log`。

21:46:28–21:46:30初次保护audit PASS；21:47:01–21:47:03重跑audit及独立previous archive-only verifier都通过：569旧archive/evidence/supplemental保持，**186非allow-list继承source/build、557所有非allow-list继承文件**字节不变；两个HEAD不变、index均空、历史删除仍缺失、全部9source hash等于gate witness、WORK_LOG旧前缀保留。日志`2026-09-24-214701-component-clipboard-protection-and-archive-retry.log`。archive-only不代表修改后live还等于previous。文档收尾后须最终`audit_component_clipboard.py --handoff`，以实际关闭日志为准。

### Immutable expected and forensic history
1. 初次oracle observer用了不存在lastSelectionClick/selectionPressedUrl；21:27对照实际字段修正为lastClick/pressedUrl并增加bounds/copyOnSelect，当时尚未安装expected或跑Rust。旧generator/manifest/fixture在`validation/component-clipboard-initial-oracle-forensics`，未改上游或生产。
2. `2026-09-24-213103-component-clipboard-initial-tests.log`：fmt过、clipboard测试7pass/1fail，跨行空白文本差异。`2026-09-24-213721-component-clipboard-trimend-retry.log`仍7pass/1fail：修复前guard误把历史已删除markdown_debug.rs算修改而退出，PowerShell又继续了测试；尽管名叫retry，当时尚未修复。所有pre-fix源/297-case oracle/manifest/generator留在`validation/component-clipboard-first-test-evidence`。Expected从未迎合Rust改写。
3. `2026-09-24-213827-component-clipboard-trimend-applied-retry.log`：正确处理historical deletion、精确2-file production修复、fmt和8tests全过；`2026-09-24-214001-component-clipboard-trimend-regression-oracle.log`生成58新增case；`2026-09-24-214031-component-clipboard-trimend-regression-tests.log`证明297前缀/旧Intl不变、安装新fixture、fmt和8tests全过。
4. `2026-09-24-214628-component-clipboard-protection-audit.log`：audit PASS，但后续独立verifier命令误用不存在的--checkpoint退出2（尚未验证archive）。21:47改为位置参数重试通过；没有修改verifier或archive，也不能把exit2称archive损坏。
5. **继承Vertex诊断不删除**：上一paint轮标准门禁曾失败1次（gemini-2.5-flash-lite Medium得到24576，预期8192）；之后5次isolated和原样四门禁retry通过，相关生产/测试未改。capture_simple取received_requests().last()等仅线索，**根因未证明**，不认定race/环境，也不声称已修复。本轮原样全门禁通过不改变该结论。完整旧失败/诊断/retry仍受保护。

### External services / not covered
- **不是完整TuiAltScreen/OS host。** Focus/Overlay/Gesture/Selection、Paint、clipboard Future/OSC52、flash controller及owning Container/MouseRegion/layout路由已存在，不重写成stub。full lifecycle/input filters/queue/key release/search/viewport/paste/render scheduling/compositor/legacy screen仍未全面接线。
- 本切片不是native clipboard adapter、实际OS送达验证、Rust Intl segmentation engine，也不是release task queue/eventloop完成。Selection clipboard组合目前non-scroll；完整ScrollView/layout/overlay集成仍需覆盖。Drop Future的取消差异明确；Rc/RefCell句柄非Send/Sync，timer必须同线程host queue，不能用ScrollView worker冒充Node eventloop。
- 真实doRender顺序search → indicator → overlays → selection → flashes → cursor/line resets/diff renderer尚未完整集成；flash controller的render不等于compositeFlashes已做。Focus restore_before_input仅焦点恢复块；frame发布需owning root，borrowed box仍有范围限制。
- visible insertion stack逆序决定focus owner，last rendered rectangle逆序决定hit；hit+decline不穿透，不重查hidden/removal；only focus=true改变focusTarget。Gesture capture优先pressTarget、移动sticky、release+click render OR不短路；Selection clear保留自身lastClick，勿混同Gesture history。
- 有限integer cells/UTF-8/native计数边界，不声明任意JS numbers/UTF16孤立surrogate/JS array identity等价；不支持任意self-reentrant callbacks、强引用环/cyclic child树/JS getter/options alias mutation。Kitty完整像素/placement/retransmission/deletion/iTerm2/probing未齐；marked18.0.5替代不可用18.0.11，完整source/transform/highlight/raw Component/grammar仍有缺口。
- M4全包、M5/M6、完整AgentHarness/dispatcher/MemorySessionRepo/Facade仍未完成；Lane12已有实现，不重写成stub。各更早“clipboard/selection/paint/focus尚缺”的说法属于历史状态，以本条范围为准。

### Checkpoint
- 新切片快照入口：workspace `.migration-handoff/checkpoint-2026-09-24-component-clipboard`。**封存是否完成以实际manifest.json/manifest.sha256/verification.json及外部component-clipboard-independent-verification-*.json成功收据为准**，文档不预写自身manifest hash。若快照尚未生成/核验未过，先完成封存，不能冒充已封存或直接开始新切片。
- previous：`.migration-handoff/checkpoint-2026-09-24-component-selection-paint`，2026-09-24T21:16:08+09:00封存，569present/1historical deletion，manifest SHA256 `af1a56f495847a3c0e32d2ffc92ac28374b12b8f8725ffb32c9ad4f56fbf1fde`。本轮entry外部`component-clipboard-entry-20260924-211719.json`21:17:20已验证全部archive/live/root/status/diff/HEAD/index；21:47 archive-only是追加复核，不是修改后live一致证明。
- `validation/component-clipboard-accepted-source.json`存9scope文件通过门禁后的原始hash。当前fixture5202543bytes SHA256 `c7c3effa66f27d5d3c9353b98811ca7f422a28fdd37ec2f33a5e5bbbe08f9918`；source-manifest3581bytes SHA256 `2d7340c8c3c3974e38a5aab009fc26f169a2fbfa4bd2aa2b741f39fcc1137f49`。
- WORK_LOG只能binary UTF-8 append；本轮217724byte保护前缀SHA256 `5be28a816ab8225414b34bcf5bd8d91467affda87bb3b9b2ef4d50fd5e27c192`；207211/188843/171829/155716/143371/128257历史前缀继续保护。WORK_LOG、TUI账本各4个历史U+FFFD保留，不新增、不批量修复。TUI仅替换顶部Current API status+追加，ORACLE只追加。
- 快照只是dirty-worktree备份，不是完整仓库；干净tracked `docs/ROADMAP.md`不在archive，别盲目当patch恢复。根交接只有workspace/MIGRATION_HANDOFF.md，不创建Rust根同名文件。封存前关闭所有日志；不能tee checkpoint或最终live verifier进repo日志；独立收据只写workspace `.migration-handoff`直属新文件。旧快照不可覆盖。

下一切片建议：**flash屏幕合成 + jump-to-end indicator绘制/点击**，复用本轮真实flash controller、既有composite_tui_line、owning ScrollHandle/真实LayoutFrame，逐步逼近完整compositor；不要继续把已完成clipboard/flash重写一遍。已只读检查上游tui-alt-screen.ts:479–482、1018–1024、1622–1656、1659–1680及测试位置；具体实施与源码oracle要求见NEXT_SLICE_PLAN.md。完整paste/搜索/事件循环后续另算。


### 2026-09-24T21:52:21+09:00 — final handoff/source audit receipt
2026-09-24 21:51:29–21:51:31+09:00 `audit_component_clipboard.py --handoff` PASS in `docs/migration/validation/2026-09-24-215129-component-clipboard-handoff-docs-and-audit.log`. Source witness9raw-byte hashes unchanged;186nonallow source/build and557all nonallow inherited files preserved;355cases/1881steps,34artifact hashes,frozen297prefixes,history/UTF8/ledger/root/HEAD/index/clean tracked ROADMAP checks passed. Exact trimEnd correction and all failed attempts remain disclosed;inherited Vertex cause NOT proven. Only this receipt is appended after those checks,no production/test/fixture changes. A final-state read-only audit will validate these receipts before creating the non-overwriting clipboard checkpoint. All command logs must close first;checkpoint/live verifier are not teed into repo logs. Sealing authority is the actual checkpoint manifest/verification plus external component-clipboard-independent-verification receipt. Full migration incomplete;goal active.


## 2026-09-24 component-screen-widgets actual-source acceptance

- 新 `src/tui/component_screen_widgets.rs`：`composite_flashes`复用真实AltScreenFlashContainer/render与composite_tui_line；只取最后height条，**height=0是JS slice(-0)=slice(0)，保留所有flash行**。无entries不补行，有entries才补齐；空width及image base等按实际源码处理。
- `ScrollToEndIndicator::composite`每次draw先清rect，依次检查label、follow_end配置/当前following、真实clip、row/image、scrollbar保留列；然后调用label、truncate/visibleWidth、floor居中。错误用Result传播，rect保持已清，不走fallback。
- 点击使用**上次发布rect**命中，但滚动**当前primary或implicit ScrollHandle**。真实scroll_to_end先发生，其自身render通知之后才explicit request_render；因此可能两次通知。点击不清rect，只在下一draw清除。
- signed geometry用i128中间运算，不提前clamp负origin。正列复用旧compositor；负列最小helper保留signed afterStart再提取可见graphemes。负row在JS是命名array property，Rust `IndicatorOutput.negative_row`单独暴露，不伪画到第0行。
- 真实完整源码oracle复制22modules、哈希4参考test文件（哈希不是执行）。**297场景/1094步**：flashes141/336、indicator57/237、clicks51/234、composed13/147、routing5/20、signed30/120。逐步比较return/error、screen/negative-row、rect、三个真实scroll状态、flash entries/nextId、layout几何及有序callback/render/flash-timer trace。6差分+3独立契约=9个新增Rust测试函数，不是297个函数。
- composed组执行真正renderLayoutFrame/VStack/ScrollView/dock；indicator/clicks/signed明确使用manual geometry seam。routing执行真实handleMouseEvent/ComponentGesture，但无关search/overlay/layout/scrollbar/paste/selection是trace/mock服务，不是完整native controller。Selection paint输入normalized bounds，不是完整鼠标selection组合；Scroll自动隐藏timer为non-delivered service，Flash timer单独记录/手动delivery。
- 继承source allow-list仅3文件：`src/tui/mod.rs`和`src/tui/tests.rs`各追加一个module；`src/tui/components/scroll_view.rs`仅追加只读follow_end getter，**不改ScrollView算法**。新production/test/fixture共3文件，总6source hash有gate witness。AI、Cargo/依赖、旧tests/fixtures/legacy host均未改。

2026-09-24 **22:28:18–22:28:40 +09:00** 四条原样标准命令全部exit0：
`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。
all-targets **2472 passed =2436 lib+27 generator+9 CLI，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本轮只新增9个测试函数。未改并发数、skip、断言或expected。

**验证环境条件不可省略：**此次通过显式给测试子进程设置 `NO_PROXY=localhost,127.0.0.1,::1`；不修改系统代理/父进程环境。使用 `python docs/migration/tools/run_component_screen_widgets_validation.py gates --loopback-no-proxy`；四条Cargo命令及overlay同时记录于`2026-09-24-222818-component-screen-widgets-gates.log`和`component-screen-widgets-gate-source-20260924-222818.json`。继承环境的首次门禁失败仍然是失败，不能称为原环境已修复。

22:29:01–22:30:15，28串行oracle命令全exit0；**36产物**逐字节复现（新2+旧34），旧34与clipboard快照一致；30 ANSI probes一致，真正layout.test.ts的15测试通过。日志`2026-09-24-222901-component-screen-widgets-repro.log`。完整native alt-screen/overlay suite仍缺离线`@xterm/headless`而**未执行**，4参考文件只读/哈希不等于执行。

22:32:04–22:32:05只读保护audit PASS：603旧archive文件及1历史删除保持，**192非allow-list继承source/build、593所有非allow-list继承文件**字节不变；两个HEAD/index、6source witness、冻结的fixture/generator/manifest、WORK_LOG前缀、成功/失败/AB证据均校验通过。日志`2026-09-24-223204-component-screen-widgets-audit.log`。本段是文档收尾前审计；还需最终`audit_component_screen_widgets.py --handoff`，以实际关闭日志为准。

- oracle最初误读LayoutFrame.boxes（真实是root tree），首次完整输出又发现overlay服务应返回`{hit:false}`而不是undefined。两项均在安装fixture/Rust测试前修好；原observer、routing产物保存在`component-screen-widgets-initial-oracle-forensics`。`2204`初始日志文件名误标，实际执行早于22:02:29，不可凭文件名推断发生时间。
- Rust初编译E0106来自测试trait-object callback缺返回lifetime；仅测试改成static str。22:09日志8pass/1fail来自测试observer按arena而非tree preorder；22:12首次patch因字符串不匹配抛ValueError，没改源码，但PowerShell误继续测试，重复8/1。随后只改observer树遍历，22:13:03–22:13:45新9tests通过。三个失败日志、首次源码和首次已执行测试源码均保留；accepted expected和生产算法未为这些失败修改。
- **22:14首次全量门禁出现416个FAILED、4个Radius测试持续未结束。**22:24:26只终止归属已核对的测试PID32224，Cargo/logger记录EXIT=4294967295，doc未运行。完整日志`2026-09-24-221422-component-screen-widgets-gates.log`及222359/222424进程/TCP/终止证据保留；第一次forensic因Windows文件共享导致Get-FileHash失败，未执行Stop，第二次才终止。Radius wait_for_auth_url存在无timeout循环，但未量测栈，不能断言全部挂起位置。
- 22:25单项HTTP显示mock应为401 bad key，实际502空body；Windows代理只读显示启用且地址127.0.0.1:7897。22:27串行A/B：同一HTTP测试继承环境fail101→仅child NO_PROXY pass0→继承环境再fail101；Radius/Kimi/models三个代表性测试同一bypass各pass0。日志`2026-09-24-222713-component-screen-widgets-http-ab.log`。确认采样失败对当前系统代理敏感；没有逐项抓包归因416失败，也不知道系统设置何时变化。**未改AI源码、系统代理、断言或线程数；不是AI生产代码修复。**源文件两次gate witness完全一致。
- 更早paint切片有一次既有Vertex失败，5次isolated及原样retry通过；根因仍未证明，不得称已修复。证据`2026-09-24-210119-component-selection-paint-vertex-diagnostic-repeats.log`及旧paint交接继续保留。

The accepted297/1094 fixture,manifest and generator remain byte-identical to their pre-first-Rust-test frozen copies. Rust preorder observer was fixed rather than changing expected geometry or screens. Manual geometry, actual renderLayoutFrame, traced unrelated routing services, normalized selection input and non-delivered scroll timers are explicitly different authority levels. Four consulted native files were not executed as a suite. Full migration incomplete;next proposed scope is pure AltScreenSearchIndex, not complete doRender.


## 2026-09-24T23:19:07+09:00 — alt-screen-search-index oracle

- 新 `src/tui/alt_screen_search_index.rs`：实际corpus/query/index/find/key实现。先按原UTF16 units剥离terminal sequences；ASCII按non-space run，非ASCII按Rust Unicode17 grapheme构建span；空白/行间压缩separator，列按真实width计算。ASCII命中可裁切列，非ASCII命中grapheme一部分仍映射整个grapheme；相邻同row段合并。
- 匹配是literal Unicode simple-case-insensitive的非重叠KMP，token是Unicode code point，offset保留原UTF16位置；不是lowercase substring、full/locale folding、Unicode normalization或可执行regex。新 `simple_case_fold.rs`来自Unicode17 CaseFolding.txt的1512个C/S映射，不是从expected搜索输出提取表。既有regex-syntax0.8.11是Unicode16，故不直接拿它冒充当前Node17匹配。
- `Utf16Text`入口保留lone surrogates，剥ANSI可以重新拼成合法surrogate pair；lone surrogate不匹配有效pair的半边、不当作U+FFFD输出。mapped replacement view只用于分词边界；真实单位用于存储、宽度和匹配。UTF8便捷入口对良构字符串无损。
- cache比较source原始字符串内容/长度，复制source输入；normalized query字面变化才重算（大小写变化仍changed）。`SearchMatches`、match、segments array、segment对象是四层独立Rc/RefCell identity；cache hit返回相同array，重算产生新array但保留旧alias。支持外部改array和嵌套segment、replace segments/detach后的别名，不用克隆Vec假装JS identity。
- 22完整上游模块离线复制/哈希，实际调用未改动`alt-screen-search.ts:1–196`；读取private corpus是观察，不是替代算法。**3069场景**：3058 standalone search+7cache sequences（76操作）+4keys；10差分+7独立契约=**17个新Rust测试函数**，不是3069测试函数。包含1512simple folds、766 Unicode17 GraphemeBreakTest/真实Intl边界、185raw UTF16、384固定seed混合输入等。
- oracle冻结前审查并验证实际Node Intl与766标准分词输入一致；Rust在运行时自行分词/宽度/匹配，不注入oracle graphemes或matches。本轮证明这些覆盖输入一致，**不是完整Intl API/locale/word-segmentation全域证明**。
- 继承source allow-list仅4文件：`src/tui/mod.rs`、`src/tui/tests.rs`各加module；`src/tui/utils.rs`加一个CRLF re-export；`src/tui/utils/utf16.rs`只追加共享现有ansi_length的raw strip helper。旧width/wrap/ScrollView/AI/Cargo/旧fixture/test算法不改。

最终当前源码于2026-09-24 **23:10:51–23:11:52 +09:00**通过四条原样标准命令：
`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`，全exit0。
all-targets **2489 passed =2453 lib+27 generator+9 CLI，0 failed，2历史CJK ignored**；doc **5 passed，0 failed，1历史ignored**。新增17测试函数；不修改线程数/skip/断言/expected。

**环境条件不可省略：**runner仅给门禁子进程显式设置 `NO_PROXY=localhost,127.0.0.1,::1`，不更改系统代理或父环境。日志`2026-09-24-231051-alt-screen-search-gates.log`，witness`alt-screen-search-gate-source-20260924-231051.json`。普通复现命令：`python docs/migration/tools/run_alt_screen_search_validation.py gates --loopback-no-proxy`。

23:12:41–23:13:55，31个串行oracle/verify命令全exit0；**39产物byte-identical（新3+旧36）**，30 ANSI probes与previous一致，实际`layout.test.ts`15测试通过。日志`2026-09-24-231241-alt-screen-search-repro.log`。新3是fixture/source-manifest/general runtime fold table。完整native alt-screen suite因缺离线`@xterm/headless`仍**未执行**；reference test哈希和3个纯索引具名Rust契约不是native suite执行。

23:15:16–23:15:17只读保护audit PASS：647旧archive文件/1历史删除、**194非allow-list source/build和636所有非allow-list继承文件**字节不变；两个HEAD/index、8source witness、冻结expected/generator/table、历史WORK_LOG前缀及失败证据通过。日志`2026-09-24-231516-alt-screen-search-audit.log`。这是文档收尾前audit；最终还要`audit_alt_screen_search.py --handoff`，以实际关闭日志及独立封存收据为准。

Frozen expected6,687,981bytes/SHA256 `8f5ea5083e07bea44adb00b85cc59baff0285c844061acda6ff7aab68b0d7abe`;22complete module hashes and1reference native test hash (not native suite execution). README describes independent generic Unicode17 table provenance and766actual Intl/conformance inputs; no runtime segmentation/match output injection. All10frozen files remained unchanged before/after the firstRust test and CRLF correction.39reproduced artifacts=new3+old36;old fixtures unchanged.

- **本轮真实失败必须保留：**首17测试及23:03:20第一轮门禁通过，但23:09:11保护audit在`utils.rs`精确字节比较失败：新增import混入LF，首次cargo fmt把旧CRLF工具文件整体规范成LF。去掉新import后，其余内容严格等于旧CRLF→LF转换，没有功能变化。`alt-screen-search-crlf-audit-evidence`保留pre-fix源码/auditor/原acceptance/repair收据；失败日志`2026-09-24-230911-alt-screen-search-audit.log`未删。恢复原CRLF+一个CRLF import，**不放宽audit**；再跑四门禁和31命令repro，当前receipt指向修复后source witness。两轮source witness只有utils.rs字节不同；fixtures/generator/table和其他7source一致。
- 标准源/Unicode license的只读HTTPS获取：`2026-09-24-225033-alt-screen-search-unicode-acquisition.log`与`reference/alt-screen-search-index/unicode/acquisition.json`记录URL/bytes/hash；没有下载或升级Cargo/npm依赖，测试/oracle重放均离线。
- **继承screen-widgets环境失败仍是失败：**`2026-09-24-221422-component-screen-widgets-gates.log`有416FAILED/4个Radius持续未结束；仅在核对PID归属后结束owned test进程，logger4294967295，doc未跑。AB日志222713显示同HTTP样本inherited fail101→child NO_PROXY pass0→inherited fail101；另外3样本bypass通过。未逐项抓包归因416失败，不知道系统代理变化时间，没修AI/系统代理/并发/skip。不要说已修复原环境。Radius无timeout位置只是风险，没有所有挂起栈证明。
- 历史222359/222424进程终止`.ps1`是不可重放取证记录，**不要执行**。更早paint的Vertex单次失败root cause仍未证明；5isolated和原样retry通过不算修复证明。

Coverage gap:Search UI/host navigation/refresh/highlight/full native suite/fullIntl and typed JS boundaries remain. This is not full M4 or full migration completion.


## 2026-09-25T00:04:16+09:00 — alt-screen-search-component 已验证，收尾后暂停

- Actual owning SearchComponent drives existing Input, focus/query callback, three-row border/result, dynamic keybindings/key labels, style order and last-render half-open navigation rect;1513 scenarios/11770 ops. Rust16 new test functions, not1513 tests. No pre-rendered Input substitution.
- Shared scalar+VS16 runtime RGI supplement: exhaustive1112064 scalar probes/207 bases;1606 actual-source width/truncate/slice cases. Fixes inherited ©️ width1→2;old3331 table/128360 fixtures/Input/index retained unchanged. Exact2 CRLF-safe utils edits plus mod registration;5 new source/data/test files.
- Final2505 all-target passed=2469lib+27generator+9CLI;2 historical ignored;docs5pass/1 historical ignored. Child-only NO_PROXY=localhost,127.0.0.1,::1.34repro commands/44 byte-identical artifacts/30ANSI probes/15native layout tests. Initial14 tests10pass/4fail are retained;5unicode mismatches fixed in generic width,3new independent assumptions corrected using actual-source probes;UI expected frozen unchanged.
- First full gate2468pass/1Vertex missing-project fail/2ignored;isolated and unchanged full retry passed,root cause not established. Historical416fail/4hung/proxy AB,index CRLF failure and network provenance remain. Evidence:validation/search-component-acceptance.json and reference/alt-screen-search-component/README.md.
- Valid UTF8 UI/safe result integers only, no full host search lifecycle/native alt-screen suite/OS clipboard/fullIntl. FullM4/M5/M6/Harness integration still incomplete. User requires暂停 after seal;do not start next slice.
