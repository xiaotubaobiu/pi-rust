## 2026-09-28T20:04:58+09:00 大块验收：native Bash/PowerShell + AgentSession/RPC shell backend

- Bash/PowerShell工具从占位接成原生执行，含shell discovery、cwd/prefix/settings和PI session/model/thinking环境、timeout/abort/drop进程树清理、原始stdout/stderr、有界输出与spill、100ms idle-grace与流更新。PowerShell不继承bash专属设置。Unix process_group不冒充setsid。
- AgentSession/RPC旧bash_executor改用同一个native backend；保留旧text callback兼容并新增fallible bytes callback。按上游WHATWG UTF8/BOM解码（executor EOF不flush）、ANSI/控制/CR清洗，spill按原始字节阈值、rolling按UTF16计数；IO失败传播，retained callback在drop/完成后撤销。
- 真实CLI子进程12/12通过：两shell→provider续跑、exit7工具错误而非CLI失败、RPC bash/stream/sanitize/history/abort且0 provider请求。工具发现修复Windows环境key大小写（PROGRAMFILES）；oracle代理仅用于原生env，含PATH/Path双键纯对象保持原样。
- 变更：`src/coding_agent/utils/shell_config*`、`core/tools/{bash,bash_process,powershell}*`、`agent_session/bash_executor*`、`agent_session/base_tools.rs`、`agent_session.rs`、`core/tools/output_accumulator.rs`（共享decoder）、注册文件及`tests/coding_agent_cli.rs`。生成器：`docs/migration/reference/coding-agent-{shell-config,bash,bash-executor}/`。shell-config 44 discovery+18 environment+7 sanitizer case（SHA256 f12973a8461d5071b7a1f43f94fa49b7462d1a20e1e059920c87cf1ee0f16b38）；executor 77 case（SHA256 7656656f6780bae8b9a261e0adf576e57076e08ca005708ca628e3c2fea8661d）。
- 四门禁 `parallel-0928-shell-acceptance-a.json`：`cargo fmt --all -- --check` 0；`cargo clippy --offline --all-targets -- -D warnings` 0；`cargo test --offline --all-targets -- --test-threads=1` **4469通过**（4421 lib+27 generate-models+9 pirs+12 CLI，lib2 ignored）；`cargo test --offline --doc -- --test-threads=1` **5通过、1 ignored**。788源码项before/after/current一致、全部日志SHA及保护tui/utils SHA独立核验通过（同prefix verification）。
- 保留shell-tests-b/c红收据：b是Windows env大写漏检，c是oracle Proxy误用于双键纯对象；两者均已修复，不覆盖历史日志。c的bash过滤43/43、CLI12/12已通过。
- **剩余**：grep/find/ls尚是built-in占位；shell TUI renderers、完整native interactive/TS extension host/package host/HTML export/RPC client及M6仍未全量完成。下一步推进management-http/tools-manager依赖与搜索工具；当前候选仅在workspace scratch，尚未编译，不计为完成。不开子智能体、不Git写入、不触碰pisper；goal继续active。

---

## 2026-09-28T19:16:56+09:00 大块验收：原生CLI / 文件工具 / 启动迁移 / 有界shell输出基础

- 已接通真实 `pi-rust` CLI main→services→SDK→runtime：print/JSON/RPC、启动session选择/工厂、stdout协议隔离；新增真实CLI子进程回归，9/9通过。read/edit/write替换built-in占位，异步tool wrapper可真正await工具，并修复retry→async tool→continuation→下一prompt死锁。
- 实现启动 migrations：legacy OAuth/API keys、session根目录、commands→prompts、fd/rg→bin、keybindings、deprecated警告UI接口；版本/非法参数preflight不写legacy数据。双平台路径34个真实上游文件系统case与3条UI effect trace；JSON/RPC迁移日志仅stderr，不等交互按键。
- 新增 `core/tools/output_accumulator.rs`：WHATWG流式UTF8、首BOM、bounded tail、按原始字节spill与回收文件句柄。162-case真实上游oracle逐append/finish/重复finish对比，另有内存有界及IO失败回归。给下一块bash/PowerShell准备，**此时两者仍为scratch，未声称工具完成**。
- 修改范围：`src/coding_agent/main/*`、`core/tools/{read,edit,write,file_mutation_queue,output_accumulator}*`、`utils/image_process*`、`extensions/wrapper*`、`agent_session*`、`migrations*`、模块注册及`tests/coding_agent_cli.rs`；oracle生成器在`docs/migration/reference/coding-agent-*`。
- 冻结四门禁 `parallel-0928-filetools-startup-acceptance-a.json`：`cargo fmt --all -- --check` 0；`cargo clippy --offline --all-targets -- -D warnings` 0；`cargo test --offline --all-targets -- --test-threads=1` **4448通过**（4403 lib、27 generate-models、9 pirs、9 CLI；lib 2 ignored）；`cargo test --offline --doc -- --test-threads=1` **5通过、1 ignored**。四命令源码稳定，777项源码指纹、4日志SHA256及保护tui/utils hash独立核验通过（同prefix verification）。
- 保留先前filetools-acceptance-b的clippy红收据；已修sessions测试enumerate并新prefix验收。startup-output-tests-a定向：migration 5、accumulator 3、CLI 9全部通过。
- 边界如实保留：Photon图片编码字节不等价（使用Rust image/Lanczos3）；read access用metadata并非完整R_OK；小数offset超限异常仍有差异；输入JSON孤立surrogate未完全兼容。migration raw/pause UI仅接口，native interactive host、TS扩展宿主、package host、HTML exporter、RPC client、M6等尚未全量完成。
- 用户最新要求直接实现，每大块集中留痕；**不开子智能体**，不Git写入，pi只读、pisper未触碰。目标active。下一步将scratch shell discovery/bash process/bash/PowerShell工具安装、接settings/AgentSession，做差分与原生进程/CLI验证。

---

## 2026-09-28T17:00:53+09:00 大块验收：项目信任 / 配置诊断 / async resource loader

- 已实现 trust-manager、project-trust、settings-diagnostics 及 CLI trust runtime context；ResourceLoader 真正 await 异步扩展/UI 同意结果，services/SDK/session 调用同步接线。信任事件保留 mode/hasUI；诊断 drain-once 与稳定去重。
- 核心文件：`src/coding_agent/core/{trust_manager,project_trust,settings_diagnostics,resource_loader}.rs`、`src/coding_agent/cli/project_trust.rs`、`src/coding_agent/extensions/runner.rs` 及相应测试。资源发现、祖先决策、持久化、UTF-16/数字键排序、BOM、锁释放均有回归。
- 冻结门禁 `docs/migration/validation/parallel-0928-trust-acceptance-b.json`：fmt 0 / clippy all-targets -D warnings 0 / all-targets **4368通过**（4332 lib + 27 generate-models + 9 pirs；lib 2 ignored）/ doc **5通过、1 ignored**。四命令源码稳定，741项源码指纹和4日志SHA256独立核验通过（同prefix verification）。
- 保留 trust-tests-a 编译失败、trust-tests-b Windows字节排序失败及 trust-acceptance-a 种子重序失败证据；修正 oracle 为双平台真实上游执行，输入仅替换路径token而不重新序列化，完整文件字节仍逐项比较。trust-tests-c 25通过；新版oracle两次生成一致 SHA256 `dbc395893c1236dc3faf2a6aaba410cde5b182d7262e2e36484ea4e6fd0ab16b`。
- 边界：proper-lockfile stale heartbeat/reclaim 尚未移植（陈旧锁 fail closed），JS/OS原生异常文本不冒充完全一致；startup选择器仍是UI host seam。完整CLI进程入口、TS宿主、完整interactive及M6尚未完成。
- **目标active，直接继续迁移**：CLI main 启动选择/工厂及真实runtime测试已在scratch准备，下一步安装、编译、定向验证。不开子智能体、不Git写入，保护tui/utils hash未变。

---

## 2026-09-28T16:10:41+09:00 大块验收通过：RPC JSONL / 33 命令 / 异步 UI / 模式主循环

- 本次冻结验收 `docs/migration/validation/parallel-0928-rpc-acceptance-a.json`：fmt 0、clippy all-targets `-D warnings` 0、all-targets **4349通过**（4313 lib + 27 generate-models + 9 pirs；lib 2 ignored）、doc **5通过/1 ignored**，0失败。四命令源码稳定；733个源文件指纹和4份日志hash独立复核通过（`parallel-0928-rpc-acceptance-a-verification.json`）。
- 实装 `src/coding_agent/modes/rpc/{jsonl,types,dispatch,ui,mode}.rs`：JSONL分帧与序列化、33命令真实runtime派发、async extension UI、prompt preflight ACK、会话替换重绑、事件背压、EOF/信号/shutdown生命周期。生产run_rpc_mode与可注入IO入口已注册；没有把模拟session冒充真实集成。
- RPC差分：863分帧轨迹+10序列化、23派发case、17 UI case；mode新增10项真实session集成回归，6个上游完整runRpcMode oracle case验证process effect trace/flush/UI request/ACK（mock session data只对比envelope，不称完整runtime差分）。mode oracle两次相同SHA256 `6dd8421c04abe9ff3fabd49e5eebeeb273af49844dde4750215df33ec9e6ea42`。
- 修复JS undefined统计字段测试，保持生产None省略而非回退null；扩展dialog跨await RAII与取消清理、abort有序监听、退出后pending prompt清理已通过整树回归。stdout flush规则、dispose期间stdin回复与第二次shutdown直接退出对齐上游。
- 边界：尚未接完整CLI main；RPC client未移植；export_html仍返回未绑定exporter的真实错误；已知命令malformed输入仍为serde诊断，JS宽松输入/孤立surrogate尚不完全兼容；Windows原生POSIX信号不支持，Unix未跨机验证；TS扩展宿主/完整interactive/M6仍待推进。**全量目标active，非迁移完成。**
- 本轮未开子智能体，未Git写入，pi只读、pisper未触碰；tui/utils.rs保护hash保持不变。用户要求每大块统一留痕，下一块直接实现settings-diagnostics、trust-manager、project-trust及资源加载异步信任接线，再推进完整CLI，不绕过信任检查。

---

## 2026-09-28T14:39:43+09:00 大块验收通过：services + print 真链路 + coordinator 连接生命周期

