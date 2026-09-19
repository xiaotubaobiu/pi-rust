# M2b 三大 API 完整移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the three foundational API implementations to full upstream parity — openai-completions.ts (1723), anthropic-messages.ts (1520), openai-responses.ts (397) + openai-responses-shared.ts (793) — plus the M2a deferred items (HTTP timeout, client reuse, retry, streaming partial-JSON), keeping the CLI working throughout.

**Architecture:** Upstream contract: every API module exports `stream` (full per-API options) and `streamSimple` (unified `reasoning` level mapped to provider-native params). Rust mapping: trait `ApiImpl { fn stream(...); fn stream_simple(...); }` with per-API impl structs (`OpenAiCompletions`, `AnthropicMessages`, `OpenAiResponses`) constructed from `ProviderConfig` + `Model`. `calculateCost` (models.ts:900) ports first — API impls fill `usage.cost`. Upstream test files under `packages/ai/test/` are the executable behavioral spec: each task names the upstream test files whose core assertions must be ported as wiremock wire tests.

**Tech Stack:** Existing deps. Upstream snapshot: C:/Users/13063/Desktop/code/pi at commit 5901446.

**Spec:** `docs/superpowers/specs/2026-09-19-m2-pi-ai-full-port.md` (§1 M2b row, §2 wire-compat constraints)

**Port style:** As M2a — implementers read upstream source + upstream test files directly; plan signatures + must-cover lists are the binding contract; upstream is the behavioral authority.

## Global Constraints

- Edition 2021, no unsafe, single crate, layering `cli → agent → ai` unchanged.
- Wire-compat: request bodies and parsed events must match upstream behavior for the same inputs (upstream test files are the oracle).
- CLI must keep working after every task (existing tests stay green; M1-era provider tests migrate to the new impls).
- Gates per task: `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt`; CI green at push.
- Commit messages: `{feat,fix,docs,chore}: <message>`.

---

### Task 1: calculateCost + ApiImpl plumbing + shared client with timeouts

**Files:**
- Create: `src/ai/cost.rs`, `src/ai/api/mod.rs` (trait + shared plumbing)
- Modify: `src/ai/mod.rs`
- Test: tests in new files

**Interfaces:**
- Produces: `calculate_cost(model: &Model, usage: &mut Usage)` porting models.ts:900-919 exactly (rate×tokens per million; tiers: highest matching `inputTokensAbove` applies to FULL request; cacheRead/cacheWrite rates; total = sum); trait `ApiImpl { fn stream(&self, cfg: &ProviderConfig, model: &Model, ctx: &TranscriptContext, options: &StreamOptions) -> mpsc::Receiver<AssistantMessageEvent>; fn stream_simple(&self, cfg: &ProviderConfig, model: &Model, ctx: &TranscriptContext, options: &SimpleStreamOptions) -> mpsc::Receiver<AssistantMessageEvent>; }`; shared `reqwest::Client` factory with `connect_timeout(60s)` (upstream SDK default total timeout 10min is stream-hostile; connect-only timeout is the M2a deferred item closed here — document divergence), `user_agent` mirroring upstream pi-user-agent.
- [ ] Failing tests: calculate_cost flat rates; tiered rates (tier applies when input > threshold); zero rates. Client factory builds.
- [ ] Implement; gates; commit `feat(ai): calculate_cost, ApiImpl trait, shared http client with timeouts`

### Task 2: openai-completions compat auto-detection

**Files:**
- Create: `src/ai/api/openai_completions/compat_detect.rs`
- Test: tests in file

**Interfaces:**
- Produces: `detect_openai_completions_compat(base_url: &str) -> OpenAiCompletionsCompat` — port upstream openai-completions.ts URL-based detection (find `detectCompat`/equivalent; Cerebras, xAI, Chutes, DeepSeek, NVIDIA NIM, Together, zAi, OpenCode, Cloudflare Workers AI, vLLM/llama.cpp defaults).
- [ ] Failing tests: one per detected provider family + unknown-URL default (from upstream detection table + upstream test `openai-completions-*` where relevant).
- [ ] Implement; gates; commit `feat(ai): openai-completions compat auto-detection`

