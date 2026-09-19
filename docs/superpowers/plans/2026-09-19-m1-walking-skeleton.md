# M1 Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A minimal coding-agent CLI (`pirs`) with multi-turn streaming chat, 5 file/bash tools, over OpenAI-compatible and Anthropic providers.

**Architecture:** Single crate, three modules mirroring upstream layers with enforced one-way deps (`cli → agent → ai`). All provider streams normalize to one `AiEvent` enum; `Context` is plain serde data; stream errors are events; app messages are separate from LLM messages via `convert_to_llm`.

**Tech Stack:** tokio, reqwest (stream), eventsource-stream, serde/serde_json, schemars, anyhow, clap, rustyline, dirs, futures; dev: wiremock, tempfile.

**Spec:** `docs/superpowers/specs/2026-09-19-m1-walking-skeleton-design.md`

## Global Constraints

- Rust edition 2021, no `unsafe`, single crate `pi-rust`, binary name `pirs`.
- Module dependency direction: `cli → agent → ai` only. `ai` must not `use crate::agent` or `crate::cli`; `agent` must not `use crate::cli`. Enforce with `pub(crate)` where possible.
- Commit messages: `{feat,fix,docs,chore}: <message>` (no scope suffixes in this repo).
- Every task ends with `cargo test` green before committing.
- Thinking blocks are display-only: never replayed to providers (Anthropic requires signatures; DeepSeek replay is M2 compat-flag work).
- Windows is a first-class platform: bash tool uses `cmd /C` on Windows, `sh -c` elsewhere.
- Run single tests: `cargo test <module-path>` (e.g. `cargo test ai::openai_compat`). Full suite: `cargo test`.

---

### Task 1: Crate scaffold

**Files:**
- Create: `Cargo.toml`, `src/main.rs`

**Interfaces:**
- Produces: binary `pirs` that prints usage; all dependencies declared for later tasks.

- [ ] **Step 1: Create the crate**

```bash
cd C:/Users/13063/Desktop/code/pi-rust
cargo init --name pi-rust --vcs none
```

- [ ] **Step 2: Add dependencies**

```bash
cargo add tokio --features full
cargo add reqwest --features json,stream
cargo add eventsource-stream
cargo add serde --features derive
cargo add serde_json
cargo add schemars
cargo add anyhow
cargo add clap --features derive
cargo add rustyline
cargo add dirs
cargo add futures
cargo add toml
cargo add --dev wiremock
cargo add --dev tempfile
```

- [ ] **Step 3: Configure binary name and replace `src/main.rs`**

In `Cargo.toml`, under `[package]` section add:

```toml
[[bin]]
name = "pirs"
path = "src/main.rs"
```

Replace `src/main.rs`:

```rust
fn main() {
    println!("pirs");
}
```

- [ ] **Step 4: Build and run**

Run: `cargo run --quiet`
Expected: prints `pirs`

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/main.rs
git commit -m "chore: scaffold pi-rust crate with pirs binary"
```

---

### Task 2: ai core types (messages, events, context, provider trait)

**Files:**
- Create: `src/ai/message.rs`, `src/ai/event.rs`, `src/ai/mod.rs`, `src/lib.rs`
- Modify: `src/main.rs` (unused for now; leave as-is)
- Test: tests inside `src/ai/message.rs` (`#[cfg(test)]`)

**Interfaces:**
- Produces (used by all later tasks):
  - `ContentBlock` (Text/Thinking/ToolCall), `StopReason`, `Usage`, `Message` (User/Assistant/ToolResult), constructors `Message::user_text`, `Message::tool_result`, method `Message::tool_calls`
  - `AiEvent` (Start/TextDelta/ThinkingDelta/ToolCallEnd/Done/Error)
  - `Context { system_prompt, messages, tools }`, `ToolDef { name, description, parameters }`
  - `trait Provider { fn stream(&self, ctx: &Context) -> mpsc::Receiver<AiEvent>; }`

- [ ] **Step 1: Write `src/lib.rs`**

```rust
pub mod ai;
```

- [ ] **Step 2: Write `src/ai/message.rs` with tests**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text { text: String },
    Thinking { thinking: String },
    ToolCall { id: String, name: String, arguments: serde_json::Value },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    Stop,
    Length,
    ToolUse,
    Error,
    Aborted,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    User { content: Vec<ContentBlock> },
    Assistant { content: Vec<ContentBlock>, stop_reason: StopReason, usage: Usage },
    ToolResult { tool_call_id: String, tool_name: String, content: Vec<ContentBlock>, is_error: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

impl Message {
    pub fn user_text(text: impl Into<String>) -> Message {
        Message::User { content: vec![ContentBlock::Text { text: text.into() }] }
    }

    pub fn tool_result(tool_call_id: String, tool_name: String, text: String, is_error: bool) -> Message {
        Message::ToolResult {
            tool_call_id,
            tool_name,
            content: vec![ContentBlock::Text { text }],
            is_error,
        }
    }

    /// Text of all text blocks, joined by newlines.
    pub fn text(&self) -> String {
        let blocks = match self {
            Message::User { content }
            | Message::Assistant { content, .. }
            | Message::ToolResult { content, .. } => content,
        };
        let mut parts = Vec::new();
        for b in blocks {
            if let ContentBlock::Text { text } = b {
                parts.push(text.clone());
            }
        }
        parts.join("\n")
    }

    /// Tool calls requested by an assistant message (empty for other roles).
    pub fn tool_calls(&self) -> Vec<ToolCall> {
        if let Message::Assistant { content, .. } = self {
            content
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::ToolCall { id, name, arguments } => Some(ToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
                    }),
                    _ => None,
                })
                .collect()
        } else {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_round_trip_all_roles() {
        let msgs = vec![
            Message::user_text("hello"),
            Message::Assistant {
                content: vec![
                    ContentBlock::Thinking { thinking: "hmm".into() },
                    ContentBlock::Text { text: "hi".into() },
                    ContentBlock::ToolCall { id: "t1".into(), name: "read_file".into(), arguments: serde_json::json!({"path": "a.txt"}) },
                ],
                stop_reason: StopReason::ToolUse,
                usage: Usage { input_tokens: 10, output_tokens: 5 },
            },
            Message::tool_result("t1".into(), "read_file".into(), "contents".into(), false),
        ];
        for m in msgs {
            let v = serde_json::to_string(&m).unwrap();
            let back: Message = serde_json::from_str(&v).unwrap();
            assert_eq!(back, m);
        }
    }

    #[test]
    fn tool_calls_extracted_only_from_assistant() {
        let a = Message::Assistant {
            content: vec![ContentBlock::ToolCall { id: "t1".into(), name: "bash".into(), arguments: serde_json::json!({}) }],
            stop_reason: StopReason::ToolUse,
            usage: Usage::default(),
        };
        assert_eq!(a.tool_calls().len(), 1);
        assert!(Message::user_text("x").tool_calls().is_empty());
    }
}
```

- [ ] **Step 3: Write `src/ai/event.rs`**

```rust
use crate::ai::message::{Message, StopReason};

/// Normalized streaming events, identical for every provider.
/// Mirrors upstream pi-ai: errors are events, not panics.
#[derive(Debug, Clone)]
pub enum AiEvent {
    Start,
    TextDelta { delta: String },
    ThinkingDelta { delta: String },
    ToolCallEnd { id: String, name: String, arguments: serde_json::Value },
    Done { stop_reason: StopReason, message: Message },
    Error { message: String },
}
```

- [ ] **Step 4: Write `src/ai/mod.rs`**

```rust
pub mod event;
pub mod message;

use event::AiEvent;
use tokio::sync::mpsc;

/// A tool declaration sent to the LLM. `parameters` is a JSON Schema object.
#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Plain, serializable conversation state. Mirrors upstream pi-ai `Context`:
/// pure data, so it can cross providers and be persisted.
#[derive(Debug, Clone)]
pub struct Context {
    pub system_prompt: String,
    pub messages: Vec<message::Message>,
    pub tools: Vec<ToolDef>,
}

/// One provider = its wire protocol implementation.
pub trait Provider: Send + Sync {
    /// Start a streaming request; events flow out of the returned channel.
    fn stream(&self, ctx: &Context) -> mpsc::Receiver<AiEvent>;
}
```

- [ ] **Step 5: Run tests**

Run: `cargo test ai::message`
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
git add src/lib.rs src/ai/
git commit -m "feat(ai): core message, event, context types and provider trait"
```

---

### Task 3: openai-compat request body builder

**Files:**
- Create: `src/ai/openai_compat/mod.rs`
- Modify: `src/ai/mod.rs` (add `pub mod openai_compat;` and `ProviderConfig`)
- Test: tests inside `src/ai/openai_compat/mod.rs`

**Interfaces:**
- Consumes: `Context`, `Message`, `ContentBlock`, `ToolDef` from Task 2.
- Produces: `ProviderConfig { base_url, api_key, model, max_tokens }` (also defined here, used by Tasks 4-6, 10, 12); `OpenAiCompatProvider::new(cfg)`, `build_request_body(&Context, &ProviderConfig) -> serde_json::Value`.

- [ ] **Step 1: Add `ProviderConfig` to `src/ai/mod.rs`**

Append inside `src/ai/mod.rs`:

```rust
/// Connection details for one provider endpoint.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u64,
}
```

And add to the module list at the top: `pub mod openai_compat;`

- [ ] **Step 2: Write builder with failing tests**

Create `src/ai/openai_compat/mod.rs`:

