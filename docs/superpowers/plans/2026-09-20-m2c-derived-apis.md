# M2c 派生 API 完整移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the remaining 7 API implementations to full upstream parity — pi-messages (443), azure-openai-responses (350), openai-codex-responses (1666), google-shared (515) + google-generative-ai (470) + google-vertex (553), mistral-conversations (946), bedrock-converse-stream (1344) — each implementing `ApiImpl`, with the established port style and wire tests.

**Architecture:** Same as M2b: each API is a module under `src/ai/api/` implementing `ApiImpl{stream, stream_simple}`; request builders pure (`RequestAssembly{body, headers}`), SSE→`AssistantMessageEvent` streams PartialAssistant-consumable, retry via T8's `send_stream_request` seam pattern. Shared families (google-shared consumed by generative-ai + vertex; azure/codex reuse openai_responses_shared).

**Tech Stack:** Existing deps. **Bedrock decision:** raw HTTP (reqwest) + `aws-sigv4` crate for SigV4 signing instead of the full aws-sdk-bedrockruntime (upstream heavily wraps the JS SDK with custom middleware anyway; wire parity is the goal, and aws-sigv4 is a small official crate — exact version pinned, disclosed). If aws-sigv4 proves insufficient for the events-signing shape, escalate to aws-sdk-bedrockruntime with a ledger ruling.

**Spec:** `docs/superpowers/specs/2026-09-19-m2-pi-ai-full-port.md` (§1 M2c row)

**Port style:** Upstream snapshot C:/Users/13063/Desktop/code/pi @ 5901446 is the behavioral authority; upstream test files are the executable oracle — port core assertions as wiremock wire tests. Auth note: ambient credential resolution (gcloud ADC, AWS profiles, OAuth) is M2d; M2c accepts explicit credentials via options/ProviderConfig.

## Global Constraints

- Edition 2021, no unsafe; layering `cli → agent → ai`; gates per task: cargo test / clippy -D warnings / fmt; CI green at push.
- Wire-compat vs upstream tests; every new dep pinned exact + disclosed.
- Commit messages: `{feat,fix,docs,chore}: <message>`.

---

### Task 1: pi-messages

**Files:** Create `src/ai/api/pi_messages/mod.rs`; Test: in file.
**Oracle:** pi-messages.test.ts. Simplest protocol: POST `{model, context, options}` → SSE of serialized assistant-message events + terminal done/error. Also ports parseStreamingJson usage for streamed tool args.
- [ ] Failing wire tests → implement ApiImpl → gates → commit `feat(ai): pi-messages api port`

### Task 2: azure-openai-responses

**Files:** Create `src/ai/api/azure_openai_responses/mod.rs`. Consumes openai_responses_shared (T7/M2b) with Azure URL/auth shape.
**Oracle:** azure-openai-{base-url,reasoning-replay,tool-choice}.test.ts + azure-utils.ts. Deployment-in-URL, api-key header vs bearer per upstream, reasoning replay rules.
- [ ] Failing wire tests → implement → gates → commit `feat(ai): azure-openai-responses api port`

### Task 3: openai-codex-responses

**Files:** Create `src/ai/api/openai_codex_responses/mod.rs`. Codex protocol over responses-shared (ChatGPT backend endpoints, session affinity, websocket-cached transport scaffold if upstream — read; if websocket transport is load-bearing and env-gated upstream, port the HTTP path fully + scaffold the transport enum, disclosing).
**Oracle:** openai-codex-stream.test.ts (+ cache-affinity-e2e already partly ported in T7/M2b). OAuth pieces defer to M2d (bearer token accepted via options).
- [ ] Failing wire tests → implement → gates → commit `feat(ai): openai-codex-responses api port`

### Task 4: google-shared

**Files:** Create `src/ai/api/google_shared.rs`. Message/tool conversion + stream processing shared by both Google APIs (18 exports).
**Oracle:** google-shared-{convert-tools,gemini3-unsigned-tool-call,image-tool-result-routing,retry,signed-empty-blocks}.test.ts, google-thinking-{disable,level-map,signature}.test.ts.
- [ ] Failing tests → implement → gates → commit `feat(ai): google shared protocol port`

### Task 5: google-generative-ai

**Files:** Create `src/ai/api/google_generative_ai/mod.rs`. Consumes google_shared; GenerativeLanguage API endpoints, SSE alt=sse.
**Oracle:** google-raw-stop-reason.test.ts + shared tests at API level.
- [ ] Failing wire tests → implement → gates → commit `feat(ai): google generative-ai api port`

### Task 6: google-vertex

**Files:** Create `src/ai/api/google_vertex/mod.rs`. Consumes google_shared; Vertex endpoints + bearer-token auth shape (ADC defers to M2d; explicit token via options).
**Oracle:** google-vertex-api-key-resolution.test.ts (auth resolution part deferred to M2d — port the API-level behavior).
- [ ] Failing wire tests → implement → gates → commit `feat(ai): google vertex api port`

### Task 7: mistral-conversations

**Files:** Create `src/ai/api/mistral/mod.rs`. Own protocol (conversations API), HTTP transport.
**Oracle:** mistral-{http-transport,raw-stop-reason,reasoning-mode,tool-schema}.test.ts.
- [ ] Failing wire tests → implement → gates → commit `feat(ai): mistral-conversations api port`

### Task 8: bedrock-converse-stream

**Files:** Create `src/ai/api/bedrock/mod.rs` (+ SigV4 signing helper). Per architecture decision: reqwest + aws-sigv4 (pinned), event-stream frame decoding if ConverseStream uses AWS event-stream binary framing (read upstream/SDK behavior — the JS SDK hides the framing; the wire protocol is AWS event-stream: port a minimal frame decoder if needed, disclosed).
**Oracle:** bedrock-{convert-messages,thinking-payload,redacted-reasoning,raw-stop-reason,cache-write-1h-cost,custom-headers,endpoint-resolution,error-metadata,response-headers}.test.ts (credential tests defer to M2d).
- [ ] Failing wire tests → implement → gates → commit `feat(ai): bedrock converse-stream api port`

### Task 9: integration

**Files:** Modify `src/main.rs` (provider selection gains azure/codex/google/google-vertex/mistral/bedrock/pi-messages where option-based auth makes them usable; document ambient-auth providers as M2d), `src/config.rs` (PROVIDERS list), select_api tests.
- [ ] Migrate; gates; push; CI green; commit `feat(ai): full API surface wired (M2c complete)`

---

## Self-Review Notes

- Deferred to M2d: ambient auth (ADC/AWS profiles/OAuth flows). M2c = explicit-credential API behavior.
- Websocket transports (codex websocket-cached) — port decision at task time with ledger ruling if scope grows.
- Test trajectory: 471 → ~600+ by T9.