### Task 3: openai-completions request builder (full)

**Files:**
- Create: `src/ai/api/openai_completions/request.rs` (absorbs M1's `build_request_body`)
- Test: tests in file

**Must-cover behaviors** (from upstream openai-completions.ts convertMessages/request assembly + its test files): message shaping (system/developer per supportsDeveloperRole + mid-convo folding when unsupported; user text+images; assistant text + tool_calls replay with JSON-string arguments + reasoning_content replay when requiresReasoningContentOnAssistantMessages; tool results with requiresToolResultName / requiresAssistantAfterToolResult; thinking-as-text `<thinking>` wrapping when requiresThinkingAsText); tools (function defs; strict per supportsStrictMode; grammar variants when supportsOpenAIGrammarTools); sampling (temperature, sampling_params merge over model defaults; maxTokensField; thinkingTokenBudgetField + thinkingBudgets; thinkingFormat variants openai/openrouter/deepseek/together/baseten/zai/qwen/chat-template/qwen-chat-template/string-thinking/ant-ling); caching (prompt_cache_key via cacheRetention + sessionAffinityFormat headers; cacheControlFormat anthropic markers; openRouterRouting `provider` field; vllmPriority); **empty tools → omit key** (M1 deferred minor closed here). Upstream tests to port assertions from: openai-completions-{empty-tools,prompt-cache,thinking-as-text,thinking-token-budget,tool-choice,tool-result-images,vllm-priority,cache-control-format}.test.ts, system-message-replay.test.ts.
- [ ] Failing wire tests per behavior cluster (request body byte-pins). [ ] Implement; gates; commit `feat(ai): openai-completions request builder (full port)`

### Task 4: openai-completions stream + stream_simple

**Files:**
- Create: `src/ai/api/openai_completions/stream.rs` (absorbs M1 SSE loop)
- Test: tests in file

**Must-cover**: SSE parse (content/reasoning_content deltas; tool_calls multi-index accumulation incl. argument fragments; [DONE]); usage mapping incl. prompt_tokens_details.cached_tokens→cacheRead, cache_creation→cacheWrite, completion_tokens_details.reasoning_tokens→reasoning, totalTokens; finish_reason map + rawStopReason; supportsFinishReason=false inference; responseModel; error bodies as Error events (pre-start vs mid-stream); stream_simple maps ThinkingLevel via thinkingLevelMap/thinkingFormat; retry hooks left for T8. Upstream tests: openai-completions-{raw-stop-reason,reasoning-details,response-model}.test.ts, tool-call-without-result.test.ts, unicode-surrogate.test.ts.
- [ ] Failing wire tests. [ ] Implement; gates; commit `feat(ai): openai-completions stream/streamSimple (full port)`

### Task 5: anthropic-messages request builder (full)

**Files:**
- Create: `src/ai/api/anthropic/request.rs` (absorbs M1 builder)
- Test: tests in file

**Must-cover**: system from replayed transcript (+ mid-convo folding when !supportsMidConvoSystemMessages); tools (cache_control placement per supportsCacheControlOnTools + long-retention ttl 1h; eager_input_streaming per compat else beta header; strict per supportsStrictTools; name normalization per anthropic-tool-name-normalization.test.ts); thinking replay WITH signatures (now full-fidelity: ThinkingContent.thinkingSignature → `signature`; empty-signature per allowEmptySignature; thinking disable per anthropic-thinking-disable.test.ts; adaptive per forceAdaptiveThinking + adaptive-thinking-models); temperature per supportsTemperature; max_tokens; fallbacks (allowedFallbackModels); metadata user_id. Upstream tests: anthropic-{thinking-disable,force-adaptive-thinking,temperature-compat,eager-tool-input-compat,empty-thinking-signature-compat,mid-conversation-effort,tool-name-normalization,long-cache-retention-e2e}.test.ts.
- [ ] Failing wire tests. [ ] Implement; gates; commit `feat(ai): anthropic-messages request builder (full port)`

### Task 6: anthropic-messages stream + stream_simple

**Files:**
- Create: `src/ai/api/anthropic/stream.rs` (absorbs M1 SSE loop)
- Test: tests in file

**Must-cover**: SSE events (message_start/message_delta usage incl. cache_creation_input_tokens→cacheWrite(+1h split cacheWrite1h), cache_read_input_tokens→cacheRead; content_block types text/thinking/tool_use + signature deltas; stop_reason map incl. model_context_window/pause_turn/refusal → mapped or rawStopReason; error events); multi tool_use (M2a fix retained); stream_simple thinking levels (budget_tokens from thinkingBudgets, adaptive mapping). Upstream tests: anthropic-{sse-parsing,cache-write-1h-cost}.test.ts, responseid.test.ts.
- [ ] Failing wire tests. [ ] Implement; gates; commit `feat(ai): anthropic-messages stream/streamSimple (full port)`

### Task 7: openai-responses-shared port

**Files:**
- Create: `src/ai/api/openai_responses_shared.rs`
- Test: tests in file

**Must-cover**: convertResponsesMessages (input items: message roles, function_call replay incl. foreign ids per openai-responses-foreign-toolcall-id.test.ts, function_call_output, reasoning items replay per reasoning-replay-e2e, empty tool result per empty-tool-result.test.ts, images per tool-result-images); convertResponsesTools (strict, grammar, namespace per namespace.test.ts); processResponsesStream skeleton (output item added/done, function_call_arguments_delta, output_text.delta, reasoning summary parts, response.completed/failed/incomplete, usage incl. input_tokens_details, message ids per message-id.test.ts, terminal-event.test.ts, partial-json-cleanup.test.ts, cache affinity headers per cache-affinity-e2e).
- [ ] Failing wire tests. [ ] Implement; gates; commit `feat(ai): openai-responses shared protocol port`

### Task 8: openai-responses stream + retry port

**Files:**
- Create: `src/ai/api/openai_responses/mod.rs`; port utils/retry.ts + utils/provider-retry.ts into `src/ai/retry.rs`
- Test: tests in files

**Must-cover**: Responses endpoint assembly (instructions, input items, tools, stream=true, max_output_tokens per supportsMaxOutputTokens, prompt_cache_options/retention per compat); SSE→events wiring through T7 processor; stream_simple reasoning effort mapping (effort levels + xhigh/max gating); retry.ts/provider-retry.ts port (retryable status codes, Retry-After honoring, maxRetryDelayMs cap 60s, provider-retry policy) applied to all three APIs' initial request. Upstream tests: openai-responses-{compat,terminal-event}.test.ts, retry.test.ts, provider-retry.test.ts.
- [ ] Failing tests. [ ] Implement; gates; commit `feat(ai): openai-responses impl + retry port`

### Task 9: integration — agent on stream_simple, cleanup

**Files:**
- Modify: `src/agent/mod.rs`, `src/main.rs`, M1 provider modules deleted/absorbed, `src/ai/mod.rs`
- Test: full suite

**Must-cover**: agent loop uses `stream_simple` with ThinkingLevel; faux provider implements ApiImpl; old `Provider` trait + openai_compat/anthropic M1 modules removed (absorbed into api/); Model plumbed from config (config gains optional cost/contextWindow for hand-declared models); all M1-era tests migrated; deferred M2a minors closed where touched (success_reason Deferred mapping documented).
- [ ] Migrate; gates; push; CI green; commit `feat(ai): crate on full API implementations (M2b complete)`

---

## Self-Review Notes

- M2a deferred items disposition: HTTP timeout + client reuse → T1; retry → T8; streaming partial-JSON for UI → remains deferred to M2f (PartialAssistant keeps raw-JSON accumulation; wire behavior unaffected); empty tools [] → T3; success_reason Deferred → T6 (rawStopReason preserved).
- Test-count trajectory: 173 + ~40-60 across T1-T9.
- Known risk: upstream test files reference SDK internals (typebox, SDK clients) — implementers port ASSERTIONS (wire bodies, parsed events), not test scaffolding; where an upstream test uses a fake fetch, use wiremock.