```rust
use crate::ai::message::{ContentBlock, Message};
use crate::ai::{Context, ProviderConfig};

/// Convert an OpenAI-compat request body from a Context.
/// Thinking blocks are display-only and never replayed.
pub fn build_request_body(ctx: &Context, cfg: &ProviderConfig) -> serde_json::Value {
    let mut messages = Vec::new();
    if !ctx.system_prompt.is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": ctx.system_prompt }));
    }
    for m in &ctx.messages {
        match m {
            Message::User { content } => {
                messages.push(serde_json::json!({ "role": "user", "content": text_of(content) }));
            }
            Message::Assistant { content, .. } => {
                let text = text_of(content);
                let tool_calls: Vec<serde_json::Value> = content
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::ToolCall { id, name, arguments } => Some(serde_json::json!({
                            "id": id,
                            "type": "function",
                            "function": { "name": name, "arguments": arguments.to_string() }
                        })),
                        _ => None,
                    })
                    .collect();
                let mut msg = serde_json::json!({ "role": "assistant", "content": if text.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(text) } });
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = serde_json::Value::Array(tool_calls);
                }
                messages.push(msg);
            }
            Message::ToolResult { tool_call_id, content, .. } => {
                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": text_of(content)
                }));
            }
        }
    }
    let tools: Vec<serde_json::Value> = ctx
        .tools
        .iter()
        .map(|t| serde_json::json!({
            "type": "function",
            "function": { "name": t.name, "description": t.description, "parameters": t.parameters }
        }))
        .collect();
    serde_json::json!({ "model": cfg.model, "messages": messages, "tools": tools, "stream": true })
}

fn text_of(content: &[ContentBlock]) -> String {
    let mut parts = Vec::new();
    for b in content {
        if let ContentBlock::Text { text } = b {
            parts.push(text.clone());
        }
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::message::{Message, ToolDef};
    use crate::ai::ProviderConfig;

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            base_url: "http://localhost:1234/v1".into(),
            api_key: "sk-test".into(),
            model: "glm-4.6".into(),
            max_tokens: 8192,
        }
    }

    #[test]
    fn system_prompt_and_user_message() {
        let ctx = Context {
            system_prompt: "be brief".into(),
            messages: vec![Message::user_text("hi")],
            tools: vec![],
        };
        let body = build_request_body(&ctx, &cfg());
        assert_eq!(body["model"], "glm-4.6");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "be brief");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "hi");
        assert!(body["tools"].as_array().unwrap().is_empty());
    }

    #[test]
    fn assistant_tool_call_and_tool_result_replay() {
        let ctx = Context {
            system_prompt: String::new(),
            messages: vec![
                Message::user_text("ls"),
                Message::Assistant {
                    content: vec![ContentBlock::ToolCall {
                        id: "t1".into(),
                        name: "bash".into(),
                        arguments: serde_json::json!({"command": "ls"}),
                    }],
                    stop_reason: crate::ai::message::StopReason::ToolUse,
                    usage: Default::default(),
                },
                Message::tool_result("t1".into(), "bash".into(), "out".into(), false),
            ],
            tools: vec![ToolDef {
                name: "bash".into(),
                description: "run".into(),
                parameters: serde_json::json!({"type": "object"}),
            }],
        };
        let body = build_request_body(&ctx, &cfg());
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[1]["tool_calls"][0]["function"]["name"], "bash");
        // arguments must be a JSON-encoded string on the wire
        assert_eq!(msgs[1]["tool_calls"][0]["function"]["arguments"], r#"{"command":"ls"}"#);
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[2]["tool_call_id"], "t1");
        assert_eq!(body["tools"][0]["function"]["name"], "bash");
    }

    #[test]
    fn thinking_blocks_not_replayed() {
        let ctx = Context {
            system_prompt: String::new(),
            messages: vec![Message::Assistant {
                content: vec![
                    ContentBlock::Thinking { thinking: "secret".into() },
                    ContentBlock::Text { text: "answer".into() },
                ],
                stop_reason: crate::ai::message::StopReason::Stop,
                usage: Default::default(),
            }],
            tools: vec![],
        };
        let body = build_request_body(&ctx, &cfg());
        assert_eq!(body["messages"][0]["content"], "answer");
    }
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test openai_compat`
Expected: 3 passed

- [ ] **Step 4: Commit**

```bash
git add src/ai/
git commit -m "feat(ai): openai-compat request body builder"
```

---

### Task 4: openai-compat SSE streaming

**Files:**
- Modify: `src/ai/openai_compat/mod.rs`
- Test: tests inside `src/ai/openai_compat/mod.rs`

**Interfaces:**
- Consumes: `Provider` trait, `AiEvent`, `ProviderConfig`.
- Produces: `OpenAiCompatProvider` implementing `Provider` (used by Task 12): `fn new(cfg: ProviderConfig) -> Self`.

- [ ] **Step 1: Write failing wiremock tests (append to test module)**

```rust
    // --- streaming tests (require tokio) ---
    use crate::ai::event::AiEvent;
    use crate::ai::Provider;
    use futures::StreamExt;

    fn sse(body: &str) -> wiremock::ResponseTemplate {
        wiremock::ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string(body.to_string())
    }

    fn chunk(delta: serde_json::Value) -> String {
        format!("data: {}\n\n", serde_json::json!({"choices": [{"delta": delta}]}))
    }

    async fn collect(provider: &crate::ai::openai_compat::OpenAiCompatProvider, ctx: &crate::ai::Context) -> Vec<AiEvent> {
        let mut rx = provider.stream(ctx);
        let mut out = Vec::new();
        while let Some(ev) = rx.recv().await {
            out.push(ev);
        }
        out
    }

    #[tokio::test]
    async fn streams_text_and_done() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/chat/completions"))
            .respond_with(sse(&format!(
                "{}{}{}",
                chunk(serde_json::json!({"content": "he"})),
                chunk(serde_json::json!({"content": "y"})),
                "data: [DONE]\n\n"
            )))
            .mount(&server)
            .await;
        let provider = OpenAiCompatProvider::new(ProviderConfig {
            base_url: format!("{}/v1", server.uri()),
            api_key: "k".into(),
            model: "m".into(),
            max_tokens: 8192,
        });
        let ctx = crate::ai::Context { system_prompt: String::new(), messages: vec![Message::user_text("hi")], tools: vec![] };
        let events = collect(&provider, &ctx).await;
        assert!(matches!(events[0], AiEvent::Start));
        let mut text = String::new();
        for ev in &events {
            if let AiEvent::TextDelta { delta } = ev { text.push_str(delta); }
        }
        assert_eq!(text, "hey");
        match events.last().unwrap() {
            AiEvent::Done { stop_reason, message } => {
                assert!(*stop_reason == crate::ai::message::StopReason::Stop);
                assert_eq!(message.text(), "hey");
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn streams_tool_call_with_split_arguments() {
        let server = wiremock::MockServer::start().await;
        let body = format!(
            "{}{}{}{}",
            chunk(serde_json::json!({"tool_calls": [{"index": 0, "id": "t1", "type": "function", "function": {"name": "read_file", "arguments": "{\"pa"}}]})),
            chunk(serde_json::json!({"tool_calls": [{"index": 0, "function": {"arguments": "th\": \"a.txt\"}"}}]})),
            chunk(serde_json::json!({})),
            "data: [DONE]\n\n"
        );
        // finish_reason arrives in a choice-level field; add it to the empty chunk instead:
        let body = body.replace(
            &chunk(serde_json::json!({})),
            &format!("data: {}\n\n", serde_json::json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})),
        );
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/chat/completions"))
            .respond_with(sse(&body))
            .mount(&server)
            .await;
        let provider = OpenAiCompatProvider::new(ProviderConfig {
            base_url: format!("{}/v1", server.uri()),
            api_key: "k".into(),
            model: "m".into(),
            max_tokens: 8192,
        });
        let ctx = crate::ai::Context { system_prompt: String::new(), messages: vec![Message::user_text("hi")], tools: vec![] };
        let events = collect(&provider, &ctx).await;
        match events.last().unwrap() {
            AiEvent::Done { stop_reason, message } => {
                assert!(*stop_reason == crate::ai::message::StopReason::ToolUse);
                let calls = message.tool_calls();
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].name, "read_file");
                assert_eq!(calls[0].arguments, serde_json::json!({"path": "a.txt"}));
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn http_error_becomes_error_event() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(wiremock::ResponseTemplate::new(401).set_body_string("bad key"))
            .mount(&server)
            .await;
        let provider = OpenAiCompatProvider::new(ProviderConfig {
            base_url: server.uri(),
            api_key: "k".into(),
            model: "m".into(),
            max_tokens: 8192,
        });
        let ctx = crate::ai::Context { system_prompt: String::new(), messages: vec![Message::user_text("hi")], tools: vec![] };
        let events = collect(&provider, &ctx).await;
        match events.last().unwrap() {
            AiEvent::Error { message } => assert!(message.contains("401"), "got: {message}"),
            other => panic!("expected Error, got {other:?}"),
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test openai_compat`
Expected: FAIL, `OpenAiCompatProvider` not defined (compile error)

- [ ] **Step 3: Implement the provider (append to non-test part of file)**

