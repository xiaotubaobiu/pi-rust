# M2f 硬化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the compat-parity and hardening debt accumulated across M2a-M2e (~70 deferred items), plus the three load-bearing commitments: the abort signal surface (prerequisite for M3 agent-core), RS256 ADC service-account minting, and the Rust model-catalog generator.

**Architecture:** Task 1 (abort surface) is load-bearing for everything else — it unblocks previously-unportable abort oracles (faux ×4, codex SSE-abort, responses/retry abort tests) and gives M3 the cancellation primitive. Tasks 2-5 are batch tasks organized by work type. Task 6 closes with docs accuracy.

**Tech Stack:** Existing deps + pinned `rsa`/`sha2` for RS256 (Task 2, exact pins, disclosed).

**Spec:** `docs/superpowers/specs/2026-09-19-m2-pi-ai-full-port.md` (§1 M2f row; deferred-item ledgers in `.superpowers/sdd/*/progress.md` are the itemized source).

**Port style:** upstream remains the behavioral authority for every parity fix; "port-safer" deviations that were explicitly ruled and documented (validation strictness, integer-like section names) stay as-is — M2f verifies documentation, not behavior change.

## Global Constraints

- Edition 2021, no unsafe; gates per task: cargo test / clippy -D warnings / fmt; CI green at push.
- New deps pinned exact + disclosed. Behavior-changing fixes each get a regression test.
- Items explicitly ruled "port-safer, keep" (validation strictness class) are documentation-checked only.
- Commit messages: `{feat,fix,docs,chore}: <message>`.

---

### Task 1: Abort signal surface

**Files:** Modify `src/ai/types/options.rs` (signal field: `Option<tokio_util::sync::CancellationToken>` — tokio-util already a dep), all 10 ApiImpls (`src/ai/api/*`), `src/ai/models/mod.rs` routing; Test: per-module.
**Oracle:** the previously-unportable abort oracles: faux abort oracles ×4 (faux-provider tests upstream), openai-codex-oauth "aborts SSE body reads after response headers" (now signal exists), openai-responses/provider-retry abort tests (retry.rs abort branches become reachable), images-models abort. Also wire the signal through `resolveProviderAuth` ops (M2d already threads AuthOperationOptions).
- [ ] Signal plumbed options → all impls → Models routing; each impl aborts fetch+stream on cancellation (mid-stream abort settles stopReason "aborted" per upstream, not "error")
- [ ] Port the unportable abort oracles; gates → commit `feat(ai): abort signal surface across providers`

### Task 2: RS256 ADC service-account minting

**Files:** Modify `src/ai/api/google_vertex/mod.rs` (replace named error); new `src/ai/auth/google_adc.rs`.
**Oracle:** google-vertex-api-key-resolution.test.ts remaining halves + upstream google-auth-library JWT semantics (RS256-signed JWT assertion → token exchange). Add `rsa` + `sha2` pinned exact.
- [ ] Service-account key file → JWT (iss/sub/scope/aud/iat/exp, RS256) → token exchange → bearer; gates → commit `feat(ai): vertex adc service account minting (rs256)`

### Task 3: Rust model-catalog generator

**Files:** Create `src/bin/generate-models.rs` (or `xtask`).
**Reference:** upstream scripts/generate-models.ts transformation (models.dev fetch → per-provider Model JSON + manifest; the provider-specific special-casing subset that survives — port the transformation functions faithfully; where upstream's script handles live-data drift we already handle via skip-missing).
- [ ] Generates data/*.json + .manifest.json byte-compatible with our manifest validation; `--data-only` semantics; offline test with fixture; gates → commit `feat(ai): rust model catalog generator`

### Task 4: Hardening fixes — behavioral batch

**Files:** across api/agent/auth per item.
Items (each: fix + regression test): malformed tool_calls index clamp (openai_compat-era note, verify current openai_completions path); total_tokens saturating_add (anthropic); Model.headers null-suppression representation (BTreeMap<String,Option<String>>); ThinkingLevelMap ordered (BTreeMap); session filename millis; bash kill grandchildren note + truncation/exit-code tests (M1 carry); `tools: []` omission verify (closed M2b — assert stays); openrouter images empty-base64 data URL rejected; HTTP-date Retry-After parse; parse_ms_header parseFloat-prefix semantics; retry_assistant_call expect removal; request_failure trailing-separator; send_once method enum.
- [ ] Each fix + test; gates → commit `fix(ai): hardening batch (indices, headers, timing, retry parsing)`

### Task 5: String-parity + coverage batch

**Files:** across api/auth/tests.
Items: error-string parity (timeout cause "due to timeout"; openrouter 502 bare message; kimi arrays; malformed-frame texts; serde-vs-SyntaxError class where cheap; statusText canonical_reason note); coverage pins (reasoning_details-from-thoughtSignature; grammar error paths; cache-control backward-scan; tool_choice wire emission (mistral + google); mid-convo-effort betas; anthropic unsigned-thinking cross-model; model-aware factory pin; tokensPerSecond timing with paused clock; message literals unpinned batch); code dedupes (credential-read wrap; parse_json_with_repair placement; ISO parser consolidation; Arc<Box<dyn Fn>>→Arc<dyn Fn>; Message::text() join; read_file_by/TestEnv test-helper dedupe).
- [ ] Parity fixes + pins; gates → commit `fix(ai): error string parity, coverage pins, dedupe`

### Task 6: Docs sweep + integration close

**Files:** README, ROADMAP, module docs.
Items: doc wording fixes (content.rs arguments invariant; string-group; filterModels markers — verify done; disclosure #11 in module docs; generated_at impossible-date comment); ApiKeyCredential extra decision verify (landed T8/M2d); ThinkingLevelMap consumption verify; "port-safer keep" items documentation audit; README/ROADMAP final M2 status; then full gates + CI.
- [ ] Docs sweep; gates; commit `docs(ai): m2f hardening close-out`

---

## Self-Review Notes

- Items ruled "port-safer, keep" (non-object-root validation, int/float enum equality, type-invalid compat overrides, integer-like section names) are documented-behavior, excluded from behavior changes.
- RS256 pinned deps: `rsa` + `sha2` (sha2 may already be in tree via aws-sigv4 — check, reuse).
- Abort design: CancellationToken on options; upstream `AbortSignal.any` composition ≙ child tokens; mid-stream abort semantics (stopReason "aborted") per upstream resolve/stream contracts.
- Test trajectory: 1263 → ~1350+ by T6.