- 本次真实冻结验收 `docs/migration/validation/parallel-0928-print-coordinator-acceptance-b.json`：fmt 0、clippy 0、all-targets **4301 通过**（4265 lib + 27 generate-models + 9 pirs；lib 2 ignored）、doc **5通过/1 ignored**，0失败。四命令源码指纹稳定、日志hash与落盘源码复核一致。不是沿用9/27 r15旧结果。
- services provider JSON继承/校验与flags插入顺序已修，services **46/46**。47-case真实上游oracle现有Rust消费者覆盖**38/47 IDs的不同深度投影**，不是47个端到端场景全完成；其余及投影边界见源码测试头部。
- print **13/13**：真实services→SDK→runtime→faux provider→两个prompt持久化、Text/Json输出、图片input/before_agent_start标签、会话替换/清理/背压；修正两处图片序列化并为真实Send工厂补ModelRuntimeReads的Send+Sync边界。shell 3/3、model_resolver 12/12。
- coordinator **31/31**：真实pending/已连接public pair登记与关闭、server替换拒绝迟到旧连接、独立socket关闭handle中断阻塞读写、route有序执行且不持全局state锁写、JS Map/Set插入顺序、未注册control的idle判定、向已关闭memory peer写入报BrokenPipe。
- a门禁保留失败：4264 lib过/1败/2ignored、clippy needless_update；修掉冗余更新，并诊断services测试把注册后台refresh与被测refresh混在一起。现先等注册的provider阶段，再建立被测gate；未延长12秒超时、未弱化await/flag顺序断言。该测试连续5次及services46项通过，见 `parallel-0928-refresh-pending-tests-b.json`。
- 明确未完成：print尚未接完整CLI main；Windows coordinator非named pipe、Unix尚未跨机验证、行长度cap仍在整行读取后检查、通用同步connect不能强制取消；detached shell进程跟踪未全接线；完整RPC/interactive/TS宿主/M6仍需推进。**全量迁移目标保持active，不报完成。**
- 用户最新要求是直接推进代码、每完成大块再统一维护文档。本轮未开子智能体，未Git写操作，pi只读/pisper未触碰；保护 `src/tui/utils.rs` SHA256仍 `a71ecc6754ebd6369feef50262413b30b0311ba9b74d0298ec264b48e186fac1`。
- 下一块：RPC JSONL分帧和类型→真实runtime命令派发→异步扩展UI/输出背压/信号与EOF生命周期→CLI入口；按真实上游差分与离线session/provider集成验证，不用假会话冒充接线完成。

---

## 2026-09-28T13:02:20+09:00 进度复核：最新定向已跑，services 8过/2败，全量未完成

- 最新详细入口：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\PROGRESS_AUDIT_2026-09-28.md`；当前主线 M5 SDK/services + M2/M3b 接线，不是只做 M4。
- 12:49 tests-b：共享 registry 6/6、ModelRuntime 注册 7/7、Lane 8/8、native adapter 4/4；services 8/10，两个 provider JSON 转换红灯未修。旧“13测试未注册/未运行”等记录已过时。
- 47-case 上游 oracle 已存在；新 Rust 消费文件已落盘，核对时尚未注册/运行，不是47/47验收。
- 最后完整门禁仍 9/27 r15：3879 通过 + doc 5。当前 714 项对 r15 新增 105/改变 31；本次10/10日志hash核验不是重跑，当前不能报全绿。
- 下一步：修转换→审阅/注册/运行oracle消费→整体回归和冻结验收→print/RPC/完整interactive/TS宿主/M6。全量目标未完成。
- 本轮只读核查源码并留痕，未运行新Cargo、未开新子智能体、未改业务源码；未修改goal状态。原字节备份和核对见 `C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\validation\parallel-0928-progress-b.json`。

---

## 2026-09-28T12:39:51+09:00 进度核对：当前主线 M5 services + M3b/M2 接线，尚未全量完成

- 当前准确入口：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\PROGRESS_AUDIT_2026-09-28.md`。用户最新 goal 允许子智能体加速全量迁移，保持 active，不暂停/不 complete。
- 最后完整验收仍是 2026-09-27 r15：3879 通过 + doc 5；本次只复核 9 个日志 hash，没有重跑 Cargo。当前713项对r15新增104/改变31，无新全绿结论。
- services 真工厂、Lane live工具接线及新回归已落盘，尚待编译/测试；47个上游oracle两跑一致，但Rust差分消费未实现。B/E/F已交付停写并关闭。
- 下一步：注册并验证新测试→修普通provider模型转换→消费oracle→冻结整树验收。旧“services仅37行/未实现”等状态已过时，旧封存内容保留为历史。

---

## 2026-09-28 并行恢复（2026-09-28T11:34:32+09:00，优先于历史停止/禁止子智能体文字）

- 最新用户明确授权子智能体，加速完成pi→pi-rust**全量**迁移；时间粗估已先告知。goal active，不是停止收尾；不缩小兼容目标。
- 当前入口：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\PARALLEL_EXECUTION_2026-09-28.md`。代码706项与11:04停止快照一致；最后完整门禁仍r15 3879+doc5，继承wave4尚未整树验收。
- 首轮：入口诊断→独立处理Unix unsafe与Lane工具执行器接线；主执行器推进typed native provider/services，另审计真实内嵌TS宿主。写范围互斥，共享文档/Cargo/整树门禁主执行器集中管理。
- pi只读、pisper不看不改、无Git写操作、离线mock验证、保护继承dirty，WORK_LOG仅二进制追加。旧暂停指令已被此次明确恢复替代，旧封存证据不可变。

以下原字节保留作历史记录：

---

## 2026-09-28 停止交接：继承 wave4 尚未验收（2026-09-28T10:58:47+09:00，优先于下方全部历史）

- **用户要求汇报进度、写交接后结束；本次仅文档收尾，完成封存后 goal paused，不继续源码开发或启动新门禁。M1–M6 全量迁移未完成。**
- 最新交接入口：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\HANDOFF_STOP_2026-09-28.md`。旧 active、计划继续、M5 百分比或 M6 全完成等文字不是当前授权或验收结论。
- 最近完整门禁仍为 **2026-09-27 M5 r15 SDK 工厂：3879 通过/0 失败/2 历史 ignored，doc 5/0/1**，收据 `C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\validation\sdk-r15-acceptance-b.json`；**不能用于证明当前 live 全绿**。
- 当前继承自其他应用：4 个既有源码变化 + 97 个新增源码/夹具文件，共 706 项源码/构建/测试夹具指纹。本轮未改生产源码、未跑 Cargo、未实现 services。
- 入口完整性快照 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0928-wave4-entry` 于 10:49:48 +09:00 独立核验成功：10395 现存文件 + 1 历史删除。manifest `7717dfc818af45232eca5a6ef30fe15f0f91cd3f286eda08b65682c8fe6a5c11`；**仅备份完整性，不是验收**。
- 接手优先：继承 wave4 集成/门禁，处理 `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\experimental\session_worker_manager.rs` 第1836行 Unix unsafe，再处理 typed native provider/services 工厂。chord/evals/server/interactive 等边界见新交接，不能以落盘代替完成。
- 新 docs-only 停止快照 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0928-w4-stop`；成功与 manifest 以 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0928-wave4-verified.json` 为准。归档 active 元数据不授权后台继续；等待用户明确恢复。不启子智能体、pi只读、pisper不看不改、无Git写操作。

- 首次停止快照复制遇到深层路径写入错误（exit1），现场保留于 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0928-wave4-handoff-stop`，不可作为有效快照；改用更短的新目录，成功仍以独立收据为准。

以下原文按原字节保留，仅作历史记录；与上文冲突时以上文及最新交接为准：

---

## 2026-09-27 停止交接补记（2026-09-27T22:18:27+09:00，优先于下方历史状态）