```rust
use crate::ai::event::AiEvent;
use crate::ai::message::{ContentBlock, Message, StopReason, Usage};
use crate::ai::{Context, Provider, ProviderConfig};
use eventsource_stream::Eventsource;
use futures::StreamExt;
use tokio::sync::mpsc;

pub struct OpenAiCompatProvider {
    cfg: ProviderConfig,
}

impl OpenAiCompatProvider {
    pub fn new(cfg: ProviderConfig) -> Self {
        OpenAiCompatProvider { cfg }
    }
}

impl Provider for OpenAiCompatProvider {
    fn stream(&self, ctx: &Context) -> mpsc::Receiver<AiEvent> {
        let (tx, rx) = mpsc::channel(64);
        let cfg = self.cfg.clone();
        let ctx = ctx.clone();
        tokio::spawn(async move {
            if let Err(e) = run_stream(ctx, cfg, tx.clone()).await {
                let _ = tx.send(AiEvent::Error { message: e.to_string() }).await;
            }
        });
        rx
    }
}

struct ToolCallAcc {
    id: String,
    name: String,
    args: String,
}

async fn run_stream(ctx: Context, cfg: ProviderConfig, tx: mpsc::Sender<AiEvent>) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let resp = client
        .post(url)
        .bearer_auth(&cfg.api_key)
        .json(&build_request_body(&ctx, &cfg))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let _ = tx.send(AiEvent::Error { message: format!("HTTP {status}: {body}") }).await;
        return Ok(());
    }
    let _ = tx.send(AiEvent::Start).await;

    let mut text = String::new();
    let mut thinking = String::new();
    let mut tool_calls: Vec<ToolCallAcc> = Vec::new();
    let mut stop_reason = StopReason::Stop;
    let mut usage = Usage::default();

    let mut es = resp.bytes_stream().eventsource();
    while let Some(item) = es.next().await {
        let ev = item?;
        if ev.data.trim() == "[DONE]" {
            break;
        }
        let chunk: serde_json::Value = serde_json::from_str(&ev.data)?;
        let choice = &chunk["choices"][0];
        let delta = &choice["delta"];

        if let Some(t) = delta["reasoning_content"].as_str() {
            thinking.push_str(t);
            let _ = tx.send(AiEvent::ThinkingDelta { delta: t.to_string() }).await;
        }
        if let Some(t) = delta["content"].as_str() {
            text.push_str(t);
            let _ = tx.send(AiEvent::TextDelta { delta: t.to_string() }).await;
        }
        if let Some(tcs) = delta["tool_calls"].as_array() {
            for tc in tcs {
                let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                if tool_calls.len() <= idx {
                    tool_calls.resize(idx + 1, ToolCallAcc { id: String::new(), name: String::new(), args: String::new() });
                }
                let acc = &mut tool_calls[idx];
                if let Some(id) = tc["id"].as_str() {
                    acc.id = id.to_string();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    acc.name = n.to_string();
                }
                if let Some(a) = tc["function"]["arguments"].as_str() {
                    acc.args.push_str(a);
                }
            }
        }
        if let Some(fr) = choice["finish_reason"].as_str() {
            stop_reason = match fr {
                "tool_calls" | "function_call" => StopReason::ToolUse,
                "length" => StopReason::Length,
                _ => StopReason::Stop,
            };
        }
        if let Some(u) = chunk["usage"] {
            if !u.is_null() {
                usage = Usage {
                    input_tokens: u["prompt_tokens"].as_u64().unwrap_or(0),
                    output_tokens: u["completion_tokens"].as_u64().unwrap_or(0),
                };
            }
        }
    }

    let mut content = Vec::new();
    if !thinking.is_empty() {
        content.push(ContentBlock::Thinking { thinking });
    }
    if !text.is_empty() {
        content.push(ContentBlock::Text { text });
    }
    for tc in tool_calls {
        let arguments = serde_json::from_str(&tc.args).unwrap_or(serde_json::json!({}));
        content.push(ContentBlock::ToolCall { id: tc.id, name: tc.name, arguments });
    }
    let message = Message::Assistant { content, stop_reason, usage };
    let _ = tx.send(AiEvent::Done { stop_reason, message }).await;
    Ok(())
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test openai_compat`
Expected: 6 passed (3 builder + 3 streaming)

- [ ] **Step 5: Commit**

```bash
git add src/ai/openai_compat/ Cargo.toml Cargo.lock
git commit -m "feat(ai): openai-compat SSE streaming provider"
```

---

### Task 5: Anthropic request body builder

**Files:**
- Create: `src/ai/anthropic/mod.rs`
- Modify: `src/ai/mod.rs` (add `pub mod anthropic;`)
- Test: tests inside `src/ai/anthropic/mod.rs`

**Interfaces:**
- Consumes: `Context`, `Message`, `ContentBlock`, `ToolDef`, `ProviderConfig`.
- Produces: `build_request_body(&Context, &ProviderConfig) -> serde_json::Value` (used by Task 6).

- [ ] **Step 1: Write builder with tests**

Create `src/ai/anthropic/mod.rs`:

```rust
use crate::ai::message::{ContentBlock, Message};
use crate::ai::{Context, ProviderConfig};

/// Build an Anthropic /v1/messages request body from a Context.
/// Thinking blocks are display-only and never replayed.
/// Tool results become user messages with tool_result blocks (Anthropic convention).
pub fn build_request_body(ctx: &Context, cfg: &ProviderConfig) -> serde_json::Value {
    let mut messages = Vec::new();
    for m in &ctx.messages {
        match m {
            Message::User { content } => {
                messages.push(serde_json::json!({ "role": "user", "content": blocks(content) }));
            }
            Message::Assistant { content, .. } => {
                messages.push(serde_json::json!({ "role": "assistant", "content": blocks(content) }));
            }
            Message::ToolResult { tool_call_id, content, is_error, .. } => {
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": text_of(content),
                        "is_error": is_error
                    }]
                }));
            }
        }
    }
    let tools: Vec<serde_json::Value> = ctx
        .tools
        .iter()
        .map(|t| serde_json::json!({
            "name": t.name,
            "description": t.description,
            "input_schema": t.parameters
        }))
        .collect();
    serde_json::json!({
        "model": cfg.model,
        "max_tokens": cfg.max_tokens,
        "system": ctx.system_prompt,
        "messages": messages,
        "tools": tools,
        "stream": true
    })
}

fn blocks(content: &[ContentBlock]) -> Vec<serde_json::Value> {
    content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(serde_json::json!({ "type": "text", "text": text })),
            ContentBlock::ToolCall { id, name, arguments } => Some(serde_json::json!({
                "type": "tool_use", "id": id, "name": name, "input": arguments
            })),
            ContentBlock::Thinking { .. } => None,
        })
        .collect()
}

fn text_of(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::message::{Message, StopReason, ToolDef};

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            base_url: "https://api.anthropic.com".into(),
            api_key: "k".into(),
            model: "claude-sonnet-4-5".into(),
            max_tokens: 8192,
        }
    }

    #[test]
    fn system_is_top_level_and_tools_use_input_schema() {
        let ctx = Context {
            system_prompt: "be brief".into(),
            messages: vec![Message::user_text("hi")],
            tools: vec![ToolDef { name: "bash".into(), description: "run".into(), parameters: serde_json::json!({"type": "object"}) }],
        };
        let body = build_request_body(&ctx, &cfg());
        assert_eq!(body["system"], "be brief");
        assert_eq!(body["max_tokens"], 8192);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn tool_use_and_tool_result_shapes() {
        let ctx = Context {
            system_prompt: String::new(),
            messages: vec![
                Message::user_text("ls"),
                Message::Assistant {
                    content: vec![ContentBlock::ToolCall { id: "t1".into(), name: "bash".into(), arguments: serde_json::json!({"command": "ls"}) }],
                    stop_reason: StopReason::ToolUse,
                    usage: Default::default(),
                },
                Message::tool_result("t1".into(), "bash".into(), "out".into(), true),
            ],
            tools: vec![],
        };
        let body = build_request_body(&ctx, &cfg());
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[1]["content"][0]["type"], "tool_use");
        assert_eq!(msgs[1]["content"][0]["input"]["command"], "ls");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][0]["is_error"], true);
    }

    #[test]
    fn thinking_blocks_not_replayed() {
        let ctx = Context {
            system_prompt: String::new(),
            messages: vec![Message::Assistant {
                content: vec![
                    ContentBlock::Thinking { thinking: "secret".into() },
                    ContentBlock::Text { text: "answer".into() },
                ],
                stop_reason: StopReason::Stop,
                usage: Default::default(),
            }],
            tools: vec![],
        };
        let body = build_request_body(&ctx, &cfg());
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test anthropic`
Expected: 3 passed

- [ ] **Step 3: Commit**

```bash
git add src/ai/
git commit -m "feat(ai): anthropic request body builder"
```

---

### Task 6: Anthropic SSE streaming

**Files:**
- Modify: `src/ai/anthropic/mod.rs`
- Test: tests inside `src/ai/anthropic/mod.rs`

**Interfaces:**
- Consumes: `Provider` trait, `AiEvent`, `ProviderConfig`.
- Produces: `AnthropicProvider` implementing `Provider`: `fn new(cfg: ProviderConfig) -> Self`.

- [ ] **Step 1: Write failing wiremock tests (append to test module)**

