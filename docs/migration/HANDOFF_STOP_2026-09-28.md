# pi → pi-rust 进度与停止交接（2026-09-28）

更新时间：2026-09-28T10:58:47+09:00（Asia/Seoul，UTC+09:00）。

## 1. 结论和当前授权

- 用户最新要求：**“汇报任务完成进度然后 写交接文档可以结束了”**。这条要求优先于旧文档的继续计划。本轮只完成现有快照收取、事实核对、文档交接与完整性封存；**不继续源码开发、不启动新 Cargo 门禁，交接完成后将 goal 设为 paused，等待明确恢复。**
- **全量迁移尚未完成。** 最近有完整门禁证据的仍是 **M5 r15 SDK session 工厂**；当前 live 已有其他应用新增内容，不能把旧门禁结果套到当前树。
- 本次收尾没有改生产源码、Cargo 配置、测试或夹具；没有 services r16 新实现。其他应用的 interactive r16/r17 与本线程原拟 services r16 是不同编号域，不可混为同一已完成切片。
- 不开启子智能体、不委派；pi 只读；pisper 不查看、不修改；保留 dirty，不 stage/commit/reset/stash/clean/push。
- 早先 2026-09-24 11:30 截止已履行；不据此启动定时任务。2026-09-27 的暂停和今天早些时候的恢复都是历史，本次停止要求收束当前执行。

## 2. 这一轮实际做了什么

1. 复核昨晚 r15 停止快照时发现 live 与归档不同。差异来自其他应用新增工作，**不是归档损坏**，没有回滚源码或文档去迎合旧验收。
2. 基于 r15 的 609 项源码/构建/测试夹具指纹，确认当前有 **4 个既有源码变更 + 97 个新增源码/夹具文件**，当前共 **706 项**。Cargo.toml、Cargo.lock、build.rs 未变。
3. 备份外部新增代码和入口文档，保存 Git HEAD/index/status/diff、继承补丁、逐文件 SHA-256；收取已在运行的入口快照进程，确认创建和独立核验均 exit 0。
4. **2026-09-28 10:49:48 +09:00** 完成继承入口核验：**10,395 个现存归档文件 + 1 个历史删除项**。证明归档完整并与核验当时 live 一致，**不是编译、测试或行为兼容性验收**。
5. 审计发现一处实际 unsafe 和多处尚未实现/简化接口；记录为接手优先项，没有趁收尾修改。
6. 写本交接、同步四入口顶部并仅二进制 UTF-8 追加 WORK_LOG；保留旧记录和失败证据，随后做 docs-only 停止快照。

4 个既有源码变更（继承自其他应用，主要为注册/说明）：
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\chord\mod.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\mod.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\modes\mod.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\lib.rs`

完整 97 项新增列表和 706 项指纹在 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\wave4-inherited-0928\entry-capture.json`，不靠简短模块清单恢复源码。

## 3. 最近已验收的开发成果与门禁

r15 在 **2026-09-27** 落地真正 `create_agent_session`，返回真实 `Arc<AgentSession>`，连通 SDK → Agent → ModelRuntime → provider。包含 runtime/settings/session/loader 构造或复用、默认 loader reload、恢复模型与 thinking、tools/noTools/custom、live blockImages、provider attribution、headers 和 awaited payload/response/context hooks。此前 r9–r14 的 JSON 输出/背压、异步扩展、SessionRuntime replacement 和 typed stream 接线保留。

