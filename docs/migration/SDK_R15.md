# W3.15 r15 — 真正 SDK session 工厂与 provider attribution

日期：2026-09-27。阶段：**M5 coding-agent**；不是 M4，也不是全量迁移或完整 CLI 已完成。
前一正式点：`checkpoint-0927-stream-adapter-r14`。

## 验收状态

最终源码的完整门禁已真实通过（`sdk-r15-acceptance-b.json`）：

| 门禁 | 结果 |
|---|---|
| `cargo fmt --all -- --check` | exit 0 |
| `cargo clippy --offline --all-targets -- -D warnings` | exit 0 |
| `cargo test --offline --all-targets -- --test-threads=1` | **3879 通过 = 3843 lib + 27 generator + 9 pirs，0 失败，2 历史 ignored** |
| `cargo test --offline --doc -- --test-threads=1` | **5 通过，0 失败，1 历史 ignored** |

- 609 项 source/build 在最终定向测试、回归及完整门禁前后冻结一致；相对 r14 净增 15 项 lib tests。
- 最终 `targeted-d`：15/15；`regression-b`：Agent/loop 90、AgentSession 86、AgentSessionRuntime 13、ModelRuntime 10 分别通过。回归集合有重叠，不相加充当全库总数。
- 本片原生集成覆盖真 SDK → Agent → ModelRuntime → OpenAI-compatible HTTP provider → loopback wiremock，验证 awaited payload、headers/response、消息持久化；不连接真实服务、不使用真实凭据。
- Oracle b/c 的 102 场景输出与 fixture 逐字节相同，并核验 14 份上游源码 hash；Oracle 与原生端到端测试边界见下文。
- 旧 `acceptance`（3878 通过）对应修复前的源码，已保存 `superseded-acceptance-source`，**不是当前最终验收**。空字符串 agentDir 回归后已重新运行全部门禁。
- 独立收尾脚本必须生成 `sdk-r15-closeout.json`，校验日志/退出码、失败快照、冻结源码、继承文件、HEAD/index、WORK_LOG 原前缀和 utils CRLF/hash；不以这段文字代替收据。
- 封存链：previous=r14 → `checkpoint-0927-sdk-r15`；只有下述外层 live receipt 为 true 且 manifest hash 一致才正式提升为 r15。封存后不再改 repo/root 入口。
正式点仍以 workspace `.migration-handoff/sdk-r15-0927-verified.json` 的 live 核验结果为准；缺失或失败时仍是 r14。

## 本片范围

既有源码只修改 `src/coding_agent/core.rs` 的模块注册。新增：

- `core/provider_attribution.rs`：纯 header/telemetry policy，不发送遥测。
- `core/sdk.rs`：公开 `create_agent_session`、输入/输出类型与 `NoTools`；返回真实 `Arc<AgentSession>`。
- `core/sdk_tests.rs`、`core/sdk_oracle.json`：差分与原生集成验证。
- `docs/migration/oracles/capture_sdk.mjs`：只读执行完整上游源码的 VM harness。

无 Cargo 依赖变化；未改 Agent/AgentSession/ModelRuntime/services 的继承实现。

### 工厂与状态

1. cwd：显式值 → supplied SessionManager 的 cwd → process cwd，再 resolve。agentDir 非空显式值才 resolve；空字符串与缺省一样走默认目录，不强制传 auth/models paths。
2. 构造或复用 ModelRuntime / SettingsManager / SessionManager。默认 loader 真正 reload；提供的 loader 不重复 reload。共享 SettingsManager clone 保留原生内部 identity。
3. 以 **已有 messages 非空** 判断恢复，不以 entries 非空判断。恢复模型必须存在且有 configured auth；否则按上游生成 fallback 文案并调用既有 initial-model resolver。SDK 传空 scopedModels 给 resolver，scopedModels 仍交给 Session。
4. thinking 优先级：显式 → 现有会话记录（旧会话没 thinking entry 则 global/default）→ per-model → global/default，再按能力 clamp。无模型为 off。
5. `tools`、`noTools=all/builtin`、defaultTools、excludeTools 按上游优先级。custom/extension tools 交给真实 AgentSession 注册；builtin-only 与 all 禁用策略不同。
6. 恢复消息；仅缺失 thinking entry 时补记。新会话写 initial model/thinking entries。
7. `convert_to_llm` 后按 **live blockImages** 替换 user/toolResult images，并按上游规则合并相邻 disabled-image 占位；纯文本消息不额外去重。