```rust
    // --- streaming tests ---
    use crate::ai::event::AiEvent;
    use crate::ai::Provider;
    use futures::StreamExt;

    fn sse(body: &str) -> wiremock::ResponseTemplate {
        wiremock::ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string(body.to_string())
    }

    fn ev(name: &str, data: serde_json::Value) -> String {
        format!("event: {name}\ndata: {}\n\n", data)
    }

    async fn collect(provider: &AnthropicProvider, ctx: &crate::ai::Context) -> Vec<AiEvent> {
        let mut rx = provider.stream(ctx);
        let mut out = Vec::new();
        while let Some(ev) = rx.recv().await {
            out.push(ev);
        }
        out
    }

    fn text_stream_body() -> String {
        format!(
            "{}{}{}{}{}{}{}",
            ev("message_start", serde_json::json!({"message": {"usage": {"input_tokens": 10}}})),
            ev("content_block_start", serde_json::json!({"index": 0, "content_block": {"type": "text"}})),
            ev("content_block_delta", serde_json::json!({"index": 0, "delta": {"type": "text_delta", "text": "he"}})),
            ev("content_block_delta", serde_json::json!({"index": 0, "delta": {"type": "text_delta", "text": "y"}})),
            ev("content_block_stop", serde_json::json!({"index": 0})),
            ev("message_delta", serde_json::json!({"delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}})),
            ev("message_stop", serde_json::json!({})),
        )
    }

    #[tokio::test]
    async fn streams_text_and_done() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/messages"))
            .respond_with(sse(&text_stream_body()))
            .mount(&server)
            .await;
        let provider = AnthropicProvider::new(ProviderConfig {
            base_url: server.uri(),
            api_key: "k".into(),
            model: "m".into(),
            max_tokens: 8192,
        });
        let ctx = crate::ai::Context { system_prompt: String::new(), messages: vec![Message::user_text("hi")], tools: vec![] };
        let events = collect(&provider, &ctx).await;
        let mut text = String::new();
        for e in &events {
            if let AiEvent::TextDelta { delta } = e { text.push_str(delta); }
        }
        assert_eq!(text, "hey");
        match events.last().unwrap() {
            AiEvent::Done { stop_reason, message } => {
                assert!(*stop_reason == StopReason::Stop);
                assert_eq!(message.text(), "hey");
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn streams_tool_use_with_input_json_delta() {
        let body = format!(
            "{}{}{}{}{}{}{}",
            ev("message_start", serde_json::json!({"message": {"usage": {"input_tokens": 10}}})),
            ev("content_block_start", serde_json::json!({"index": 0, "content_block": {"type": "tool_use", "id": "t1", "name": "read_file"}})),
            ev("content_block_delta", serde_json::json!({"index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"pa"}})),
            ev("content_block_delta", serde_json::json!({"index": 0, "delta": {"type": "input_json_delta", "partial_json": "th\": \"a.txt\"}"}})),
            ev("content_block_stop", serde_json::json!({"index": 0})),
            ev("message_delta", serde_json::json!({"delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 3}})),
            ev("message_stop", serde_json::json!({})),
        );
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(sse(&body))
            .mount(&server)
            .await;
        let provider = AnthropicProvider::new(ProviderConfig {
            base_url: server.uri(),
            api_key: "k".into(),
            model: "m".into(),
            max_tokens: 8192,
        });
        let ctx = crate::ai::Context { system_prompt: String::new(), messages: vec![Message::user_text("hi")], tools: vec![] };
        let events = collect(&provider, &ctx).await;
        match events.last().unwrap() {
            AiEvent::Done { stop_reason, message } => {
                assert!(*stop_reason == StopReason::ToolUse);
                let calls = message.tool_calls();
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].id, "t1");
                assert_eq!(calls[0].arguments, serde_json::json!({"path": "a.txt"}));
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn http_error_becomes_error_event() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(wiremock::ResponseTemplate::new(401).set_body_string("bad key"))
            .mount(&server)
            .await;
        let provider = AnthropicProvider::new(ProviderConfig {
            base_url: server.uri(),
            api_key: "k".into(),
            model: "m".into(),
            max_tokens: 8192,
        });
        let ctx = crate::ai::Context { system_prompt: String::new(), messages: vec![Message::user_text("hi")], tools: vec![] };
        let events = collect(&provider, &ctx).await;
        match events.last().unwrap() {
            AiEvent::Error { message } => assert!(message.contains("401"), "got: {message}"),
            other => panic!("expected Error, got {other:?}"),
        }
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test anthropic`
Expected: FAIL, `AnthropicProvider` not defined

- [ ] **Step 3: Implement the provider (append to non-test part)**

```rust
use crate::ai::event::AiEvent;
use crate::ai::message::{ContentBlock, Message, StopReason, Usage};
use crate::ai::{Context, Provider, ProviderConfig};
use eventsource_stream::Eventsource;
use futures::StreamExt;
use tokio::sync::mpsc;

pub struct AnthropicProvider {
    cfg: ProviderConfig,
}

impl AnthropicProvider {
    pub fn new(cfg: ProviderConfig) -> Self {
        AnthropicProvider { cfg }
    }
}

impl Provider for AnthropicProvider {
    fn stream(&self, ctx: &Context) -> mpsc::Receiver<AiEvent> {
        let (tx, rx) = mpsc::channel(64);
        let cfg = self.cfg.clone();
        let ctx = ctx.clone();
        tokio::spawn(async move {
            if let Err(e) = run_stream(ctx, cfg, tx.clone()).await {
                let _ = tx.send(AiEvent::Error { message: e.to_string() }).await;
            }
        });
        rx
    }
}

struct ToolAcc {
    id: String,
    name: String,
    json: String,
}

async fn run_stream(ctx: Context, cfg: ProviderConfig, tx: mpsc::Sender<AiEvent>) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/messages", cfg.base_url.trim_end_matches('/'));
    let resp = client
        .post(url)
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&build_request_body(&ctx, &cfg))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let _ = tx.send(AiEvent::Error { message: format!("HTTP {status}: {body}") }).await;
        return Ok(());
    }
    let _ = tx.send(AiEvent::Start).await;

    let mut text = String::new();
    let mut thinking = String::new();
    let mut tool: Option<ToolAcc> = None;
    let mut stop_reason = StopReason::Stop;
    let mut usage = Usage::default();

    let mut es = resp.bytes_stream().eventsource();
    while let Some(item) = es.next().await {
        let ev = item?;
        let data: serde_json::Value = serde_json::from_str(&ev.data)?;
        match ev.event.as_str() {
            "message_start" => {
                usage.input_tokens = data["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
            }
            "content_block_start" => {
                let block = &data["content_block"];
                if block["type"] == "tool_use" {
                    tool = Some(ToolAcc {
                        id: block["id"].as_str().unwrap_or_default().to_string(),
                        name: block["name"].as_str().unwrap_or_default().to_string(),
                        json: String::new(),
                    });
                }
            }
            "content_block_delta" => {
                let delta = &data["delta"];
                match delta["type"].as_str().unwrap_or_default() {
                    "text_delta" => {
                        if let Some(t) = delta["text"].as_str() {
                            text.push_str(t);
                            let _ = tx.send(AiEvent::TextDelta { delta: t.to_string() }).await;
                        }
                    }
                    "thinking_delta" => {
                        if let Some(t) = delta["thinking"].as_str() {
                            thinking.push_str(t);
                            let _ = tx.send(AiEvent::ThinkingDelta { delta: t.to_string() }).await;
                        }
                    }
                    "input_json_delta" => {
                        if let Some(t) = delta["partial_json"].as_str() {
                            if let Some(acc) = tool.as_mut() {
                                acc.json.push_str(t);
                            }
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                stop_reason = match data["delta"]["stop_reason"].as_str().unwrap_or_default() {
                    "tool_use" => StopReason::ToolUse,
                    "max_tokens" => StopReason::Length,
                    _ => StopReason::Stop,
                };
                if let Some(o) = data["usage"]["output_tokens"].as_u64() {
                    usage.output_tokens = o;
                }
            }
            "message_stop" => break,
            "error" => {
                let msg = data["error"]["message"].as_str().unwrap_or("unknown error").to_string();
                let _ = tx.send(AiEvent::Error { message: msg }).await;
                return Ok(());
            }
            _ => {}
        }
    }

    let mut content = Vec::new();
    if !thinking.is_empty() {
        content.push(ContentBlock::Thinking { thinking });
    }
    if !text.is_empty() {
        content.push(ContentBlock::Text { text });
    }
    if let Some(acc) = tool {
        let arguments = serde_json::from_str(&acc.json).unwrap_or(serde_json::json!({}));
        content.push(ContentBlock::ToolCall { id: acc.id, name: acc.name, arguments });
    }
    let message = Message::Assistant { content, stop_reason, usage };
    let _ = tx.send(AiEvent::Done { stop_reason, message }).await;
    Ok(())
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test anthropic`
Expected: 6 passed (3 builder + 3 streaming)

- [ ] **Step 5: Commit**

```bash
git add src/ai/anthropic/
git commit -m "feat(ai): anthropic SSE streaming provider"
```

---

### Task 7: Agent loop — single turn, faux provider

**Files:**
- Create: `src/agent/mod.rs`, `src/agent/event.rs`, `src/agent/faux.rs`, `src/agent/tool.rs`
- Modify: `src/lib.rs` (add `pub mod agent;`)
- Test: tests inside `src/agent/mod.rs`

**Interfaces:**
- Consumes: `Provider`, `Context`, `AiEvent`, `Message`, `ContentBlock`, `StopReason` from ai layer.
- Produces (used by Tasks 8, 9, 12):
  - `AgentEvent` enum (TurnStart/AssistantDelta/ThinkingDelta/MessageEnd/ToolExecutionStart/ToolExecutionEnd/TurnEnd/AgentEnd/AgentError)
  - `AgentMessage` enum (`Message(Message)` / `Notification { text }`) + `convert_to_llm(&[AgentMessage]) -> Vec<Message>`
  - `AgentTool { name, description, parameters, execute }`, `make_tool<T>(name, description, fn(T) -> BoxToolFuture) -> AgentTool`, `type BoxToolFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>`
  - `Agent::new(provider: Arc<dyn Provider>, tools: Vec<AgentTool>, system_prompt: String)`, `Agent::prompt(&mut self, text, on_event: &mut dyn FnMut(AgentEvent)) -> anyhow::Result<()>`, field `pub messages: Vec<AgentMessage>`
  - `FauxProvider` for tests: `new()`, `push_script(Vec<AiEvent>)`, `impl Provider`

- [ ] **Step 1: Write `src/agent/event.rs`**

```rust
/// Agent-level events consumed by the UI. Mirrors upstream pi-agent-core.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    TurnStart,
    AssistantDelta { delta: String },
    ThinkingDelta { delta: String },
    MessageEnd,
    ToolExecutionStart { tool_call_id: String, tool_name: String, arguments: serde_json::Value },
    ToolExecutionEnd { tool_call_id: String, tool_name: String, is_error: bool },
    TurnEnd,
    AgentEnd,
    AgentError { message: String },
}
```

- [ ] **Step 2: Write `src/agent/tool.rs`**

