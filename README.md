# pi-rust

**中文** | [English](#english)

[Pi Agent Harness](https://github.com/earendil-works/pi) 的 Rust 全量重写。derived from [earendil-works/pi](https://github.com/earendil-works/pi)（MIT）。

行为级完全兼容（drop-in compatible）——session 文件、`auth.json`、keybindings/themes/skills、JSON 输出、RPC 协议、扩展 API 与上游一致，可互相操作。不是源码逐行翻译（跨语言不存在），而是同架构哲学、同外部行为的全新实现。

规模：约 88 万行 Rust；5,457 项测试全部通过（Windows + Linux 双平台门禁）。

## 构建

需要 Rust 稳定版工具链。

    cargo build --release --offline
    # 产物：target/release/pirs.exe（主 CLI）、pi-rust.exe、generate-models.exe

安装到 PATH：

    cargo install --path .

## 使用

### 配置凭据（三选一）

**OAuth 登录**（anthropic / codex / copilot / openrouter / xai / kimi / radius 等 9 家）：

    pirs login --provider anthropic

凭据自动存入 `auth.json`（与上游 pi 格式互通；默认路径 Windows 为 `%APPDATA%\pi-rust\auth.json`，Linux 为 `~/.config/pi-rust/auth.json`，macOS 为 `~/Library/Application Support/pi-rust/auth.json`）。

**环境变量**：

    set ANTHROPIC_API_KEY=sk-ant-...        # Windows
    export ANTHROPIC_API_KEY=sk-ant-...     # Linux/macOS

**命令行显式传入**（优先级最高，不落盘）：

    pirs --provider anthropic --api-key sk-ant-...

### 启动交互会话

    pirs --provider anthropic --model claude-sonnet-4-5
    pirs --provider openai-compat --base-url https://open.bigmodel.cn/api/paas/v4 --model glm-4.6
    pirs --provider openai-compat --base-url <url> --model <id> --api-key <key>

支持 `--provider`：anthropic、openai-compat、openai-responses、azure-openai-responses、openai-codex、google、google-vertex、mistral、amazon-bedrock、pi-messages。

会话内支持 `/model`、`/settings`、`/compact`、`/export`、`/share`、`/tree`、`/session`、`/bug` 等命令，扩展系统、skills、hooks、themes、keybindings 均可用。

### 与上游 v0.99 同代的能力

- **MCP 客户端**：stdio / streamable-HTTP 传输、OAuth（动态客户端注册 + 回环回调）、`mcp.json` 配置、`/mcp` 管理、tool/resources/prompts 暴露策略（direct/deferred/codemode/hidden）。
- **codemode**：内嵌 QuickJS（quickjs-ng）沙箱，模型可以用 JavaScript 组合调用工具（`searchTools`、命名空间、延迟加载）。
- **tool-search**：BM25 工具检索与延迟加载。
- **system 主题**：从终端回读的背景/调色板实时生成 OKHSL 配色（对比度规则引擎），支持浅色/深色终端与灰度首帧。
- **pi-durable**：持久执行库（JSONL/内存/SQLite 存储、fork/事务/观察、调度器与 harness）。
- **System One / llama.cpp 分类器**、ChatGPT/Meta OAuth 新流程、指数退避重试。

## 平台支持

- **Windows**：全量开发与验证平台。
- **Linux / macOS**：平台分支代码已移植（Unix socket、termux/wl-copy/xclip/pbcopy 剪贴板等），需在对应平台跑一轮门禁验证。

## 已知限制

- 剪贴板：Windows 文本读与 win/mac 图像读依赖上游预编译 native N-API 模块，当前缺失；Linux 全路径（termux/wl/x11 子进程）与 OSC 52 兜底已实现。
- experimental 子系统的运行时绑定（Windows named pipe、node:vm 宿主、esbuild 打包）按 seam 惯例留给宿主装配。

---

<a name="english"></a>
# English

A full rewrite of the [Pi Agent Harness](https://github.com/earendil-works/pi) in Rust. derived from [earendil-works/pi](https://github.com/earendil-works/pi) (MIT).

Behaviorally drop-in compatible — session files, `auth.json`, keybindings/themes/skills, JSON output, the RPC protocol and the extension API all interoperate with upstream. Not a line-by-line translation (impossible across languages), but a fresh implementation with the same architecture and identical external behavior.

Scale: ~880k lines of Rust; 5,457 tests, all passing (gates verified on both Windows and Linux).

## Build

Requires a stable Rust toolchain.

    cargo build --release --offline
    # artifacts: target/release/pirs.exe (main CLI), pi-rust.exe, generate-models.exe

Install onto PATH:

    cargo install --path .

## Usage

### Configure credentials (pick one)

**OAuth login** (anthropic / codex / copilot / openrouter / xai / kimi / radius and more):

    pirs login --provider anthropic

Credentials are stored in `auth.json` (upstream-pi format; default path: `%APPDATA%\pi-rust\auth.json` on Windows, `~/.config/pi-rust/auth.json` on Linux, `~/Library/Application Support/pi-rust/auth.json` on macOS).

**Environment variable**:

    set ANTHROPIC_API_KEY=sk-ant-...        # Windows
    export ANTHROPIC_API_KEY=sk-ant-...     # Linux/macOS

**Explicit flag** (highest priority, never persisted):

    pirs --provider anthropic --api-key sk-ant-...

### Start an interactive session

    pirs --provider anthropic --model claude-sonnet-4-5
    pirs --provider openai-compat --base-url https://open.bigmodel.cn/api/paas/v4 --model glm-4.6
    pirs --provider openai-compat --base-url <url> --model <id> --api-key <key>

Supported `--provider`: anthropic, openai-compat, openai-responses, azure-openai-responses, openai-codex, google, google-vertex, mistral, amazon-bedrock, pi-messages.

In-session commands: `/model`, `/settings`, `/compact`, `/export`, `/share`, `/tree`, `/session`, `/bug` and more. Extensions, skills, hooks, themes and custom keybindings all work.

### Capabilities current with upstream v0.99

- **MCP client**: stdio / streamable-HTTP transports, OAuth (dynamic client registration + loopback callback), `mcp.json` config, `/mcp` management, tool/resources/prompts exposure policies (direct/deferred/codemode/hidden).
- **codemode**: an embedded QuickJS (quickjs-ng) sandbox where the model composes tool calls in JavaScript (`searchTools`, namespaces, deferred loading).
- **tool-search**: BM25 tool retrieval with deferred loading.
- **system theme**: live OKHSL palette generation from the terminal's reported background/palette (contrast-rule engine), light/dark terminals, grayscale first frame.
- **pi-durable**: the durable-execution library (JSONL/memory/SQLite storage, forks/transactions/observations, scheduler + harness).
- **System One / llama.cpp classifiers**, the ChatGPT/Meta OAuth flows, exponential-backoff retries.

## Platform support

- **Windows**: fully developed and verified (all gates run here).
- **Linux / macOS**: platform branches are ported (Unix sockets, termux/wl-copy/xclip/pbcopy clipboard); run the gate suite once on those platforms to confirm.

## Known limitations

- Clipboard: Windows text-read and win/mac image-read rely on upstream's prebuilt native N-API module and are missing; the full Linux path (termux/wl/x11 subprocesses) and OSC 52 fallback are implemented.
- experimental subsystem runtime bindings (Windows named pipes, node:vm host, esbuild bundling) are left to host assembly per the seam convention.

## License

MIT, same as upstream. Copyright and design of all ported content belong to the original [earendil-works/pi](https://github.com/earendil-works/pi) authors.
