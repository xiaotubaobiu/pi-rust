# pi → pi-rust 进度与停止交接（2026-09-27）

更新时间：2026-09-27T22:18:27+09:00（Asia/Seoul，UTC+09:00）。

## 1. 当前结论与停止指令

- 用户最新要求：**“汇报任务完成进度然后写交接文档可以结束了”**。本轮仅核验与文档收尾，不实施新模块；交接封存完成后将 goal 设为 **paused**，等待用户明确恢复，不后台续做。全量迁移未完成，不得标记 complete。
- **最后已验收源码版本：M5 / r15 SDK session 工厂；r16 services 尚未实施。**
- r15 于2026-09-27 21:42正式封存。随后曾恢复active，于21:58:30留下r16入口核验；继续工作仅到源码审计/设计，没有services开工目录、start_slice、生产补丁或新增测试。此次进入收尾时工具仍为active，本次停止要求收束该状态，不沿用旧文档的继续授权。
- 本轮22:09:01再次独立核验r15：**8632现存归档文件 + 1历史删除**与当时live一致；**609项source/build**全部等于最终r15门禁指纹。此后只写文档，没有重新运行Cargo或增加测试数。
- 原r15 checkpoint、成功/失败收据保持不可变；新增 **docs-only 停止快照**，不是r16实现checkpoint。
- 串行无子智能体；pi只读；pisper不看不改；保留继承dirty，无stage/commit/reset/stash/clean/push。

## 2. 架构与阶段定位

阶段定义：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\ROADMAP.md`。不按文件数量伪造整体百分比。

| 阶段 | 职责 | 当前准确边界 |
|---|---|---|
| M1 | 最薄AI → Agent → CLI可运行骨架 | 已有基础CLI与测试，不等于完整pi CLI完成。 |
| M2 | pi-ai：模型、供应商、认证、流式响应、模型目录 | 已有主要实现及回归；services审计发现动态provider共享注册/同步路由仍需补齐，不能据此声称所有扩展行为等价。 |
| M3 / M3b | Agent核心、AgentHarness、runtime/drive、重试、工具、会话与持久化 | 前期runtime/drive主链已有实现/封存；保留各片边界，本次没有重做generation。 |
| M4 | TUI渲染、组件、Markdown、键鼠、焦点、搜索 | 既有TUI/Markdown/search成果保留；原生OS剪贴板交付等仍有披露边界，本轮未改TUI。 |
| **M5** | coding-agent产品层：Session、扩展、SDK、services、运行模式、CLI | **当前主线：r15 SDK工厂已验收；services未实施，print/RPC/interactive、完整CLI及内嵌TS host未全量完成。** |
| M6 | protocol/client/server/telemetry/backends/chord/evals等支撑件 | 已有部分protocol/client/telemetry等切片；server及其余支撑件/跨平台验收未全量完成。 |

之前的TUI/Markdown是 **M4**，runtime/drive是 **M3b**，当前SDK/services是 **M5**。跨层修正可能触及M2/M3，但不是又做M4。

## 3. 最近已落地成果（不是本次文档收尾新增）

按现有正式交接记录，最近完成链路为：

1. r9/r10：typed JSON入口、输出guard/背压，保留序列化与最终清理顺序。
2. r11/r12：异步command-context与扩展事件等待/错误传播。
3. r13：真实AgentSessionRuntime生命周期、replacement、live session slot。
4. r14：Agent typed stream/key/callback/transport接线。
5. **r15：真正 `create_agent_session` 返回 `Arc<AgentSession>`，SDK → Agent → ModelRuntime → provider连通**：
   - Runtime/Settings/SessionManager/ResourceLoader构造或复用；默认loader真reload，supplied loader不重复reload。
   - 恢复模型/auth/fallback、thinking/entries、tools/noTools/default/exclude/custom、live blockImages。
   - provider attribution、telemetry/OpenCode gating、OpenRouter规则、headers合并边界。
   - live retry/httpIdle/ws timeout、awaited payload/response/context hooks；Weak session slot避免强引用环。
   - 修复合法整数thinking budget的f64→u32转换和非法范围拒绝；空 `agentDir=""` 按JS falsy选默认路径。

r15只修改既有 `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core.rs` 的注册，并新增：

- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core\sdk.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core\provider_attribution.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core\sdk_tests.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core\sdk_oracle.json`