```rust
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use std::future::Future;
use std::pin::Pin;

pub type BoxToolFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
pub type ToolFn = Box<dyn Fn(serde_json::Value) -> BoxToolFuture + Send + Sync>;

/// An executable tool: declaration (sent to the LLM) + executor.
#[derive(Clone)]
pub struct AgentTool {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: serde_json::Value,
    pub execute: std::sync::Arc<ToolFn>,
}

/// Build an AgentTool from a typed args struct. The struct's JSON Schema
/// (schemars) is sent to the LLM; incoming arguments are validated by
/// deserialization (mirrors upstream validateToolCall).
pub fn make_tool<T, F>(name: &'static str, description: &'static str, execute: F) -> AgentTool
where
    T: DeserializeOwned + JsonSchema + Send + 'static,
    F: Fn(T) -> BoxToolFuture + Send + Sync + 'static,
{
    AgentTool {
        name,
        description,
        parameters: serde_json::to_value(schemars::schema_for!(T)).expect("schema serializes"),
        execute: std::sync::Arc::new(Box::new(move |value| {
            match serde_json::from_value::<T>(value) {
                Ok(args) => execute(args),
                Err(e) => Box::pin(async move { Err(format!("invalid arguments: {e}")) }),
            }
        })),
    }
}
```

- [ ] **Step 3: Write `src/agent/faux.rs` (test helper, but a normal module — compiled always, used by tests)**

```rust
use crate::ai::event::AiEvent;
use crate::ai::{Context, Provider};
use std::collections::VecDeque;
use std::sync::Mutex;
use tokio::sync::mpsc;

/// Scripted provider for tests, mirroring upstream fauxProvider:
/// each stream() call dequeues the next script in push order (FIFO).
pub struct FauxProvider {
    scripts: Mutex<VecDeque<Vec<AiEvent>>>,
}

impl FauxProvider {
    pub fn new() -> Self {
        FauxProvider { scripts: Mutex::new(VecDeque::new()) }
    }

    pub fn push_script(&self, script: Vec<AiEvent>) {
        self.scripts.lock().unwrap().push_back(script);
    }
}

impl Provider for FauxProvider {
    fn stream(&self, _ctx: &Context) -> mpsc::Receiver<AiEvent> {
        let (tx, rx) = mpsc::channel(64);
        let script = self.scripts.lock().unwrap().pop_front().unwrap_or_default();
        tokio::spawn(async move {
            for ev in script {
                let _ = tx.send(ev).await;
            }
        });
        rx
    }
}
```

- [ ] **Step 4: Write `src/agent/mod.rs` with failing test**

```rust
pub mod event;
pub mod faux;
pub mod tool;

use crate::ai::event::AiEvent;
use crate::ai::message::Message;
use crate::ai::{Context, Provider, ToolDef};
use event::AgentEvent;
use std::sync::Arc;
use tool::AgentTool;

/// Application-level message. LLM-visible messages are wrapped in
/// `Message`; everything else stays app-only and is filtered out by
/// `convert_to_llm` (mirrors upstream AgentMessage vs LLM message split).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentMessage {
    Message(Message),
    Notification { text: String },
}

pub fn convert_to_llm(messages: &[AgentMessage]) -> Vec<Message> {
    messages
        .iter()
        .filter_map(|m| match m {
            AgentMessage::Message(m) => Some(m.clone()),
            AgentMessage::Notification { .. } => None,
        })
        .collect()
}

pub struct Agent {
    pub provider: Arc<dyn Provider>,
    pub tools: Vec<AgentTool>,
    pub system_prompt: String,
    pub messages: Vec<AgentMessage>,
    pub max_turns: usize,
}

impl Agent {
    pub fn new(provider: Arc<dyn Provider>, tools: Vec<AgentTool>, system_prompt: String) -> Self {
        Agent { provider, tools, system_prompt, messages: Vec::new(), max_turns: 25 }
    }

    fn build_context(&self) -> Context {
        Context {
            system_prompt: self.system_prompt.clone(),
            messages: convert_to_llm(&self.messages),
            tools: self
                .tools
                .iter()
                .map(|t| ToolDef {
                    name: t.name.to_string(),
                    description: t.description.to_string(),
                    parameters: t.parameters.clone(),
                })
                .collect(),
        }
    }

    /// Run one user prompt to completion of the tool-call loop.
    pub async fn prompt(&mut self, text: &str, on_event: &mut dyn FnMut(AgentEvent)) -> anyhow::Result<()> {
        self.messages.push(AgentMessage::Message(Message::user_text(text)));
        on_event(AgentEvent::TurnStart);
        let result = self.run_turns(on_event).await;
        on_event(AgentEvent::AgentEnd);
        result
    }

    async fn run_turns(&mut self, on_event: &mut dyn FnMut(AgentEvent)) -> anyhow::Result<()> {
        for _turn in 0..self.max_turns {
            let ctx = self.build_context();
            let mut rx = self.provider.stream(&ctx);
            let mut assistant: Option<Message> = None;
            while let Some(ev) = rx.recv().await {
                match ev {
                    AiEvent::Start => {}
                    AiEvent::TextDelta { delta } => on_event(AgentEvent::AssistantDelta { delta }),
                    AiEvent::ThinkingDelta { delta } => on_event(AgentEvent::ThinkingDelta { delta }),
                    AiEvent::ToolCallEnd { .. } => {}
                    AiEvent::Done { message, .. } => assistant = Some(message),
                    AiEvent::Error { message } => {
                        on_event(AgentEvent::AgentError { message: message.clone() });
                        anyhow::bail!("stream error: {message}");
                    }
                }
            }
            let msg = assistant.ok_or_else(|| anyhow::anyhow!("stream ended without Done"))?;
            on_event(AgentEvent::MessageEnd);
            self.messages.push(AgentMessage::Message(msg.clone()));

            let calls = msg.tool_calls();
            if calls.is_empty() {
                on_event(AgentEvent::TurnEnd);
                return Ok(());
            }
            for call in calls {
                on_event(AgentEvent::ToolExecutionStart {
                    tool_call_id: call.id.clone(),
                    tool_name: call.name.clone(),
                    arguments: call.arguments.clone(),
                });
                let (output, is_error) = self.execute_tool(&call.name, call.arguments).await;
                on_event(AgentEvent::ToolExecutionEnd { tool_call_id: call.id.clone(), tool_name: call.name.clone(), is_error });
                self.messages.push(AgentMessage::Message(Message::tool_result(call.id, call.name, output, is_error)));
            }
            on_event(AgentEvent::TurnEnd);
        }
        anyhow::bail!("exceeded max_turns ({})", self.max_turns)
    }

    async fn execute_tool(&self, name: &str, arguments: serde_json::Value) -> (String, bool) {
        match self.tools.iter().find(|t| t.name == name) {
            None => (format!("unknown tool: {name}"), true),
            Some(t) => match (t.execute)(arguments).await {
                Ok(out) => (out, false),
                Err(e) => (e, true),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::faux::FauxProvider;
    use crate::ai::message::{ContentBlock, StopReason};

    fn text_done(text: &str) -> AiEvent {
        AiEvent::Done {
            stop_reason: StopReason::Stop,
            message: Message::Assistant {
                content: vec![ContentBlock::Text { text: text.to_string() }],
                stop_reason: StopReason::Stop,
                usage: Default::default(),
            },
        }
    }

    #[tokio::test]
    async fn single_turn_no_tools() {
        let faux = Arc::new(FauxProvider::new());
        faux.push_script(vec![AiEvent::Start, AiEvent::TextDelta { delta: "he".into() }, AiEvent::TextDelta { delta: "y".into() }, text_done("hey")]);
        let mut agent = Agent::new(faux.clone(), vec![], "sys".into());

        let mut events = Vec::new();
        agent.prompt("hello", &mut |ev| events.push(format!("{ev:?}"))).await.unwrap();

        assert_eq!(agent.messages.len(), 2);
        let deltas: Vec<&str> = events.iter().filter_map(|e| match e {
            s if s.starts_with("AssistantDelta") => Some(s.as_str()),
            _ => None,
        }).collect();
        assert_eq!(deltas.len(), 2);
        assert!(events.iter().any(|e| e.starts_with("AgentEnd")));

        // notification messages are filtered from LLM context
        agent.messages.push(AgentMessage::Notification { text: "ui only".into() });
        let ctx = agent.build_context();
        assert_eq!(ctx.messages.len(), 2);
        assert_eq!(ctx.system_prompt, "sys");
    }
}
```

- [ ] **Step 5: Run tests**

Run: `cargo test agent`
Expected: 1 passed

- [ ] **Step 6: Commit**

```bash
git add src/lib.rs src/agent/
git commit -m "feat(agent): agent loop, tool registry, faux provider, single turn"
```

---

### Task 8: Agent loop — tool-call turns

**Files:**
- Modify: `src/agent/mod.rs` (test module only)
- Test: tests inside `src/agent/mod.rs`

**Interfaces:**
- Consumes: everything from Task 7 (loop already implements tool turns; these tests pin the behavior).

- [ ] **Step 1: Write failing tests (append to test module)**

