# pi → pi-rust 全量迁移进度复核（2026-09-28T13:02:20+09:00）

本节优先于下方 12:39 的历史核对。当前用户要求查看并汇报进度；本轮仅只读检查源码/现有收据和更新留痕，不继续实现、不启动新子智能体、不运行新的 Cargo 门禁。没有暂停或完成全量 goal 的操作。

## 结论

**全量迁移未完成，尚不能把 pi-rust 当成完整等价的 pi 替换品。当前主线是 M5 SDK/services 集成，同时补 M2 注册语义和 M3b Lane 工具执行链，不是仍停在 M4。**

pi 以 CLI 为入口，但路线图要求全部包与行为兼容，包括会话/配置格式、JSON/RPC 输出以及未修改的 TS 扩展可运行。文件存在、编译通过或测试数量增加均不等于全量完成，不据此编造总完成百分比。

## M1–M6 当前位置

| 阶段 | 职责 | 当前可确认状态 | 主要剩余 |
|---|---|---|---|
| M1 | 最薄 AI → Agent → CLI 骨架 | pirs 最小 CLI 与既有测试已建立 | 完整 pi 命令/模式属于后续集成，不能把骨架当完整 CLI |
| M2 | AI、模型/provider、认证、流式响应/catalog | 主体已有实现和历史回归；最新共享注册表 6/6、ModelRuntime 注册 7/7 通过 | 普通扩展 provider JSON 转换存在真实缺陷；新改动未整树验收，仍有 adapter/SDK 兼容边界 |
| M3/M3b | Agent/Harness、runtime/drive、重试、工具与持久化 | generation/drive 主链成果保留；Lane installed-tools 8/8、native adapter 4/4 通过 | 新接线需整体回归；callable system-prompt 等独立边界仍未闭合 |
| M4 | TUI 渲染、组件、Markdown/LaTeX、键鼠/焦点/搜索 | 已有 Tui core/main-screen 和实质 LaTeX，不是早期 stub 状态 | 原生终端 host、OS clipboard、平台行为等尚未全量闭合 |
| M5 | coding-agent Session、扩展、SDK/services、CLI 模式 | r15 真实 SDK 工厂已完整验收；services 真工厂已落盘并运行测试，目前 8/10 通过 | 两个 services 红灯；print/RPC 未注册；完整 interactive 会话壳/viewport/controller/components 未完成；内嵌 TS/JS 宿主未实现 |
| M6 | protocol/client/server/telemetry/backends/chord/evals 等支撑件 | 已有多个支撑模块落盘 | chord 异步 lifecycle/esbuild/VM、evals 真实 AgentSession 接入、server 差分缺口和跨平台验证仍未完成 |

归属澄清：早先 Markdown/search 是 M4；runtime/drive 是 M3b；最近 SDK/services 是 M5。M5 的完整交互应用不等于 M4 的 TUI 基础库。

## 最新定向验证：2026-09-28 12:45:59–12:49:07 +09:00

收据：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\validation\parallel-0928-services-tests-b.json`，mode=`diagnostic-not-acceptance`。

| 测试范围 | 真实结果 |
|---|---|
| services 工厂 | 8 通过、2 失败，exit 101 |
| Models 共享 registry | 6/6 通过 |
| ModelRuntime 同步注册/注销 | 7/7 通过 |
| Lane installed-tools 公开入口 | 8/8 通过 |
| native tools adapter | 4/4 通过 |

F 的 13 个测试已经注册并运行，旧记录中“未注册/未运行”仅适用于 12:39。Lane 回归也已运行。不得将这些定向测试与历史 3879 相加，冒充当前全库通过数。

两个失败集中在普通 provider 配置转换：`provider_config_from_value` 将扩展模型按完整 Model 反序列化并 filter_map，导致可继承 provider 级 api/baseUrl 的合法模型被静默丢弃；原本应拒绝的缺 baseUrl 注册也没有按预期失败。源码仍保留该逻辑，尚未修复。测试原始红灯和日志保留，本轮不修改源码或用完整 Model fixture 绕过缺陷。

47 场景上游 oracle 已有两次一致输出。新增 Rust 消费文件 `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core\agent_session_services_oracle_tests.rs` 已落盘，但核对时尚未注册到父模块，也未运行，**不能宣称 Rust 47/47 通过**；文件自身还披露了覆盖和 collaborator 的边界。

## 最近完整验收与当前树的区别

最后完整验收仍是 **2026-09-27 21:32:25–21:38:37 +09:00 的 r15 SDK**：

- fmt / clippy 都 exit 0。
- all-targets：**3879 = 3843 lib + 27 generate-models + 9 pirs** 通过，0 失败、2 历史 ignored。
- doc：5 通过、0 失败、1 历史 ignored。
- 收据：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\validation\sdk-r15-acceptance-b.json`。

本轮重新计算上面两份收据对应的 **10 份日志，10/10 SHA-256 匹配**，并读取日志内真实 test result；这是历史证据核验，不是重跑。

当前源码/构建/夹具指纹共 **714 项**。对 r15：新增 105、改变 31、删除 0；对最新 tests-b：新增 1、改变 0、删除 0（新增 oracle 消费测试）。文件统计不是完成率。当前源码没有新的整树全绿结论，而且已知 services 两个失败仍在。