### 真正请求接线与 reload 时机

真实路径：`SDK → Agent → ModelRuntime → provider`，而非测试 façade / mock factory。

- 每次 stream factory 读取 live retry/httpIdle/ws timeout。显式请求值优先；httpIdle=0 映射到 2147483647。即使显式 timeout 已给，httpIdle getter 仍执行，对齐上游校验时机。
- 每次 stream factory 捕获一次 **headerRunner**。该请求后续 auth/headers 异步等待期间发生 reload，headers 仍用该请求捕获的 runner；下一次 factory 才取新的。
- payload/response/context 在各自调用时取 **当前 runner**，并真正 await 原生异步 handler。
- `Arc<Mutex<Weak<AgentSession>>>` 替代上游 runner-ref，不强持有 session，无强引用环；不新增导航 block_on 或 detached reload 线程。
- 原生 typed context/header JSON 无法解析时发 `<native-sdk-boundary>` diagnostic，保留整份输入，不悄悄 filter_map 丢消息/headers。
- `SettingsValue` 数字是 JS f64。thinking budgets 用精确整数/范围检查转成既有 u32 类型，支持 99.0 这样的合法 JS integer，不截断分数或饱和非法值。

### Attribution 的兼容性细节

- `PI_TELEMETRY` 存在时优先；仅 `1` 或不分大小写的 true/yes 开启，不 trim。测试不修改进程环境，不用 unsafe。
- OpenRouter 保留 legacy **case-sensitive substring** 判定（包含 invalid URL、path、suffix）；不能擅自改为更“安全”的 exact-host 规则。
- NVIDIA / Cloudflare / OpenCode 使用 URL exact-host 与各自 provider 名判定。
- attribution 顺序 OpenRouter → NVIDIA → Cloudflare，受 telemetry gating。
- 非空 sessionId 的 OpenCode session/client headers **不受 telemetry gating**。
- source 按顺序覆盖 defaults，保留 null deletion marker 与原始大小写；空集合返回 None。

## 差分证据边界

VM 执行完整、未改写的 upstream sdk/provider-attribution/telemetry、Agent/loop/default-stream、ai thinking helpers、transcript/events/text、messages、model-resolver、auth-guidance/defaults。

102 场景：22 factory、7 stream/options、47 attribution、22 telemetry、4 images。Rust 消费 fixture，不把手写期望伪称 upstream 输出。

**受控 collaborator 边界必须保留：**

- Oracle 的 filesystem/session/settings/resource/model-runtime 使用内存 collaborator；AgentSession 只记录 config，设置 runner-ref。
- ai models 只调用 thinking helpers；auth/storage/network 依赖、resolver minimatch/CLI 路径为 fail-on-use stubs。
- 因而 oracle 不是 CLI/SDK 全链路。原生测试另外使用真实 SessionManager、ResourceLoader、AgentSession、ModelRuntime，HTTP 集成只连 loopback wiremock。
- no-model 文案只规范成 `NO_MODELS`（host docs 路径不同）。model 比较读取两边 **Agent.state.model** 的 unknown sentinel；原生 AgentSession getter 把 sentinel 映射成 None，是继承 seam，未在本片改动。
- stream/options 比较排除真实 ModelRuntime 补的 fake apiKey、空 headers 的 optional 表示差异；headers 本身另行比较。
- custom/extension tool 组合是上游 SDK/AgentSession 源码导出的字面断言，不冒称执行了完整上游 AgentSession。

