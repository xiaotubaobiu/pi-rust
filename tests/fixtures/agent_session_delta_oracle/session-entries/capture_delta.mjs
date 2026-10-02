// Agent-session delta oracle: the NEW session-manager entry kinds and the
// session projection, captured from the verbatim upstream HEAD
// (`pi@2bbfcca43`, v0.99.1) sources copied under ./src:
//
//   src/core/session-manager.ts  sha256
//   450d82c529933214e088b8422f00061815e617f352f6c834689787a314064bff
//
// Executed under node --experimental-strip-types with the session_manager
// oracle's deterministic seams (loader.mjs routes `crypto` to the shared
// counter stub; the `@earendil-works/pi-ai` facade stubs `uuidv7`).
//
// Scenarios (pinned byte-exactly after the scrub contract below):
// - usage_entry_json        appendUsage lines: without note, with note,
//                           empty note (absent key)
// - context_edit_json       appendContextEdit lines: string replacement on
//                           user/assistant/toolResult (assistant and
//                           toolResult normalize to a text block), null
//                           replacement, array replacement on a custom
//                           message, and every error message
// - projection_grid         buildSessionProjection over edits: string and
//                           array replacements, omission, custom-message
//                           content replacement, system passthrough,
//                           older-compaction skip, thinking/model settings
// - compaction_self_kept    appendCompaction(summary, null, ...) stores the
//                           entry's own id as firstKeptEntryId
//
// Scrub contract (mirrored by the Rust replay in
// src/coding_agent/session_manager_tests.rs):
// - ISO-Z strings under "timestamp" become "1970-01-01T00:00:00.000Z"
// - scenario root path occurrences become "<root>"
// - canonical mode key-sorts every object (serde_json BTreeMap order)
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetIdCounters } from "./id_state.mjs";

const mod = await import(new URL("./src/core/session-manager.ts", import.meta.url).href);
const { SessionManager } = mod;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function makeScrub(root) {
  const walk = (key, value) => {
    if (typeof value === "string") {
      let v = value.split(root).join("<root>");
      if ((key === "timestamp" || key === "labelTimestamp") && ISO_RE.test(v)) {
        v = "1970-01-01T00:00:00.000Z";
      }
      if (v.length > 128) v = v.slice(0, 32) + `<len=${value.length}>`;
      return v;
    }
    if (typeof value === "number") {
      if (key === "timestamp" || key === "created") return 0;
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(key, item));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(k, v);
      return out;
    }
    return value;
  };
  const sorted = (input) => {
    if (Array.isArray(input)) return input.map(sorted);
    if (input && typeof input === "object") {
      const out = {};
      for (const key of Object.keys(input).sort()) out[key] = sorted(input[key]);
      return out;
    }
    return input;
  };
  return {
    walk,
    canon: (value) => JSON.stringify(sorted(walk("<no-key>", value))),
    // Wire order: scrubbed but NOT key-sorted (pins the append literal's key
    // order).
    raw: (value) => JSON.stringify(walk("<no-key>", value)),
  };
}

const out = {};

function assistantText(text, ts = 0) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: ts,
  };
}

function usage(input, output, costTotal) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: costTotal / 2, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
}

// ---- usage_entry_json ------------------------------------------------------

{
  resetIdCounters();
  const root = mkdtempSync(join(tmpdir(), "pi-delta-usage-"));
  const scrub = makeScrub(root);
  const manager = SessionManager.inMemory(root, undefined, undefined);
  manager.appendUsage("cache_warm", "anthropic", "claude-test", usage(10, 5, 0.5));
  manager.appendUsage("cache_warm", "anthropic", "claude-test", usage(1, 2, 0.25), "warm note");
  manager.appendUsage("cache_warm", "anthropic", "claude-test", usage(1, 1, 0.1), "");
  out.usage_entry_json = manager
    .getEntries()
    .map((entry) => scrub.canon(entry));
  out.usage_entry_raw = manager
    .getEntries()
    .map((entry) => scrub.raw(entry));
}

// ---- context_edit_json -----------------------------------------------------

