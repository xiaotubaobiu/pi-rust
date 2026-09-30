# 全量迁移并行恢复计划（2026-09-28）

更新时间：2026-09-28T11:34:32+09:00，当前 goal active。最新用户明确允许子智能体并要求先估时；估时已先告知：主要产品链路3–5天，全量兼容候选7–14天，按持续执行/3–4工作单元粗估，低置信度，第一轮集成后修正。不是交期承诺，不以砍功能兑现估时。

## 当前基线与真实缺口

- 当前706项source/build/fixtures与 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0928-w4-stop` 完全一致；该快照是完整性封存，不是新代码验收。
- 最后完整门禁仍为r15：3879通过/0失败/2 ignored；doc5/0/1，不能套到继承wave4树。
- 新发现：Lane的drive_env_for仍tools=Vec::new，实际执行器未接入；native provider注册仍Value空实现；services仅数据契约；print/RPC/interactive/TS host/M6剩余仍需完整实现。
- 保存入口：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\parallel-resume-0928`；WORK_LOG只binary append；旧封存/失败现场不可变。

## 第一轮分工（此时为计划，实际派发ID随后留痕）

| 工作单元 | 具体任务 | 互斥写范围 |
|---|---|---|
| 主执行器 | 继承树诊断、typed native provider及services关键路径、集成、整树门禁、连续交接 | coding_agent/core + extensions + agent_session；Cargo和共享文档仅主执行器 |
| worker-A | 消除session worker Unix unsafe，保留真实kill/ESRCH语义与受控测试 | experimental/session_worker_manager.rs及其tests、process.rs及其tests；如需Cargo变更先报主执行器 |
| worker-B | Lane真实工具执行器与context配置贯穿到installed drive，端到端faux工具回归 | agent_core/harness/runtime/lane.rs及专属测试，必要的agent_harness/types接线先明确范围 |
| worker-C | 内嵌TS/JS宿主可执行方案与本机离线依赖审计；明确最小真实集成接口，不用JSON/外部Node替代目标 | 初始只读审计，不改共享文件；有可落地独立代码范围再认领 |

派发前主执行器先收取fmt/clippy入口诊断；运行中的全树命令不能因观察超时重启。生产改动并发时的测试只能当诊断，正式验收必须在稳定指纹上完成。每个worker须直接编辑明确范围并带回修改清单、命令、退出码和边界；不得删除继承工作或更新共享WORK_LOG。主执行器核对并集成，不盲信worker声明。

## 不变的全量目标

以 `C:\Users\13063\Desktop\code\agent work\pi-rust\docs\ROADMAP.md` 为准：全包Rust行为兼容，Session/auth/设置等字节协议，以及原TS扩展不改即可运行。必须真实接线、跨平台验证，不能把空壳、同步化替代、caller-supplied closures或少数oracle绿当全部完成。

## 执行约束

pi只读；pisper不看不改；无stage/commit/reset/stash/clean/push；无真实凭据/付费provider/OS clipboard/unsafe。Cargo offline，测试--test-threads=1，NO_PROXY=127.0.0.1,localhost。格式修正仅明确scope，保护tui/utils.rs原CRLF/hash。全仓fmt只check。HEAD/index和dirty都保留。其他应用若同时改树，先审计并认领，不覆盖。

## 首轮实际派发（2026-09-28T11:47:05+09:00）

