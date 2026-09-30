# Component clipboard + flash — validated slice record

更新时间：2026-09-24T21:51:29+09:00（Asia/Seoul）。

实现/测试/复现/初次保护已验证；最终handoff audit与封存状态以实际日志/manifest/外部收据为准，不能凭本标题判定整个任务完成。

## Scope
- 新 `src/tui/component_clipboard.rs`：注入service在调用时立即开始，返回owned non-Send Future；pending期间不持有可变host/Selection借用。仅Boolean(true)成功；string（含空串）原样失败消息，其他值Copy failed；失败提示5000ms，不走fallback；同步throw/异步reject/terminal或flash错误用Result传播。无注入时立即写UTF-8标准base64 OSC52+BEL、flash Copied!并返回ready true；这不是OS送达核验。
- `ComponentSelection::copy_active_selection_to_clipboard`在调用时抓取真实active_text，空/缺选择返回false；既有request_copy_active_selection的bool仍仅代表initiated。Host必须保留/poll待完成Future，丢弃Future取消continuation，与丢弃JS Promise不同；release任务队列尚需完整host接线。
- 新 `src/tui/components/alt_screen_flash.rs`：真实stack/render/invalidate、递增id、setTimeout→unref→entry插入→requestRender、到期按id删除、dispose清timer/entries但不render/重置id。FlashId有owning container identity，避免跨container同numeric id误删。Math.max(0,duration)保留NaN，Node timer coercion仍是host服务；timer须同线程queue，drop前dispose。render严格复用truncate_to_width及inverse样式。
- 新真实完整源码oracle复制22modules、哈希4参考test文件（不算native执行）；**355场景/1881步**：delivery35/151、osc52 97/291、selection85/501、flashes128/748、sequences10/190。每步严格比较result/beforeDrain/settled状态、Selection字段与有序trace。5差分+3独立契约=8个新Rust测试函数。
- 原297场景/1533步expected冻结，58个新空白回归仅追加：25JS trim whitespace+4non-trim codepoints、注入/OSC52双路径和leading whitespace保留；所有原case及5个原Intl输入前缀不变。现在34个Intl服务输入，不是Rust ICU。实际Selection事件用于empty-tree/no-overlay/non-scroll；不能说本切片已验证ScrollView/layout clipboard组合或完整eventloop。
- 新差分发现继承Selection真实trimEnd缺陷：is_js_space_unicode仅Zs/Zl/Zp，漏TAB等。只把utils.rs已有js_trim_end暴露pub(crate)，Selection import/call复用它；其算法未变。旧Selection194/1707、Paint295/1266及全部32旧产物仍字节不变。本轮不是“所有旧production不变”：这个精确修正是明确例外。
- 继承source allow-list共5文件：`src/tui/mod.rs`、`src/tui/tests.rs`、`src/tui/components/mod.rs`仅各增module声明；`src/tui/utils.rs`仅helper可见性；`src/tui/component_selection.rs`仅import与trim调用。新production/test/fixture共4文件；全部9source-scope hash有gate witness。未改Cargo/依赖/旧tests/fixtures或legacy host。

