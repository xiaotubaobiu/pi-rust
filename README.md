# pi-rust

Pi Agent Harness 的 Rust 重写。derived from [earendil-works/pi](https://github.com/earendil-works/pi)(MIT)。

**目标**:行为级完全兼容(drop-in compatible)的全量重写——session 文件、`auth.json`、keybindings/themes/skills、JSON 输出、RPC 协议、扩展 API 与上游一致,可互相操作。不是源码逐行翻译(跨语言不存在),而是同架构哲学、同外部行为的全新实现。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 行走骨架:三层打通的最小 agent CLI | 已实现 |
| M2 | `pi-ai` 完整移植(9 种 API、全部供应商、catalog、OAuth、faux、图像) | 进行中:M2a(类型系统)+ M2b(三大 API 完整移植)已完成,M2c-f 待做 |
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
- M2b 已实现:openai-completions / anthropic-messages / openai-responses 三大 API 完整移植(请求组装、SSE 流式、thinkingFormat/compat、重试、cost 计算),471 个测试,已通过真机验收。M2c(派生 API)进行中。

## License

MIT
