# Component selection paint — validated slice record

更新时间：2026-09-24T21:14:57+09:00（Asia/Seoul）。

**Implementation/test/oracle/protection validation passed; full migration is not complete. Sealing authority is the actual checkpoint verification and external independent receipt, not this heading.**

- 新独立模块 `src/tui/component_selection_paint.rs`，对应真实 `tui-alt-screen.ts:1553–1617`：`apply_selection_highlight`、纯函数`apply_selection`、`ComponentSelection::apply_selection`便捷入口。便捷入口用既有`bounds()`；纯函数输入必须是已规范化bounds。
- highlight开头inverse，保留真实extract_ansi_code识别的token，并在每个以m结尾的ANSI token后重新inverse，尾部inverse-off；不能仅首尾加样式。图片标记行（包括嵌入Kitty/iTerm2）不改。
- rect/clip/screen长度/terminal columns裁切；scroll内容坐标以signed i128投影，负screen row/col不能提前clamp；沿用真实grapheme-cell边界和三段strict slice_by_column。缺bounds/frame/scroll box保持内容不变。传入saved frame与live scrollTop正确配合，无Selection/Focus/Gesture/scroll/layout/timer副作用。
- 新实际完整源码oracle复制22模块、哈希4参考测试文件；调用真实paint/columns/highlight而非手抄JS算法。`paintBounds`是明确normalized-bounds seam；`paint`由真实事件形成Selection；`renderFrame`使用实际Container/ScrollView/renderLayoutFrame。每步比较结果、完整Selection/Focus/Gesture/scroll状态和有序trace。
- **295场景/1266步**：highlights30/30、screen131/132、scroll106/322、composed20/118、sequences8/664。**8个新增Rust测试函数=5差分+3独立契约**（ANSI/OSC原样与reset重施inverse；脱离registry/current frame后的owning scroll+saved frame；负起始行不能限制首个可见行起始列）。2个Intl segment输入是外部服务输入，不是Rust ICU引擎。
- 旧Selection194场景/1707步、Focus/Overlay/Gesture及全部旧30产物、前轮forensics保持字节一致。仅两个继承源码增加module声明：`src/tui/mod.rs`、`src/tui/tests.rs`。新源码仅paint module、fixture与test三个文件；未改Cargo/依赖、旧算法/tests/fixtures或legacy host。