完整说明：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\SDK_R15.md`。

## 4. 验证结果与证据

**最终源码验收只认acceptance-b，不能把第一次3878全绿套到后来修正的源码。**

收据：`C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\validation\sdk-r15-acceptance-b.json`。
运行时段：2026-09-27 21:32:25–21:38:37 +09:00。

| 门禁 | 结果 |
|---|---|
| `cargo fmt --all -- --check` | exit 0 |
| `cargo clippy --offline --all-targets -- -D warnings` | exit 0 |
| `cargo test --offline --all-targets -- --test-threads=1` | **3879通过 = 3843 lib + 27 generator + 9 pirs；0失败；2历史ignored** |
| `cargo test --offline --doc -- --test-threads=1` | **5通过；0失败；1历史ignored** |

- targeted-d：15/15。Agent/loop 90、AgentSession 86、AgentSessionRuntime 13、ModelRuntime 10分别通过；集合重叠，不相加当总数。
- actual-source oracle：102场景（factory22/stream7/attribution47/telemetry22/images4），两次输出与fixture逐字节一致，14项上游source hash已核验。
- Oracle使用完整上游模块和明确的controlled collaborators；其中AgentSession只记录config，**不是完整CLI oracle**。真实SDK→原生Session/Runtime→loopback HTTP provider集成另测，不用真实key/付费provider。
- **本次只做指纹与归档核验，未重跑Cargo**；609项source/build未变，引用的是上述已验收结果，不冒称新门禁。
- r15编译/测试/oracle失败、第一次旧绿门禁、closeout-a脚本失败原件均保留，禁止重写。此次文档生成器首轮inline Python因嵌套三引号SyntaxError退出1，未执行仓库写入；故障说明保存在新证据目录，不是生产或Cargo失败。

### 4.1 最后正式源码封存点（不可变）

- checkpoint：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0927-sdk-r15`
- manifest SHA256：`56ba1c2c177e25fde159a2970f8eb642b39abeb4d7ffdb9b3bd64a076e83089e`
- 正式独立收据：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\sdk-r15-0927-verified.json`
- 21:58只读核验：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\services-r16-0927-entry-verified.json`
- 本轮改文档前的live复核：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0927-2205-entry-verified.json`
- Rust HEAD：`f8d69f7930e23a6b8f5fd3f794e81d51505ab24a`
- pi HEAD：`5901446094988aa5cd8e11efdaa131c3949106f1`

### 4.2 本次docs-only停止快照

- 目标：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0927-r15-handoff-stop`
- 独立收据：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0927-2205-verified.json`
- 备份、指纹、scope、执行日志：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\handoff-stop-0927-2205\`
- **只有独立收据存在、manifest hash匹配且 `live_files_status_diff_root_HEADs_and_indices_verified: true` 才是正式停止快照**；此处预告不是成功证明。
- previous=r15，允许修改既有源码列表为空。源码验收仍为r15；新增快照只补文档，不冒充r16交付。
- snapshot writer固有 `goal_status: active` 是封存时元数据，不授权续做。封存后按用户指令暂停，最终以goal工具返回和汇报为准。
- 文档更新后，旧r15的whole-live校验会因文档不同而失败，这是预期；核验当前整树用新停止快照，核验旧归档用 `--archive-only`，不要回滚新文档迎合旧校验。

## 5. r16 services：已审计，未实施

当前 `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core\agent_session_services.rs` 仍仅约36行r13数据契约，尚无services工厂。
上游：`C:\Users\13063\Desktop\code\agent work\pi\packages\coding-agent\src\core\agent-session-services.ts`（221行）。

恢复后按上游顺序实现：

1. resolve cwd/agentDir；默认ModelRuntime **总是**传agentDir下auth.json/models.json及signal。与r15 SDK“仅显式非空agentDir才强制路径”不同。
2. supplied/default SettingsManager保identity；loader options先spread，再强制cwd/agentDir/settings；真正reload(reloadOptions)。
3. pending普通provider按序逐项注册，失败变nonfatal `Extension "<path>" error: <message>`；整组完成才清普通队列，再处理native组并整组清除。需审计reentry/live-array行为，不能提前take丢掉注册。
4. 注册后、flags前 `refresh({allowNetwork:false})`；refresh错误传播，不当注册warning吞掉。
5. flags按扩展顺序合并，重名后者覆盖；输入Map保序。boolean flag任何输入都设true；string只接受string（包括空串），bool给string报 `Extension flag "--name" requires a value`；unknown最终按输入顺序合成单条，精确 `Unknown option: --x` / `Unknown options: --x, --y`。
6. create-from-services转发真r15 SDK的manager/model/thinking/scoped/tools/exclude/noTools/custom/start-event等字段，保留handles；supplied loader不二次reload。

### 5.1 必须先处理的真实风险

**A. native provider通道仍是JSON空壳。**
`C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\extensions\types.rs` 的RegisterNativeProviderHandler/PendingNativeProviderRegistration用Value，loader/runner/API host同样如此。`C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\agent_session.rs` 的native register忽略输入后Ok(())。必须typed化，保留真实ApiImpl/auth/refresh/filter callbacks及identity，不能解析JSON得到无回调provider就声称完成。普通provider函数型config也有JSON seam，不能假装完整TS host。

**B. 同步注册遇到持锁refresh的风险。**
`C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core\model_runtime.rs` 用Tokio Mutex包Models，并持guard跨 `models.refresh(...).await`。AgentSession普通register/unregister当前通过 `futures::executor::block_on` 桥接。不能机械给native再加block_on；需验证pending refresh期间replacement/unregister、用户callback reentry不死锁。**这是源码审计风险；本轮未写并发测试或运行死锁复现，也未修复。**

**C. Models Clone注释与实际结构不一致。**
`C:\Users\13063\Desktop\code\agent work\pi-rust\src\ai\models\mod.rs` 注释称shared-registration clone，实际providers是 `Vec<(String, Arc<dyn Provider>)>`；derive Clone复制Vec，后续注册不共享。建议审查共享registry，getter/refresh先clone handles、释放锁后回调/await；ModelRuntime不以整仓异步锁包刷新，新增真正同步注册facade并保留async API兼容。**只是待审查设计，没有代码落地，不能当作已证明正确的方案。**

### 5.2 建议scope与验收

先补读resource_loader的DefaultResourceLoaderOptions/ResourceLoaderReloadOptions/reload/override及Provider/ApiImpl签名，正式登记新scope并备份，再改代码。预计涉及：

- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\ai\models\mod.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core\model_runtime.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core\model_registry.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\core\agent_session_services.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\extensions\types.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\extensions\loader.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\extensions\runner.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\extensions\loader_tests.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\extensions\runner_tests.rs`
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\coding_agent\agent_session.rs`

如复用/迁移private provider_config_from_value，先审计provider_composer等scope；不偷偷越界。不直接重跑旧sdk-r15的start_slice.py；新片previous应使用本次正式docs-only快照，源码门禁基线仍为r15/609项。

建议验证：

- 完整未改写上游services文件VM oracle，明确collaborators，trace reload→普通/native注册→clear→offline refresh→flags；覆盖逐项失败继续、顺序、exact文案、paths、from-services全字段。
- 真typed native fake provider携带callbacks，经services→SDK→provider的loopback集成、handle identity；不读真实凭据。
- Models clone后更新可见性、pending refresh同步replacement/unregister、callback reentry、cancel/supersede；不持registry锁跨await/用户回调。
- 新源码定向+全门禁/doc，保存失败源码/原始日志/退出码，冻结指纹后独立封存，不沿用r15数量冒充新片验收。

旧审计仍供参考，但其中历史active段落不优于此次停止指令：`C:\Users\13063\Desktop\code\agent work\.migration-handoff\sdk-r15-0927\next-slice-audit.md`。

## 6. 必须保留的不变量与剩余主线

- r15：**headers runner每次stream factory捕获快照**；auth等待期间reload仍用该请求旧runner；payload/response/context在各自调用时取live runner。不能混成永久缓存或全部取最新。
- r13 replacement：abort→最终持久化→shutdown→**同步**beforeInvalidate/dispose→create/apply→setup/transcript→rebind/withSession。每次await后重读live slot，只有字面true取消，不回滚已apply/dispose状态。
- Runtime.dispose非幂等、不先await abort；print外层才guard。print finally：remove signals→guarded dispose→flush，dispose失败不flush。
- 保留r10输出背压/r9 JSON边界；禁止busy-loop、block_on导航、脱离线程reload、永久缓存旧session。
- services后才是真print orchestration→RPC，并继续interactive/CLI、内嵌TS host及M6剩余切片。隔离modes/server WIP不能直接恢复注册，旧忙等/假接线需重新审计。
- Native Future poll-driven≠JS eager Promise，mpsc≠独立result Promise；任意JS object/throw/stack、headers insertion order、继承SettingsManager非法输入等差异仍存在。未交付未修改上游TS扩展直接运行能力，不宣称全量等价。

## 7. 接手步骤与约束

1. 等用户明确恢复；先读本文件与四入口顶部，不按历史active或旧并行工作记录自动续做。
2. 用新停止快照执行独立verifier，receipt取新唯一文件；失败先审计，不能覆盖旧证据或reset继承dirty。
3. 核对source/build仍为r15 acceptance-b的609项，再新建services slice、scope/before hashes、WORK_LOG binary append开工记录。
4. 串行做前置→工厂→定向/全门禁→独立封存，不重跑旧start脚本或poll旧会话句柄。

独立核验示例（PowerShell）：

```powershell
$env:PYTHONIOENCODING = 'utf-8'
$env:GIT_OPTIONAL_LOCKS = '0'
$env:NO_PROXY = '127.0.0.1,localhost'
$receipt = 'C:\Users\13063\Desktop\code\agent work\.migration-handoff\resume-entry-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json'
& 'C:\Users\13063\anaconda3\python.exe' 'C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\tools\verify_handoff_checkpoint.py' 'C:\Users\13063\Desktop\code\agent work\.migration-handoff\checkpoint-0927-r15-handoff-stop' --receipt $receipt
```

- Python：`C:\Users\13063\anaconda3\python.exe`；Node：`C:\Users\13063\anaconda3\node.exe`。本次未重新查询Node版本。
- Cargo offline，测试 `--test-threads=1`。仅scope格式修正：`rustfmt --edition 2024 --config skip_children=true,style_edition=2021 <scope files>`，不要全仓无差别改行尾。
- `C:\Users\13063\Desktop\code\agent work\pi-rust\docs\migration\WORK_LOG.md` **只能binary UTF-8 append**，不可重写历史字节前缀。
- `C:\Users\13063\Desktop\code\agent work\pi-rust\src\tui\utils.rs` 原CRLF保持；SHA256 `a71ecc6754ebd6369feef50262413b30b0311ba9b74d0298ec264b48e186fac1`。
- 无真实凭据/真实或付费provider/OS clipboard/unsafe，无Git写操作，无委派。pi只读，pisper不看不改。
- 既有Cargo/验证进程均已终态；本次无在途Cargo。接手重新检查，不poll旧session ID。历史11:30截止已履行，不推定新工作时限。
