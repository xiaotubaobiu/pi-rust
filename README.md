# pi-rust

Pi Agent Harness 的 Rust 重写。derived from [earendil-works/pi](https://github.com/earendil-works/pi)(MIT)。

**目标**:行为级完全兼容(drop-in compatible)的全量重写——session 文件、`auth.json`、keybindings/themes/skills、JSON 输出、RPC 协议、扩展 API 与上游一致,可互相操作。不是源码逐行翻译(跨语言不存在),而是同架构哲学、同外部行为的全新实现。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 行走骨架:三层打通的最小 agent CLI | 已实现 |
| M2 | `pi-ai` 完整移植(10 种 API、全部供应商、catalog、OAuth、faux、图像) | 已完成:M2a–M2e 全部落地;遗留 M2f 加固清单 |
| M3 | `pi-agent-core` 完整移植(steering、hooks、并行工具、compaction) | 未开始 |
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
- M2e 已实现:模型目录(38 个生成 shard、1407 个模型,嵌入二进制)、`Models` 集合(getAuth/stream 路由、refresh/store、动态 provider)、40 个内置 provider 工厂注册表、faux provider、图像 API。config.toml 新增可选 `cost` 定价表(上游 `ModelCost` 形状:camelCase `cacheRead`/`cacheWrite` + 可选 `tiers`)。packages/ai 移植完成;显式余项:`Models.checkAuth/login/logout` 薄包装随 M3 落地(能力已在 auth 层),M2f 承担加固清单(abort 信号面、RS256 服务账号签名、字符串一致性等);Models 接入 CLI 默认路径随 M3 落地,当前 CLI 保持直连 provider 流程。

## License

MIT