依据：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\SDK_R15.md`；最终验收收据 `C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\validation\sdk-r15-acceptance-b.json`。

验收时段 **2026-09-27 21:32:25–21:38:37 +09:00**：

| 门禁 | 历史 r15 结果 |
|---|---|
| `cargo fmt --all -- --check` | exit 0 |
| `cargo clippy --offline --all-targets -- -D warnings` | exit 0 |
| `cargo test --offline --all-targets -- --test-threads=1` | **3,879 通过 = 3,843 lib + 27 generate-models + 9 pirs；0 失败；2 个历史 ignored** |
| `cargo test --offline --doc -- --test-threads=1` | **5 通过；0 失败；1 个历史 ignored** |

本次只核对该收据及对应日志 SHA-256，**未重跑 Cargo、未新增测试数**。当前 706 项指纹已不同于 r15 的 609 项，当前整树是否全绿仍待验证。

## 4. M1–M6 分工和当前准确位置

阶段定义以 `C:\Users\13063\Desktop\code\agent work\pi-rust\docs\ROADMAP.md` 为准。pi 是以 CLI 为产品入口的多包项目，Rust 目标不只是命令解析器，还包括模型、Agent、TUI、扩展和支撑服务。

| 阶段 | 干什么 | 当前可如实表述的进度 |
|---|---|---|
| M1 | 最薄 AI → Agent → CLI 可运行骨架 | 已有基础 CLI/测试；不等于完整 pi CLI 兼容。 |
| M2 | pi-ai：模型、供应商、认证、流式响应和模型目录 | 已有主要实现及回归；动态 native provider 注册/共享语义仍有待处理点。 |
| M3 / M3b | Agent 核心、Harness、runtime/drive、工具、重试、会话持久化 | 既有 drive 主链迁移和封存成果保留；本次没有重做 generation。 |
| M4 | TUI 差分渲染、Markdown、组件、键鼠、焦点、搜索 | 既有组件成果保留；原生 OS 剪贴板等边界仍需闭合，本次未动 TUI。 |
| **M5** | coding-agent：Session、扩展、SDK/services、print/RPC/interactive/CLI | **r15 SDK 工厂已验收；services 工厂未实现。新增 CLI/experimental/interactive 是继承的待集成工作，完整模式/CLI/内嵌 TS host 未全量闭合。** |
| M6 | protocol/client/server/telemetry/backends/chord/evals 等支撑件 | 有多片实现；本次继承 chord/server/evals 新内容，但存在接口替代、平台边界和未完成验证，不能宣称全部完成。 |

所以：早先 Markdown/search 属于 **M4**，runtime/drive 属于 **M3b**，近期 SDK/services 及产品模式属于 **M5**，chord/server/evals 属于 **M6**。不采用缺少验收口径的“总进度百分比”或“M6 6/6 已完成”。

## 5. 其他应用新增内容：落盘不等于整树验收

外部原始说明保留在 `C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\NEXT_SLICE_PLAN.md` 的历史区，以及 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\wave4-inherited-0928\before\pi-rust\docs\migration\NEXT_SLICE_PLAN.md` 的原字节备份。

| 继承范围 | 外部交接声明（非本轮独立验收） |
|---|---|
| experimental 核心 | 51 个测试及 oracle；worker/coordinator 等仍有接口待接线。 |
| CLI | 约 32 文件，60 个测试、127 组 oracle。 |
| chord 消费侧 | 50 个测试、7 组 oracle；异步生命周期/esbuild/Node VM 仍有简化或未实现。 |
| M6 server | 64 个测试、27/28 oracle；不能把 27/28 当全部通过，第 28 项原因本次未核验。 |
| interactive r16 | model-search/catalog-refresh/session-share 确定性核心，9 个测试。 |
| interactive r17、experimental W3.16b | theme/external_editor、coordinator/server 半成品；外部称可编译但未完成、未验证。 |

外部称 `cargo check --lib --tests` 为 0 错误，并明确未跑 fmt/clippy/全量测试；本次未重新执行该命令，不为其定向测试数或里程碑百分比背书。上述不同范围可能重叠，不能直接相加成新的全仓测试总数。

## 6. 接手前必须知道的风险

### P0：继承代码违反 no-unsafe

`C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\experimental\session_worker_manager.rs` 第 **1836** 行，在 `#[cfg(unix)]` 的 `kill_pid_sigkill` 中直接 `unsafe { libc::kill(...) }`；项目禁止 unsafe。Windows 编译/测试不覆盖这个 Unix 分支。

尚未修复，也未选定实现。恢复后先读上游语义与本地调用链，选择真正安全且语义等价的进程终止实现；**不能为了门禁改成假成功、恒 false、allow lint 或直接删功能**。现有 `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\experimental\process.rs` 有安全 `std::process::Child::kill` 包装，但它能否替代 manager 的 pid 回调尚未审计。不得终止用户进程，相关验证用 fake/受控子进程。