## Validation
2026-09-24 **21:42:25–21:43:44 +09:00** 原样四标准门禁全部exit0：
`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。
all-targets **2463 passed =2427 lib+27 generator+9 CLI，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。只新增8个Rust测试函数，不是2463个新测试；未改线程数、skip或测试标准。日志`2026-09-24-214225-component-clipboard-full-gates.log`另含1次先行只读oracle verifier，因此合计5条exit0。

21:44:25–21:45:37，26串行oracle命令全exit0；**34产物**逐字节复现（新2+旧32），旧32与previous paint快照一致；30 ANSI probes一致，真实layout.test.ts的15测试通过。完整native alt-screen/overlay suite仍缺离线`@xterm/headless`而未执行；4参考文件只读/哈希不等于执行。日志`2026-09-24-214425-component-clipboard-oracle-repro.log`。

21:46:28–21:46:30初次保护audit PASS；21:47:01–21:47:03重跑audit及独立previous archive-only verifier都通过：569旧archive/evidence/supplemental保持，**186非allow-list继承source/build、557所有非allow-list继承文件**字节不变；两个HEAD不变、index均空、历史删除仍缺失、全部9source hash等于gate witness、WORK_LOG旧前缀保留。日志`2026-09-24-214701-component-clipboard-protection-and-archive-retry.log`。archive-only不代表修改后live还等于previous。文档收尾后须最终`audit_component_clipboard.py --handoff`，以实际关闭日志为准。

## Failures
1. 初次oracle observer用了不存在lastSelectionClick/selectionPressedUrl；21:27对照实际字段修正为lastClick/pressedUrl并增加bounds/copyOnSelect，当时尚未安装expected或跑Rust。旧generator/manifest/fixture在`validation/component-clipboard-initial-oracle-forensics`，未改上游或生产。
2. `2026-09-24-213103-component-clipboard-initial-tests.log`：fmt过、clipboard测试7pass/1fail，跨行空白文本差异。`2026-09-24-213721-component-clipboard-trimend-retry.log`仍7pass/1fail：修复前guard误把历史已删除markdown_debug.rs算修改而退出，PowerShell又继续了测试；尽管名叫retry，当时尚未修复。所有pre-fix源/297-case oracle/manifest/generator留在`validation/component-clipboard-first-test-evidence`。Expected从未迎合Rust改写。
3. `2026-09-24-213827-component-clipboard-trimend-applied-retry.log`：正确处理historical deletion、精确2-file production修复、fmt和8tests全过；`2026-09-24-214001-component-clipboard-trimend-regression-oracle.log`生成58新增case；`2026-09-24-214031-component-clipboard-trimend-regression-tests.log`证明297前缀/旧Intl不变、安装新fixture、fmt和8tests全过。
4. `2026-09-24-214628-component-clipboard-protection-audit.log`：audit PASS，但后续独立verifier命令误用不存在的--checkpoint退出2（尚未验证archive）。21:47改为位置参数重试通过；没有修改verifier或archive，也不能把exit2称archive损坏。
5. **继承Vertex诊断不删除**：上一paint轮标准门禁曾失败1次（gemini-2.5-flash-lite Medium得到24576，预期8192）；之后5次isolated和原样四门禁retry通过，相关生产/测试未改。capture_simple取received_requests().last()等仅线索，**根因未证明**，不认定race/环境，也不声称已修复。本轮原样全门禁通过不改变该结论。完整旧失败/诊断/retry仍受保护。

## Checkpoint
- 新切片快照入口：workspace `.migration-handoff/checkpoint-2026-09-24-component-clipboard`。**封存是否完成以实际manifest.json/manifest.sha256/verification.json及外部component-clipboard-independent-verification-*.json成功收据为准**，文档不预写自身manifest hash。若快照尚未生成/核验未过，先完成封存，不能冒充已封存或直接开始新切片。
- previous：`.migration-handoff/checkpoint-2026-09-24-component-selection-paint`，2026-09-24T21:16:08+09:00封存，569present/1historical deletion，manifest SHA256 `af1a56f495847a3c0e32d2ffc92ac28374b12b8f8725ffb32c9ad4f56fbf1fde`。本轮entry外部`component-clipboard-entry-20260924-211719.json`21:17:20已验证全部archive/live/root/status/diff/HEAD/index；21:47 archive-only是追加复核，不是修改后live一致证明。
- `validation/component-clipboard-accepted-source.json`存9scope文件通过门禁后的原始hash。当前fixture5202543bytes SHA256 `c7c3effa66f27d5d3c9353b98811ca7f422a28fdd37ec2f33a5e5bbbe08f9918`；source-manifest3581bytes SHA256 `2d7340c8c3c3974e38a5aab009fc26f169a2fbfa4bd2aa2b741f39fcc1137f49`。
- WORK_LOG只能binary UTF-8 append；本轮217724byte保护前缀SHA256 `5be28a816ab8225414b34bcf5bd8d91467affda87bb3b9b2ef4d50fd5e27c192`；207211/188843/171829/155716/143371/128257历史前缀继续保护。WORK_LOG、TUI账本各4个历史U+FFFD保留，不新增、不批量修复。TUI仅替换顶部Current API status+追加，ORACLE只追加。
- 快照只是dirty-worktree备份，不是完整仓库；干净tracked `docs/ROADMAP.md`不在archive，别盲目当patch恢复。根交接只有workspace/MIGRATION_HANDOFF.md，不创建Rust根同名文件。封存前关闭所有日志；不能tee checkpoint或最终live verifier进repo日志；独立收据只写workspace `.migration-handoff`直属新文件。旧快照不可覆盖。

## Boundaries
- **不是完整TuiAltScreen/OS host。** Focus/Overlay/Gesture/Selection、Paint、clipboard Future/OSC52、flash controller及owning Container/MouseRegion/layout路由已存在，不重写成stub。full lifecycle/input filters/queue/key release/search/viewport/paste/render scheduling/compositor/legacy screen仍未全面接线。
- 本切片不是native clipboard adapter、实际OS送达验证、Rust Intl segmentation engine，也不是release task queue/eventloop完成。Selection clipboard组合目前non-scroll；完整ScrollView/layout/overlay集成仍需覆盖。Drop Future的取消差异明确；Rc/RefCell句柄非Send/Sync，timer必须同线程host queue，不能用ScrollView worker冒充Node eventloop。
- 真实doRender顺序search → indicator → overlays → selection → flashes → cursor/line resets/diff renderer尚未完整集成；flash controller的render不等于compositeFlashes已做。Focus restore_before_input仅焦点恢复块；frame发布需owning root，borrowed box仍有范围限制。
- visible insertion stack逆序决定focus owner，last rendered rectangle逆序决定hit；hit+decline不穿透，不重查hidden/removal；only focus=true改变focusTarget。Gesture capture优先pressTarget、移动sticky、release+click render OR不短路；Selection clear保留自身lastClick，勿混同Gesture history。
- 有限integer cells/UTF-8/native计数边界，不声明任意JS numbers/UTF16孤立surrogate/JS array identity等价；不支持任意self-reentrant callbacks、强引用环/cyclic child树/JS getter/options alias mutation。Kitty完整像素/placement/retransmission/deletion/iTerm2/probing未齐；marked18.0.5替代不可用18.0.11，完整source/transform/highlight/raw Component/grammar仍有缺口。
- M4全包、M5/M6、完整AgentHarness/dispatcher/MemorySessionRepo/Facade仍未完成；Lane12已有实现，不重写成stub。各更早“clipboard/selection/paint/focus尚缺”的说法属于历史状态，以本条范围为准。

## Next
下一切片建议：**flash屏幕合成 + jump-to-end indicator绘制/点击**，复用本轮真实flash controller、既有composite_tui_line、owning ScrollHandle/真实LayoutFrame，逐步逼近完整compositor；不要继续把已完成clipboard/flash重写一遍。已只读检查上游tui-alt-screen.ts:479–482、1018–1024、1622–1656、1659–1680及测试位置；具体实施与源码oracle要求见NEXT_SLICE_PLAN.md。完整paste/搜索/事件循环后续另算。

---
## Original active-WIP history (preserved verbatim below)

# Component clipboard + flash — ACTIVE WIP

Started 2026-09-24T21:21:46+09:00. Goal active; full migration incomplete. Serial only; no subagents, no pi/pisper edits or Git mutations.

## Entry
Previous checkpoint-2026-09-24-component-selection-paint:569 present files/1historical deletion,manifest SHA256 af1a56f495847a3c0e32d2ffc92ac28374b12b8f8725ffb32c9ad4f56fbf1fde. Independent live/archive/root/status/diff/HEAD/index entry receipt:workspace .migration-handoff/component-clipboard-entry-20260924-211719.json (21:17:20+09:00). WORK_LOG217724 bytes SHA256 5be28a816ab8225414b34bcf5bd8d91467affda87bb3b9b2ef4d50fd5e27c192; binary append only.

## Scope / minimal allow-list
Only inherited source additions are module declarations in src/tui/mod.rs,src/tui/tests.rs,src/tui/components/mod.rs. New production:component_clipboard.rs and components/alt_screen_flash.rs;new tests/fixture in component_clipboard namespace. Preserve all32 previous oracle artifacts,existing algorithms/tests/fixtures,Cargo/dependencies and historical failures byte-for-byte.

## Design
Read actual tui-alt-screen.ts clipboard/public/release/flash methods and complete alt-screen-flash.ts,plus upstream clipboard/flash tests. Clipboard begins eagerly (like JS async before its first await), returns a real non-Send owned Future, captures selection text at invocation, awaits injected result, accepts only boolean true, propagates typed errors, and uses actual OSC52 UTF-8/base64 fallback. Required host services have no no-op defaults. Future owns Rc host, no mutable host/selection borrow across await. Flash ports stack,id/timer lifecycle,unref,expiry/dispose/invalidate and exact truncate/render;owning timer identity rejects cross-container stale delivery. No full OS/event-loop/compositor claim.

## Acceptance required
New actual-source oracle including controlled deferred promises,futures,timers and before-drain traces;real Selection composition and real flash controller. Four original gates;old32 plus new artifacts byte-identical reproduction;30 ANSI probes;15 native layout tests;new protection/handoff audit;fresh immutable checkpoint+independent live verification. Preserve failures and never modify a passing expected prefix to fit Rust.

## Evidence-driven scope amendment 2026-09-24T21:38:27+09:00
Initial tests7pass/1fail exposed existing JS trimEnd mismatch in Selection. Additional inherited allow-list:utils.rs only exposes existing js_trim_end as pub(crate);component_selection.rs imports/calls it. Old algorithms/tests/fixtures otherwise protected. Full failure and pre-fix source+oracle are saved; expected is frozen. Mislabelled21:37 retry happened before repair and also failed; failed pre-edit guard preserved all files.


### 2026-09-24T21:52:21+09:00 — final handoff/source audit receipt
2026-09-24 21:51:29–21:51:31+09:00 `audit_component_clipboard.py --handoff` PASS in `docs/migration/validation/2026-09-24-215129-component-clipboard-handoff-docs-and-audit.log`. Source witness9raw-byte hashes unchanged;186nonallow source/build and557all nonallow inherited files preserved;355cases/1881steps,34artifact hashes,frozen297prefixes,history/UTF8/ledger/root/HEAD/index/clean tracked ROADMAP checks passed. Exact trimEnd correction and all failed attempts remain disclosed;inherited Vertex cause NOT proven. Only this receipt is appended after those checks,no production/test/fixture changes. A final-state read-only audit will validate these receipts before creating the non-overwriting clipboard checkpoint. All command logs must close first;checkpoint/live verifier are not teed into repo logs. Sealing authority is the actual checkpoint manifest/verification plus external component-clipboard-independent-verification receipt. Full migration incomplete;goal active.
