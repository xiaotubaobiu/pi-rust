# M3a pi-agent-core 核心移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the agent CORE (packages/agent/src root, 2505 lines: types.ts 463, agent-loop.ts 857, agent.ts 607, stream-fn.ts 20, index.ts 152) to full upstream parity. The harness/ subtree (~31k lines: compaction, execution, pico3, hooks infra) is M3b with its own recon — explicitly out of scope here.

**Architecture:** New module tree `src/agent_core/` (the M1-era `src/agent/` mini-loop stays until T6 integration swap, then is replaced). Core concepts ported faithfully from upstream packages/agent/src + README: AgentMessage (app/LLM split + declaration-merging equivalent), AgentEvent stream (agent_start/turn_*/message_*/tool_execution_*/agent_end), the turn loop (prompt → LLM → tool execution → toolResult → repeat), steering + follow-up queues with one-at-a-time/all modes, shouldStopAfterTurn, continue(), waitForIdle, abort, tool execution modes (parallel preflight/sequential), beforeToolCall/afterToolCall hooks, terminate hints.

**Tech Stack:** Existing deps. The Models collection (M2e) supplies streamFn (upstream's `streamFn: models.streamSimple`); faux provider from M2e supplies test doubles.

**Spec:** upstream packages/agent/README.md (comprehensive behavioral spec — AgentMessage vs LLM message, event sequences, steering, options) + packages/agent/src/* + oracle tests packages/agent/test/{agent,agent-loop}.test.ts.

**Port style:** upstream is authority; oracle tests are executable spec; harness deferral disclosed.

## Global Constraints

- Edition 2021, no unsafe; gates per task: cargo test / clippy -D warnings / fmt; CI green at push.
- Layering: agent_core consumes ai (Models/Providers) — never the reverse.
- Commit messages: `{feat,fix,docs,chore}: <message>`.

---

### Task 1: agent types

**Files:** Create `src/agent_core/types.rs`.
**Upstream:** types.ts (463 lines — read IN FULL). Port: AgentMessage (User/Assistant/ToolResult + extension point), AgentEvent (all variants), ToolExecutionMode, AgentTool (execute/update/skip/terminate surface), AgentState, AgentOptions (as data), SteeringMode/FollowUpMode.
- [ ] Failing serde/semantics tests → implement → gates → commit `feat(agent-core): agent types`

### Task 2: agent-loop — core turns

**Files:** Create `src/agent_core/agent_loop.rs`.
**Upstream:** agent-loop.ts (857 — read IN FULL) + agent-loop.test.ts. Port: agentLoop generator equivalent (channel-based): prompt list → per-turn context build (convertToLlm) → Models.streamSimple → event mapping → tool-call handling → toolResult messages → done/abort semantics; tool execution modes (parallel preflight sequentialize per upstream default; sequential); beforeToolCall/afterToolCall hooks; terminate hints (all-terminated batch skips follow-up LLM call); maxTurns guard (M1 carried).
- [ ] Failing faux-driven loop tests (upstream agent-loop.test.ts core) → implement → gates → commit `feat(agent-core): agent loop core turns`

### Task 3: agent-loop — steering, follow-up, abort

**Files:** Modify `src/agent_core/agent_loop.rs`.
**Upstream:** agent-loop.ts steering/follow-up/abort sections. Port: steering queue (inject after current turn's tools finish), follow-up queue (checked when no tool calls + no steering), one-at-a-time/all modes, shouldStopAfterTurn hook, abort (stopReason aborted settle), continue-from-context entry.
- [ ] Failing tests → implement → gates → commit `feat(agent-core): steering, follow-up, abort`

### Task 4: Agent class

**Files:** Create `src/agent_core/agent.rs`.
**Upstream:** agent.ts (607 — read IN FULL) + agent.test.ts. Port: Agent struct wrapping the loop: subscribe (awaited listeners in registration order), prompt()/continue(), waitForIdle, state accessors, agent_start/agent_end lifecycle, message_end barrier before tool preflight (upstream contract), isStreaming.
- [ ] Failing tests → implement → gates → commit `feat(agent-core): agent class`

### Task 5: integration swap

**Files:** Modify `src/agent/` (delete M1 mini-loop, re-export agent_core), `src/agent_core/` (faux alignment: M2e real faux becomes the test double), `src/cli` if touched, `src/main.rs`.
**Oracle:** the M1-era agent tests migrate onto the full port (loop/class tests replace mini-loop tests; unique intents preserved); the CLI keeps working (direct-provider flow unchanged from M2e-T7 decision).
- [ ] Swap; migrate tests; full gates; push; CI green; commit `feat(agent-core): crate on full agent core (M3a complete)`

---

## Self-Review Notes

- proxy.ts (406, browser/backend stream proxy) deferred to M5 (coding-agent consumes it) — disclosed scope cut.
- index.ts is barrel exports — no separate task.
- Harness (~31k lines) = M3b, own recon + plan after M3a.
- Test trajectory: 1357 → ~1450+ by T5.
