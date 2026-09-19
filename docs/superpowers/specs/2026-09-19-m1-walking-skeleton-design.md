# M1 行走骨架:最小 agent CLI 设计规格

日期:2026-09-19
状态:待评审
上游参照:https://github.com/earendil-works/pi (commit 5901446 附近)
本阶段定位:[docs/ROADMAP.md](../../ROADMAP.md) 的 M1,全量重写程序的第一阶段。

## 1. 目标

三层架构端到端打通的最小可用 coding agent CLI:多轮对话 + 读/改文件 + 执行 bash。作为后续逐包加深的骨架,架构哲学与上游完全对齐。

非目标(明确不做,YAGNI):全屏 TUI、扩展系统、MCP、上下文压缩、并行工具执行、cost 统计、OAuth、图片输入、模型 catalog、与上游 session 格式兼容(M5 再做)。

## 2. 架构

上游三层与哲学四条的映射(哲学:统一流式事件、Context 纯数据、错误即事件、应用消息与 LLM 消息分离):

```
src/cli/     ← packages/coding-agent 的交互壳:REPL、流式渲染
src/agent/   ← packages/agent:循环、工具、agent 事件
src/ai/      ← packages/ai:Provider trait + OpenAI兼容/Anthropic 协议 + 统一事件
```

依赖单向 `cli → agent → ai`,模块可见性由编译器强制;规模增长后机械拆分为 workspace。

### 上游 → 本仓库目录映射

| 上游(TS) | 本仓库(Rust) | 说明 |
|---|---|---|
| packages/ai/src/types.ts | src/ai/message.rs + src/ai/event.rs | types.ts 拆为纯数据消息与流式事件两块 |
| packages/ai/src/api/*(9 种) | src/ai/openai_compat/、src/ai/anthropic/ | M1 只实现 openai-completions 与 anthropic-messages 两种 |
| packages/agent/src/agent.ts + agent-loop.ts | src/agent/mod.rs | 上游两者咬合紧密,M1 合并;完整移植(M3)再拆 |
| packages/coding-agent 内置工具 | src/agent/tools/ | read_file、write_file、edit_file、bash、list_dir |
| packages/coding-agent 交互/settings | src/cli/repl.rs、render.rs、src/config.rs | 非 TUI 壳 + settings 最小子集 |

## 3. 核心类型(草案)

```rust
// ai 层:统一流式事件(照搬 pi-ai 事件模型子集)
enum AiEvent {
    Start,
    TextDelta { delta: String },
    ThinkingDelta { delta: String },
    ToolCallEnd { id: String, name: String, arguments: serde_json::Value },
    Done { stop_reason: StopReason, usage: Usage },
    Error { message: String },
}

// ai 层:纯数据 Context(serde 可序列化 → session 即 JSONL,可跨供应商切换)
struct Context { system_prompt: String, messages: Vec<Message>, tools: Vec<ToolDef> }

// ai 层:供应商 = 目录 + 认证 + 协议(M1 各一份静态注册)
trait Provider { fn stream(&self, ctx: &Context) -> ReceiverStream<AiEvent>; }

// agent 层:应用消息与 LLM 消息分离
enum AgentMessage { User(UserMsg), Assistant(AssistantMsg), ToolResult(ToolResultMsg) /* 预留扩展变体 */ }
fn convert_to_llm(msgs: Vec<AgentMessage>) -> Vec<Message>; // 过滤桥接
```

## 4. 功能清单

- REPL:多轮对话、流式输出、`/quit` `/clear` `/model` 命令
- 内置工具 5 个:read_file、write_file、edit_file(字符串替换)、bash(带超时)、list_dir;参数为 Rust 结构体,schemars 派生 JSON Schema,serde 反序列化即校验(对应上游 validateToolCall)
- 供应商:OpenAI 兼容(自定义 base_url + model + key,覆盖 GLM/DeepSeek/Kimi/Ollama)+ Anthropic 原生;工具执行为顺序执行
- 配置:`~/.config/pi-rust/config.toml` + 环境变量(`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GLM_API_KEY` 等);模型直填 id,无 catalog
- Session:M1 自有 JSONL 格式(追加写),不追求上游兼容
- 系统提示词:简版 coding agent prompt

## 5. 技术选型

tokio、reqwest(stream)+ eventsource-stream、serde/serde_json、schemars、anyhow、clap、rustyline、dirs、futures。全部为主流维护良好的 crate。

## 6. 测试策略

- ai 层:wiremock 本地 mock HTTP;两种协议的事件解析单测(含工具调用流式分片)
- agent 层:照上游 fauxProvider 思路做脚本化假供应商,测循环、工具调度、错误即事件
- 工具:临时目录集成测试

## 7. 交付

- 仓库 github.com/xiaotubaobiu/pi-rust(公开,MIT,README 注明 derived from 上游)
- 二进制名 `pirs`
- 验收:`pirs` 可用 GLM 或 Anthropic 完成一次"读文件 → 修改 → 跑测试"的真实任务

## 决策记录

- 2026-09-19 范围从"最小重写"升级为全量重写程序(M1 为阶段 0,骨架先行);见 ROADMAP.md
- 2026-09-19 单 crate 起步;哲学四条作为硬约束;后期机械拆 workspace
- 2026-09-19 仓库形式:独立新仓库而非 GitHub fork(Rust 与 TS 历史无关;README 注明来源)
- 2026-09-19 MVP 供应商:OpenAI 兼容 + Anthropic 原生(用户实际使用 GLM)
