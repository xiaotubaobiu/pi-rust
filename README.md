# pi-rust

Pi Agent Harness 的 Rust 重写。derived from [earendil-works/pi](https://github.com/earendil-works/pi)(MIT)。

**目标**:行为级完全兼容(drop-in compatible)的全量重写——session 文件、`auth.json`、keybindings/themes/skills、JSON 输出、RPC 协议、扩展 API 与上游一致,可互相操作。不是源码逐行翻译(跨语言不存在),而是同架构哲学、同外部行为的全新实现。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 行走骨架:三层打通的最小 agent CLI | 已实现 |
| M2 | `pi-ai` 完整移植(10 种 API、全部供应商、catalog、OAuth、faux、图像) | 已完成:M2a–M2f 全部落地;packages/ai 移植完成,余项均为具名后续 |
| M3 | `pi-agent-core` 完整移植(steering、hooks、并行工具、compaction) | 进行中:M3a 核心(types/loop/steering/Agent 类)已落地,harness 子树(~3.1 万行)为 M3b |
| M4 | `pi-tui` 完整移植(自研差分渲染器、编辑器、补全) | 未开始 |
| M5 | `coding-agent` 完整移植(sessions、settings、skills、扩展系统、RPC) | 未开始 |
| M6 | 支撑件(protocol、client、server、telemetry、session-backends、chord、evals) | 未开始 |

详见 [docs/ROADMAP.md](docs/ROADMAP.md) 与 [M1 设计规格](docs/superpowers/specs/2026-09-19-m1-walking-skeleton-design.md)。

## 状态

- M1 已实现:最小 agent CLI(pirs)。用法:

    cargo run -- --provider openai-compat --base-url <url> --model <id>
    # 需要 GLM_API_KEY / OPENAI_API_KEY 或 ANTHROPIC_API_KEY

- M2a 已实现:packages/ai 类型系统完整移植(types.ts + transcript.ts + validation + 事件协议),serde wire 格式与上游一致。
- M2b 已实现:openai-completions / anthropic-messages / openai-responses 三大 API 完整移植(请求组装、SSE 流式、thinkingFormat/compat、重试、cost 计算),已通过真机验收。
- M2c 已实现:pi-messages / azure / codex(含 websocket 传输)/ google×2 / vertex / mistral / bedrock(SigV4 + AWS 事件流)七个 API 完整移植。全部 10 种上游 API 现已可用:`--provider` 支持 anthropic、openai-compat、openai-responses、azure-openai-responses、openai-codex、google、google-vertex、mistral、amazon-bedrock、pi-messages。
- M2d 已实现:认证体系——auth.json 凭据存储(与上游格式互通)、9 个 OAuth 登录流程(anthropic / codex / copilot / openrouter / xai / kimi / radius 等)、凭据解析优先级(显式 → auth.json → 环境变量)、`pirs login/logout` 子命令、bedrock/vertex 环境凭据链。
- M2e 已实现:模型目录(38 个生成 shard、1407 个模型,嵌入二进制)、`Models` 集合(getAuth/stream 路由、refresh/store、动态 provider)、40 个内置 provider 工厂注册表、faux provider、图像 API。config.toml 新增可选 `cost` 定价表(上游 `ModelCost` 形状:camelCase `cacheRead`/`cacheWrite` + 可选 `tiers`)。packages/ai 移植完成;显式余项:`Models.checkAuth/login/logout` 薄包装与 CLI 默认路径接入随 M3 落地(能力已在 auth 层),当前 CLI 保持直连 provider 流程。
- M2f 已实现:加固清单全部落地,packages/ai 移植完成,余项均为具名后续(abort 已补、RS256 已补、Rust 生成器已补)。abort 信号面(`CancellationToken`)贯通 10 种 API 与 Models 路由,流中中断落 stopReason `aborted`;Vertex ADC 服务账号签名落地(RS256 JWT 断言 → token 兑换,进程级缓存);Rust 模型目录生成器落地(输出与内嵌 catalog 的 manifest 校验字节兼容);错误字符串一致性与一批加固修复(索引、header 合并、Retry-After 解析等)各带回归测试。显式余项:Vertex ADC 的 gcloud CLI 变体保持具名错误(移植不含 gcloud CLI 调用面,既定裁决),外加 M2f ledger 记录的具名 minor 尾项(生成器数值格式角落、ADC 缓存粒度等),均不影响正常路径的上游可观察行为。
- M3a 已实现:agent 核心完整移植——`AgentMessage`(应用消息与 LLM 消息分离,自定义消息为闭合枚举变体)、全部 10 种 `AgentEvent`、turn 循环(并行/顺序工具执行、before/after 钩子、terminate 规则)、steering 与 follow-up 队列(单条/全部模式)、abort、`Agent` 类(订阅按注册顺序等待、message_end 工具预检屏障、wait_for_idle)、5 个内置工具与 JSONL session 已迁移到完整核心。显式余项:harness 子树(~3.1 万行)为 M3b;session JSONL 当前为扁平 AgentMessage 格式,上游 SessionManager 的信封格式随 M3b 落地;`Models` 接入 CLI 默认路径随 M3b/M5 落地。

## License

MIT