- **用户要求汇报、写交接后结束。本轮仅文档收尾，封存后暂停，不实施services；M1–M6全量迁移未完成。**
- 最新进度/架构/接手入口：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\HANDOFF_STOP_2026-09-27.md`。其中r16 typed native provider、持锁refresh/同步注册、Models clone风险均为审计和待审查设计，**不是已落地代码**。
- 最近已验收源码仍是 **M5 r15 SDK工厂**：all-targets 3879通过/0失败/2历史ignored，doc 5通过/0失败/1历史ignored。收据 `C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\validation\sdk-r15-acceptance-b.json`；此次未重跑Cargo、未增加测试数。
- r15后恢复期间只有r16入口核验/审计，无services源码改动/开工/验收。此次22:09:01复核r15的8632文件+1历史删除与live一致，609项source/build未变，收据 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0927-2205-entry-verified.json`。
- 新增 **docs-only** 快照 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0927-r15-handoff-stop`，正式性只认 `C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0927-2205-verified.json` 的live核验成功且manifest匹配；源码验收仍是r15，不是r16交付。原r15归档/收据不变，新快照允许修改既有源码列表为空。
- 旧文档active/暂停/恢复都是历史；本停止要求优先。snapshot的active是封存时元数据，不是后台继续授权；封存后将goal设paused，等待用户明确恢复。无子智能体、不碰pisper/pi源码、不进行Git写操作。

以下保持原始历史记录（不可当作当前继续授权）：

---

## 2026-09-27 W3.15 r15 真正 SDK session 工厂：完整门禁通过，交接封存入口

- **本轮停止点**：用户在2026-09-27本轮明确要求“汇报任务完成进度然后写交接文档可以结束了”。只收取既有在途门禁并完成r15封存，不开启services或其他新切片；封存后暂停。快照元数据的active是封存创建时的状态，不表示授权后台继续；全量迁移未完成。
- **真实验收**：fmt exit0、offline clippy all-targets -D warnings exit0；all-targets 单线程 **3879通过（3843 lib + 27 generator + 9 pirs）/0失败/2历史ignored**；doc **5通过/0失败/1历史ignored**，忽略名单与r14相同。609项source/build在最终定向、回归、全部门禁和独立closeout一致；净增15项测试。最终收据 `docs/migration/validation/sdk-r15-acceptance-b.json`，独立复核 `sdk-r15-closeout.json`；所有本片验证进程已终态，无在途Cargo，不再poll旧句柄。
- **落地范围（M5，不是M4）**：公开真正 `create_agent_session`，返回真实 Arc<AgentSession>；ModelRuntime/SettingsManager/SessionManager/ResourceLoader 构造或复用，默认loader真reload、supplied loader不重复reload；恢复模型/auth/fallback、thinking/entries、tools/noTools/default/exclude/custom、live blockImages。新增provider attribution leaf，保留telemetry/OpenCode gating、legacy OpenRouter substring及精确host规则、null headers/覆盖顺序。本片只改1个既有source core.rs注册，新增4项source/fixture，无Cargo变化。
- **真正生产链路与时机**：SDK→Agent→ModelRuntime→provider已接；live retry/httpIdle/ws timeout，idle0→2147483647、显式request优先。**headerRunner是每次stream factory快照**，该请求auth/headers等待期间reload仍用旧runner；payload/response/context在调用时取当前runner，真正await。Weak session slot无强循环；typed JSON无效时diagnostic并保留完整输入。精确JS整数budgets转换；空字符串agentDir按falsy默认，不强制auth/models路径。不要把headers快照误改成永久缓存或执行时取最新。
- **验证边界**：最终targeted-d 15/15，含真实SDK到loopback HTTP provider、awaited payload、持久化、pending auth跨reload、四类hooks时机、tools策略和路径边界。102场景actual-source oracle（factory22/stream7/attribution47/telemetry22/images4）b/c逐字节一致，14份上游source hash已核验；完整上游模块+明确内存collaborators，Oracle AgentSession仅记录config，**不是完整CLI或SDK全链路oracle**；原生真集成另测。不使用真实key/真实provider。
- **修复与原始证据**：check-a/targeted-a编译失败、oracle-a无效getter导致Node1/空stdout、targeted-b 9过/1失败均保留日志及对应源码。targeted-b按同一Agent.state层修比较，没改fixture/生产语义迎合。第一次acceptance虽3878全绿，最终复核发现agentDir=空串差异后保存superseded-acceptance-source、加回归、重跑全部门禁；**只以acceptance-b为最终源码验收**，不篡改旧收据。
- **回归与保护**：Agent/loop 90、AgentSession 86、AgentSessionRuntime 13、ModelRuntime 10分别全过（集合重叠，不相加）。Cargo、utils原CRLF/SHA、WORK_LOG binary append前缀、两repo HEAD/index、pi status/diff以及scope外8577项继承文件独立核验。原件/失败和旧绿快照/final.patch/after-hashes在workspace `.migration-handoff/sdk-r15-0927`。
- **正式封存判定**：checkpoint为workspace `.migration-handoff/checkpoint-0927-sdk-r15`，previous=r14。必须有外层 `.migration-handoff/sdk-r15-0927-verified.json`，其 `live_files_status_diff_root_HEADs_and_indices_verified: true` 且manifest hash一致才是正式r15。缺失/失败则最后正式点仍r14；入口预告不是成功收据。create/verify日志及finalization只写外层；封存后不再改repo/root入口；allow-existing-source仅core.rs。
- **未完成边界**：本片是M5 SDK工厂切片，不是services/完整CLI/M1–M6验收完成。Windows offline native；Future poll-driven不等于JS eager Promise，mpsc不等于独立result promise；未新增embedded TS host、进程全局defaultStreamFn、任意JS object/throw/stack语义；typed无效输入、headers insertion order与继承SettingsManager/无模型getter seams均在 `docs/migration/SDK_R15.md` 披露。封存后依用户要求暂停，待明确恢复。
- **下一实际切片**：用户明确恢复后，先独立核验r15，再实现 `agent_session_services.rs` 真工厂：同identity settings/loader→reload→有序普通/native provider注册（逐项nonfatal diagnostics，整组后清队列）→offline refresh→flags→create-from-services调用r15真SDK。**pending native provider/handler/host仍为Value，不能承载ApiImpl/auth/fetch/filter callbacks；先typed化，禁止JSON空壳冒充等价。** services默认runtime总传auth/models paths，与SDK显式agentDir规则不同。详见workspace `.migration-handoff/sdk-r15-0927/next-slice-audit.md`；之后print→RPC→M6。
- **生命周期不变量**：r13 replacement abort→最终持久化→shutdown→同步beforeInvalidate/dispose→create/apply→setup/transcript→rebind/withSession；每次await后读live slot，仅字面true取消，不回滚已apply/dispose状态。Runtime.dispose非幂等、不先await abort；print外层guard，finally remove signals→guarded dispose→flush，dispose失败不flush。保留r10输出背压/r9 JSON；禁止忙等/block_on导航/脱离线程reload/缓存旧session。
- **协作约束**：串行无子智能体/委派；pi只读，不查看修改pisper；保留dirty，无stage/commit/reset/stash/clean/push；无真实凭据/付费provider/OS clipboard/unsafe。历史11:30截止已履行；此前的继续授权由本轮收尾停止要求收束。交接完成后不再推进。

以下为历史证据（非当前live状态）：

---

## 2026-09-27 W3.14 r14 Agent stream adapter：完整门禁通过，交接封存入口

- **真实验收**：fmt exit0、offline clippy all-targets -D warnings exit0；all-targets单线程 **3864通过（3828 lib + 27 generator + 9 pirs）/0失败/2历史ignored**；doc **5通过/0失败/1历史ignored**，忽略名单与r13一致。605项source/build在门禁前后和独立closeout完全一致，净增14项测试。命令/退出码/日志hash见 `docs/migration/validation/stream-adapter-r14-acceptance.json`，独立复核见 `stream-adapter-r14-closeout.json`。所有本片验证进程已终态，无在途Cargo，不再poll旧句柄。
- **落地范围**：Agent/loop新增typed async `stream_fn`、逐轮`get_api_key`、request callbacks/transport、完整继承SimpleStreamOptions；每轮transform→convert→normalize→key→await factory，保留默认Models路径。显式Off清除继承reasoning，live run signal覆盖存储signal，空key按上游回退；回调Arc身份保留，run间可换runtime配置。只改三个既有source：types.rs、agent.rs、agent_loop.rs。
- **错误/异步契约**：正常请求错误走terminal events；factory/key拒绝raw loop传播、Agent外层按既有error/aborted生命周期结算。合作式取消，不race/drop未完成factory/key。awaited listener、bounded channel背压和agent_end idle barrier保持。缺terminal stream原防御行为保留，不冒称JS合法stream语义。新增14项测试（`stream-adapter-r14-targeted-c.json`）覆盖pending/reject/reentry等，并通过真实ModelRuntime+HTTP provider到loopback wiremock验证headers→awaited payload→response和回调错误。
- **真实差分**：完整未改写上游Agent/loop/default-stream/transcript/text/EventStream，16场景被Rust消费；修正后的oracle b/c两次逐字节一致。原oracle-a六个raw场景因采样调用把emit/signal反传而无效（Node虽exit0但trace为空）；targeted-b确实失败并暴露问题。已按上游签名修正harness、加入采样自校验，**没改Rust断言/生产行为来迎合错误样本**。旧fixture/script、原始stdout/stderr、失败receipt与source快照全部保留，closeout单独核验。oracle仅stream/key测试collaborators，不是SDK端到端。
- **回归与保护**：Agent/loop 90、AgentSessionRuntime 13、Models 128、callbacks 2分别通过（重叠不可相加充当总数）。targeted-a旧AgentOptions测试字面初始化缺4字段的编译失败也完整留痕。Cargo/原utils CRLF/hash、WORK_LOG binary append前缀、两repo HEAD/index/pi status+diff以及scope外8541项继承文件已独立核验。原件/final.patch/after-hashes/失败快照在workspace `.migration-handoff/stream-adapter-r14-0927`。
- **正式封存判定**：checkpoint为workspace `.migration-handoff/checkpoint-0927-stream-adapter-r14`，previous=r13；必须存在外层 `.migration-handoff/stream-adapter-r14-0927-verified.json` 且 `live_files_status_diff_root_HEADs_and_indices_verified: true`、manifest hash一致才是正式r14。缺失/失败时最后正式点仍r13，不以入口预告代替收据。create/verify日志/finalization只写外层；封存后不再写repo/root入口；allow-existing-source只含scope三个既有文件。
- **未完成边界**：本片为 **M5 SDK所需的Agent层接线前置，不是M4、真正SDK/services或完整CLI**。AgentSessionRuntime/r13数据契约不等于服务工厂；生产create_agent_session尚未落地。Windows offline native限定；Future poll-driven不等于JS eager Promise，mpsc不等于JS独立result promise；进程全局default-stream API、原hook signal/error seam、任意JS identity/throw/stack/embedded host未扩展。全量M1–M6未完成，goal active。详情 `docs/migration/STREAM_ADAPTER_R14.md`。
- **下一实际切片**：先核验正式r14，再做provider-attribution leaf与真正SDK ModelRuntime流接线：live SettingsManager retry/http idle/ws timeout（idle0→2147483647，显式options优先）、归因headers和**当前**runner的headers/payload/response/context钩子，reload不可缓存旧runner。之后services loader.reload→有序provider/native注册/diagnostics→offline refresh→flags；pending native provider需typed化，不能用JSON/测试factory冒充。执行审计见workspace `.migration-handoff/stream-adapter-r14-0927/next-slice-audit.md`；r13旧审计里“先补streamFn”的前置已完成，不重复。
- **生命周期不可破坏**：replacement先abort→最终持久化→shutdown→同步beforeInvalidate/dispose→create/apply/setup/transcript/rebind/withSession；Runtime.dispose非幂等且不先await abort，print外层才guard。各await后读live slot，只字面true取消，不加全局async mutex、不回滚已apply/dispose状态。然后接r10 guard/背压+r9 JSON/print finally（remove signals→guarded dispose→flush，dispose失败不flush）→RPC/M6。禁止恢复隔离WIP忙等/block_on导航/脱离线程reload/旧session缓存。
- **协作约束**：串行无子智能体/委派；pi只读、不查看修改pisper；保留dirty，无stage/commit/reset/stash/clean/push；无真实凭据/付费provider/OS clipboard/unsafe。历史11:30截止与暂停已履行，用户已明确继续，无新截止。

以下为历史证据（非当前live状态）：

---

## 2026-09-27 W3.13 r13 AgentSessionRuntime：完整门禁通过，交接封存入口

- **真实验收**：fmt exit0、offline clippy all-targets -D warnings exit0；all-targets单线程 **3850通过（3814 lib + 27 generator + 9 pirs）/0失败/2历史ignored**；doc **5通过/0失败/1历史ignored**，忽略名单与r12一致。603项source/build在完整门禁前后和独立收尾完全一致。完整命令/退出码/日志hash见 `docs/migration/validation/session-runtime-r13-acceptance.json`，独立复核见 `session-runtime-r13-closeout.json`。验证进程已终态，无在途Cargo，不再poll旧句柄。
- **落地范围**：M5 `AgentSessionRuntime` 已注册：真实AgentSession/current-session slot、typed async factory、new/switch/fork/import/dispose、setup/transcript/rebind/withSession生命周期；补齐cwd验证与typed错误。`AgentSessionServices`仅共享数据契约，**不是SDK/services构造实现**。SettingsManager改共享Arc内部状态，session/services/loader的设置、存储、pending写和error queue保持同一身份。
- **差分与异步证据**：Node直接执行完整未改写上游Runtime/cwd源码，41项生命周期+5项cwd场景被Rust真实session/manager消费，两次独立采样逐字节一致。oracle明确披露factory/session/manager/runner collaborators，不冒充SDK端到端。新13项Rust测试全部通过（`session-runtime-r13-targeted-h.json`），含pending/reject/reentrant/live-slot、磁盘和内存fork、import失败副作用、settings共享，以及真实faux run下abort→最终消息持久化→shutdown的顺序；另证实dispose先等shutdown、随后dispose取消agent、不先await run。
- **回归**：SettingsManager 39、AgentSession 86、extensions 87、resource-loader 16分别通过（相互有重叠，不能相加充当全库总数）。相对r12全库净增13。真实faux provider在Agent与ModelRuntime两处注册，无真实网络/凭据；内存假key明确非秘密。
- **失败留痕/保护**：a缺SettingsManager Clone；b测试JSONL缺type标签；d测试编译接口；e测试绕过Session.prompt；f超时、g诊断证实测试的ModelRuntime漏注册faux provider。原日志/真实Cargo101和source快照全部保留，未改oracle迎合、未放宽8秒timeout、未修改生产鉴权或abort行为。既有source仅core.rs/settings_manager.rs两项，新5项source/fixture+1项oracle脚本；Cargo、utils原CRLF/hash、WORK_LOG binary append历史前缀、两repo HEAD/index/pi status+diff及scope外继承文件全部核验。原件/final.patch/after-hashes在workspace `.migration-handoff/session-runtime-r13-0927`。
- **正式封存判定**：checkpoint为workspace `.migration-handoff/checkpoint-0927-session-runtime-r13`，previous=r12；必须存在外层 `.migration-handoff/session-runtime-r13-0927-verified.json` 且 `live_files_status_diff_root_HEADs_and_indices_verified: true`、manifest hash一致才是正式r13。缺失/失败时最后正式点仍r12，不以此段预告替代收据。create/verify日志/finalization均写workspace外层，封存期间及之后停止repo/root入口写入；allow-existing-source仅scope两项。
- **未完成边界**：本片是 **M5会话生命周期，不是M4或完整CLI**。Windows离线native限定，native factory/回调Future为poll-driven，不等同JS eager Promise/microtask；任意JS throw/stack、embedded JS host、部分typed/JSON identity与OS错误文本仍有seam。真正SDK、create-services/create-from-services及print/RPC/server尚未完成/注册；M1–M6未全量完成，goal active。
- **下一实际切片**：先核验r13收据，再扩scope补Agent/loop typed stream adapter与options（当前AgentOptions缺streamFn/onPayload/onResponse/transport，loop直接Models.stream_simple）。之后实现真正SDK的ModelRuntime流接线、live settings/retry/timeout、attribution与当前runner的headers/payload/response/context钩子，再services factory的reload→provider注册→offline refresh→flags。见workspace `.migration-handoff/session-runtime-r13-0927/next-slice-audit.md`。再接r10输出guard/背压+r9 JSON/print finally→RPC/M6。禁止用test factory冒充SDK，也禁止恢复隔离WIP忙等/block_on导航/脱离线程reload/缓存旧session。
- **生命周期不可破坏**：replacement先abort再shutdown，再同步beforeInvalidate/dispose，最后create/apply/setup/transcript/rebind/withSession；Runtime.dispose自身非幂等且不先await abort，print外层才guard。Runtime仅字面true取消，不等于通用runner truthy短路；各await后读live slot，允许异步重入，不加全局async mutex。失败不回滚已apply/已dispose状态。
- **协作约束**：无子智能体/委派，pi只读，不查看修改pisper；保留dirty，无stage/commit/reset/stash/clean/push，无真实凭据/付费provider/OS clipboard/unsafe。历史11:30截止/暂停已履行，用户已明确继续，无新截止。

以下为历史证据（非当前live状态）：

---

## 2026-09-27 W3.13 r12 async-events：完整门禁通过，交接封存入口

- **真实验收**：fmt exit0、offline clippy all-targets -D warnings exit0；all-targets单线程 **3837通过（3801 lib + 27 generator + 9 pirs）/0失败/2历史ignored**；doc **5通过/0失败/1历史ignored**，忽略名单与r11一致。598项source/build在完整门禁前后和独立收尾均一致。完整命令/退出码/日志hash在 `docs/migration/validation/async-events-r12-acceptance.json`，独立复核在 `async-events-r12-closeout.json`。验证进程已终态，无在途Cargo，不再poll旧句柄。
- **落地范围**：通用HandlerFn改借用式HandlerFuture，13条分派/辅助入口逐handler await；AgentSession输入、持久化前消息拦截、reload/shutdown、steer/followUp等消费者真实等待，不是async外壳。setModel返回共享CommandFuture；sendMessage/sendUserMessage/compact使用Tokio执行并路由错误/回调，普通sendUserMessage Err不再丢弃；ui_prompt/void会话通知显式detached调度，无runtime时报告错误。最终targeted-f：新22、extensions87、AgentSession86、resource-loader16分别全过（相互有重叠，不能相加当全库总数），全库相对r11净增22。
- **差分证据**：完整未改写runner.ts的38场景被Rust消费，独立重采样逐字节一致。两批真实行为红灯（0通过/2失败、7通过/2失败，Cargo101）证实并修复truthy cancel、live event.type、project_trust跨await全局snapshot、headers写入后reject仍保留修改。首次oracle-a漏structuredClone导致context两条未到pending，原始脚本/输出保留；oracle-b仅修这两条，oracle-c新增两条且既有36条不变。before_agent_start另有native gate测试，不冒称actual-source覆盖。
- **失败留痕/保护**：async传播编译失败、targeted-b引用需clone、targeted-c的18过/2失败（测试误设session streaming/idle行为）、d漏Ordering导入、e的resource-loader零匹配均保留；未改oracle迎合。既有source只改scope12项，新增3项src测试/fixture+1项oracle脚本。Cargo不变，WORK_LOG binary append历史前缀、utils原CRLF/hash、两repo HEAD/index/upstream status+diff、scope外继承文件均核验。原件/红灯快照/final.patch/after-hashes在workspace `.migration-handoff/async-events-r12-0927`。
- **正式封存判定**：checkpoint为workspace `.migration-handoff/checkpoint-0927-async-events-r12`，previous=r11；必须存在外层 `.migration-handoff/async-events-r12-0927-verified.json` 且 `live_files_status_diff_root_HEADs_and_indices_verified: true`、manifest hash一致，才是正式r12。缺失/失败时最后正式点仍r11，不以此段预告代替收据。create/verify日志/finalization全部写workspace外层，封存期间及之后停止repo/root入口写入；allow-existing-source仅scope12项。
- **未完成边界**：本片是 **M5运行时/print的异步事件前置，不是M4或完整CLI**。Windows离线native限定；HandlerFuture/dispatch是poll-driven，CommandFuture是eager共享native任务；Tokio不等于JS Promise/queueMicrotask。factory/UI facade、JS host、任意JS throw/stack、JSON对象identity/重赋值及其它typed mutation/truthiness、completion callback自身抛错仍有seam。Runtime/print/RPC/server仍未注册，M1–M6未全量完成，goal active。
- **下一实际切片**：核验r12收据后新开scope，对完整AgentSessionRuntime建立生命周期oracle并接native async factory/services/current-session。本轮确认AgentSessionServices、SDK create_agent_session和MissingSessionCwdError尚无native实现，要补所需typed接口/cwd验证，不把测试collaborator称作生产SDK。replacement为abort→shutdown→同步beforeInvalidate→dispose→create/apply→new setup与transcript同步→rebind→withSession；Runtime.dispose非幂等且不先abort，print闭包才guard；通用emit truthy cancel与Runtime字面true取消不能合并。详见workspace `.migration-handoff/async-events-r12-0927/next-slice-audit.md`。再接r10输出背压/r9 JSON/print finally，再RPC/M6 server。禁止恢复隔离WIP忙等/block_on导航/脱离线程reload/缓存旧session。
- **协作约束**：无子智能体/委派，pi只读，不查看修改pisper；保留继承dirty，无stage/commit/reset/stash/clean/push，无真实凭据/付费provider/OS clipboard/unsafe。历史11:30截止/暂停已履行，用户已明确继续，无新截止。

以下为历史证据（非当前live状态）：

---

## 2026-09-27 W3.13 r11 async command-context：完整门禁通过，交接封存入口

- **真实验收**：fmt exit0、offline clippy all-targets -D warnings exit0；all-targets单线程 **3815通过（3779 lib + 27 generator + 9 pirs）/0失败/2历史ignored**；doc **5通过/0失败/1历史ignored**，忽略名单与r10一致。595项source/build在完整门禁前后和独立收尾均一致。命令/真实退出码/日志hash在 `docs/migration/validation/command-context-r11-acceptance.json`，独立复核在 `command-context-r11-closeout.json`；session55020已正常终态，无在途Cargo，不再poll旧句柄。
- **落地范围**：新增共享 `CommandFuture`，六动作 waitForIdle/newSession/fork/navigateTree/switchSession/reload 和 setup/withSession可await；command-context保持调用时即时stale检查、选择当前handler并原样返回任务，不把分派延后到poll。区分同步throw与异步reject，忽略handle不取消已启动工作；无runtime的已完成默认动作、多等待者、panic→awaiter错误、rebind/inflight、重入无持锁均有回归。`RegisteredCommand.handler`区分同步void/Promise/throw，AgentSession真实await，拒绝仍作为handled命令emitError并报告preflight(true)，不是吞错或落回模型。
- **两个真实红灯→修复**：空stale字符串应为falsy，第一条非空消息才锁定；另一个是handled命令重复preflight（[true,true] vs [true]）。原实现测试exit101、日志/source原件/hash均保留；prompt最终确认现仅在messages存在时执行，同时覆盖input/streaming queue早返回。等待期间更换runner时，catch向当前runner报错。消费者真实session验证pending reload/拒绝、runner替换、无模型调用及streaming早返回。中间targeted-a/b编译问题、c测试误设初始消息为空都保留，未改oracle迎合；最终targeted-d 20通过、clippy0。
- **差分与写域证据**：未改写完整上游runner 45场景 + AgentSession原方法17场景（共62）重采样exit0且与首次fixture逐字节一致，上游source hash未变。既有source改动仅scope九项，新增五项source/fixture+两项oracle脚本；Cargo.toml/lock完全不变。scope/before、两条红灯source、完整final.patch和after hashes在workspace `.migration-handoff/command-context-r11-0927`；WORK_LOG原字节前缀、utils原CRLF/hash、Rust/upstream HEAD与index均核验保持。
- **正式封存判定**：checkpoint为workspace `.migration-handoff/checkpoint-0927-command-context-r11`，previous=r10；必须有外层 `.migration-handoff/command-context-r11-0927-verified.json` 且 `live_files_status_diff_root_HEADs_and_indices_verified: true`、manifest hash相同，才能认定r11正式封存。收据缺失/失败时最后正式封存仍r10，不以本段预告替代收据。create/verify日志及finalization全部写workspace外层，封存期间及之后不写repo；allow-existing-source仅scope九项且全部确实存在于r10归档。
- **未完成边界**：本片是 **M5 print的异步命令前置，不是M4续做或完整CLI**。只验证Windows离线native；general extension事件/factory/UI仍有同步seam，JS host/microtask、任意JS throw/stack、owned options的JS对象identity未完成；nested callback与runner替换测试使用显式collaborator，不等于真实RuntimeHost已落地。print/RPC/server仍未注册，r9更深provider/message/storage未知字段等继承seam不消失，M1–M6全量仍未完成，goal active。
- **下一实际切片**：先核验r11收据，再针对上游真实 `core/agent-session-runtime.ts`（AgentSessionRuntime，449行）建立生命周期oracle并补native async factory/services/current-session接线；明确审计general async事件依赖，不能用同步emit包async壳冒充等待扩展Promise。replacement严格abort→shutdown→beforeInvalidate→dispose→create/apply→setup→rebind→withSession，失败不吞。之后接print的最新session slot、owned OutputGuard、`to_json_event_string`、订阅背压、空initialMessage/errorMessage与finally顺序。Runtime.dispose本身非幂等且不先abort，print闭包才有幂等guard，不要加错层。具体审查/指纹在workspace `.migration-handoff/command-context-r11-0927/next-slice-audit.md`。不得恢复隔离WIP忙等wait/block_on导航/脱离线程reload、旧mod/json_event和缓存旧session；print后再RPC、M6 server。
- **协作约束**：无子智能体/委派，pi只读，不查看修改pisper；继承dirty保持，无stage/commit/reset/stash/clean/push，无真实凭据/付费provider/OS clipboard/unsafe。WORK_LOG只允许binary UTF-8 append，src/tui/utils.rs不可换行改写。

以下为历史证据（非当前live状态）：

---

## 2026-09-27 W3.13 r10 output-guard：完整门禁通过，独立封存/接手入口

- **真实门禁**：fmt0、offline clippy all-targets -D warnings 0；all-targets串行 **3796通过（3760 lib + 27 generator + 9 pirs）/0失败/2历史ignored**；doc **5通过/0失败/1历史ignored**。忽略名单与r9完全一致。590项source/build冻结前后及收尾复读一致；验收命令/退出码/日志hash在 `docs/migration/validation/output-guard-r10-acceptance.json`，独立核验在 `output-guard-r10-closeout.json`。session77134已正常exit0，无在途Cargo，不再poll旧句柄。
- **本片落地**：`core/output_guard`是真实callback完成队列（非同步空背压）、持久rejected tail与每个enqueue的fatal exit(1)、精确10ms三类code重试、背压tail identity复检、独立flush空写、stdout路由/takeover/restore/替换writer。safe native FIFO IO线程适配；真实子进程验证stdout只含JSON协议、诊断只到stderr，事件序列化用当前 `to_json_event_string`。
- **真实红灯→修复**：同一同步栈4096次入队，上游成功路径4097次写/0 exit、失败路径1次写/4096个exit；原Rust两个子进程均栈溢出0xc00000fd（父test101），原始日志/source原件/hash保留。已改为spawn任务驱动、tail仅oneshot完成通知，消除递归poll；两个压力场景与全部17项定向测试通过。子进程有20s有界等待和回收，未改fixture迎合实现。
- **证据/写域**：18基础+2 backlog actual-source oracle重新执行exit0、逐字节不变，上游output-guard.ts hash未变。scope、三项继承source/build原件、红灯原件、完整final.patch及after hashes在workspace `.migration-handoff/output-guard-r10-0927`；Cargo.lock逐字节核验仅根依赖增加已缓存libc，无包版本变化。utils原CRLF/hash与WORK_LOG历史前缀保持。
- **正式封存判定**：新目录workspace `.migration-handoff/checkpoint-0927-output-guard-r10`，previous=r9；只有外层 `.migration-handoff/output-guard-r10-0927-verified.json` 存在、`live_files_status_diff_root_HEADs_and_indices_verified: true`且manifest hash匹配才算正式r10。否则最后正式封存仍r9。create/verify日志与finalization收据写workspace外层，封存期间及之后不写repo；allow-existing-source仅core.rs、Cargo.toml、Cargo.lock三项（均确实在r9归档中）。
- **未完成边界**：本片为M5 print/RPC输出前置，不是M4续做或完整CLI交付。native仅UTF8、bool保守false；任意Rust println不被全局拦截，JS-host需显式接router，process convenience在Tokio runtime内使用。本次只验证Windows，未证明Unix/全编码/Node high-watermark/JS任意throw与全局monkey-patch兼容。print/RPC/server尚未注册；r9记载的更深provider/message/storage未知字段、JS identity/原始数值溢出等继承seam仍在，W3.13与M1–M6全量未完成。
- **下一实际切片**：继续print接线，但先修真正的async command-context边界。`extensions/types.rs`的WaitForIdle/NewSession/Fork/NavigateTree/SwitchSession/Reload六类handler及`extensions/runner.rs`的command-context方法当前同步；隔离WIP print里的忙等wait、futures::executor::block_on导航、脱离线程reload并吞错误不能恢复为正式实现。先用未改写上游runner/print建立异步完成/拒绝/会话rebind oracle，再引入可await接口与回归；之后接owned OutputGuard、空initialMessage/空errorMessage回退、最新session引用、幂等dispose与finally错误/flush顺序。不得注册旧mod.rs/json_event或把同步host骨架称兼容；再继续RPC、M6 server。
- **协作约束**：无子智能体，pi只读，pisper不查看/修改；无stage/commit/reset/stash/clean/push，无真实凭据/付费provider/OS clipboard/unsafe。WORK_LOG仅binary UTF-8 append，不全仓可写格式化。全量goal active，无新截止或暂停请求。

以下为历史证据（非当前live状态）：

---

## 2026-09-27 W3.13 r9 typed ingress：完整门禁通过，独立封存/接手入口

- **真实门禁**：fmt exit0、offline clippy all-targets -D warnings exit0；串行 all-targets **3779通过（3743 lib + 27 generator + 9 pirs）、0失败、2历史ignored**；doc **5通过、0失败、1历史ignored**。585项source/build在冻结前后及独立收尾复读一致。准确命令/退出码/日志SHA256在`docs/migration/validation/modes-ingress-contract-r9-acceptance.json`；独立核验在`modes-ingress-contract-r9-closeout.json`。session7138已正常exit0，不再poll旧句柄。
- **本片落地**：真实serde AgentEvent→AgentSessionEvent→JSON入站保字段/键序；私有不可变typed+raw carrier、只读`kind()`匹配；reducer/CLI/session queue/extension/listener/persistence与TurnEnd flush接入。AgentEnd willRetry按上游原键槽覆盖/末尾追加；MessageEnd显式整条替换、原子同步typed/wire、无旧未知字段残留。反序列化现在返回Preserved，消费者须对`event.kind()`模式匹配，不能把envelope当未知事件跳过；需要typed相等时比较kind视图。
- **证据**：4组真实红灯→绿色；新增17项入站/真实消费者回归通过，agent types19通过、modes23通过。33条直接上游oracle（18 ordinary/11 updates/2 start/2 errors）+2条原方法replacement oracle重新执行exit0、逐字节不变；与原红灯fixture SHA256一致，两个只读上游文件hash也一致。scope、8个继承source原件、含新增文件完整patch和after hashes在workspace`.migration-handoff/modes-ingress-contract-r9-0927`；无新依赖，Cargo.toml/lock、utils原CRLF与WORK_LOG历史前缀原样。
- **封存位置**：workspace`.migration-handoff/checkpoint-0927-modes-ingress-r9`，previous=正式r8。仅在外层独立收据`.migration-handoff/modes-ingress-r9-0927-verified.json`存在、`live_files_status_diff_root_HEADs_and_indices_verified: true`且manifest hash匹配后，才算正式封存；该收据缺失/失败时最后正式封存仍r8。create/verify完整日志及finalization收据写workspace外层，封存期间不写repo。
- **未完成边界**：本片仅typed-valid AgentEvent JSON入站到本次event输出；standalone AgentMessage、更早provider解码、session-storage及后来生成的事件仍有未知字段/键序丢失边界。typed持久化内容正确不等于未知字段已被持久化。跨事件JS对象identity/其它扩展原地mutation仍有seam；未知stream变体在typed入口仍拒绝（direct session Value路径开放）。原始`1e400`等溢出、其它包integer-index、print/RPC/server、W3.13整体及M1–M6全量未验收；本次Windows离线串行门禁不证明Unix/真实provider兼容。
- **下一片串行**：先核验r9收据及live稳定，再恢复隔离WIP中的print/RPC，但不要原样复制旧json_event/mod声明。JSON输出必须走`to_json_event_string`，不能退回普通serde writer。先审计output-guard真实顺序/背压/重试/致命错误以及print的空initialMessage、errorMessage空串回退、session rebind和退出清理；建立actual-source oracle后再注册。runtime-host与信号/扩展桥必须明确留界，不能恢复骨架即宣称全量完成。随后再接M6 server。
- **协作约束**：无子智能体，pi只读，pisper不查看/修改；无stage/commit/reset/stash/clean/push，无真实凭据/付费provider/OS clipboard/unsafe。WORK_LOG仅binary UTF-8 append，不全仓可写格式化。全量goal保持active，无新截止时间或暂停请求。

### r9封存执行补记（2026-09-27，需与上方收据一并核对）

首轮create因`src/cli/render.rs`不在r8 dirty snapshot而安全拒绝（exit1、destination尚未创建，verify未运行），不是源码/门禁失败。该文件在r8是干净tracked文件；已用r8的完整source冻结hash、scope原件和Git HEAD checkout filters逐字节交叉核验（原CRLF是Git checkout语义）。重试只对r8归档实际存在的7个继承source传`--allow-existing-source`；render.rs按新dirty tracked文件进入r9归档，仍属于本轮8文件scope。无更改source/fixture/门禁，无放宽兼容性断言。失败原始日志/finalization保留；重试日志/finalization使用`modes-ingress-r9-0927-r2-*`，最终独立收据名仍为`modes-ingress-r9-0927-verified.json`。保护/原件核验见外层`modes-ingress-r9-0927-checkpoint-preflight-r2.json`。


以下为历史记录；旧绿色和旧在途状态不代表当前live。

---

## 2026-09-27 W3.13 r9 typed ingress：17项新增定向全部通过，冻结源码运行完整门禁

- 最后正式封存仍为r8；当前live为r9，尚未完成完整门禁/独立封存。
- targeted-b已于2026-09-27T16:12:51+09:00正常终态：scoped rustfmt0、offline clippy0、json_ingress_ 17通过、agent types19通过、modes23通过；日志SHA256已复读核验，旧session18517不再poll。
- r8的578项source/build复核仅8个已登记继承文件改变；Cargo.toml/lock、utils原CRLF和WORK_LOG 419140字节历史前缀保持原样。scope在workspace .migration-handoff/modes-ingress-contract-r9-0927。
- 现在冻结源码，串行运行run_acceptance.py modes-ingress-contract-r9-acceptance；完成前不得复用r8全绿。随后独立复读日志/source/oracle，保存scope patch，更新交接后create/verify封存。
- 本轮仅typed-valid AgentEvent入站→本次session/JSON事件保字段和键序；更早provider/standalone message、持久化后续事件、原始数字溢出、print/RPC/server及全量M1–M6仍未验收。串行、不委派、不改pi/pisper、不做Git写操作；goal active。

以下是历史记录，旧在途状态不代表当前状态。

---

## 2026-09-27 W3.13 r9 typed ingress：定向已通过一轮，补充测试/门禁中（未封存）

- **最后正式封存仍是r8**：workspace `.migration-handoff/checkpoint-0927-modes-number-r8`及`modes-number-r8-0927-verified.json`。当前live已有r9修改，不能把r8的全绿移用到当前树。
- **r9进展**：33条直接上游oracle，4组真实serde AgentEvent→session→JSON红灯已修复；第一轮新增14测试通过、modes23通过。现补了3条native/异常替换/extension原字段集成测试，`modes-ingress-contract-r9-targeted-b`串行运行（scoped fmt→clippy→ingress→agent-types→modes），尚未完成完整四门禁。
- **实现与scope**：只读typed view + 私有原始JSON carrier，反序列化后应`event.kind()`再模式匹配；接入真实reducer、CLI、session queue/extension/persistence路径及retry覆盖。message_end显式全替换同步typed/wire，不能使用旧snapshot。8个继承文件原件/登记在workspace `.migration-handoff/modes-ingress-contract-r9-0927`；WORK_LOG仅binary append，utils CRLF、Cargo.toml/lock受保护。
- **明确边界**：只是AgentEvent JSON入站到本次event输出的保字段/键序；standalone AgentMessage、provider、session-storage及以后生成的事件仍有更早的typed丢失边界。未知stream变体仍须由direct session Value路径处理；不声称任意JSON入站、原始数值溢出、print/RPC/server或W3.13/M1–M6已完成。
- **接续**：先读取targeted-b真实收据/日志确认终态，禁止叠跑Cargo；处理真实失败后冻结source，运行run_acceptance.py全新前缀完整门禁。通过后更新四入口、append日志、存scope patch，再以r8为previous独立封存/核验。仍串行无子智能体，不改pi/pisper，不做Git写操作。goal active，无新截止或暂停。

下方历史封存不代表当前live已全绿。

---

## 2026-09-27 W3.13 r8：完整门禁通过，独立封存/接手入口

- **门禁已验证**：fmt exit0、offline clippy all-targets -D warnings exit0；串行all-targets **3762通过（3726 lib + 27 generator + 9 pirs）、0失败、2历史ignored**；doc **5通过、0失败、1历史ignored**。578项source/build hashes冻结前后和收尾复读一致。准确命令、退出码及日志hash：`docs/migration/validation/modes-number-contract-r8-acceptance.json`；独立复读：`modes-number-contract-r8-closeout.json`。
- **本切片**：M5 JSON Number兼容。5组真实路径红灯→绿色；新增数字测试9通过、整个modes19通过。61原始数字输入、6378 IEEE位模式（双符号全有限指数桶、含8非有限内存值）、14数字错误标签的直接上游oracle未改。开启float_roundtrip修解析舍入，共享JS Number writer接真实session wire、OrderedValue和错误标签；整数先按binary64舍入，负零/指数阈值/非有限JSON输出及数字样式字符串已有验证。Cargo.lock不变、无新依赖。
- **封存位置**：workspace `.migration-handoff/checkpoint-0927-modes-number-r8`，previous为正式r7。必须核对独立收据 `.migration-handoff/modes-number-r8-0927-verified.json` 的 `live_files_status_diff_root_HEADs_and_indices_verified: true` 且manifest hash一致，才算正式封存；该收据缺失/失败时最后有效封存仍为r7，不能只凭本文宣称封存成功。create/verify原始日志与finalization记录都写workspace外层。r8 scope、原件、最终完整patch与after hashes：`.migration-handoff/modes-number-contract-r8-0927`。
- **未完成边界**：4个`1e400`等原始JSON溢出入站仍未实现（不是把Infinity预替null就算兼容）；typed入口未知字段/原始键序、其它包integer-index、print/RPC/server未验收。Value投影不等于JS Number字符串wire，恢复print/RPC时须走`to_json_event_string`。本次Windows离线串行门禁不证明Unix/真实provider或全量M1–M6完成。
- **下一步串行**：先核验r8收据及当前树，再对typed入口保字段/键序建立actual-source与实际AgentEvent→AgentSession路径差分，先红后绿且新登记scope；随后接print/RPC与M6 server。不委派、不改pi/pisper、不stage/commit/reset/clean/stash/push。WORK_LOG只能binary UTF-8 append，TUI utils原CRLF必须保留。goal保持active，无新截止时间或暂停请求。

下方为历史记录；旧绿色/旧在途句柄不代表当前状态。

---

## 2026-09-27 W3.13 r8 Number定向通过，完整门禁进行中

r8真实红灯5组已修复；新增数字测试9通过、modes模块19通过，准确记录见validation/modes-number-contract-r8-targeted.json。开启serde_json float_roundtrip（lock无变化）；共享JS Number输出接modes/OrderedValue及错误标签。61 raw / 6378 IEEE bits / 14错误标签的actual-source oracle原样保留；另4个溢出原始JSON输入仍未实现。

现在冻结源码运行fmt、offline clippy、串行all-targets及doc；未出终态前不称live全绿。最后正式封存为workspace .migration-handoff/checkpoint-0927-modes-order-r7（8313文件独立核验）。r8 scope原件在.migration-handoff/modes-number-contract-r8-0927。下一步按完整门禁结果收口并新封存；typed未知字段、其它包integer-key、print/RPC/server、W3.13与全量迁移尚未完成。不开子智能体，pi只读，pisper不碰，无Git写操作。下方历史记录不代表当前live。

---

## 2026-09-27 W3.13 r8 Number差分进行中

r7已正式封存并独立核验8313文件，manifest2374ff381f0a3afcee83a4703b77e450a322caaab28079ba5690bbc1081ccdac。live现进入r8：Node直接上游oracle已采集61个原始数字输入、6378个IEEE位模式（含8个非有限内存数值）和14个错误标签，5组真实路径测试已全部红灯（0通过/5失败，cargo exit101），含1865条解析bits差异；生产修复现在开始。另4个溢出JSON文本明确作为未实现入站审计，不冒充已通过。

下一步依据真实红灯修Number输出/有限数字入站舍入，再完整门禁和新封存；不能将r7绿色套用于live。不开子智能体，pi只读，pisper不碰；W3.13、print/RPC/server及全量迁移仍未完成。最新过程见WORK_LOG及validation/modes-number-contract-r8-*，原件/scope在workspace .migration-handoff/modes-number-contract-r8-0927。下方为历史记录。

---

## 2026-09-27 W3.13 r7：完整门禁通过，交接封存入口

- **已验证**：fmt exit0；offline clippy all-targets -D warnings exit0；串行all-targets **3753通过（3717 lib + 27 generator + 9 pirs）、0失败、2历史ignored**；doc **5通过、0失败、1历史ignored**。575项source/build hashes在门禁前后不变，保存的命令、退出码和日志hash也已独立复读。收据：`docs/migration/validation/modes-order-contract-r7-acceptance.json`。
- **本切片**：29个直接import只读上游json-event.ts的oracle样例，5组真实入口/AgentEvent→AgentSessionEvent差分从红转绿；另2项键分类/递归幂等单测。修复Value/string投影丢字段或重排、显式partial权威、id/name原位覆盖/undefined省略、内部discriminator桥接、数字属性名递归枚举；保留旧oracle，不用排序测试结果掩盖wire差异。定向7通过，modes全模块13通过。
- **封存入口**：workspace `.migration-handoff/checkpoint-0927-modes-order-r7`；成功标志必须同时存在有效manifest及独立收据 `.migration-handoff/modes-order-r7-0927-verified.json`（`live_files_status_diff_root_HEADs_and_indices_verified: true`，且manifest哈希一致）。创建/核验原始日志也放workspace外层，核验时不修改仓库。若该收据尚未成功，最后有效封存仍是r6b，不能只凭本段宣称封存完成。r7原件、scope、最终patch和hash位于workspace `.migration-handoff/modes-order-contract-r7-0927`。
- **边界**：这不是完整JSON.stringify兼容；一般Number字符串格式、typed入口未知字段/原始键序、其它包integer-index语义仍未验收。4个其它模块只修过时文档，没有宣称其运行时已修复。旧raw_partial单测输入曾与上游冲突，已显式修正输入而未改expected，原因在WORK_LOG。Windows离线串行门禁不能替代Unix、真实provider或全上游行为验收。
- **下一步（串行）**：先做Number原始JSON/实际入口字节oracle（-0、整数浮点、2^53边界、指数阈值、极小/大值及错误标签），确认差异后再限域修复；另开明确scope审计typed入口和protocol/chord等包，不能仅让OrderedValue旁路过测。然后再接print/RPC入口与M6 server。W3.13整体、print/RPC/server注册、M5/M6和全量M1–M6任务**均未宣告完成**。

用户已要求继续；goal保持active，无新截止或暂停请求；不开子智能体、不触碰pisper、pi只读、不做Git写操作。下方为历史记录。

---

## 2026-09-27 W3.13 r7定向通过，进入完整门禁

r7生产修复已落盘并验证：json_wire_新增7项通过，JSON modes模块13项通过；29个实际只读上游oracle用例保持不变，5组行为回归已从全红转绿。已统一Value/string投影，保留delta及嵌套未知字段，尊重显式partial，按JS规则递归枚举integer-index键。详见validation/modes-order-contract-r7-targeted.json和WORK_LOG最新段。

当前准备冻结源码跑fmt / offline clippy / 串行all-targets / doc，结果未出前不称live全绿。最后正式封存仍workspace .migration-handoff/checkpoint-0927-modes-order-r6b，8298文件独立核验；不得把它的3746通过套用于live。一般Number字符串格式、typed入口未知字段、其它包integer-key仍待独立审计；print/RPC/server、W3.13整体与M1–M6全量尚未完成。下方为历史记录。

---

## 2026-09-27 W3.13 r7进行中；r6b已正式封存

r6b四门禁已通过：3746通过（3710+27+9）、0失败、2历史ignored；doc5通过/1历史ignored；574项source/build hashes不变。已创建并独立核验workspace .migration-handoff/checkpoint-0927-modes-order-r6b（8298文件），收据modes-order-r6b-0927-verified.json，完整留痕已落盘。

live已进入r7，不能套用r6b绿色结论：新增29个实际上游JSON事件oracle样例、5组真实入口/AgentEvent→AgentSessionEvent回归，覆盖字段重排/未知字段、partial权威、数字键。首轮新增测试仅因AgentSessionEvent无Deserialize编译失败，已改正确构造方式，行为红灯正在验证（日志modes-order-contract-r7-red-r2.log；session3746）；生产修复尚未开始。下一步先接收红灯再修投影/JS数字键排序，重新门禁与封存。print/RPC/server及全量迁移尚未完成；详见WORK_LOG最新段。下方为历史记录。

---

## 2026-09-27 W3.13 r6/r6b：本轮四门禁通过，准备封存

- fmt / offline clippy all-targets -D warnings：exit0。串行all-targets：3746通过（3710 lib + 27 generator + 9 pirs）、0失败、2历史ignored；doc：5通过、0失败、1历史ignored。收据：validation/modes-order-contract-r6-acceptance-r2.json，574项源码/构建hash前后不变。
- r6：48处JSON Map删除保序、12条红→绿字节回归、10个actual-source hashes；r5b compaction定向通过。r6b修复有序JSON扩大内部类型触发的Clippy告警，仅Box内部终态/错误记录及消除借用，不改wire。
- 封存目标：workspace .migration-handoff/checkpoint-0927-modes-order-r6b；只有manifest和独立收据modes-order-r6b-0927-verified.json实际成功才算封存。此前最后封存为checkpoint-0927-wave3。
- 下一步r7：JSON事件typed重建导致的字段顺序/未知字段问题，以及JS integer-index键递归排序；已准备actual-source脚本capture_event_projection_contracts.mjs，尚未运行或注册新fixture。W3.13、print/RPC/server及全量M1–M6均未完成。本次Windows串行门禁不证明Unix或全上游行为全面兼容。

旧会话均终态（包括91385），不要重复等待。详见WORK_LOG最新段；下方为历史记录。

---

## 2026-09-27 W3.13 r6 定向验证通过，开始当前树完整门禁

r5b compaction oracle定向1通过。r6逐处修正48个已确认JSON Map删除点，17个生产文件及4个测试文件；新增12条真实路径字节回归先全红、后12全绿，actual-source Node证据exit0（10个源hash）。格式风格已按Cargo edition2021纠正，fmt-r2 exit0。未改历史oracle或排序产品输出。

当前开始冻结源码跑fmt复核、offline clippy、串行all-targets及doc；结果未出前不称live全绿。最后正式绿色封存仍checkpoint-0927-wave3，不能代表本轮live。print/RPC/server未接入；W3.13仍待integer-index keys、typed重建/未知字段等JSON兼容性审计。完整日志与接续见WORK_LOG最新段、validation/modes-order-contract-r6-*；旧会话均已结束，不重复等待。下方为历史记录。

---

## 2026-09-27 W3.13 当前接续：r5已终态，r5b/r6审计进行中

r4 chord 20通过；r5 actual-source Node契约证据exit0。全量lib已结束：3697通过、1失败、2忽略（不是all-targets）。唯一失败为compaction测试的两处动态run(name)期望漏用oracle约定的显式canon，已补齐，待定向验证；原oracle与产品wire不变。下一步逐处修复JSON Map删除/缓存顺序，再跑完整门禁。不得重复等待21745或以旧wave3绿色代表live；尚无新绿色封存，print/RPC/server未接入。详见WORK_LOG最新段和validation/modes-order-contract-r5-full-lib.log、modes-order-contract-r5-node.json；备份workspace modes-order-contract-r5b-0927。下方为历史记录。

---

## 2026-09-27 W3.13 键序审计r3：session-manager定向通过

仅测试canon恢复与Node oracle相同的显式递归排序，新增canon不影响wire顺序回归。session_manager整个测试模块59通过、0失败（含持久化JSONL测试）；日志modes-order-contract-r3-session.log。原oracle与产品实现未改，备份见workspace modes-order-contract-r3-0927。全量未重跑、未封存。下一步核对chord services/delta的canonical辅助函数，并继续产品JSON Map删除语义审计。下方r2/r1及wave3为历史记录。

---

## 2026-09-27 W3.13 键序审计r2进展

已按上游修正transcript/protocol旧排序偏差测试；deferred错误输出已加强为完整原始oracle字节相等；validation可选null删除改shift_remove，新增嵌套剩余字段顺序回归。这四项定向测试均通过。日志modes-order-contract-r1-*和r2-*，原文件备份在workspace对应目录。尚未重跑全量，不能推算剩余失败数或称验收完成。下一步修复session_manager测试canon的显式排序（Node oracle原本就排序），继续审计JSON删除及其他失败；不可排序产品wire或改oracle迎合实现。

---

## 2026-09-27 W3.13 最新终态（优先于下方历史记录）

全量键序审计已结束，exit101：3660 passed / 33 failed / 2 ignored；modes JSON 8个测试均通过。session 44074不是运行中任务，不应继续等待或据旧记录重复启动。全量日志 modes-json-0927-full-order-audit.log 已保留。当前树未验收；最后有效绿色封存仍为 checkpoint-0927-wave3，不能代表live。正在依据上游逐项审计33个失败与JSON Map删除语义；print/RPC/server未接入本切片。

---

## 2026-09-27 W3.13 当前：JSON全仓影响审计中

已扩scope开启serde_json preserve_order；备份见workspace modes-json-order-scope-0927。r5 7过1失败，剩余error字段顺序已调整。全量审计session 44074，日志modes-json-0927-full-order-audit.log，尚未验收；不能以历史wave3绿色描述当前树。需核对全仓键序/Map.remove语义变化，未接入print/RPC。详情WORK_LOG最新段。

---

## 2026-09-27 wave3 双跑门禁结果（当前有效）

- fmt check / offline clippy all-targets -D warnings 均通过；串行 all-targets 两轮各3721通过、0失败、2历史ignored；doc 5通过、0失败、1历史ignored。第二轮session 21875已正常退出0。
- 532项源码/构建hash双跑后不变；WORK_LOG历史前缀及TUI utils字节核验通过。证据：docs/migration/validation/resume-20260927-wave3-acceptance.json。
- 封存目标 workspace .migration-handoff/checkpoint-0927-wave3；只有实际manifest和独立收据 wave3-0927-verified.json成功才算封存完成。历史wave2归档7353文件独立核验通过。
- 本次封存为继承工作树备份+当前Windows门禁验证，不代表全部继承行为已重新与上游逐项核验，也不证明Unix端、完整M1-M6验收。全量目标仍active。
- 下一步串行续作隔离的W3.13 modes；已读预查发现json_event的start/partial映射有披露差异，须先按上游真实协议修正，不能照搬半成品并称兼容。之后再接M6 server，不同时散开。

---

## 2026-09-27 Codex 接续状态（优先于下方历史快照）

更新时间：2026-09-27T13:24:54.106325+09:00。全量迁移仍未完成；本会话串行，禁止子智能体。

- 当前实际入口为 docs/migration/NEXT_SLICE_PLAN.md 的 wave3 收尾，不是历史 Anthropic/Responses 队列。其他应用新增代码全部保留。
- 本会话修复 client/transport.rs 的 Clone 派生位置及 Codex Responses callback test lint；fmt check 与 offline all-targets Clippy -D warnings 均 exit0。
- 本次全量串行第一轮：3685 lib + 27 generate-models + 9 pirs = 3721通过，0失败，2历史ignored；doc 5通过、0失败、1历史ignored。日志 docs/migration/validation/resume-20260927-tests-r1.log、resume-20260927-doc.log。
- 第二轮全量串行测试已启动，尚未确认结果（session 21875）；日志 resume-20260927-tests-r2.log。不得重复启动，先核实进程/日志。
- 532项源码/构建hash在首轮及doc后不变；证据 workspace .migration-handoff/resume-20260927-wave3-test-source.json。wave2后10项继承源码差异清单 resume-20260927-wave3-inherited-delta.json，仅为观测，不冒充行为审计。
- wave3尚未封存。下一步确认第二轮结果，审计继承变更/新文件、更新交接并封存独立核验，再继续隔离 modes/server。完整里程碑结论需对照 ROADMAP 逐项验证，不能只由测试数推断完成。

---

# 迁移状态（当前快照）

更新时间：2026-09-25T12:51:46+09:00。用户已恢复，goal active；全量未完成。

## 阶段定位
| 阶段 | 用途 | 当前边界 |
|---|---|---|
| M1 | 最小 AI→agent→CLI 骨架 | 有基础命令/测试，不等同完整pi CLI |
| M2 | AI/provider 层 | 主体已移植，本轮回填Anthropic请求hooks；仍有其他adapter/SDK差异 |
| M3 / M3b | Agent核心 / 独立AgentHarness runtime | 当前主线；generation接线已封存，正在补provider前置依赖，tools/structural/deferred/dispatcher仍待做 |
| M4 | TUI渲染/组件/交互host | 原组件/search保留；完整host等未完成；本轮未改TUI |
| M5 | 完整coding-agent产品/CLI/TS扩展 | 未全量移植 |
| M6 | protocol/client/server/telemetry/backends/chord/evals | 未全量移植 |

按docs/ROADMAP.md的协议/行为合同验收，不按文件数量算百分比。

## 并行波次快照（2026-09-25 17:10+09:00，进行中）

用户已解除子智能体禁令并确认 codex 停止；本会话以 2 并发槽轮转推进，行为等价标准不变（byte oracle 覆盖确定性序列化接缝）。已完成并定向验证（全量门禁待波次收口统一执行）：
1. openai-responses-callbacks：8 测试 + 42 oracle（21 场景×normal/simple）字节一致；scope src/ai/api/openai_responses/**。
2. drive/tools（上游 692 行）：10 测试 + 8 组 oracle 字节一致；新 drive/tools.rs 1584 行 + tests 2068 行。
3. telemetry（packages/telemetry 596 行 + harness/telemetry.ts 636 行 + context.ts 遥测切片）：7 测试 + 2 oracle 字节一致（schema 12241 字节、memory 后端行为）；新 agent_core/telemetry/** 与 harness/telemetry.rs。
4. drive/structural 剩余（上游 1222 行核心链）：34 测试 + 17 oracle 对比通过；修复 DurableCompactionPreparation rename 缺失与 guard 顺序两个 wire bug。
5. drive/reconcile tools 分支 + deferred 全链 + Faux deferred 桥接：16 新测试 + oracle 3 项字节一致（configurationError.details 键序为披露的既定规范形分歧）；修复 recovery.rs/publish.rs 两处 settle_operation 误用 continue_operation；faux deferred 真值性修复。
6. M3b task11：上游 memory-session-repo/memory-conformance 58 场景全量字节重放，实现零缺陷（memory.rs 未改），84 测试。
进行中：agent_harness/dispatcher（622 行，M3b 收尾大件）、M5 W3.1 utils 叶子包（816 行，coding_agent 模块树首个切片）。
队列：AgentHarness 后接 M5 W3.2-W3.17（docs/migration/M5_SLICE_PLAN.md，17 片）；M4 host 剩余与 M6 未动。
M5 估算已交付用户：净新增约 65000 行，M5 本体约 4-8 个并行工作日（24/7 约 3 天），全量约 7-10 晚。

## 本轮实际落地
1. Anthropic 普通流/simple/OAuth/header-owned/Copilot 路由接通真实进程内 `onPayload` / `onResponse`，现在实际支持 callbacks；不再只是字段透传。
2. payload 在 HTTP/retry 前 await；None 保留 params，replacement 按 JSON 可表示的 JS spread 并强制 stream:true。成功 response metadata 在 Start/SSE 消费前 await；hook 失败不 HTTP retry，hook 等待不与取消强行 race。
3. 依据 lockfile 的 SDK 0.124.0 实际源码，callback 后分离 betas/user_profile_id/workspace_id 到 headers；支持空 beta/恢复 client default、output_format 转换/冲突。实际 wire 不再泄漏 betas，并补 `/v1/messages?beta=true`。原纯 build_request 合同保留。
4. 新增14个 Rust 测试函数（Anthropic11 + Models/generation3），含真实 Models→Lane→generation→HTTP→durable publish、401 settlement、异步 hooks/cancel/retry。27 个 actual-source 生命周期场景由普通/simple 两路重放，共54次 loopback 场景。
5. 延续已封存 generation 能力：真实 stream_harness_assistant、gate/hooks/progress drain、scope/UUIDv7/retry、runId/recovery、orphan-prefix replay。此轮没有改这些实现或 TUI 源码。

## 验证证据
- 四门禁全部 exit0：`cargo fmt --all -- --check`；`cargo clippy --offline --all-targets -- -D warnings`；`cargo test --offline --all-targets`；`cargo test --offline --doc`。
- **2605 项项目测试通过 = 2569 lib + 27 generate-models + 9 pirs，0 失败，2 历史 CJK ignored；doc 5 passed / 0 failed / 1 历史 ignored。** 门禁日志 `anthropic-callbacks-gates-20260925-124558-802409.log`（12:45:58–12:47:44 +09:00）。源码 witness `anthropic-callbacks-gates-source-20260925-124558-802409.json`。
- 定向 `anthropic-callbacks-targeted-20260925-124448-788973.log`：anthropic:: 100、generation::tests::anthropic_callbacks 3、request_callbacks 7，全部真实匹配并通过。零匹配视为失败。
- oracle `anthropic-callbacks-repro-20260925-124744-385494.log`：27 场景，完整 fixture byte-identical。执行 pinned upstream stream/retry + SDK Messages.create/transformOutputFormat/buildHeaders；依赖 mock seams 及未覆盖内容见 `docs/migration/reference/anthropic-callbacks/README.md`。不是完整 SDK/整包差分验收。
- 全部证据入口 `docs/migration/validation/anthropic-callbacks-acceptance.json`。仅子进程 NO_PROXY=localhost,127.0.0.1,::1；无 test-thread/skip/旧断言降级，无真实 key 或模型请求。
- 开发失败全部保留：零匹配、错误 import、wiremock MIME（调整 header 顺序仍失败，最终用 set_body_raw 正确指定 MIME）、generation fixture 在 checkpoint 后才改 RuntimeConfig 导致缺认证（改为配置已捕获的 durable generation options）。没有为迁就测试改业务语义或 oracle 输出。

## 尚未完成
- callbacks 现支持 **Anthropic + OpenAI Completions + Faux 正常流**。其他 adapter 对 callback-bearing 请求仍明确 setup error；Faux separate deferred handle 未桥接。完整多 provider Harness 尚未完成。
- owned JSON callback bridge 不代表任意 JS 对象/custom toString/原地修改后返回 undefined 完全兼容。顶层非 BMP 字符串 spread 会产生孤立 UTF-16 surrogate，当前明确 pre-send error；普通对象中的 emoji 可用。TS 扩展仍属 M5。
- SDK client/fetch override、完整 transport/helper headers、精确 APIError 文案与继承 SSE parser 差异不在本切片。仅 HTTP error seam 受控，不能把 canned error 当作真实 SDK formatting 验收。
- callable systemPrompt/toolContext、telemetryContext 尚缺；drive tools 执行器、structural 剩余生成/attempt/publish、deferred 全执行链、reconcile tools、dispatcher/公开 AgentHarness 仍缺。
- M3b task11 kinds/child-conversation oracle、storage failure 注入、memory-session-repo/conformance 完整重放待做。
- M4 既有 Markdown/路由/overlay/focus/selection/paint/clipboard/search 成果保留；完整 host/eventloop/Intl/native clipboard/Kitty/latex/marked 新版本仍缺。本轮未重跑完整 native TUI 历史 oracle。
- M4 native clipboard 依赖评估（2026-09-28，只读，未实现）：上游机制为三层——(1) native N-API 预编译模块为主（`pi/packages/tui/src/native-platform.ts` 26-63 行按平台加载 `win32-platform.node`/`darwin-platform.node`/`linux-platform-x11.node`；linux 的 `setText` 缺省，见 14 行注释）；(2) 子进程系统命令 fallback（`coding-agent/src/utils/clipboard.ts`：读 22-33 行 termux-clipboard-get/wl-paste/xclip/xsel，写 57-74 行 pbcopy/clip/wl-copy/xclip/xsel，`clipboard-command.ts` 提供 3s 默认超时+50MiB 上限）；(3) 远程会话 OSC 52 兜底（7-18、75 行，100k base64 上限）。**结论：可无依赖移植（子进程路线）**——上游 Linux 主路径与全平台 fallback 均为系统命令，`std::process::Command` 即可等价（macOS 补 `pbpaste` 读、Windows 写用 `clip`）；平台受限点：Windows 文本读与 win/mac 图像读上游走 native OS API 模块，无 CLI 等价物（无依赖路线此两面缺失，PowerShell 变通慢且非上游语义）；仅当要求完全 OS-API 对齐才需新依赖（arboard/copypasta 类；Cargo.lock 现无，`clipboard-win` 5.4.1 仅为 rustyline 传递依赖，不可直接使用）。
- M5/M6 未全量迁移。测试数、文件数不是完成百分比；本切片通过不等于 M2/M3b 或整个迁移完成。

## 入口历史摘要纠偏
- 旧14/16文件统计不等于drive完成；TS实际12个.ts且Rust拆分不同。旧2556测试、旧generation stub和旧Anthropic字段透传均是已被后续工作推进的历史，不是当前验收。

## 快照与审计
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
