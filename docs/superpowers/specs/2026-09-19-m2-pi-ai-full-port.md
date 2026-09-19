# M2 pi-ai 完整移植 设计规格

日期:2026-09-19
状态:已批准(用户目标指令:按 pi 项目全量重写,边重写边测试,功能与原版相同)
上游基准:earendil-works/pi 本地快照 commit `5901446`(C:/Users/13063/Desktop/code/pi)
本阶段定位:[ROADMAP.md](../ROADMAP.md) M2,即 packages/ai(2.5 万行)的完整移植。

## 1. 范围与分解

上游 packages/ai 实测结构(行数为源码行):

| 分解 | 内容 | 上游文件 | 规模 |
|---|---|---|---|
| M2a | 类型系统 + 转录语义 + 事件协议 | types.ts(990)、utils/transcript.ts(234) | ~1250 |
| M2b | 三大 API 完整移植 | api/openai-completions.ts(1723)、api/anthropic-messages.ts(1520)、api/openai-responses.ts(397) + openai-responses-shared.ts(793) | ~4450 |
| M2c | 派生 API | azure-openai-responses(350)、openai-codex-responses(1666)、google-generative-ai(470) + google-shared(515) + google-vertex(553)、mistral-conversations(946)、bedrock-converse-stream(1344)、pi-messages(443)、transform-messages(235)、constrained-sampling(277) | ~6850 |
| M2d | 认证体系 | auth/(types, resolve, credential-store, context, helpers, oauth/*)、env-api-keys.ts(188) | ~1500 |
| M2e | Models 集合 + 供应商注册 + 目录 + 图像 | models.ts(966)、models-store.ts、model-catalog.ts、providers/*、images*.ts、env 供应商清单 | ~8000+ |
| M2f | 所需 utils 按需移植 | utils/(retry, provider-retry, event-stream, validation, estimate, overflow, sanitize-unicode, hash, headers, text, sleep, uuid, diagnostics…) | 按需 |

每期独立走 spec→plan→实现→测试;M2a-b 完成后测试用例总数须 ≥ 50(用户目标)。

## 2. 兼容性硬约束(JSON 层面与上游一致)

- serde 序列化的字段名与判别值必须与上游 JSON 完全一致(role 标签、`type: "toolCall"`、camelCase 字段如 `toolCallId`/`stopReason`/`cacheRead`),保证:上游 pi 的 session JSONL 能被 pi-rust 读取,反之亦然(ROADMAP 兼容性标准)。
- 枚举值集合与上游一一对应:StopReason 7 值(pending/stop/length/toolUse/error/aborted/deferred)、KnownApi 10 值、KnownProvider 38 值。
- Compat 结构体字段名与上游 catalog JSON 一致(camelCase,如 `supportsDeveloperRole`)。

## 3. Rust 映射决定(与上游的类型机制差异,行为等价)

| 上游(TS) | pi-rust(Rust) |
|---|---|
| `Message` 判别联合(role) | `enum Message`,serde `tag = "role"` |
| `string \| TextContent[]` 联合 | `StringOrBlocks` 自定义 serde(untagged) |
| TypeBox TSchema 工具参数 | JSON Schema `serde_json::Value`(schemars 可桥接);校验= 反序列化即校验 + `validate_tool_call` |
| branded `TranscriptContext` | newtype `TranscriptContext(Vec<Message>)`,仅 `normalize_context` 可构造(私有字段) |
| 事件携带共享 live `partial` | 事件不携带 partial;提供 `PartialAssistant` 归并器,消费方随事件更新,可观察行为等价 |
| `Model.compat` 按 api 条件类型 | `enum ModelCompat { OpenAiCompletions(..), OpenAiResponses(..), Anthropic(..), Bedrock(..), Mistral(..) }` |
| declaration merging 自定义消息 | 预留 `Message::Custom` 变体位(M2a 不实现,M3 agent 层决定) |
| AbortSignal | tokio CancellationToken(按需,事件流取消) |

## 4. 测试与验收

- 每任务 TDD;serde 往返测试使用手写 fixture(与上游 session-format 文档/样例一致)。
- 行为测试直接对照上游源码注释与 README 合同(如 normalizeContext 分节重放规则)。
- 每期完成:全套测试 + clippy -D warnings + fmt + CI 双平台绿。
- 量化门:M2a-b 累计测试 ≥ 50。

## 5. 非目标

图像 API 实现、OAuth 流程实现、目录生成脚本在 M2d/e 才做;M2a 不动 agent/cli 层(仅 T10 集成适配)。
