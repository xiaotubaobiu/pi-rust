## 2026-09-27 wave3 双跑门禁结果（当前有效）

- fmt check / offline clippy all-targets -D warnings 均通过；串行 all-targets 两轮各3721通过、0失败、2历史ignored；doc 5通过、0失败、1历史ignored。第二轮session 21875已正常退出0。
- 532项源码/构建hash双跑后不变；WORK_LOG历史前缀及TUI utils字节核验通过。证据：docs/migration/validation/resume-20260927-wave3-acceptance.json。
- 封存目标 workspace .migration-handoff/checkpoint-0927-wave3；只有实际manifest和独立收据 wave3-0927-verified.json成功才算封存完成。历史wave2归档7353文件独立核验通过。
- 本次封存为继承工作树备份+当前Windows门禁验证，不代表全部继承行为已重新与上游逐项核验，也不证明Unix端、完整M1-M6验收。全量目标仍active。
- 下一步串行续作隔离的W3.13 modes；已读预查发现json_event的start/partial映射有披露差异，须先按上游真实协议修正，不能照搬半成品并称兼容。之后再接M6 server，不同时散开。

---

# 下一执行者提示（ACTIVE）

更新：2026-09-25T12:51:46+09:00。先读AGENTS.md、HANDOFF.md、MIGRATION_STATUS.md及WORK_LOG最新段。

## 约束
- 用户 2026-09-25 已明确要求基于昨夜工作继续迁移。当前 goal **active**；旧 search-ui 暂停和 2026-09-24 11:30 截止仅是已履行的历史，不是当前执行指令。全量迁移未完成，不标 complete；未经新的暂停请求不标 paused。
- 只做 `pi` → `pi-rust`；`pi` 只读，`pisper` 不查看、不修改。
- 禁止子智能体/委派，串行执行。保留继承 dirty；无 commit/stage/push/reset/stash/clean。
- 不使用 unsafe、真实凭据、付费模型调用或 OS clipboard。验证为离线 Cargo + Faux/loopback HTTP mock。
- `WORK_LOG.md` 只能 binary UTF-8 append，不改历史前缀；`src/tui/utils.rs` 的 CRLF 字节不动。不要无差别执行全仓库格式化写入。
- Rust HEAD `f8d69f7930e23a6b8f5fd3f794e81d51505ab24a`；上游 HEAD `5901446094988aa5cd8e11efdaa131c3949106f1`。

## 当前验收
- 四门禁全部 exit0：`cargo fmt --all -- --check`；`cargo clippy --offline --all-targets -- -D warnings`；`cargo test --offline --all-targets`；`cargo test --offline --doc`。
- **2605 项项目测试通过 = 2569 lib + 27 generate-models + 9 pirs，0 失败，2 历史 CJK ignored；doc 5 passed / 0 failed / 1 历史 ignored。** 门禁日志 `anthropic-callbacks-gates-20260925-124558-802409.log`（12:45:58–12:47:44 +09:00）。源码 witness `anthropic-callbacks-gates-source-20260925-124558-802409.json`。
- 定向 `anthropic-callbacks-targeted-20260925-124448-788973.log`：anthropic:: 100、generation::tests::anthropic_callbacks 3、request_callbacks 7，全部真实匹配并通过。零匹配视为失败。
- oracle `anthropic-callbacks-repro-20260925-124744-385494.log`：27 场景，完整 fixture byte-identical。执行 pinned upstream stream/retry + SDK Messages.create/transformOutputFormat/buildHeaders；依赖 mock seams 及未覆盖内容见 `docs/migration/reference/anthropic-callbacks/README.md`。不是完整 SDK/整包差分验收。
- 全部证据入口 `docs/migration/validation/anthropic-callbacks-acceptance.json`。仅子进程 NO_PROXY=localhost,127.0.0.1,::1；无 test-thread/skip/旧断言降级，无真实 key 或模型请求。
- 开发失败全部保留：零匹配、错误 import、wiremock MIME（调整 header 顺序仍失败，最终用 set_body_raw 正确指定 MIME）、generation fixture 在 checkpoint 后才改 RuntimeConfig 导致缺认证（改为配置已捕获的 durable generation options）。没有为迁就测试改业务语义或 oracle 输出。