### P1：services 仍是数据契约，不是真工厂

`C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core\agent_session_services.rs` 共 37 行，文件说明明确服务构造、flags 和 create-from-services 未实现。

原 r16 审计仍有效，但不是代码成果：
- pending native provider / handler / host 仍用 Value，不能承载 provider callbacks/identity；需要真正 typed native 通道，不能用 JSON 空壳假装等价。
- ModelRuntime 使用 Tokio Mutex 包装 Models，refresh 存在跨 await 持锁；同步 register/unregister 路径的 block_on 风险需要处理，不能机械复制。
- Models 的 Vec clone 不保证后续 provider 注册共享；共享 registry 和真正同步 registration facade 属待审查设计。

详细原审计：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\sdk-r15-0927\next-slice-audit.md`；前次完整交接：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\HANDOFF_STOP_2026-09-27.md`。

### P1：其他兼容性边界不能被“已落盘”掩盖

- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\modes\mod.rs` 目前注册 JSON event 和 interactive，print/RPC 仍是隔离 WIP，没有因此完成可用的完整模式接线。
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\chord\mod.rs` 明示 D2：异步 lifecycle 被同步 closure 简化；D7/D9：esbuild/Node VM 是未闭合平台接口。
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\evals\mod.rs` 的真实 AgentSession run loop 仍由 caller-supplied `AgentRunner` 替代。
- server/experimental 的 Unix 分支不能靠 Windows 全绿验收；oracle 对齐数量、实际平台与未覆盖路径必须分别报告。
- native clipboard、完整 interactive 会话壳/viewport/renderer/components、内嵌 TS 扩展 host 和 M6 剩余仍需逐项闭合。

## 7. 下一执行者的顺序（仅计划；本次不执行）

1. **获得用户明确恢复授权**；先读本文件和 AGENTS，核验本次停止快照及其前一入口快照，不以旧 active 元数据自行续做。若 live 又被其他应用改动，先另行备份/审计差异，不重置已有工作。
2. 当前优先级是 **wave4 继承代码的集成审计/验证**，不是立即开 services。冻结 706 项入口指纹和继承 101 项范围；任何新增修改范围先留痕，不全仓自动 format。
3. 阅读测试入口和进程/平台边界，修复上述 no-unsafe 违规；运行并记录真实门禁结果，暴露问题按上游行为修复。外部建议单线程双跑，至少明确每次源码指纹、覆盖平台、完整命令、退出码和日志；不要把不同源码上的结果拼接成一轮绿。
4. 若发现失败，保存失败源码/日志/收据；通过后再建立真正的 acceptance checkpoint，和本次仅完整性封存明确区分。
5. 树稳定后实施 typed native provider 前置 → services 工厂 → print/RPC/interactive/CLI/TS host 与 M6 剩余；不要再次把 services 空数据契约当工厂完成。

恢复后的门禁命令（以下 **本次未执行**；从 Rust 根目录运行）：

```powershell
Set-Location -LiteralPath 'C:\Users\13063\Desktop\code\agent work\pi-rust'
$env:GIT_OPTIONAL_LOCKS='0'
$env:PYTHONIOENCODING='utf-8'
$env:NO_PROXY='127.0.0.1,localhost'
cargo fmt --all -- --check
cargo clippy --offline --all-targets -- -D warnings
cargo test --offline --all-targets -- --test-threads=1
cargo test --offline --doc -- --test-threads=1
```

仅明确 scope 文件可格式修正：`rustfmt --edition 2024 --config skip_children=true,style_edition=2021 <scope files>`。禁止真实凭据/真实或付费 provider/OS clipboard/unsafe；Cargo offline；测试单线程。WORK_LOG 只能 binary UTF-8 append。

services 顺序保留：cwd/agentDir/settings → loader reload → 有序普通/native provider 注册（逐项 nonfatal diagnostics，整组处理后清队列）→ offline refresh → flags → 调用真正 r15 SDK。flags bool 一律 true，string 仅接受 string，并保持精确错误/unknown 顺序及单复数。默认 services runtime 总传 auth/models 路径，与 SDK 的显式非空 agentDir 规则不同。

不可破坏既有时序：
- r15 headers runner 在每次 stream factory 时快照；payload/response/context 在调用时读 live runner。
- replacement：abort → 最终持久化 → shutdown → 同步 beforeInvalidate/dispose → create/apply → setup/transcript → rebind/withSession。
- 每个 await 后重读 live slot；仅字面 true 取消；不回滚已 apply/dispose 状态。
- Runtime.dispose 非幂等、不先 await abort；print 外层 guard；finally remove signals → guarded dispose → flush，dispose 失败不 flush。
- 保留 r10 输出背压/r9 JSON；禁止忙等、block_on 导航、脱离线程 reload、缓存旧 session。

## 8. 证据、恢复入口与封存语义

### 已完成的未验收继承入口

- 快照：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0928-wave4-entry`。
- manifest SHA-256：`7717dfc818af45232eca5a6ef30fe15f0f91cd3f286eda08b65682c8fe6a5c11`。
- 独立收据：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\wave4-inherited-0928-entry-verified.json`。
- 入口审计/备份/命令/日志：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\wave4-inherited-0928`。
- 10,395 现存文件 + 1 历史删除；`acceptance_proven: false`，不是新的门禁验收点。