{
  resetIdCounters();
  const root = mkdtempSync(join(tmpdir(), "pi-delta-edit-"));
  const scrub = makeScrub(root);
  const manager = SessionManager.inMemory(root, undefined, undefined);
  const user = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const assistant = manager.appendMessage(assistantText("answer"));
  const toolResult = manager.appendMessage({
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [{ type: "text", text: "out" }],
    isError: false,
    timestamp: 1,
  });
  const customMessage = manager.appendCustomMessageEntry("note", "custom body", false, undefined);
  manager.appendModelChange("anthropic", "claude-test");

  const lines = [];
  // String replacement: user keeps the string; assistant/toolResult
  // normalize to a single text block.
  lines.push(manager.getEntry(manager.appendContextEdit(user, { content: "edited user" })));
  lines.push(manager.getEntry(manager.appendContextEdit(assistant, { content: "edited assistant" })));
  lines.push(manager.getEntry(manager.appendContextEdit(toolResult, { content: "edited tool" })));
  // Null replacement omits the target.
  lines.push(manager.getEntry(manager.appendContextEdit(toolResult, null)));
  // Array replacement on a custom message passes through verbatim.
  lines.push(
    manager.getEntry(
      manager.appendContextEdit(customMessage, {
        content: [{ type: "text", text: "custom replacement" }],
      }),
    ),
  );
  out.context_edit_json = lines.map((entry) => scrub.canon(entry));

  const errors = {};
  try {
    manager.appendContextEdit("missing-id", { content: "x" });
  } catch (error) {
    errors.not_found = error.message;
  }
  try {
    // Move the leaf to the first user message: the assistant message, the
    // tool result, and everything after them leave the active branch (but
    // stay indexed, so the branch check is what fires).
    manager.branch(user);
    manager.appendContextEdit(toolResult, { content: "x" });
  } catch (error) {
    errors.off_branch = error.message;
  }
  try {
    const thinking = manager.appendThinkingLevelChange("high");
    manager.appendContextEdit(thinking, { content: "x" });
  } catch (error) {
    errors.not_editable = error.message;
  }
  try {
    manager.appendContextEdit(user, { content: 42 });
  } catch (error) {
    errors.bad_content = error.message;
  }
  out.context_edit_errors = errors;
}

// ---- projection_grid -------------------------------------------------------

{
  resetIdCounters();
  const root = mkdtempSync(join(tmpdir(), "pi-delta-proj-"));
  const scrub = makeScrub(root);
  const manager = SessionManager.inMemory(root, undefined, undefined);
  manager.appendMessage({ role: "user", content: "u1", timestamp: 1 });
  manager.appendMessage(assistantText("a1"));
  const toolResult = manager.appendMessage({
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [{ type: "text", text: "out" }],
    isError: false,
    timestamp: 1,
  });
  const customMessage = manager.appendCustomMessageEntry("note", "custom body", false, undefined);
  manager.appendMessage({ role: "user", content: "u2", timestamp: 2 });
  manager.appendThinkingLevelChange("high");

  const entries = manager.getEntries();
  const byCustomType = (type) => entries.find((entry) => entry.customType === type).id;
  const userId = entries.find((entry) => entry.type === "message" && entry.message.role === "user").id;

  manager.appendContextEdit(userId, { content: "u1 edited" });
  manager.appendContextEdit(toolResult, {
    content: [
      { type: "text", text: "replacement one" },
      { type: "image", data: "Zm9v", mimeType: "image/png" },
    ],
  });
  manager.appendContextEdit(customMessage, { content: "custom edited" });
  const omitted = manager.appendMessage({ role: "user", content: "u3 omitted", timestamp: 3 });
  manager.appendContextEdit(omitted, null);

  const projection = manager.buildSessionProjection();
  out.projection_grid = {
    thinkingLevel: projection.thinkingLevel,
    model: projection.model,
    entries: projection.entries.map((entry) => ({
      type: entry.sourceEntry.type,
      id: entry.sourceEntry.id,
      messages: entry.messages,
    })),
    messages: projection.messages,
  };
  out.projection_canon = scrub.canon(out.projection_grid);
  const context = manager.buildSessionContext();
  out.context_matches_projection =
    JSON.stringify(context.messages) === JSON.stringify(projection.messages) &&
    context.thinkingLevel === projection.thinkingLevel;
}

// ---- compaction_self_kept --------------------------------------------------

{
  resetIdCounters();
  const root = mkdtempSync(join(tmpdir(), "pi-delta-compaction-"));
  const scrub = makeScrub(root);
  const manager = SessionManager.inMemory(root, undefined, undefined);
  manager.appendMessage({ role: "user", content: "u1", timestamp: 1 });
  const id = manager.appendCompaction("summary so far", null, 1000, undefined, false, usage(3, 4, 0.2));
  const entry = manager.getEntry(id);
  out.compaction_self_kept = {
    firstKeptEntryIdEqualsId: entry.firstKeptEntryId === entry.id,
    canon: scrub.canon(entry),
  };
}

import { writeFileSync } from "fs";
writeFileSync(new URL("./agent_session_delta_oracle.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("delta oracle written:", Object.keys(out).join(","));
