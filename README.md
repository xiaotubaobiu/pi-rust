# pi-rust

**中文** | [English](#english)

[Pi Agent Harness](https://github.com/earendil-works/pi) 的 Rust 全量重写。derived from [earendil-works/pi](https://github.com/earendil-works/pi)（MIT）。

行为级完全兼容（drop-in compatible）——session 文件、`auth.json`、keybindings/themes/skills、JSON 输出、RPC 协议、扩展 API 与上游一致，可互相操作。不是源码逐行翻译（跨语言不存在），而是同架构哲学、同外部行为的全新实现。

规模：824 个 Rust 源文件、约 52.7 万行；5,136 项测试全部通过。

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

会话内支持 `/model`、`/settings`、`/compact`、`/export`、`/share`、`/tree`、`/session` 等命令，扩展系统、skills、hooks、themes、keybindings 均可用。

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

Scale: 824 Rust source files, ~527k lines; 5,136 tests, all passing.

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

In-session commands: `/model`, `/settings`, `/compact`, `/export`, `/share`, `/tree`, `/session` and more. Extensions, skills, hooks, themes and custom keybindings all work.

## Platform support

- **Windows**: fully developed and verified (all gates run here).
- **Linux / macOS**: platform branches are ported (Unix sockets, termux/wl-copy/xclip/pbcopy clipboard); run the gate suite once on those platforms to confirm.

## Known limitations

- Clipboard: Windows text-read and win/mac image-read rely on upstream's prebuilt native N-API module and are missing; the full Linux path (termux/wl/x11 subprocesses) and OSC 52 fallback are implemented.
- experimental subsystem runtime bindings (Windows named pipes, node:vm host, esbuild bundling) are left to host assembly per the seam convention.

## License

MIT, same as upstream. Copyright and design of all ported content belong to the original [earendil-works/pi](https://github.com/earendil-works/pi) authors.