## 接手顺序

1. 保存 services 红灯，修 JSON → ProviderConfigInput 映射：直接构造扩展模型，保留继承、headers/compat/samplingParams 等字段，错误不静默吞掉。
2. 审阅并注册 oracle 消费测试；跑 services、共享 registry、ModelRuntime、Lane 及 SDK/AgentSession/loader/runner 回归，逐项记录真实结果。
3. 停写、冻结指纹后运行 fmt / offline clippy / all-targets / doc；通过并独立核验后才发布新验收点。
4. 继续 print/RPC、完整 interactive、真实内嵌 TS host 和 M6 剩余边界；不得以这次 services 切片结束代替全量完成。

pi 保持只读，pisper 不看不改；保留继承 dirty，不 stage/commit/reset/stash/clean/push。本次原文备份：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\parallel-resume-0928\progress-b-docs-before`；核对收据：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\validation\parallel-0928-progress-b.json`，非验收收据。

---

# 以下是 2026-09-28 12:39 的历史记录（原字节保留，以上节为准）

# pi → pi-rust 全量迁移进度核对

核对时间：2026-09-28T12:39:51+09:00。本文件优先于旧 README 的阶段表和早期停止交接中的“services 未实现”等时点描述；不是新的源码验收收据。

## 1. 结论与当前授权

- 全量迁移未完成。当前主线是 **M5 SDK/services 产品集成，同时补 M3b 工具执行与 M2 注册共享语义**。不是仍只做 M4，也不是可完整替换上游 pi 的成品。
- 用户最新 goal 明确允许子智能体加速全量迁移；goal active。此次进度核对不暂停、不标 complete。旧 11:30/禁止子智能体/停止要求是历史状态。
- pi 是以 CLI 为入口的多包项目；全量目标还包括 AI、Agent、TUI、扩展与支撑包，不能只完成命令解析就算结束。
- 本次进度核对不修改生产源码、不运行 Cargo；只复核磁盘与已有收据、登记新交付和更新可移交文档。

## 2. M1–M6 当前位置

| 阶段 | 职责 | 可核实进度及剩余边界 |
|---|---|---|
| M1 | 最小 AI → Agent → CLI 骨架 | 已有 pirs 基础 CLI 和测试；不是完整 pi CLI。 |
| M2 | 模型/provider、认证、流式响应、catalog | 主体实现与既有回归已存在。今天改为共享 registry、同步注册/注销和 typed native provider；新增 13 条相关回归尚未注册父模块/运行。不能宣称所有 adapter/SDK 行为完全兼容。 |
| M3 / M3b | Agent/Harness、runtime/drive、重试、工具、持久化 | generation/drive 主链成果保留。今天 installed Lane 改为读取 live native tools/context，原工具执行/hook/持久化后继续生成；8 条公开入口回归 + 4 条 adapter 测试已落盘但未运行。callable system-prompt 等独立边界仍在。 |
| M4 | TUI 渲染、组件、Markdown/LaTeX、键鼠/焦点/搜索 | 已有 renderer/components、Tui core/main-screen 与实质 LaTeX，不再是早期 latex stub/无主循环状态；终端原生 host、OS clipboard、完整平台边界仍未全量闭合。 |
| M5 | coding-agent 的 Session、扩展、SDK/services、CLI/模式 | r15 真实 SDK factory 已验收；services 已从 37 行契约扩为实际工厂，但新代码待验收。print/RPC 仍未注册；interactive 只迁确定性核心、theme/editor 等，完整会话壳/viewport/controller/components 未完成；原 TS 扩展内嵌宿主未实现。 |
| M6 | protocol/client/server/telemetry/backends/chord/evals | 已有多片实现，但 chord 异步 lifecycle 被同步化、esbuild/VM 未闭合；evals 真实 AgentSession 仍用 caller-supplied AgentRunner；server 的外部 27/28 oracle 声明不能算全部通过，跨平台验证未完。 |

来源：docs/ROADMAP.md、当前模块注册和实现、历史验收及新交付。文件数/测试数不换算为总进度百分比。早先 Markdown/search 是 M4，runtime/drive 是 M3b，SDK/services 是 M5，chord/server/evals 是 M6。

## 3. 最近真正完整验收：2026-09-27 r15 SDK

验收窗口 2026-09-27 21:32:25–21:38:37 +09:00；收据 docs/migration/validation/sdk-r15-acceptance-b.json。

- fmt exit 0；offline clippy all-targets -D warnings exit 0。
- all-targets：**3879 = 3843 lib + 27 generate-models + 9 pirs**，0 失败、2 历史 ignored。
- doc：5 通过、0 失败、1 历史 ignored。
- 本次重新计算该 4 份日志与今天诊断的 5 份日志 SHA-256，9/9 与收据一致。这只是历史证据核验，不是重跑。
- 最新 12:35:48 +09:00 源码/构建/fixture 快照共 **713 项**；对 r15 的 609 项新增 104、既有改变 31、无删除。这不是完成率，也不能继承旧全绿。