```rust
    use crate::agent::tool::make_tool;
    use schemars::JsonSchema;
    use serde::Deserialize;
    use std::sync::Mutex as StdMutex;

    #[derive(Deserialize, JsonSchema)]
    struct EchoArgs {
        text: String,
    }

    #[tokio::test]
    async fn tool_call_loop_two_turns() {
        let faux = Arc::new(FauxProvider::new());
        // turn 1: model requests echo tool
        faux.push_script(vec![AiEvent::Done {
            stop_reason: StopReason::ToolUse,
            message: Message::Assistant {
                content: vec![ContentBlock::ToolCall { id: "t1".into(), name: "echo".into(), arguments: serde_json::json!({"text": "hi"}) }],
                stop_reason: StopReason::ToolUse,
                usage: Default::default(),
            },
        }]);
        // turn 2: model answers using the tool result
        faux.push_script(vec![text_done("echo said hi")]);

        let echo_tool = make_tool("echo", "echo text back", |a: EchoArgs| {
            Box::pin(async move { Ok(format!("echo: {}", a.text)) })
        });
        let mut agent = Agent::new(faux.clone(), vec![echo_tool], String::new());

        let mut tool_events: Vec<String> = Vec::new();
        agent.prompt("run echo", &mut |ev| {
            if let AgentEvent::ToolExecutionEnd { tool_name, is_error, .. } = ev {
                tool_events.push(format!("{tool_name} error={is_error}"));
            }
        }).await.unwrap();

        assert_eq!(tool_events, vec!["echo error=false".to_string()]);
        assert_eq!(agent.messages.len(), 4); // user, assistant(toolcall), toolresult, assistant(final)
        match &agent.messages[2] {
            AgentMessage::Message(Message::ToolResult { content, is_error, .. }) => {
                assert!(!is_error);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "echo: hi"),
                    other => panic!("unexpected block {other:?}"),
                }
            }
            other => panic!("expected tool result message, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn invalid_args_and_unknown_tool_become_error_results() {
        let faux = Arc::new(FauxProvider::new());
        faux.push_script(vec![AiEvent::Done {
            stop_reason: StopReason::ToolUse,
            message: Message::Assistant {
                content: vec![ContentBlock::ToolCall { id: "t1".into(), name: "echo".into(), arguments: serde_json::json!({"wrong": "arg"}) }],
                stop_reason: StopReason::ToolUse,
                usage: Default::default(),
            },
        }]);
        faux.push_script(vec![AiEvent::Done {
            stop_reason: StopReason::ToolUse,
            message: Message::Assistant {
                content: vec![ContentBlock::ToolCall { id: "t2".into(), name: "nope".into(), arguments: serde_json::json!({}) }],
                stop_reason: StopReason::ToolUse,
                usage: Default::default(),
            },
        }]);
        faux.push_script(vec![text_done("done")]);

        let echo_tool = make_tool("echo", "echo text back", |a: EchoArgs| {
            Box::pin(async move { Ok(format!("echo: {}", a.text)) })
        });
        let mut agent = Agent::new(faux.clone(), vec![echo_tool], String::new());

        let mut errors: Vec<bool> = Vec::new();
        agent.prompt("go", &mut |ev| {
            if let AgentEvent::ToolExecutionEnd { is_error, .. } = ev {
                errors.push(is_error);
            }
        }).await.unwrap();

        assert_eq!(errors, vec![true, true]); // invalid args, then unknown tool; final turn has no tool
        assert_eq!(agent.messages.len(), 6); // user, asst, toolresult, asst, toolresult, asst
        match agent.messages.last().unwrap() {
            AgentMessage::Message(Message::Assistant { content, .. }) => {
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "done"),
                    other => panic!("unexpected block {other:?}"),
                }
            }
            other => panic!("expected final assistant message, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn stream_error_is_reported() {
        let faux = Arc::new(FauxProvider::new());
        faux.push_script(vec![AiEvent::Error { message: "boom".into() }]);
        let mut agent = Agent::new(faux.clone(), vec![], String::new());

        let mut got_error = false;
        let result = agent.prompt("hi", &mut |ev| {
            if let AgentEvent::AgentError { message } = ev {
                assert_eq!(message, "boom");
                got_error = true;
            }
        }).await;
        assert!(result.is_err());
        assert!(got_error);
    }
```

- [ ] **Step 2: Run tests**

Run: `cargo test agent`
Expected: 4 passed (1 from Task 7 + 3 new). If `text_done`/imports collide, adjust test-module imports only.

- [ ] **Step 3: Commit**

```bash
git add src/agent/mod.rs
git commit -m "test(agent): tool-call loop, invalid args, stream error paths"
```

---

### Task 9: Built-in tools

**Files:**
- Create: `src/agent/tools/mod.rs`, `read_file.rs`, `write_file.rs`, `edit_file.rs`, `list_dir.rs`, `bash.rs`
- Test: tests inside each tool file

**Interfaces:**
- Consumes: `make_tool`, `AgentTool`, `BoxToolFuture` from Task 7.
- Produces: `pub fn builtin_tools() -> Vec<AgentTool>` returning read_file, write_file, edit_file, list_dir, bash (used by Task 12).

- [ ] **Step 1: Write `src/agent/tools/mod.rs` and the four file tools**

```rust
pub mod bash;
pub mod edit_file;
pub mod list_dir;
pub mod read_file;
pub mod write_file;

use crate::agent::tool::AgentTool;

pub fn builtin_tools() -> Vec<AgentTool> {
    vec![
        read_file::tool(),
        write_file::tool(),
        edit_file::tool(),
        list_dir::tool(),
        bash::tool(),
    ]
}
```

`src/agent/tools/read_file.rs`:

```rust
use crate::agent::tool::{make_tool, AgentTool};
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Deserialize, JsonSchema)]
pub struct ReadFileArgs {
    /// Path to the file, relative or absolute.
    pub path: String,
}

pub fn tool() -> AgentTool {
    make_tool("read_file", "Read a text file from disk and return its contents", |a: ReadFileArgs| {
        Box::pin(async move {
            let content = std::fs::read_to_string(&a.path).map_err(|e| format!("read failed: {e}"))?;
            Ok(content)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_and_reports_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "hello").unwrap();
        let t = tool();
        let ok = (t.execute)(serde_json::json!({"path": path.to_str().unwrap()})).await;
        assert_eq!(ok.unwrap(), "hello");

        let missing = (t.execute)(serde_json::json!({"path": "/nonexistent/x.txt"})).await;
        assert!(missing.is_err());
    }
}
```

`src/agent/tools/write_file.rs`:

```rust
use crate::agent::tool::{make_tool, AgentTool};
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Deserialize, JsonSchema)]
pub struct WriteFileArgs {
    /// Path to write to. Parent directories are created if needed.
    pub path: String,
    /// Full content to write (replaces the file).
    pub content: String,
}

pub fn tool() -> AgentTool {
    make_tool("write_file", "Write content to a file, replacing it entirely", |a: WriteFileArgs| {
        Box::pin(async move {
            if let Some(parent) = std::path::Path::new(&a.path).parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
            }
            let bytes = a.content.len();
            std::fs::write(&a.path, &a.content).map_err(|e| format!("write failed: {e}"))?;
            Ok(format!("wrote {bytes} bytes to {}", a.path))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writes_and_creates_parents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/dir/a.txt");
        let t = tool();
        let out = (t.execute)(serde_json::json!({"path": path.to_str().unwrap(), "content": "abc"})).await.unwrap();
        assert!(out.contains("3 bytes"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "abc");
    }
}
```

`src/agent/tools/edit_file.rs`:

```rust
use crate::agent::tool::{make_tool, AgentTool};
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Deserialize, JsonSchema)]
pub struct EditFileArgs {
    /// Path to the file to edit.
    pub path: String,
    /// Exact text to replace. Must appear exactly once in the file.
    pub old_string: String,
    /// Replacement text.
    pub new_string: String,
}

pub fn tool() -> AgentTool {
    make_tool("edit_file", "Replace an exact, unique occurrence of text in a file", |a: EditFileArgs| {
        Box::pin(async move {
            let content = std::fs::read_to_string(&a.path).map_err(|e| format!("read failed: {e}"))?;
            let count = content.matches(&a.old_string).count();
            if count == 0 {
                return Err("old_string not found in file".into());
            }
            if count > 1 {
                return Err(format!("old_string appears {count} times; it must be unique"));
            }
            let updated = content.replacen(&a.old_string, &a.new_string, 1);
            std::fs::write(&a.path, updated).map_err(|e| format!("write failed: {e}"))?;
            Ok(format!("edited {}", a.path))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn edit_requires_unique_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "one two two").unwrap();
        let t = tool();

        let dup = (t.execute)(serde_json::json!({
            "path": path.to_str().unwrap(), "old_string": "two", "new_string": "three"
        })).await;
        assert!(dup.unwrap_err().contains("2 times"));

        let ok = (t.execute)(serde_json::json!({
            "path": path.to_str().unwrap(), "old_string": "one", "new_string": "uno"
        })).await;
        assert!(ok.is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "uno two two");
    }
}
```

`src/agent/tools/list_dir.rs`:

```rust
use crate::agent::tool::{make_tool, AgentTool};
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Deserialize, JsonSchema)]
pub struct ListDirArgs {
    /// Directory to list.
    pub path: String,
}

pub fn tool() -> AgentTool {
    make_tool("list_dir", "List the entries of a directory", |a: ListDirArgs| {
        Box::pin(async move {
            let mut out: Vec<String> = Vec::new();
            let mut entries = std::fs::read_dir(&a.path).map_err(|e| format!("list failed: {e}"))?;
            while let Some(entry) = entries.next().map_err(|e| format!("list failed: {e}"))? {
                let name = entry.file_name().to_string_lossy().to_string();
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                out.push(if is_dir { format!("{name}/") } else { name });
            }
            out.sort();
            if out.is_empty() {
                Ok("(empty directory)".into())
            } else {
                Ok(out.join("\n"))
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lists_and_marks_dirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("b.txt"), "").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let t = tool();
        let out = (t.execute)(serde_json::json!({"path": dir.path().to_str().unwrap()})).await.unwrap();
        assert!(out.lines().any(|l| l == "b.txt"));
        assert!(out.lines().any(|l| l == "sub/"));
    }
}
```

- [ ] **Step 2: Write `src/agent/tools/bash.rs`**