## 边界
- callbacks 现支持 **Anthropic + OpenAI Completions + Faux 正常流**。其他 adapter 对 callback-bearing 请求仍明确 setup error；Faux separate deferred handle 未桥接。完整多 provider Harness 尚未完成。
- owned JSON callback bridge 不代表任意 JS 对象/custom toString/原地修改后返回 undefined 完全兼容。顶层非 BMP 字符串 spread 会产生孤立 UTF-16 surrogate，当前明确 pre-send error；普通对象中的 emoji 可用。TS 扩展仍属 M5。
- SDK client/fetch override、完整 transport/helper headers、精确 APIError 文案与继承 SSE parser 差异不在本切片。仅 HTTP error seam 受控，不能把 canned error 当作真实 SDK formatting 验收。
- callable systemPrompt/toolContext、telemetryContext 尚缺；drive tools 执行器、structural 剩余生成/attempt/publish、deferred 全执行链、reconcile tools、dispatcher/公开 AgentHarness 仍缺。
- M3b task11 kinds/child-conversation oracle、storage failure 注入、memory-session-repo/conformance 完整重放待做。
- M4 既有 Markdown/路由/overlay/focus/selection/paint/clipboard/search 成果保留；完整 host/eventloop/Intl/native clipboard/Kitty/latex/marked 新版本仍缺。本轮未重跑完整 native TUI 历史 oracle。
- M5/M6 未全量迁移。测试数、文件数不是完成百分比；本切片通过不等于 M2/M3b 或整个迁移完成。

## 快照
- 入口：workspace `.migration-handoff/checkpoint-0925-gen-wire`；manifest SHA256 `18c90b295d92e7753b324736015a769f229a17bfa05f377464a11105139e6212`；本轮入口独立收据 `anth-entry-verified-20260925-1214.json`。
- 本轮封存目标 `.migration-handoff/checkpoint-0925-anth`；独立收据目标 `anth-verified.json`。**成功以实际 manifest/verification/独立收据为准；本文不预写自身 manifest hash。**
- 源码 scope `docs/migration/anthropic-callbacks-scope.json` 共6路径；审计工具 `audit_anthropic_callbacks_scope.py` 检查所有入口归档、非scope源码/构建、HEAD/index、门禁source witness和TUI CRLF。
- WORK_LOG 入口前缀366263 bytes，SHA256 `d41c011df55150410f944058e737df700b2cc515f0b7e9d9e8af22a3204a62fa`；只能binary UTF-8追加。入口1009归档文件/1历史删除。
- 上游有继承未跟踪 `.zcodeignore`；本轮未写pi，不能声称整个上游工作区pristine。上游相关源码hash已重新验证。
- 快照是dirty-worktree备份，不是完整仓库；clean tracked文件依赖固定HEAD。不要盲目覆盖或把备份当patch恢复。
- 关闭repo日志后再写workspace checkpoint/核验输出。开始下一切片前只读核验本轮封存、登记新入口/scope；后续live变化不影响immutable archive，但不能继续断言live等于旧封存。

## 下一具体切片
1. 先独立核验 `checkpoint-0925-anth`，读实际代码/收据。若别的应用有新修改，记录scope差异，不回滚。
2. 下一最小切片 **OpenAI Responses 请求生命周期 callbacks**：读上游openai-responses.ts及测试，记录hash；覆盖普通/simple、payload替换/None/null、response前后顺序、hook失败/abort/非2xx/retry，以及Models/generation真实集成。先明确scope再写代码；不要一并宣布Codex/Azure/deferred均支持。
3. 逐adapter补齐剩余callbacks和deferred边界，然后继续M3b drive tools/structural/deferred/dispatcher具体依赖；每次只封存一个可验收切片，不散开多个半成品。
4. 每切片保留actual-source和loopback测试、四门禁、binary append日志、scope审计、不可覆盖快照。全量goal active；只有用户新的明确暂停/截止指令才暂停。

## 复验
```powershell
& 'C:\Users\13063\anaconda3\python.exe' docs/migration/tools/run_anthropic_callbacks_validation.py targeted
& 'C:\Users\13063\anaconda3\python.exe' docs/migration/tools/run_anthropic_callbacks_validation.py gates
& 'C:\Users\13063\anaconda3\node.exe' docs/migration/reference/anthropic-callbacks/oracle.mjs --check
```
前两个命令生成新repo日志，务必先做只读封存核验。旧暂停及旧验证数仅是历史。