### 本次 docs-only 停止封存

- 约定新快照：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0928-w4-stop`，previous 为上述继承入口；**允许修改既有源码列表为空**。
- 正式有效性以 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0928-wave4-verified.json` 存在、`live_files_status_diff_root_HEADs_and_indices_verified: true` 且 manifest hash 匹配为准。没有收据或校验失败时不得宣称封存成功。
- 文档原字节、scope、源码前后 706 项指纹、Git HEAD/index 比对、WORK_LOG 前缀校验及实际命令/退出码保存在 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0928-wave4`；主执行记录 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0928-wave4\closeout-retry-shortpath.json`。
- 本次仅新增本文件，给四入口加优先级最高的停止说明，binary append WORK_LOG。WORK_LOG 原前缀 **477,860 bytes / SHA-256 `a4162eb4b80b805ed32b9a14fe21963b76dd92271ccb075ce0e676d95d96728d`**；历史前缀不重写、不修编码。
- 旧快照、失败收据/日志不可变。首次尝试用昨晚快照核验今天 live 的 exit 1 记录 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\services-r16-0928-entry-verify.log` 保留；它说明 live 改动，不代表旧归档损坏。
- checkpoint 工具的 `goal_status: active` 是其写入的封存时元数据，不是后台继续授权。**最终暂停以本聊天 goal 工具返回的 paused 为准**；`full_migration_complete` 始终 false。

保护项：
- Rust HEAD：`f8d69f7930e23a6b8f5fd3f794e81d51505ab24a`。
- pi HEAD：`5901446094988aa5cd8e11efdaa131c3949106f1`。
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\tui\utils.rs` 原 CRLF/字节保持，SHA-256：`a71ecc6754ebd6369feef50262413b30b0311ba9b74d0298ec264b48e186fac1`。

不要重启已完成的 exec 会话：入口快照 session 25948 已 exit 0，旧入口核验 session 65775 已 exit 1，均为终态。没有本轮新增 Cargo 进程或子智能体需要接管；其他应用的运行状态不由此推断。

### 本次封存失败现场与短路径重试（2026-09-28T11:02:58+09:00）

首次停止快照在 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0928-wave4-handoff-stop` 复制深层 scratch 构建产物时发生 `FileNotFoundError`，进程 exit 1；失败目标路径实际长 **260 字符**，符合 Windows 长路径边界问题。该目录没有完成 manifest，**不能当成功快照**，不删除、不覆盖。

原始脚本、命令、退出码、日志与首版文档已保留在 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0928-wave4`；原失败记录 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0928-wave4\closeout.json`、日志 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0928-wave4\capture-docs-only.log` 不修改。改用更短 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0928-w4-stop` 独立重新创建及核验，现有归档内最长目标文件路径 **249 字符**。最终结果只认上述独立 verified 收据及重试执行记录 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0928-wave4\closeout-retry-shortpath.json`。重试仍只修改同一文档 scope，源码/测试/依赖保持不动，没有启动 Cargo。