- 入口诊断已结束：fmt exit1，clippy exit101；两命令前后706项指纹稳定。收据 `docs/migration/validation/parallel-0928-entry.json`，日志同前缀；保留失败，不当验收。
- worker-A `01a0e5e7-7ff4-70b2-958e-c120fc5c55a4`：experimental/** 去unsafe及继承lint修正。
- worker-B `01a0e5e7-c72f-7e72-8c4a-f2209a0ed419`：runtime/lane.rs与专属tests，真实工具/context接线；额外harness范围须先协调。
- worker-C `01a0e5e8-04d9-7930-91a7-a38c0893c31f`：真实内嵌TS宿主及本机离线依赖只读审计。
- 主执行器扩展原生provider/services范围到 `src/ai/models/mod.rs`及专属测试（Models共享registry与避免异步持锁）；仍独占Cargo、共享文档与构建命令。工作单元不运行Cargo、不嵌套委托。
- 源码并发写入期间的检查只算诊断；所有worker停写、指纹冻结后再收完整门禁。


## 2026-09-28T12:02:36+09:00 集成继续与实际交付登记

- 前一goal轮分类为progress：只读核验确认708项source/build/fixtures，对r15新增99/既有修改13，六份门禁日志hash匹配；未假报当前全绿。现在继续实际开发，不暂停全量目标。
- worker-A已停止写入：experimental五文件，安全Unix SIGKILL/失败传播及测试，尚未跑Cargo；主执行器补rustix =1.1.5/process到Unix依赖，Windows不能替代Unix验证。
- worker-D `01a0e5e8-fed5-7740-ba9c-11bbf3719d8a` 已交付并关闭：CLI/modes/server/chord限定23文件lint/格式，未改注册集合，未跑Cargo。
- worker-B `01a0e5e7-c72f-7e72-8c4a-f2209a0ed419` 已恢复；批准扩围至agent_harness/harness_impl.rs的runtime_config_from（不改models_for_lane）、drive_operation.rs、runtime/drive/tools.rs及Lane专属tests，完成真实工具/context live配置和installed drive回归。已有native_tools适配器+4测试不算接线完成。
- 主执行器继续Models共享registry、ModelRuntime同步注册、typed native provider、services真工厂与测试；C仍仅只读宿主审计。Cargo/共享文档/整树门禁主执行器独占，无嵌套委托。
- 新检查仅diagnostic；所有worker停写并冻结指纹后再正式验收。pi只读/pisper不看不改/不执行Git写操作/不用真实凭据。


## 2026-09-28T12:39:51+09:00 进度核对与新交付登记（无新源码验收）

- 当前报告：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\PROGRESS_AUDIT_2026-09-28.md`；713项source/build/fixtures，对r15新增104/改变31/无删除；旧r15四日志和今天五诊断日志9/9哈希匹配，不代表当前树全绿。
- B交付真实Lane live工具/context→installed drive接线、8公开入口回归+4 adapter及11处fixture适配；E交付47真实上游oracle（两跑exit0、字节一致、55不变量）；F交付共享registry6+同步注册7回归。B/E/F均停写并关闭；未启新worker。
- 主执行器此前已落盘services真工厂+10新测试、typed native provider/共享registry/同步注册/队列identity。10测试尚未跑；F13测试父模块尚未注册。发现provider_config_from_value用完整Model解码合法ProviderModelConfig可能静默丢项，需要保留真实红灯再修。
- 今天native-check-a exit0但源码不稳定；services-check-a exit101的11字段缺失已修但未复跑。最近正式全绿仍sdk-r15-acceptance-b，3879+doc5。
- 本轮仅只读源码/证据与docs留痕；无Cargo、无生产改动、无Git写。C宿主依赖审计已完成；内嵌TS host仍未实现。继续注册/定向测试→oracle消费→冻结整树验收，不暂停全量goal。


## 2026-09-28T12:45:48+09:00 实际集成与 services 差分消费委派

- 上轮进度核对为progress：核实新交付/47-case oracle并更新交接。此轮进入实现，不重复用汇报代替开发。
- 已注册 F 的13个回归。parallel-0928-services-tests-a：限定rustfmt exit0；services test编译exit101，发现新Lane测试缺SessionReader导入、services测试ScopedModel.thinking_level需Some。两处已修，失败源码保留于 .migration-handoff/parallel-resume-0928/integration-a，准备b批定向回归；没有改provider模型fixture来绕过真实缺陷。
- 复用 E（01a0e5fd-8454-76e1-bf8a-d3125199f378）只写 src/coding_agent/core/agent_session_services_oracle_tests.rs，消费已有真实oracle；不改父模块/生产/Cargo/文档、不跑Cargo、不嵌套委派。主执行器独占配置转换修复、测试注册和Cargo。
- 所有本轮命令仅diagnostic；并行写源码不能当正式验收。原goal active。


## 2026-09-28T13:02:20+09:00 只读进度复核：登记 tests-b 的真实终态

- 用户要求查看pi→pi-rust全量迁移进度。本轮无业务源码改动、无新Cargo、无新子智能体，无Git写操作；全量goal状态未改。
- 重新核验r15四份+tests-b六份日志，10/10 SHA匹配。最近全量仍r15的3879通过+doc5，不能继承给当前树。
- tests-b：services 8过/2败；共享registry6、注册7、Lane8、adapter4分别全过。provider_config_from_value合法模型静默丢弃/错误注册未拒绝仍未修，下一步必须修真实转换。
- 714项源码/构建/夹具，对r15新增105/改变31/删除0；对tests-b只新增oracle消费者文件，尚未注册/运行，不能宣称47/47。
- 进度报告和三个交接入口已补最新状态，旧内容按原字节保留。收据 `C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\validation\parallel-0928-progress-b.json`；备份 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\parallel-resume-0928\progress-b-docs-before`。
- WORK_LOG此前前缀 488343 bytes / SHA256 60483d16f15d28d1891c1607d2596ccdb97dd3aefa6e6f26bcbc2b7ec4197dcb，仅binary UTF-8 append。