今天诊断：

| 收据 | 真实结果 | 限制 |
|---|---|---|
| parallel-0928-entry.json | fmt 1 / clippy 101 | 706 项稳定，保留失败 |
| parallel-0928-native-check-a.json | cargo check --offline --tests 0 | 检查期间源码变动，仅诊断 |
| parallel-0928-services-check-a.json | scoped-format 0 / check 101 | 11 处测试构造缺 native_tools；已落盘修补，尚未复跑 |

不能汇报“当前树全绿”或把新增未运行测试加到 3879。

## 4. 今天已落盘、待主执行器验收

1. **services 真工厂**：create_agent_session_services / create_agent_session_from_services，路径解析、runtime/settings 创建或复用、loader 选项覆盖/reload、普通→native 分组注册、offline refresh、flags；后者委托真正 SDK。10 条测试已注册但未格式/编译/运行。
2. **typed provider 与共享 registry**：Models 的 clone 共享 Arc/Mutex registry；provider 回调锁外；ModelRuntime 同步注册/注销及后台 refresh；扩展队列保留同数组 live append、filter 换数组与整组后 clear。13 条新回归在两独立文件，父模块尚未注册。
3. **Lane 原生工具执行链**：Harness 配置→Lane→installed dispatcher→live 工具/context→hooks/持久化→下一次生成。8 条真实公开入口回归及4条 adapter 测试；未执行，不把源码接线当端到端通过。
4. **services 上游 oracle**：直接运行未修改 agent-session-services.ts 和 paths.ts，47 场景（flags13/构造14/provider队列10/refresh1/失败4/SDK转发5）；两跑各 exit0，306678 bytes 输出完全一致，55 条字面/不变量检查通过。主执行器重新核验两输出与 fixture 字节相等、11 个来源/脚本/日志 hash 一致。ModelRuntime/settings/loader/SDK 使用明确 collaborator/spy；尚无 Rust 消费该 fixture 的差分测试，不能算 Rust 47/47。
5. **Unix 安全修复**：experimental 的 unsafe kill 改为 rustix 安全接口及受控测试，Cargo 已加入 Unix-only rustix；未通过 Unix 门禁，不用 Windows check 替代。CLI/modes/server/chord 限定 lint/格式修正也未整树验收。

发现的待修行为问题：agent_session.rs 的 provider_config_from_value 先把每个扩展模型反序列化为完整 Model 再 filter_map。合法 ProviderModelConfig 可从 provider 继承 api/baseUrl 且没有 provider 字段，可能被静默丢弃；新 services 测试专门覆盖，需先取得红灯再修真实转换，不能把 fixture 改成完整 Model 绕开。

## 5. 新交付与执行资源

- B / Kuhn（01a0e5e7-c72f-7e72-8c4a-f2209a0ed419）：Lane 接线 + 8 端到端/4 adapter + 11 处 fixture 适配；已停止写入并关闭。
- E / Leibniz（01a0e5fd-8454-76e1-bf8a-d3125199f378）：scratch/services_r16_oracle/** 与 agent_session_services_oracle.json；已完成并关闭。fixture SHA256 c1ad28f32e7011b9e433998d326e70f9c03ad5e001051637b386b3c16d2177dc。
- F / Rawls（01a0e5fe-860e-70b1-b44d-7e84c0eae312）：ai/models/shared_registry_tests.rs（6）与 core/model_runtime_registration_tests.rs（7）；已停止写入并关闭；未运行 Cargo。
- A/D/C 已完成并关闭。C 的本机离线审计未找到可直接构建的完整 Deno/V8/Boa/QuickJS 依赖；现有 loader seam/外部 Node oracle 不是内嵌 TS 宿主。不得缩小“未修改上游 TS 扩展可运行”的终点。
- 本次没有启动新 worker；查询时无 cargo/rustc/rustfmt/clippy-driver 进程。

## 6. 紧接着做什么

1. 主执行器限定格式化 services 文件，注册 F 的两个父模块，运行带新 prefix 的 offline 定向编译/测试并保留红灯。
2. 修首次类型/接口问题和普通 provider JSON 转换缺陷；跑 services/shared registry/ModelRuntime 注册/Lane installed tools 回归。
3. 编写 Rust 对 47 场景 oracle 的差分消费，补 services 全 options、失败与 refresh 顺序边界。
4. 回归 SDK/AgentSession/loader/runner，停写冻结源码后跑 fmt/clippy/all-targets/doc 四门禁；独立核验后才发布新验收点。
5. 继续 print/RPC、完整 interactive、真实内嵌 TS host 与 M6 剩余；全量目标保持不变。

pi 只读、pisper 不看不改；保留 dirty，无 Git 写操作、真实凭据/付费调用、OS clipboard 或 unsafe。Cargo offline；tests 单线程；共享文档/Cargo/整树验收由主执行器集中处理。WORK_LOG 仅二进制 UTF-8 追加，旧失败和验收证据不覆盖。

本次只读核对记录：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\validation\parallel-0928-progress-a.json`（mode=progress-audit-not-acceptance）。这份记录不替代 Cargo 门禁或正式封存。