```rust
use crate::agent::tool::{make_tool, AgentTool};
use schemars::JsonSchema;
use serde::Deserialize;
use std::process::Stdio;
use std::time::Duration;

fn default_timeout_ms() -> u64 {
    30_000
}

#[derive(Deserialize, JsonSchema)]
pub struct BashArgs {
    /// Shell command to run.
    pub command: String,
    /// Kill the command after this many milliseconds. Default 30000.
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

pub fn tool() -> AgentTool {
    make_tool("bash", "Run a shell command and return its combined stdout and stderr", |a: BashArgs| {
        Box::pin(async move {
            let mut cmd = if cfg!(windows) {
                let mut c = tokio::process::Command::new("cmd");
                c.arg("/C").arg(&a.command);
                c
            } else {
                let mut c = tokio::process::Command::new("sh");
                c.arg("-c").arg(&a.command);
                c
            };
            cmd.stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);

            let child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
            let output = match tokio::time::timeout(Duration::from_millis(a.timeout_ms), child.wait_with_output()).await {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => return Err(format!("command failed: {e}")),
                Err(_) => return Err(format!("command timed out after {} ms", a.timeout_ms)),
            };

            let mut out = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.is_empty() {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&stderr);
            }
            if out.len() > 10_000 {
                out.truncate(10_000);
                out.push_str("\n... (truncated)");
            }
            if !output.status.success() {
                return Ok(format!("exit code: {}\n{out}", output.status.code().unwrap_or(-1)));
            }
            Ok(out)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    const ECHO: &str = "echo pirs_test_ok";
    #[cfg(not(windows))]
    const ECHO: &str = "echo pirs_test_ok";

    #[tokio::test]
    async fn runs_command() {
        let t = tool();
        let out = (t.execute)(serde_json::json!({"command": ECHO})).await.unwrap();
        assert!(out.contains("pirs_test_ok"), "got: {out}");
    }

    #[tokio::test]
    async fn timeout_kills() {
        let t = tool();
        #[cfg(windows)]
        let slow = "ping -n 10 127.0.0.1 >nul";
        #[cfg(not(windows))]
        let slow = "sleep 10";
        let err = (t.execute)(serde_json::json!({"command": slow, "timeout_ms": 300})).await;
        assert!(err.unwrap_err().contains("timed out"));
    }
}
```

- [ ] **Step 3: Register module in `src/agent/mod.rs`**

Add to the module list at the top of `src/agent/mod.rs`: `pub mod tools;`

- [ ] **Step 4: Run tests**

Run: `cargo test agent::tools`
Expected: 7 passed (2+1+1+1+2). Note: the timeout test takes ~300 ms.

- [ ] **Step 5: Commit**

```bash
git add src/agent/
git commit -m "feat(agent): builtin tools read/write/edit/list/bash"
```

---

### Task 10: Config loading and API key resolution

**Files:**
- Create: `src/config.rs`
- Modify: `src/lib.rs` (add `pub mod config;`)
- Test: tests inside `src/config.rs`

**Interfaces:**
- Consumes: nothing (standalone).
- Produces (used by Task 12): `Config { provider, model, base_url, max_tokens }` with `Config::default()`, `parse_config(toml_str) -> anyhow::Result<Config>`, `resolve_api_key(provider: &str, cli_key: Option<&str>) -> Option<String>`.

- [ ] **Step 1: Write `src/config.rs` with tests**

```rust
use serde::{Deserialize, Serialize};

pub const PROVIDERS: &[&str] = &["anthropic", "openai-compat"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// "anthropic" or "openai-compat"
    pub provider: String,
    /// Model id sent to the provider, e.g. "claude-sonnet-4-5" or "glm-4.6".
    pub model: String,
    /// API base URL. Required for openai-compat; default https://api.anthropic.com for anthropic.
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u64,
}

fn default_max_tokens() -> u64 {
    8192
}

impl Default for Config {
    fn default() -> Self {
        Config {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-5".into(),
            base_url: None,
            max_tokens: default_max_tokens(),
        }
    }
}

pub fn parse_config(toml_str: &str) -> anyhow::Result<Config> {
    let cfg: Config = toml::from_str(toml_str)?;
    if !PROVIDERS.contains(&cfg.provider.as_str()) {
        anyhow::bail!("unknown provider '{}'; expected one of {:?}", cfg.provider, PROVIDERS);
    }
    if cfg.provider == "openai-compat" && cfg.base_url.is_none() {
        anyhow::bail!("openai-compat requires base_url in config or --base-url");
    }
    Ok(cfg)
}

/// Path of the user config file: <config_dir>/pi-rust/config.toml
pub fn config_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("pi-rust").join("config.toml"))
}

pub fn load_config() -> anyhow::Result<Config> {
    match config_path().filter(|p| p.exists()) {
        Some(path) => parse_config(&std::fs::read_to_string(path)?),
        None => Ok(Config::default()),
    }
}

/// Key resolution: explicit CLI flag wins, then the provider's env vars.
/// openai-compat accepts keys for common compatible vendors (GLM, OpenAI, DeepSeek, Moonshot).
pub fn resolve_api_key(provider: &str, cli_key: Option<&str>) -> Option<String> {
    if let Some(k) = cli_key {
        if !k.is_empty() {
            return Some(k.to_string());
        }
    }
    let candidates: &[&str] = match provider {
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "openai-compat" => &["GLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY"],
        _ => &[],
    };
    candidates
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_config() {
        let cfg = parse_config(r#"
provider = "openai-compat"
model = "glm-4.6"
base_url = "https://open.bigmodel.cn/api/paas/v4"
"#).unwrap();
        assert_eq!(cfg.provider, "openai-compat");
        assert_eq!(cfg.model, "glm-4.6");
        assert_eq!(cfg.max_tokens, 8192);
    }

    #[test]
    fn rejects_unknown_provider_and_missing_base_url() {
        assert!(parse_config("provider = \"nope\"\nmodel = \"m\"").is_err());
        assert!(parse_config("provider = \"openai-compat\"\nmodel = \"m\"").is_err());
    }

    #[test]
    fn cli_key_wins_over_env() {
        std::env::set_var("PIRS_TEST_KEY_ENV", "env-key");
        let got = resolve_api_key_env("PIRS_TEST_KEY_ENV", Some("cli-key"));
        assert_eq!(got.unwrap(), "cli-key");

        let from_env = resolve_api_key_env("PIRS_TEST_KEY_ENV", None);
        assert_eq!(from_env.unwrap(), "env-key");

        let missing = resolve_api_key_env("PIRS_TEST_KEY_MISSING", None);
        assert!(missing.is_none());
    }
}

/// Test-visible variant of env resolution so tests don't race provider env vars.
#[doc(hidden)]
pub fn resolve_api_key_env(env_name: &str, cli_key: Option<&str>) -> Option<String> {
    if let Some(k) = cli_key {
        if !k.is_empty() {
            return Some(k.to_string());
        }
    }
    std::env::var(env_name).ok().filter(|v| !v.is_empty())
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test config`
Expected: 3 passed

- [ ] **Step 3: Commit**

```bash
git add src/config.rs src/lib.rs
git commit -m "feat(config): toml config, provider validation, api key resolution"
```

---

### Task 11: Session JSONL writer

**Files:**
- Create: `src/agent/session.rs`
- Modify: `src/agent/mod.rs` (add `pub mod session;`)
- Test: tests inside `src/agent/session.rs`

**Interfaces:**
- Consumes: `AgentMessage` (serde-serializable, from Task 7).
- Produces: `SessionWriter::create(dir: &Path) -> anyhow::Result<Self>`, `session.append(&AgentMessage) -> anyhow::Result<()>`, `session.path() -> &Path` (used by Task 12).

- [ ] **Step 1: Write `src/agent/session.rs` with test**

```rust
use crate::agent::AgentMessage;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Append-only JSONL transcript: one AgentMessage per line.
pub struct SessionWriter {
    file: std::fs::File,
    path: PathBuf,
}

impl SessionWriter {
    pub fn create(dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        let path = dir.join(format!("session-{ts}.jsonl"));
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(SessionWriter { file, path })
    }

    pub fn append(&mut self, message: &AgentMessage) -> anyhow::Result<()> {
        let line = serde_json::to_string(message)?;
        writeln!(self.file, "{line}")?;
        self.file.flush()?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::message::Message;

    #[test]
    fn appends_parsable_lines() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = SessionWriter::create(dir.path()).unwrap();
        s.append(&AgentMessage::Message(Message::user_text("hello"))).unwrap();
        s.append(&AgentMessage::Notification { text: "ui".into() }).unwrap();

        let content = std::fs::read_to_string(s.path()).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        match serde_json::from_str::<AgentMessage>(lines[0]).unwrap() {
            AgentMessage::Message(m) => assert_eq!(m.text(), "hello"),
            other => panic!("expected message line, got {other:?}"),
        }
        match serde_json::from_str::<AgentMessage>(lines[1]).unwrap() {
            AgentMessage::Notification { text } => assert_eq!(text, "ui"),
            other => panic!("expected notification line, got {other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test agent::session`
Expected: 1 passed

- [ ] **Step 3: Commit**

```bash
git add src/agent/
git commit -m "feat(agent): jsonl session writer"
```

---

### Task 12: CLI — render, commands, REPL, main wiring

**Files:**
- Create: `src/cli/mod.rs`, `src/cli/render.rs`, `src/cli/repl.rs`
- Modify: `src/lib.rs` (add `pub mod cli;`), `src/main.rs` (full rewrite)
- Test: tests inside `src/cli/render.rs`

**Interfaces:**
- Consumes: `Agent`, `AgentEvent`, `builtin_tools`, `SessionWriter` from agent; `Config`, `resolve_api_key` from config; `Provider`, `ProviderConfig`, `OpenAiCompatProvider`, `AnthropicProvider` from ai.
- Produces: runnable `pirs` binary.

- [ ] **Step 1: Write `src/cli/render.rs` with tests**

