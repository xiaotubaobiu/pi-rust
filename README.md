# pi-rust

[Pi Agent Harness](https://github.com/earendil-works/pi) 的 Rust 全量重写。derived from [earendil-works/pi](https://github.com/earendil-works/pi)（MIT）。

**目标**：行为级完全兼容（drop-in compatible）的全量重写——session 文件、`auth.json`、keybindings/themes/skills、JSON 输出、RPC 协议、扩展 API 与上游一致，可互相操作。不是源码逐行翻译（跨语言不存在），而是同架构哲学、同外部行为的全新实现。

## 状态：全量迁移完成

六个里程碑（M1–M6）的全部代码工作已完成：

| 里程碑 | 对应上游包 | 状态 |
|---|---|---|
| M1 | 行走骨架：三层打通的最小 agent CLI（`pirs`） | ✅ |
| M2 | `pi-ai`：10 种 API、全部供应商、catalog、OAuth、faux、图像、callbacks | ✅ |
| M3 | `pi-agent-core`：harness 运行时（drive 14 模块、AgentHarness 公开外壳、telemetry、session 内存仓库） | ✅ |
| M4 | `pi-tui`：自研差分渲染器、事件循环、43 个组件、latex/图像/markdown 18.0.11、主题 | ✅ |
| M5 | `coding-agent`：sessions、settings、skills、扩展系统、model 栈、package-manager、agent-session、modes（interactive/print/json/rpc）、experimental 集群、cli | ✅ |
| M6 | `protocol`（CBOR/帧/编解码）、`client`、`server`、`evals`、`chord`（delta 复制状态/服务） | ✅ |

规模：824 个 Rust 源文件、约 52.7 万行。

## 验证方法

行为等价标准：**确定性序列化接缝逐字节一致**。全部移植切片以 actual-source oracle 验证——把上游 TypeScript 源码用 Node（`--experimental-strip-types`）真实执行捕获基准输出，Rust 侧同输入重放并断言逐字节相等（resolve-hook 方案映射 bare imports 到字节一致的源码副本）。LLM 响应等天然非确定项不纳入比对。

门禁：`cargo fmt --check` + `cargo clippy -D warnings` + 全量测试（串行模式双跑）+ `cargo test --doc`，当前 **5,136 项测试通过 / 0 失败**，日志归档于 `docs/migration/validation/`。

五次不可变检查点快照（wave1–wave6）均经独立核验脚本复核，最终清单 `full_migration_complete: true`。

## 构建

    cargo build --release --offline
    # 产物：target/release/pirs.exe（主 CLI）、generate-models.exe

## 运行

    pirs --provider anthropic --model <id>
    pirs login / logout          # OAuth 与 auth.json（与上游格式互通）
    pirs --provider openai-compat --base-url <url> --model <id>
    # 需要 ANTHROPIC_API_KEY / OPENAI_API_KEY / GLM_API_KEY 等环境凭据

支持 `--provider`：anthropic、openai-compat、openai-responses、azure-openai-responses、openai-codex、google、google-vertex、mistral、amazon-bedrock、pi-messages。

## 平台支持

- **Windows**：全量开发与验证平台（全部门禁在此跑通）。
- **Linux / macOS**：全部平台分支代码已移植（`cfg(unix)`：Unix socket 服务端、termux/wl-copy/xclip/pbcopy 剪贴板等），需在对应平台执行一轮门禁验证。

## 已披露边界

- **剪贴板**：Linux 主路径（termux/wl/x11 子进程）与 OSC 52 兜底已实现；Windows 文本读与 win/mac 图像读依赖上游预编译 native N-API 模块，无命令行等价物，当前缺失（需 arboard 类 crate，引入需联网）。
- **experimental 平台 seam**：Windows named pipe 传输、node:vm 扩展宿主、esbuild 打包按 seam 惯例留给运行时绑定；确定性协议/校验/状态机面已全量。
- **oracle 重放增量**：interactive 会话壳 oracle 已重放 338/344 场景（6 个 skip 均内联披露理由：JS harness 构件不可复现 / tmux decision-seam 设计 / npm seam 已闭合）。
- 详单见 [docs/migration/NEXT_SLICE_PLAN.md](docs/migration/NEXT_SLICE_PLAN.md) 与 [docs/migration/MIGRATION_STATUS.md](docs/migration/MIGRATION_STATUS.md)。

## 仓库结构（镜像上游包）

    src/ai/           ← packages/ai（API 适配器、callbacks、模型面）
    src/agent_core/   ← packages/agent（chord 支撑、harness 运行时、驱动层）
    src/coding_agent/ ← packages/coding-agent（核心/模式/CLI/扩展/包管理）
    src/tui/          ← packages/tui（渲染器/组件/终端能力）
    src/protocol/ src/client/ src/server/ src/chord/ src/evals/ ← packages/ 同名包

迁移过程文档：`docs/migration/`（WORK_LOG 50 万字节追加式台账、每片 scope 清单、oracle 先例、验证日志）。

## 许可

MIT，同上游。所有移植内容的著作权与设计归属 [earendil-works/pi](https://github.com/earendil-works/pi) 原作者。