## Accepted verification
2026-09-24 **21:01:31–21:01:52 +09:00** 原样四标准门禁全部exit0：
`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。
all-targets **2455 passed =2419 lib+27 generator+9 CLI，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本轮只新增8个测试函数，不是2455个新测试。未改测试线程数、跳过或放宽测试；日志`docs/migration/validation/2026-09-24-210131-component-selection-paint-full-gates-retry.log`。

21:02:13–21:03:24，24串行oracle命令全部exit0；**32产物**逐字节复现（新paint2+旧30），旧30与component-selection快照相等；30 ANSI probes一致，真实layout.test.ts的15测试通过。完整native alt-screen/overlay suite仍离线缺`@xterm/headless`而未执行；4个参考测试文件只读/哈希不算执行。完整顺序/命令/输出在`2026-09-24-210213-component-selection-paint-oracle-repro.log`。

21:05:32–21:05:34首次保护审计及previous archive-only独立验证通过；21:10:44–21:10:46接续保护审计再次通过：545旧archive、evidence/supplemental保持；**186个非allow-list继承source/build、536个所有非allow-list继承文件**保持字节不变；两个HEAD不变、两个index空。全部5个源码scope hash等于通过门禁时witness；历史WORK_LOG前缀保留。日志`2026-09-24-210532-component-selection-paint-protection-audit.log`、`2026-09-24-211044-component-selection-paint-handoff-resume-protection.log`。文档收尾后还须`audit_component_selection_paint.py --handoff`，以实际关闭日志为准。

## Failures retained
1. `2026-09-24-205312-component-selection-paint-initial-oracle.log`：初次真实oracle成功；fixture此后从未改写，没有expected迎合修复。
2. `2026-09-24-205335-component-selection-paint-initial-tests.log`：fmt成功；新production调用不存在的`ScrollHandle::scroll_top()`而E0599。仅改用既有`scroll.snapshot().scroll_top`，未改旧源码或fixture。`2026-09-24-205541-component-selection-paint-accessor-retry.log`：fmt和8个新增测试全过。
3. `2026-09-24-205750-component-selection-paint-full-gates.log`：fmt/clippy过，all-targets exit101；lib2418 passed/1 failed/2 ignored。未修改的`ai::api::google_vertex::tests::default_budgets_follow_the_vertex_model_families`在`google_vertex/mod.rs:2661`失败：flash-lite Medium actual24576/expected8192。runner fail-fast，所以当次generator/CLI/doc未跑。
4. `2026-09-24-210119-component-selection-paint-vertex-diagnostic-repeats.log`：该既有Vertex测试5次isolated全过；之后原样四门禁重试全过，期间未改production/test/expected/env/线程策略。`capture_simple`读取received_requests().last()且不验证新请求或Done，24576又是前一case值，这**仅是诊断线索，根因未证明**。不声称已修复，不认定环境/并发race；完整失败、诊断、重试均保留。

## Handoff/sealing
- 本切片快照入口：workspace `.migration-handoff/checkpoint-2026-09-24-component-selection-paint`。**封存是否完成，以实际manifest.json/manifest.sha256/verification.json及外部`component-selection-paint-independent-verification-*.json`成功收据为准**，本文不预写自身manifest hash以避免循环。若目录未生成/核验未过，先完成封存，不能冒充已封存或直接开下一切片。
- previous：`.migration-handoff/checkpoint-2026-09-24-component-selection`；2026-09-24T20:39:30+09:00创建、20:39:31验证；545 present files/1历史删除；manifest SHA256 `de6400d661be7884473b0416a2a122162b4c36bb36f41715abdf3c9e52250128`。本轮入口外部收据`component-selection-paint-entry-20260924-204554.json`已验证全部archive/live/root/status/diff/HEAD/index；21:05 archive-only是补充验证，不是当时live相等证明。
- `validation/component-selection-paint-accepted-source.json`记录全部5个source-scope原始字节hash。fixture2332991 bytes SHA256 `ef3635debddac6df619bff16c3acc7128d183b5c88919479a1ac6a97e029dbc5`；source-manifest3759 bytes SHA256 `c7a097a4cfd270d23fbed2ea893c7584cd874b92ae534baee5f98aacc2d8e89d`。
- WORK_LOG仅binary UTF-8 append；本轮207211-byte保护前缀SHA256 `61ca26dc0ae40c1dfdc53c58ed1b159ba3bb2780e3c763878779d7f8d5aa31b5`，188843/171829/155716/143371/128257历史前缀继续保护。WORK_LOG与TUI账本各4个历史U+FFFD保留，不新增、不批量修复。TUI只改顶端Current API status并追加，ORACLE账本只追加。
- 快照只是dirty-worktree备份，不是完整仓库；干净tracked `docs/ROADMAP.md`不在archive，不能盲用patch恢复。根交接只有workspace/MIGRATION_HANDOFF.md，不创建Rust根同名文件。封存前关闭所有变化日志，不能tee checkpoint或最终live verifier到repo日志；独立收据只写workspace .migration-handoff新文件。所有旧快照不可覆盖。

## Next slice
下一切片：**clipboard async delivery/result、flash及OSC52**。先读`tui-alt-screen.ts:301–305、643–644、1445–1468`与完整`components/alt-screen-flash.ts`及对应测试。注入copySelection必须await，仅`=== true`成功；string失败消息、其它值Copy failed、error duration5000ms；rejection按真实源码传播、不吞异常。无注入路径写UTF-8 base64 OSC52+BEL并flash Copied!，上游return true不等于操作系统核验送达。现有`request_copy_active_selection` bool只代表initiated，不能偷偷改成虚构的送达证明。复用既有Selection真实text；用可控deferred promise/future对照真实源码的pending/resolve/reject及有序trace，不触发真实剪贴板。详见NEXT_SLICE_PLAN.md。

## Historical initial WIP (preserved as planning history, not current status)
### Original 20:47 WIP entry

Started 2026-09-24T20:47:47+09:00 (Asia/Seoul). Goal active, full migration incomplete.

## Entry protection
- Previous: `.migration-handoff/checkpoint-2026-09-24-component-selection` (545 present files +1 historical deletion). Manifest SHA256 `de6400d661be7884473b0416a2a122162b4c36bb36f41715abdf3c9e52250128`.
- Independent entry receipt: `.migration-handoff/component-selection-paint-entry-20260924-204554.json`. All archive/live/evidence/root/Git checks PASS.
- Only inherited source allow-list: `src/tui/mod.rs`, `src/tui/tests.rs`, module declarations only. All old30 oracle artifacts, earlier forensic records, Cargo/deps and Selection/Focus/Overlay/Gesture production/tests stay byte-identical.
- WORK_LOG207211 bytes SHA256 `61ca26dc0ae40c1dfdc53c58ed1b159ba3bb2780e3c763878779d7f8d5aa31b5`; append only, preserve historical U+FFFD.

## Intended implementation
Read actual `tui-alt-screen.ts:1383–1422,1553–1617,1658–1673`, `utils.ts`, `terminal-image.ts`, and upstream paint/grapheme tests. New pure paint stage receives normalized Selection bounds and an explicit frame; signed projection must not clamp negative endpoints before row/column decisions. Reapply inverse after every extracted ANSI token ending in m; preserve image lines; use strict column slicing. Reuse current owning Selection through an inherent convenience method without modifying its source.

## Evidence to complete
New actual-source oracle (complete copied modules; not handwritten reference algorithms), direct and renderer/event-composed Rust comparisons; four offline gates; old30 artifacts plus new artifacts reproducible;30 probes;15 native layout tests; protection audit; refreshed portable handoff; closed logs; new non-overwriting checkpoint and independent verification. Record failures and fixes, never replace a passing expected prefix.

## Nonclaims
This is not the full doRender compositor, clipboard delivery/flash/OSC52, Rust Intl engine, native alt-screen suite, or OS event loop. Existing missing @xterm/headless stays disclosed. No subagents, no commits/staging, no pi or pisper modification.


### 2026-09-24T21:15:53+09:00 — final handoff/source audit receipt
2026-09-24 21:15:11–21:15:13 +09:00 final `audit_component_selection_paint.py --handoff` PASS. Log: `docs/migration/validation/2026-09-24-211511-component-selection-paint-handoff-final-audit.log`. All5 source-scope raw-byte hashes match the standard-gate witness;186 nonallow inherited source/build and536 all nonallow inherited files remain unchanged. All295 cases/1266 steps and32 oracle artifact hashes checked; UTF-8/history/ledger-prefix/root/HEAD/index/clean tracked ROADMAP checks passed. Vertex failure remains disclosed with cause NOT proven. Only this receipt is appended after those checks; no production/test/fixture changes. A final-state read-only audit will check these receipts before non-overwriting checkpoint creation. All logs must be closed; no tee for checkpoint/final live verifier. Sealing authority: actual component-selection-paint manifest/verification and an external independent receipt. Full migration incomplete; goal active.