```rust
use crate::agent::event::AgentEvent;

/// Pure formatting helpers; the REPL prints their results.
pub fn tool_start_line(tool_name: &str, arguments: &serde_json::Value) -> String {
    format!("[tool] {tool_name}({arguments})")
}

pub fn tool_end_line(tool_name: &str, is_error: bool, output: &str) -> String {
    let first_line = output.lines().next().unwrap_or("").to_string();
    let tag = if is_error { "error" } else { "ok" };
    format!("[{tag}] {tool_name}: {first_line}")
}

/// Print one agent event to stdout. Returns nothing; deltas print inline.
pub fn render_event(ev: &AgentEvent) {
    match ev {
        AgentEvent::TurnStart => {}
        AgentEvent::AssistantDelta { delta } => {
            use std::io::Write;
            print!("{delta}");
            let _ = std::io::stdout().flush();
        }
        AgentEvent::ThinkingDelta { .. } => {}
        AgentEvent::MessageEnd => println!(),
        AgentEvent::ToolExecutionStart { tool_name, arguments, .. } => {
            println!("{}", tool_start_line(tool_name, arguments));
        }
        AgentEvent::ToolExecutionEnd { tool_name, is_error, .. } => {
            // preview line only; the full result text lives in the conversation context
            println!("{}", tool_end_line(tool_name, *is_error, ""));
        }
        AgentEvent::TurnEnd => {}
        AgentEvent::AgentEnd => {}
        AgentEvent::AgentError { message } => println!("[error] {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_tool_lines() {
        let start = tool_start_line("bash", &serde_json::json!({"command": "ls"}));
        assert_eq!(start, r#"[tool] bash({"command":"ls"})"#);

        let end = tool_end_line("bash", false, "file1\nfile2");
        assert_eq!(end, "[ok] bash: file1");

        let err = tool_end_line("bash", true, "boom\nmore");
        assert_eq!(err, "[error] bash: boom");

        let empty = tool_end_line("bash", false, "");
        assert_eq!(empty, "[ok] bash: ");
    }
}
```

- [ ] **Step 2: Write `src/cli/repl.rs`**

```rust
use crate::agent::event::AgentEvent;
use crate::agent::session::SessionWriter;
use crate::agent::Agent;
use anyhow::Result;
use rustyline::error::ReadlineError;
use rustyline::DefaultEditor;

pub const SYSTEM_PROMPT: &str = "\
You are a coding agent working in the user's current directory. \
Use the provided tools to read and edit files and run commands. \
Be concise.";

pub async fn run(agent: &mut Agent, session: &mut SessionWriter, model_label: &str) -> Result<()> {
    let mut rl = DefaultEditor::new()?;
    println!("pirs ready. model: {model_label}. commands: /clear /model /quit");
    loop {
        let line = match rl.readline("» ") {
            Ok(line) => line,
            Err(ReadlineError::Interrupted) | Err(ReadlineError::Eof) => break,
            Err(e) => return Err(e.into()),
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let _ = rl.add_history_entry(&line);

        match line.as_str() {
            "/quit" | "/exit" => break,
            "/clear" => {
                agent.messages.clear();
                println!("context cleared");
                continue;
            }
            "/model" => {
                println!("{model_label}");
                continue;
            }
            cmd if cmd.starts_with('/') => {
                println!("unknown command: {cmd}");
                continue;
            }
            text => {
                let start = agent.messages.len();
                let result = agent.prompt(text, &mut |ev: AgentEvent| {
                    crate::cli::render::render_event(&ev);
                }).await;
                if let Err(e) = result {
                    println!("[error] {e}");
                }
                for m in &agent.messages[start..] {
                    session.append(m)?;
                }
            }
        }
    }
    println!("bye");
    Ok(())
}
```

- [ ] **Step 3: Write `src/cli/mod.rs`**

```rust
pub mod render;
pub mod repl;
```

- [ ] **Step 4: Write `src/main.rs` (full replacement)**

```rust
use anyhow::{bail, Context as AnyhowContext, Result};
use clap::Parser;
use pi_rust::agent::session::SessionWriter;
use pi_rust::agent::tools::builtin_tools;
use pi_rust::agent::Agent;
use pi_rust::ai::anthropic::AnthropicProvider;
use pi_rust::ai::openai_compat::OpenAiCompatProvider;
use pi_rust::ai::{Provider, ProviderConfig};
use pi_rust::cli::repl;
use pi_rust::config::{load_config, resolve_api_key, Config};
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "pirs", version, about = "Minimal coding agent CLI (Rust rewrite of pi)")]
struct Args {
    /// Provider: anthropic | openai-compat
    #[arg(long)]
    provider: Option<String>,
    /// Model id, e.g. claude-sonnet-4-5 or glm-4.6
    #[arg(long)]
    model: Option<String>,
    /// API base URL (required for openai-compat)
    #[arg(long)]
    base_url: Option<String>,
    /// API key (overrides env resolution)
    #[arg(long)]
    api_key: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut cfg: Config = load_config()?;
    if let Some(p) = args.provider { cfg.provider = p; }
    if let Some(m) = args.model { cfg.model = m; }
    if args.base_url.is_some() { cfg.base_url = args.base_url.clone(); }

    let key = resolve_api_key(&cfg.provider, args.api_key.as_deref())
        .context("no API key found: set ANTHROPIC_API_KEY (anthropic) or GLM_API_KEY/OPENAI_API_KEY (openai-compat), or pass --api-key")?;

    let pcfg = ProviderConfig {
        base_url: match (&cfg.provider, &cfg.base_url) {
            (_, Some(url)) => url.clone(),
            ("anthropic", None) => "https://api.anthropic.com".into(),
            _ => bail!("openai-compat requires --base-url or base_url in config"),
        },
        api_key: key,
        model: cfg.model.clone(),
        max_tokens: cfg.max_tokens,
    };

    let provider: Arc<dyn Provider> = match cfg.provider.as_str() {
        "anthropic" => Arc::new(AnthropicProvider::new(pcfg)),
        "openai-compat" => Arc::new(OpenAiCompatProvider::new(pcfg)),
        other => bail!("unknown provider: {other}"),
    };

    let mut agent = Agent::new(provider, builtin_tools(), repl::SYSTEM_PROMPT.to_string());
    let sessions_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("pi-rust")
        .join("sessions");
    let mut session = SessionWriter::create(&sessions_dir)?;
    println!("session: {}", session.path().display());

    repl::run(&mut agent, &mut session, &cfg.model).await
}
```

- [ ] **Step 5: Build, clippy, and smoke test**

Run: `cargo build`
Expected: success

Run: `cargo clippy --all-targets -- -D warnings`
Expected: no warnings

Run: `cargo run --quiet -- --help`
Expected: usage text with `--provider --model --base-url --api-key`

Run: `cargo test`
Expected: all tests green

- [ ] **Step 6: Commit**

```bash
git add src/
git commit -m "feat(cli): repl, rendering, config wiring and pirs binary"
```

---

### Task 13: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI on push/PR running fmt, clippy, tests on Linux and Windows.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - run: cargo fmt --check
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo test
```

- [ ] **Step 2: Verify formatting locally, then push**

Run: `cargo fmt`
Run: `git add .github/ && git commit -m "ci: fmt, clippy, test on linux and windows" && git push`

Run: `gh run watch --exit-status` (from repo root, after a few seconds: `gh run list` to find the run)
Expected: CI green on both OSes. If Windows-only failures appear (path separators, CRLF), fix and re-push; `bash` tool tests are written cross-platform already.

- [ ] **Step 3: Commit (already included in push)**

If fixes were needed:

```bash
git add -u && git commit -m "fix: windows CI issues" && git push
```

---

### Task 14: Live acceptance smoke test

**Files:**
- No new files.

**Interfaces:**
- Consumes: built binary + a real GLM or Anthropic API key.

- [ ] **Step 1: Run against a real provider**

With a GLM key (OpenAI-compatible) or `ANTHROPIC_API_KEY` set:

```bash
cargo run -- --provider openai-compat --base-url https://open.bigmodel.cn/api/paas/v4 --model glm-4.6
```

Acceptance checklist (from spec §7):
1. Streaming text renders incrementally as the model responds.
2. Prompt: "create hello.txt containing 'hi', then read it back" — agent calls write_file then read_file; tool lines print; final answer confirms.
3. `bash` works: "print the rust compiler version" runs `rustc --version` (via cmd /C on Windows).
4. Session file exists in `%LOCALAPPDATA%/pi-rust/sessions/` and contains one JSON line per message.
5. `/clear` empties context, `/model` prints the model, `/quit` exits.
6. Provider switch: same conversation works after restart with `--provider anthropic --model claude-sonnet-4-5` and `ANTHROPIC_API_KEY` (Context portability across providers).

- [ ] **Step 2: Update README status and commit**

In `README.md`, change the status section to:

```markdown
## 状态

M1 已实现:最小 agent CLI(pirs)。用法:

    cargo run -- --provider openai-compat --base-url <url> --model <id>
    # 需要 GLM_API_KEY / OPENAI_API_KEY 或 ANTHROPIC_API_KEY
```

```bash
git add README.md && git commit -m "docs: m1 usage and status" && git push
```

---

## Self-Review Notes

- Spec coverage: §2 architecture → Tasks 2-8 module layout and deps; §3 core types → Task 2 (AiEvent/Context), Task 7 (AgentMessage + convert_to_llm); §4 features → Tasks 3-6 (providers), 9 (5 tools), 10 (config+env), 11 (JSONL session), 12 (REPL + /commands); §5 stack → Task 1; §6 testing → wiremock (4, 6), faux provider (7-8), tempdir (9, 11); §7 delivery → binary name (Task 1), acceptance (Task 14).
- Type consistency: `AiEvent::Done { stop_reason, message }` used consistently in Tasks 2/4/6/7/8; `make_tool` signature identical in Tasks 7 and 9; `Agent::prompt(&mut self, text, &mut dyn FnMut(AgentEvent))` in Tasks 7/8/12.
- Known M1 simplifications carried into code: thinking blocks never replayed (Tasks 3/5 test this); tool output is not streamed mid-execution; consecutive same-role messages are not merged for Anthropic (our loop always alternates).