## 失败、修复及留痕

所有原日志与失败源码保留在 `docs/migration/validation/sdk-r15-*` 及 workspace `.migration-handoff/sdk-r15-0927/`，不覆盖失败 receipt。

- `check-a`：3 个初次接口编译错误（LoadExtensionsResult 导入、Context struct、TextContent 字段）。
- `oracle-a`：调用不存在的 Agent getSteeringMode/getFollowUpMode；改用真实 getters。该次 stdout 为空，Node exit1，不当作有效 fixture。
- `targeted-a`：ProviderConfig private import、allow_network bool/Option 接口错误，未执行测试。
- `targeted-b`：9 过 / 1 失败。no-model 比较错误地跨越 Session getter / Agent.state 层，按 oracle 实际读取层修测试，未改 fixture 或生产语义迎合。refresh Result warning 也修为明确 unwrap。
- 源码复核发现 SettingsValue f64→serde u32 会拒绝合法 integer，新增精确 budget 转换与非法范围测试；不是声称一个未运行的失败门禁。

- 第一次全门禁 `acceptance` 虽绿，但最终逐行复核发现空字符串 agentDir 的 JS truthy/Option-Some 差异。保留该绿版本 `superseded-acceptance-source`，修生产路径选择并加第15项精确回归；最终以新 source 的 targeted-d/regression-b/acceptance-b 为准，旧绿门禁不挪用。

- 独立closeout首轮校验脚本误把故意为空的 oracle-a 原始 stdout 当成JSON receipt解析而失败（非生产门禁失败）；已保存脚本和错误日志，改为只对receipt解析JSON，三份raw stdout仍逐字节/hash独立核验，不跳过原始失败证据。

## 尚未完成 / 原生边界

- **Services 工厂、pending provider/native 注册、flags、create-from-services 仍未落地**。`agent_session_services.rs` 当前仍只是 r13 的数据契约。
- SDK 未设置 JS 进程全局 defaultStreamFn；所有 SDK Session 走 per-instance adapter，继承的 Agent Models fallback 保留。
- Future 为 poll-driven，不等于 JS eager Promise；mpsc 不等于 JS 独立 result promise。资源 reload/settings 文件操作沿用原生同步语义。
- TS 扩展仍需注入已有 loader/host；不是未修改上游 TS 扩展可直接运行的完整 embedded JS host。
- callback JSON 不是任意 JS object identity/undefined/prototype/throw/stack。headers BTreeMap 次序不等于 JS insertion order。
- request 整数字段受现有 unsigned native 类型约束；非法负数、越界 budgets 等报错，不宣称原生非法输入与 JS unvalidated passthrough 等价。SettingsManager 既有分数截断/null seam 未扩展。
- 默认 ModelRuntime 创建路径保留生产行为；验证注入 in-memory runtime，不读取真实凭据、不请求真实/付费 provider、不使用 OS clipboard。
- Print 最终接线、RPC、M6 与完整 M1–M6 验收尚未完成。用户本轮要求汇报并交接后结束；完成封存后暂停，不启动 services 新切片。

## 下一片执行顺序

详见 workspace `.migration-handoff/sdk-r15-0927/next-slice-audit.md`。先独立核验正式 r15，再做 services：共享 settings/loader → reload → 有序普通/native provider 注册与诊断/清队列 → offline refresh → flags → 调用本片真正 SDK。pending native provider 的 Value seam 必须 typed 化，不能用 JSON 冒充承载函数/实例的 native provider。

生命周期沿用 r13：replacement abort → 最终持久化 → shutdown → 同步 beforeInvalidate/dispose → create/apply → setup/transcript → rebind/withSession。每次 await 后读 live session slot；不回滚已 apply/dispose 状态；Runtime.dispose 非幂等，print 外层 guard；print 最终 remove signals → guarded dispose → flush，dispose 失败不 flush。
