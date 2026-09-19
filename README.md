# pi-rust

Pi Agent Harness 的 Rust 重写。derived from [earendil-works/pi](https://github.com/earendil-works/pi)(MIT)。

**目标**:行为级完全兼容(drop-in compatible)的全量重写——session 文件、`auth.json`、keybindings/themes/skills、JSON 输出、RPC 协议、扩展 API 与上游一致,可互相操作。不是源码逐行翻译(跨语言不存在),而是同架构哲学、同外部行为的全新实现。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 行走骨架:三层打通的最小 agent CLI | 进行中 |
| M2 | `pi-ai` 完整移植(9 种 API、全部供应商、catalog、OAuth、faux、图像) | 未开始 |
| M3 | `pi-agent-core` 完整移植(steering、hooks、并行工具、compaction) | 未开始 |
| M4 | `pi-tui` 完整移植(自研差分渲染器、编辑器、补全) | 未开始 |
| M5 | `coding-agent` 完整移植(sessions、settings、skills、扩展系统、RPC) | 未开始 |
| M6 | 支撑件(protocol、client、server、telemetry、session-backends、chord、evals) | 未开始 |

详见 [docs/ROADMAP.md](docs/ROADMAP.md) 与 [M1 设计规格](docs/superpowers/specs/2026-09-19-m1-walking-skeleton-design.md)。

## 状态

M1 尚未开始实现。设计文档评审中。

## License

MIT
