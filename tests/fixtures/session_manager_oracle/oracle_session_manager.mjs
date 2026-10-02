// Oracle capture for the W3.10 session-manager slice: upstream
// coding-agent/src/core/session-manager.ts (sha256
// 450d82c529933214e088b8422f00061815e617f352f6c834689787a314064bff, vendored
// verbatim in ./src/core/) executed under node --experimental-strip-types.
//
// Determinism scaffolding:
// - `crypto.randomUUID` (session-manager's generateId) is intercepted by
//   loader.mjs and replaced with the shared counter stub in id_state.mjs
//   ("00000001", "00000002", ...).
// - the `@earendil-works/pi-ai` facade stubs `uuidv7` (session ids) with
//   "@u1", "@u2", ... while `getCurrentSystemMessage` stays the REAL upstream
//   implementation.
// - every scenario block calls resetIdCounters() so the Rust test (which
//   drives the same seams per test function) reproduces the exact sequence.
//
// Scrub contract (mirrored by the Rust side in
// src/coding_agent/session_manager_tests.rs — order-independent):
// - scenario root path occurrences become "<root>"
// - `<date>T<hh>-<mm>-<ss>-<mmm>Z_` filename stamps become "<stamp>_"
// - string values under "timestamp" shaped as ISO-Z become
//   "1970-01-01T00:00:00.000Z"; numeric values under "timestamp" become 0;
//   numeric values under "created" become 0 ("modified" is fixture-pinned)
// - strings longer than 128 chars become their first 32 chars plus "<len=N>"
// - canonical mode additionally key-sorts every object so serde_json's
//   BTreeMap ordering compares byte-for-byte.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { resetIdCounters } from "./id_state.mjs";

const mod = await import(new URL("./src/core/session-manager.ts", import.meta.url));
const {
  SessionManager,
  assertValidSessionId,
  buildContextEntries,
  buildSessionContext,
  findMostRecentSession,
  getDefaultSessionDir,
  getLatestCompactionEntry,
  loadEntriesFromFile,
  migrateSessionEntries,
  parseSessionEntries,
  sessionEntryToContextMessages,
} = mod;

// ---- scrub contract -------------------------------------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
const STAMP_EMBEDDED_RE = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/g;

function makeScrub(root) {
  const walk = (key, value) => {
    if (typeof value === "string") {
      let v = value.split(root).join("<root>");
      v = v.split(process.cwd()).join("<cwd>");
      v = v.replace(STAMP_EMBEDDED_RE, "<stamp>_");
      if ((key === "timestamp" || key === "labelTimestamp") && ISO_RE.test(v)) v = "1970-01-01T00:00:00.000Z";
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
    rawText: (text) =>
      text
        .split("\n")
        .map((line) => {
          if (!line.trim()) return line;
          try {
            return JSON.stringify(walk("<no-key>", JSON.parse(line)));
          } catch {
            // Malformed fragments carry no wall stamps.
            return line.split(root).join("<root>").split(process.cwd()).join("<cwd>");
          }
        })
        .join("\n"),
  };
}

const out = {};
const FILE_BYTES = {};
const CANON_CAPS = {};
const ERROR_CAPS = {};

// ---- fixture builders (test/session-manager/build-context.test.ts) --------

function msg(id, parentId, role, text) {
  const base = { type: "message", id, parentId, timestamp: "2025-01-01T00:00:00Z" };
  if (role === "user") {
    return { ...base, message: { role, content: text, timestamp: 1 } };
  }
  return {
    ...base,
    message: {
      role,
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
      timestamp: 1,
    },
  };
}

function compaction(id, parentId, summary, firstKeptEntryId, extra = {}) {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: "2025-01-01T00:00:00Z",
    summary,
    firstKeptEntryId,
    tokensBefore: 1000,
    ...extra,
  };
}

function branchSummary(id, parentId, summary, fromId, extra = {}) {
  return { type: "branch_summary", id, parentId, timestamp: "2025-01-01T00:00:00Z", summary, fromId, ...extra };
}

function custom(id, parentId, customType, data) {
  return { type: "custom", id, parentId, timestamp: "2025-01-01T00:00:00Z", customType, data };
}

function thinkingLevel(id, parentId, level) {
  return { type: "thinking_level_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", thinkingLevel: level };
}

function modelChange(id, parentId, provider, modelId) {
  return { type: "model_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", provider, modelId };
}

function customMessage(id, parentId, customType, content, display, details) {
  const entry = {
    type: "custom_message",
    id,
    parentId,
    timestamp: "2025-01-01T00:00:00Z",
    customType,
    content,
    display,
  };
  if (details !== undefined) entry.details = details;
  return entry;
}

function labelEntry(id, parentId, targetId, label) {
  const entry = { type: "label", id, parentId, timestamp: "2025-01-01T00:00:00Z", targetId };
  if (label !== undefined) entry.label = label;
  return entry;
}

function sessionInfo(id, parentId, name) {
  const entry = { type: "session_info", id, parentId, timestamp: "2025-01-01T00:00:00Z" };
  if (name !== undefined) entry.name = name;
  return entry;
}

const SYSTEM_MESSAGE = { role: "system", content: "system prompt", timestamp: 123 };

// ---- buildSessionContext / buildContextEntries grid ------------------------

const CONTEXT_CASES = [
  ["empty", [], undefined],
  ["single-user", [msg("m1", null, "user", "hello")], undefined],
  [
    "simple-conversation",
    [
      msg("m1", null, "user", "hello"),
      msg("m2", "m1", "assistant", "hi there"),
      msg("m3", "m2", "user", "how are you"),
      msg("m4", "m3", "assistant", "great"),
    ],
    undefined,
  ],
  [
    "thinking-level",
    [msg("m1", null, "user", "hello"), thinkingLevel("t1", "m1", "high"), msg("m2", "t1", "assistant", "thinking hard")],
    undefined,
  ],
  ["model-from-assistant", [msg("m1", null, "user", "hello"), msg("m2", "m1", "assistant", "hi")], undefined],
  [
    "model-change-overwritten",
    [msg("m1", null, "user", "hello"), modelChange("mc1", "m1", "openai", "gpt-4"), msg("m2", "mc1", "assistant", "hi")],
    undefined,
  ],
  [
    "compaction-includes-summary",
    [
      msg("m1", null, "user", "first"),
      msg("m2", "m1", "assistant", "response1"),
      msg("m3", "m2", "user", "second"),
      msg("m4", "m3", "assistant", "response2"),
      compaction("c1", "m4", "Summary of first two turns", "m3"),
      msg("m5", "c1", "user", "third"),
      msg("m6", "m5", "assistant", "response3"),
    ],
    undefined,
  ],
  [
    "compaction-keeps-from-first",
    [
      msg("m1", null, "user", "first"),
      msg("m2", "m1", "assistant", "response"),
      compaction("c1", "m2", "Empty summary", "m1"),
      msg("m3", "c1", "user", "second"),
    ],
    undefined,
  ],
  [
    "multiple-compactions-latest",
    [
      msg("m1", null, "user", "a"),
      msg("m2", "m1", "assistant", "b"),
      compaction("c1", "m2", "First summary", "m1"),
      msg("m3", "c1", "user", "c"),
      msg("m4", "m3", "assistant", "d"),
      compaction("c2", "m4", "Second summary", "m4"),
      msg("m5", "c2", "user", "e"),
    ],
    undefined,
  ],
  [
    "context-entries-with-custom",
    [
      msg("m1", null, "user", "first"),
      custom("cu1", "m1", "old-state", { hidden: true }),
      msg("m2", "cu1", "assistant", "response1"),
      custom("cu2", "m2", "kept-card", { title: "Kept" }),
      msg("m3", "cu2", "user", "second"),
      compaction("c1", "m3", "Summary", "cu2"),
      custom("cu3", "c1", "after-card", { title: "After" }),
      msg("m4", "cu3", "assistant", "response2"),
    ],
    undefined,
  ],
  [
    "settings-from-full-path",
    [
      msg("m1", null, "user", "first"),
      thinkingLevel("t1", "m1", "high"),
      msg("m2", "t1", "assistant", "response1"),
      msg("m3", "m2", "user", "second"),
      compaction("c1", "m3", "Summary", "m3"),
    ],
    undefined,
  ],
  [
    "branch-a",
    [msg("m1", null, "user", "start"), msg("m2", "m1", "assistant", "response"), msg("m3", "m2", "user", "branch A"), msg("m4", "m2", "user", "branch B")],
    "m3",
  ],
  [
    "branch-b",
    [msg("m1", null, "user", "start"), msg("m2", "m1", "assistant", "response"), msg("m3", "m2", "user", "branch A"), msg("m4", "m2", "user", "branch B")],
    "m4",
  ],
  [
    "branch-summary-in-path",
    [
      msg("m1", null, "user", "start"),
      msg("m2", "m1", "assistant", "response"),
      msg("m3", "m2", "user", "abandoned path"),
      branchSummary("b1", "m2", "Summary of abandoned work", "m3"),
      msg("m4", "b1", "user", "new direction"),
    ],
    "m4",
  ],
  [
    "complex-tree",
    [
      msg("m1", null, "user", "start"),
      msg("m2", "m1", "assistant", "r1"),
      msg("m3", "m2", "user", "q2"),
      msg("m4", "m3", "assistant", "r2"),
      compaction("c1", "m4", "Compacted history", "m3"),
      msg("m5", "c1", "user", "q3"),
      msg("m6", "m5", "assistant", "r3"),
      msg("m7", "m3", "user", "wrong path"),
      msg("m8", "m7", "assistant", "wrong response"),
      branchSummary("b1", "m3", "Tried wrong approach", "m8"),
      msg("m9", "b1", "user", "better approach"),
    ],
    "m6",
  ],
  [
    "complex-tree-branch-leaf",
    [
      msg("m1", null, "user", "start"),
      msg("m2", "m1", "assistant", "r1"),
      msg("m3", "m2", "user", "q2"),
      msg("m4", "m3", "assistant", "r2"),
      compaction("c1", "m4", "Compacted history", "m3"),
      msg("m5", "c1", "user", "q3"),
      msg("m6", "m5", "assistant", "r3"),
      msg("m7", "m3", "user", "wrong path"),
      msg("m8", "m7", "assistant", "wrong response"),
      branchSummary("b1", "m3", "Tried wrong approach", "m8"),
      msg("m9", "b1", "user", "better approach"),
    ],
    "m9",
  ],
  ["leaf-not-found", [msg("m1", null, "user", "hello"), msg("m2", "m1", "assistant", "hi")], "nonexistent"],
  ["orphaned-entries", [msg("m1", null, "user", "hello"), msg("m2", "missing", "assistant", "orphan")], "m2"],
  ["leaf-null", [msg("m1", null, "user", "hello"), msg("m2", "m1", "assistant", "hi")], null],
  [
    "compaction-with-system-message",
    [
      msg("m1", null, "user", "first"),
      msg("m2", "m1", "assistant", "response"),
      compaction("c1", "m2", "Summary with system", "m1", { systemMessage: SYSTEM_MESSAGE }),
      msg("m3", "c1", "user", "second"),
    ],
    undefined,
  ],
  [
    "custom-message-entries-in-context",
    [
      msg("m1", null, "user", "first"),
      customMessage("cm1", "m1", "note", "plain note", true, { meta: 1 }),
      customMessage("cm2", "cm1", "blocks", [{ type: "text", text: "block note" }], false),
      msg("m2", "cm2", "assistant", "reply"),
    ],
    undefined,
  ],
];

{
  const st = makeScrub("<root>");
  out.buildContext = CONTEXT_CASES.map(([name, entries, leafId]) => {
    const ctx = buildSessionContext(entries, leafId);
    const ctxEntries = buildContextEntries(entries, leafId);
    return {
      name,
      leafId,
      ids: ctxEntries.map((entry) => entry.id),
      thinkingLevel: ctx.thinkingLevel,
      model: ctx.model,
      roles: ctx.messages.map((m) => m.role),
      canon: st.canon(ctx.messages),
    };
  });
}

// ---- sessionEntryToContextMessages battery ---------------------------------

const ENTRY_BATTERY = {
  "user-message": msg("m1", null, "user", "hello"),
  "assistant-message": msg("m2", null, "assistant", "hi"),
  "thinking-level": thinkingLevel("t1", null, "high"),
  "model-change": modelChange("mc1", null, "openai", "gpt-4"),
  "custom-entry": custom("cu1", null, "state", { a: 1 }),
  "custom-message-text": customMessage("cm1", null, "note", "plain", true, { meta: 1 }),
  "custom-message-blocks": customMessage("cm2", null, "blocks", [{ type: "text", text: "b" }], false),
  "branch-summary": branchSummary("b1", null, "summary text", "m1"),
  "branch-summary-empty": branchSummary("b2", null, "", "m1"),
  "compaction": compaction("c1", null, "summary", "m1"),
  "compaction-with-system": compaction("c2", null, "summary", "m1", { systemMessage: SYSTEM_MESSAGE }),
  "session-info": sessionInfo("si1", null, "name"),
  "label": labelEntry("l1", null, "m1", "checkpoint"),
  "label-clear": labelEntry("l2", null, "m1"),
  // hand-edited null-content guards
  "system-null-content": { type: "message", id: "n1", parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "system", content: null, timestamp: 5 } },
  "user-null-content": { type: "message", id: "n2", parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "user", content: null, timestamp: 6 } },
  "assistant-null-content": { type: "message", id: "n3", parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "assistant", content: null, api: "anthropic-messages", provider: "anthropic", model: "claude-test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 7 } },
  "toolresult-null-content": { type: "message", id: "n4", parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "nested-model", content: null, isError: false, timestamp: 8 } },
  "custom-message-null-content": customMessage("cm3", null, "note", null, true),
};

{
  const st = makeScrub("<root>");
  out.entryToContext = Object.entries(ENTRY_BATTERY).map(([name, entry]) => ({
    name,
    canon: st.canon(sessionEntryToContextMessages(entry)),
  }));
}

// ---- getLatestCompactionEntry / parseSessionEntries ------------------------

{
  const st = makeScrub("<root>");
  out.latestCompaction = [
    { name: "none", input: [msg("m1", null, "user", "hi")] },
    { name: "last", input: [msg("m1", null, "user", "hi"), compaction("c1", "m1", "s", "m1")] },
    { name: "middle", input: [compaction("c1", null, "s", "m1"), msg("m2", "c1", "user", "hi")] },
  ].map(({ name, input }) => ({ name, canon: st.canon(getLatestCompactionEntry(input)) }));

  const PARSE_INPUTS = {
    "mixed": '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\nnot json\n\n{"type":"message","id":"m1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n{"type":"unknown-kind","payload":true}',
    "empty": "",
    "blank-lines": "\n  \n\t\n",
  };
  out.parseEntries = Object.entries(PARSE_INPUTS).map(([name, content]) => ({
    name,
    canon: st.canon(parseSessionEntries(content)),
  }));
}

// ---- migrateSessionEntries -------------------------------------------------

{
  const st = makeScrub("<root>");
  const MIGRATE_CASES = {
    "v1": [
      { type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
      { type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
      { type: "compaction", timestamp: "2025-01-01T00:00:02Z", summary: "s", firstKeptEntryIndex: 1, tokensBefore: 10 },
    ],
    "v2": [
      { type: "session", id: "sess-2", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
      { type: "message", id: "hookmsgid", parentId: null, timestamp: "2025-01-01T00:00:01Z", message: { role: "hookMessage", content: "from a hook", timestamp: 1 } },
      { type: "message", id: "usermsgid", parentId: "hookmsgid", timestamp: "2025-01-01T00:00:02Z", message: { role: "user", content: "hi", timestamp: 2 } },
    ],
    "current": [
      { type: "session", id: "sess-3", version: 3, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
      { type: "message", id: "usermsgid", parentId: null, timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
    ],
  };
  out.migrate = Object.entries(MIGRATE_CASES).map(([name, entries]) => {
    const copy = JSON.parse(JSON.stringify(entries));
    migrateSessionEntries(copy);
    return { name, canon: st.canon(copy) };
  });
}

// ---- loadEntriesFromFile + newline repair ----------------------------------

resetIdCounters();
{
  const root = mkdtempSync(join(tmpdir(), "pi-sm-oracle-load-"));
  const st = makeScrub(root);
  const caps = {};

  caps["nonexistent-count"] = loadEntriesFromFile(join(root, "nonexistent.jsonl")).length;

  const emptyFile = join(root, "empty.jsonl");
  writeFileSync(emptyFile, "");
  caps["empty-count"] = loadEntriesFromFile(emptyFile).length;
  FILE_BYTES["empty"] = readFileSync(emptyFile, "utf8");

  const noHeader = join(root, "no-header.jsonl");
  writeFileSync(noHeader, '{"type":"message","id":"m1"}\n');
  caps["no-header-count"] = loadEntriesFromFile(noHeader).length;
  FILE_BYTES["no-header"] = readFileSync(noHeader, "utf8");

  const malformed = join(root, "malformed.jsonl");
  writeFileSync(malformed, "not json\n");
  caps["malformed-count"] = loadEntriesFromFile(malformed).length;
  FILE_BYTES["malformed"] = readFileSync(malformed, "utf8");

  const valid = join(root, "valid.jsonl");
  writeFileSync(
    valid,
    '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
      '{"type":"message","id":"m1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
  );
  const validEntries = loadEntriesFromFile(valid);
  caps["valid"] = { count: validEntries.length, types: validEntries.map((e) => e.type) };

  const mixed = join(root, "mixed.jsonl");
  writeFileSync(
    mixed,
    '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
      "not valid json\n" +
      '{"type":"message","id":"m1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
  );
  caps["mixed-count"] = loadEntriesFromFile(mixed).length;

  const unterminated =
    '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
    '{"type":"message","id":"m1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}';
  const untermFile = join(root, "unterminated.jsonl");
  writeFileSync(untermFile, unterminated);
  caps["unterminated-count"] = loadEntriesFromFile(untermFile).length;
  FILE_BYTES["unterminated-input"] = st.rawText(unterminated);
  FILE_BYTES["unterminated-bytes"] = st.rawText(readFileSync(untermFile, "utf8"));

  const malformedTail =
    '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' + '{"type":"message"';
  const tailFile = join(root, "malformed-tail.jsonl");
  writeFileSync(tailFile, malformedTail);
  caps["malformed-tail-count"] = loadEntriesFromFile(tailFile).length;
  FILE_BYTES["malformed-tail-input"] = st.rawText(malformedTail);
  FILE_BYTES["malformed-tail-bytes"] = st.rawText(readFileSync(tailFile, "utf8"));

  const invalidUnterm = join(root, "invalid.jsonl");
  writeFileSync(invalidUnterm, '{"type":"message","id":"m1"}');
  const invalidContent = readFileSync(invalidUnterm, "utf8");
  caps["invalid-unterminated-count"] = loadEntriesFromFile(invalidUnterm).length;
  caps["invalid-unterminated-unchanged"] = readFileSync(invalidUnterm, "utf8") === invalidContent;

  // cwd discovery through open()
  const storedCwd = join(root, "stored-project");
  const headerFile = join(root, "header.jsonl");
  const writeHeader = (prefix, sessionId) =>
    writeFileSync(
      headerFile,
      `${prefix}${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2025-01-01T00:00:00Z", cwd: storedCwd })}\n`,
    );
  writeHeader("\n  \n", "leading-blank");
  const opened = SessionManager.open(headerFile, root);
  caps["leading-blank"] = { id: opened.getSessionId(), cwd: opened.getCwd() };

  writeHeader("not json\n{broken json\n", "leading-malformed");
  const opened2 = SessionManager.open(headerFile, root);
  caps["leading-malformed"] = { id: opened2.getSessionId(), cwd: opened2.getCwd() };

  writeHeader("", "a".repeat(8192));
  const opened3 = SessionManager.open(headerFile, root);
  caps["multi-buffer-header"] = { id: opened3.getSessionId(), cwd: opened3.getCwd() };

  CANON_CAPS["load-entries"] = st.canon(caps);
  rmSync(root, { recursive: true, force: true });
}

// ---- scan-limit handling ----------------------------------------------------

{
  const root = mkdtempSync(join(tmpdir(), "pi-sm-oracle-scan-"));
  const st = makeScrub(root);
  const LIMIT = 1024 * 1024;
  const storedCwd = join(root, "stored-project");
  const overrideCwd = join(root, "override-project");
  const caps = {};
  const writeBig = (name, id, prefix) => {
    const file = join(root, `${name}.jsonl`);
    writeFileSync(
      file,
      `${prefix}${JSON.stringify({ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00Z", cwd: storedCwd })}\n`,
    );
    return file;
  };
  for (const { name, id, prefix } of [
    { name: "large-header", id: "a".repeat(LIMIT + 1), prefix: "" },
    { name: "large-prefix", id: "large-prefix", prefix: `${"x".repeat(LIMIT + 1)}\n` },
  ]) {
    const file = writeBig(name, id, prefix);
    caps[name] = {};
    for (const [tag, override] of [["default", undefined], ["override", overrideCwd]]) {
      const sm = SessionManager.open(file, root, override);
      caps[name][tag] = { id: sm.getSessionId(), cwd: sm.getCwd() };
    }
  }
  CANON_CAPS["scan-limit"] = st.canon(caps);
  rmSync(root, { recursive: true, force: true });
}

// ---- findMostRecentSession (pinned mtimes) ----------------------------------

{
  const root = mkdtempSync(join(tmpdir(), "pi-sm-oracle-recent-"));
  const st = makeScrub(root);
  const T1 = 1_700_000_000_000;
  const T2 = 1_700_000_050_000;
  const pin = (file, t) => utimesSync(file, new Date(t), new Date(t));
  const caps = {};

  mkdirSync(join(root, "empty-dir"));
  caps["empty-dir"] = findMostRecentSession(join(root, "empty-dir"));
  caps["nonexistent"] = findMostRecentSession(join(root, "nonexistent"));

  writeFileSync(join(root, "file.txt"), "hello");
  writeFileSync(join(root, "file.json"), "{}");
  caps["non-jsonl"] = findMostRecentSession(root);

  writeFileSync(join(root, "invalid.jsonl"), '{"type":"message"}\n');
  caps["invalid-header"] = findMostRecentSession(root);

  const single = join(root, "session.jsonl");
  writeFileSync(single, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
  caps["single"] = findMostRecentSession(root);

  const older = join(root, "older.jsonl");
  const newer = join(root, "newer.jsonl");
  writeFileSync(older, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
  writeFileSync(newer, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
  pin(older, T1);
  pin(newer, T2);
  caps["most-recent"] = findMostRecentSession(root);

  const invalid2 = join(root, "invalid2.jsonl");
  const valid2 = join(root, "valid2.jsonl");
  writeFileSync(invalid2, '{"type":"not-session"}\n');
  writeFileSync(valid2, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
  pin(invalid2, T1);
  pin(valid2, T2);
  caps["skips-invalid"] = findMostRecentSession(root);

  const oversized = join(root, "oversized.jsonl");
  const valid3 = join(root, "valid3.jsonl");
  writeFileSync(oversized, "x".repeat(1024 * 1024 + 1));
  writeFileSync(valid3, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
  pin(oversized, T2);
  pin(valid3, T1);
  caps["skips-oversized"] = findMostRecentSession(root);

  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  const fileA = join(root, "a.jsonl");
  const fileB = join(root, "b.jsonl");
  writeFileSync(
    fileA,
    `${JSON.stringify({ type: "session", id: "a", timestamp: "2025-01-01T00:00:00Z", cwd: projectA })}\n`,
  );
  writeFileSync(
    fileB,
    `${JSON.stringify({ type: "session", id: "b", timestamp: "2025-01-01T00:00:00Z", cwd: projectB })}\n`,
  );
  pin(fileA, T1);
  pin(fileB, T2);
  caps["cwd-a"] = findMostRecentSession(root, projectA);
  caps["cwd-b"] = findMostRecentSession(root, projectB);
  caps["cwd-none"] = findMostRecentSession(root);

  CANON_CAPS["most-recent"] = st.canon(caps);
  rmSync(root, { recursive: true, force: true });
}

// ---- default session dir ----------------------------------------------------

{
  const agentDir = join(tmpdir(), "pi-sm-oracle-agent-home");
  rmSync(join(agentDir, "sessions"), { recursive: true, force: true });
  const created = getDefaultSessionDir("C:\\oracle-fixed-cwd", agentDir);
  out.defaultDir = {
    path: created.split(tmpdir()).join("<tmp>"),
    exists: existsSync(created),
    nested: created.split(join(agentDir, "sessions")).length === 2,
  };
  rmSync(agentDir, { recursive: true, force: true });
}

// ---- SessionManager file-writing grid ----------------------------------------

resetIdCounters();
{
  const root = mkdtempSync(join(tmpdir(), "pi-sm-oracle-mgr-"));
  const st = makeScrub(root);
  const userText = (text, ts = 0) => ({ role: "user", content: text, timestamp: ts });
  const assistantText = (text, ts = 0) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: ts,
  });
  const caps = {};

  // deferred flush: file appears only with the first assistant message
  const flushDir = join(root, "flush");
  mkdirSync(flushDir);
  const s1 = SessionManager.create(join(root, "proj"), flushDir);
  s1.appendMessage(userText("first question"));
  s1.appendMessage(assistantText("first answer"));
  s1.appendMessage(userText("second question"));
  s1.appendMessage(assistantText("second answer"));
  const flushFile = s1.getSessionFile();
  caps["flush-file-base"] = basename(flushFile).replace(STAMP_RE, "<stamp>_");
  FILE_BYTES["flush"] = st.rawText(readFileSync(flushFile, "utf8"));

  // append after flush appends a single line
  s1.appendThinkingLevelChange("high");
  FILE_BYTES["append-after-flush"] = st.rawText(readFileSync(flushFile, "utf8"));

  // createBranchedSession without assistant: deferred, then single header
  const s2 = SessionManager.create(join(root, "proj"), flushDir);
  const firstId = s2.appendMessage(userText("first question"));
  s2.appendMessage(assistantText("first answer"));
  s2.appendMessage(userText("second question"));
  s2.appendMessage(assistantText("second answer"));
  const branchFile = s2.createBranchedSession(firstId);
  caps["branch-no-assistant-exists"] = existsSync(branchFile);
  s2.appendCustomEntry("preset-state", { name: "plan" });
  s2.appendMessage(assistantText("new answer"));
  const branchLines = readFileSync(branchFile, "utf8").trim().split("\n");
  caps["branch-no-assistant-headers"] = branchLines.filter((l) => JSON.parse(l).type === "session").length;
  caps["branch-no-assistant-unique-ids"] = (() => {
    const ids = branchLines.map((l) => JSON.parse(l)).filter((r) => r.type !== "session").map((r) => r.id);
    return new Set(ids).size === ids.length;
  })();
  FILE_BYTES["branch-no-assistant"] = st.rawText(readFileSync(branchFile, "utf8"));

  // createBranchedSession with assistant: immediate write
  const s3 = SessionManager.create(join(root, "proj"), flushDir);
  s3.appendMessage(userText("first question"));
  const a2 = s3.appendMessage(assistantText("first answer"));
  s3.appendMessage(userText("second question"));
  s3.appendMessage(assistantText("second answer"));
  const branchFile2 = s3.createBranchedSession(a2);
  caps["branch-assistant-exists"] = existsSync(branchFile2);
  FILE_BYTES["branch-assistant"] = st.rawText(readFileSync(branchFile2, "utf8"));

  // labels preserved through createBranchedSession (persisted)
  const s4 = SessionManager.create(join(root, "proj"), flushDir);
  const m1 = s4.appendMessage(userText("hello"));
  const m2 = s4.appendMessage(assistantText("hi"));
  s4.appendLabelChange(m1, "important");
  s4.appendLabelChange(m2, "also-important");
  s4.appendMessage(userText("followup"));
  const m3Entry = s4.getEntries().at(-1);
  const branchFile3 = s4.createBranchedSession(m2);
  FILE_BYTES["labels-branch"] = st.rawText(readFileSync(branchFile3, "utf8"));
  caps["labels-branch-labels"] = [
    { id: m1, label: s4.getLabel(m1) },
    { id: m2, label: s4.getLabel(m2) },
    { id: m3Entry.id, label: s4.getLabel(m3Entry.id) },
  ];
  caps["labels-tree"] = s4.getTree();

  // label rewiring through a removed label entry
  const s5 = SessionManager.create(join(root, "proj"), flushDir);
  const r1 = s5.appendMessage(userText("hello"));
  s5.appendLabelChange(r1, "checkpoint");
  const modelChangeId = s5.appendModelChange("anthropic", "claude-test");
  const r2 = s5.appendMessage(userText("followup"));
  s5.appendMessage(assistantText("done"));
  const branchFile5 = s5.createBranchedSession(r2);
  caps["label-rewire-parent"] = s5.getEntry(modelChangeId)?.parentId;
  // the branched path (user, label, model change, user) has no assistant, so
  // the write is deferred to the first appended assistant message
  caps["label-rewire-deferred"] = existsSync(branchFile5);
  s5.appendMessage(assistantText("post-fork"));
  FILE_BYTES["label-rewire"] = st.rawText(readFileSync(branchFile5, "utf8"));

  // compaction firstKeptEntryId remap when kept entry sits behind a label
  const s6 = SessionManager.create(join(root, "proj"), flushDir);
  const c1 = s6.appendMessage(userText("one"));
  s6.appendMessage(assistantText("two"));
  s6.appendLabelChange(c1, "kept-mark");
  const kept = s6.getEntries().find((e) => e.type === "label").targetId;
  const compactionId = s6.appendCompaction("summary", kept, 100);
  s6.appendMessage(userText("three"));
  s6.appendMessage(assistantText("four"));
  const branchFile6 = s6.createBranchedSession(compactionId);
  const parsed6 = readFileSync(branchFile6, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  caps["compaction-remap-kept"] = parsed6.find((e) => e.type === "compaction").firstKeptEntryId === kept;
  FILE_BYTES["compaction-remap"] = st.rawText(readFileSync(branchFile6, "utf8"));

  // in-memory branch semantics
  const s7 = SessionManager.inMemory();
  const i1 = s7.appendMessage(userText("1"));
  const i2 = s7.appendMessage(assistantText("2"));
  s7.appendMessage(userText("3"));
  s7.branch(i2);
  const i4 = s7.appendMessage(userText("4"));
  const result7 = s7.createBranchedSession(i2);
  caps["in-memory-branch-result"] = result7 === undefined;
  caps["in-memory-branch-entries"] = s7.getEntries().map((e) => e.id);
  caps["in-memory-branch-ids"] = [i1, i2, i4];

  // forkFrom
  const sourcePath = join(root, "source.jsonl");
  writeFileSync(
    sourcePath,
    `${[
      JSON.stringify({ type: "session", version: 3, id: "source-session-id", timestamp: "2025-01-01T00:00:00Z", cwd: root }),
      JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "carried over", timestamp: 1 } }),
    ].join("\n")}\n`,
  );
  const forked = SessionManager.forkFrom(sourcePath, join(root, "target-cwd"), join(root, "forks"), { id: "forked-session-id" });
  caps["fork-header-id"] = forked.getHeader().id;
  caps["fork-parent"] = forked.getHeader().parentSession;
  FILE_BYTES["fork"] = st.rawText(readFileSync(forked.getSessionFile(), "utf8"));
  caps["fork-cwd"] = forked.getCwd();

  // setSessionFile corruption handling
  const corruptDir = join(root, "corrupt");
  mkdirSync(corruptDir);
  const emptyFile = join(corruptDir, "empty.jsonl");
  writeFileSync(emptyFile, "");
  const smEmpty = SessionManager.open(emptyFile, corruptDir);
  FILE_BYTES["corrupt-empty-rewritten"] = st.rawText(readFileSync(emptyFile, "utf8"));
  caps["corrupt-empty-reopen-same-id"] = SessionManager.open(emptyFile, corruptDir).getSessionId() === smEmpty.getSessionId();
  caps["corrupt-empty-file-preserved"] = smEmpty.getSessionFile() === emptyFile;

  const noHeaderFile = join(corruptDir, "no-header.jsonl");
  const originalContent =
    '{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n';
  writeFileSync(noHeaderFile, originalContent);
  try {
    SessionManager.open(noHeaderFile, corruptDir);
    ERROR_CAPS["open-no-header"] = null;
  } catch (error) {
    ERROR_CAPS["open-no-header"] = st.canon(error.message);
  }
  caps["corrupt-no-header-unchanged"] = readFileSync(noHeaderFile, "utf8") === originalContent;

  const nonSessionFile = join(corruptDir, "not-a-session.log");
  const logContent = '{"type":"event","data":"not a session"}\n';
  writeFileSync(nonSessionFile, logContent);
  try {
    SessionManager.open(nonSessionFile, corruptDir);
    ERROR_CAPS["open-not-session"] = null;
  } catch (error) {
    ERROR_CAPS["open-not-session"] = st.canon(error.message);
  }
  caps["corrupt-log-unchanged"] = readFileSync(nonSessionFile, "utf8") === logContent;

  // persisted session listing (SessionManager.list / listAll / findById / continueRecent)
  const flatDir = join(root, "flat");
  mkdirSync(flatDir);
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  mkdirSync(projectA);
  mkdirSync(projectB);
  const mkPersisted = (cwd, label, t) => {
    const session = SessionManager.create(cwd, flatDir);
    session.appendMessage({ role: "user", content: label, timestamp: 1000 });
    session.appendMessage({ ...assistantText(`reply to ${label}`), timestamp: t });
    return session.getSessionFile();
  };
  const sessionA = mkPersisted(projectA, "from A", 1_700_000_000_000);
  const sessionB = mkPersisted(projectB, "from B", 1_700_000_050_000);
  utimesSync(sessionA, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  utimesSync(sessionB, new Date(1_700_000_050_000), new Date(1_700_000_050_000));

  const listA = await SessionManager.list(projectA, flatDir);
  const listAllFlat = await SessionManager.listAll(flatDir);
  caps["list-a"] = listA.map((s) => ({ ...s, created: s.created.getTime(), modified: s.modified.getTime() }));
  caps["list-all"] = listAllFlat.map((s) => ({ ...s, created: s.created.getTime(), modified: s.modified.getTime() }));
  caps["continue-recent"] = SessionManager.continueRecent(projectA, flatDir).getSessionFile();

  const listProgress = [];
  await SessionManager.list(projectA, flatDir, (loaded, total) => listProgress.push([loaded, total]));
  caps["list-progress"] = listProgress;

  const idOf = (file) => JSON.parse(readFileSync(file, "utf8").split("\n")[0]).id;
  caps["find-by-id"] = {
    a: SessionManager.findById(projectA, idOf(sessionA), flatDir),
    foreign: SessionManager.findById(projectA, idOf(sessionB), flatDir),
    b: SessionManager.findById(projectB, idOf(sessionB), flatDir),
  };

  // usage round-trip through a file-backed reload
  const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } };
  const s8 = SessionManager.create(join(root, "proj"), flushDir);
  const rootId = s8.appendMessage(userText("question"));
  s8.appendMessage(assistantText("answer"));
  s8.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "nested-model", content: [{ type: "text", text: "result" }], isError: false, usage, timestamp: 1234 });
  s8.appendCompaction("summary", rootId, 100, undefined, false, usage);
  s8.branchWithSummary(rootId, "branch summary", undefined, false, usage);
  const reopened = SessionManager.open(s8.getSessionFile(), flushDir);
  caps["usage-roundtrip"] = reopened.getEntries();

  for (const [k, v] of Object.entries(caps)) CANON_CAPS[`manager.${k}`] = st.canon(v);
  rmSync(root, { recursive: true, force: true });
}

// ---- in-memory behavior grid --------------------------------------------------

resetIdCounters();
{
  const root = mkdtempSync(join(tmpdir(), "pi-sm-oracle-mem-"));
  const st = makeScrub(root);
  const userText = (text, ts = 1) => ({ role: "user", content: text, timestamp: ts });
  const assistantText = (text, ts = 1) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: ts,
  });
  const caps = {};

  // append + tree traversal
  const s1 = SessionManager.inMemory();
  const id1 = s1.appendMessage(userText("first"));
  const id2 = s1.appendMessage(assistantText("second"));
  const id3 = s1.appendMessage(userText("third"));
  caps["append-entries"] = s1.getEntries();
  caps["append-parents"] = [s1.getEntry(id1).parentId, s1.getEntry(id2).parentId, s1.getEntry(id3).parentId];
  caps["leaf-advances"] = [s1.getLeafId() === id3, s1.getLeafEntry().id === id3];

  const s2 = SessionManager.inMemory();
  const t1 = s2.appendMessage(userText("hello"));
  const th1 = s2.appendThinkingLevelChange("high");
  s2.appendMessage(assistantText("response"));
  caps["thinking-parents"] = [s2.getEntries().find((e) => e.type === "thinking_level_change").parentId, s2.getEntries()[2].parentId];

  const s3 = SessionManager.inMemory();
  s3.appendMessage(userText("hello"));
  const mo1 = s3.appendModelChange("openai", "gpt-4");
  s3.appendMessage(assistantText("response"));
  const modelEntry = s3.getEntries().find((e) => e.type === "model_change");
  caps["model-parents"] = [modelEntry.parentId, modelEntry.provider, modelEntry.modelId, s3.getEntries()[2].parentId];

  const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } };
  const s4 = SessionManager.inMemory();
  const c1 = s4.appendMessage(userText("1"));
  const c2 = s4.appendMessage(assistantText("2"));
  const compId = s4.appendCompaction("summary", c1, 1000, undefined, false, usage);
  s4.appendMessage(userText("3"));
  const compactionEntry = s4.getEntries().find((e) => e.type === "compaction");
  caps["compaction-parents"] = [compactionEntry.parentId, compactionEntry.summary, compactionEntry.firstKeptEntryId, compactionEntry.tokensBefore, compactionEntry.usage, s4.getEntries()[3].parentId];

  const s5 = SessionManager.inMemory();
  const cu1 = s5.appendMessage(userText("hello"));
  const customId = s5.appendCustomEntry("my_data", { key: "value" });
  s5.appendMessage(assistantText("response"));
  const customEntry = s5.getEntries().find((e) => e.type === "custom");
  caps["custom-parents"] = [customEntry.parentId, customEntry.customType, customEntry.data, s5.getEntries()[2].parentId];

  // getBranch grid
  const s6 = SessionManager.inMemory();
  caps["branch-empty"] = s6.getBranch().length;
  const b1 = s6.appendMessage(userText("hello"));
  caps["branch-single"] = s6.getBranch().map((e) => e.id);
  const b2 = s6.appendMessage(assistantText("2"));
  const b3 = s6.appendThinkingLevelChange("high");
  const b4 = s6.appendMessage(userText("3"));
  caps["branch-full"] = s6.getBranch().map((e) => e.id);
  caps["branch-from-mid"] = s6.getBranch(b2).map((e) => e.id);

  // getTree grid
  const s7 = SessionManager.inMemory();
  caps["tree-empty"] = s7.getTree().length;
  const tr1 = s7.appendMessage(userText("1"));
  const tr2 = s7.appendMessage(assistantText("2"));
  const tr3 = s7.appendMessage(userText("3"));
  const tree7 = s7.getTree();
  caps["tree-linear"] = {
    roots: tree7.length,
    rootId: tree7[0].entry.id,
    childId: tree7[0].children[0].entry.id,
    grandchildId: tree7[0].children[0].children[0].entry.id,
    leafChildren: tree7[0].children[0].children[0].children.length,
  };

  s7.branch(tr2);
  const tr4 = s7.appendMessage(userText("4-branch"));
  const tree7b = s7.getTree();
  caps["tree-branch"] = {
    roots: tree7b.length,
    childCount: tree7b[0].children[0].children.length,
    childIds: tree7b[0].children[0].children.map((c) => c.entry.id).sort(),
  };

  const s8 = SessionManager.inMemory();
  s8.appendMessage(userText("root"));
  const r2 = s8.appendMessage(assistantText("response"));
  s8.branch(r2);
  const ra = s8.appendMessage(userText("branch-A"));
  s8.branch(r2);
  const rb = s8.appendMessage(userText("branch-B"));
  s8.branch(r2);
  const rc = s8.appendMessage(userText("branch-C"));
  const tree8 = s8.getTree();
  caps["tree-multi-branch"] = {
    count: tree8[0].children[0].children.length,
    ids: tree8[0].children[0].children.map((c) => c.entry.id).sort(),
  };

  const s9 = SessionManager.inMemory();
  s9.appendMessage(userText("1"));
  const d2 = s9.appendMessage(assistantText("2"));
  const d3 = s9.appendMessage(userText("3"));
  s9.appendMessage(assistantText("4"));
  s9.branch(d2);
  const d5 = s9.appendMessage(userText("5"));
  s9.appendMessage(assistantText("6"));
  s9.branch(d5);
  s9.appendMessage(userText("7"));
  const tree9 = s9.getTree();
  const node2 = tree9[0].children[0];
  const node5 = node2.children.find((c) => c.entry.id === d5);
  const node3 = node2.children.find((c) => c.entry.id === d3);
  caps["tree-deep"] = { node2Children: node2.children.length, node5Children: node5.children.length, node3Children: node3.children.length };

  // branch / branchWithSummary
  const s10 = SessionManager.inMemory();
  const z1 = s10.appendMessage(userText("1"));
  s10.appendMessage(assistantText("2"));
  s10.appendMessage(userText("3"));
  s10.branch(z1);
  caps["branch-leaf"] = s10.getLeafId() === z1;
  const z4 = s10.appendMessage(userText("branched"));
  caps["branch-child"] = s10.getEntries().find((e) => e.id === z4).parentId === z1;

  const s11 = SessionManager.inMemory();
  const y1 = s11.appendMessage(userText("1"));
  s11.appendMessage(assistantText("2"));
  const y3 = s11.appendMessage(userText("3"));
  const summaryId = s11.branchWithSummary(y1, "Summary of abandoned work", undefined, false, usage);
  const summaryEntry11 = s11.getEntries().find((e) => e.type === "branch_summary");
  caps["branch-summary"] = {
    leaf: s11.getLeafId() === summaryId,
    parentId: summaryEntry11.parentId,
    fromId: summaryEntry11.fromId,
    usage: summaryEntry11.usage,
  };

  // labels
  const s12 = SessionManager.inMemory();
  const lm = s12.appendMessage(userText("hello"));
  caps["label-initial"] = s12.getLabel(lm) === undefined;
  const labelId = s12.appendLabelChange(lm, "checkpoint");
  caps["label-set"] = s12.getLabel(lm);
  const labelEntry12 = s12.getEntries().find((e) => e.id === labelId);
  caps["label-entry"] = { targetId: labelEntry12.targetId, label: labelEntry12.label };
  s12.appendLabelChange(lm, undefined);
  caps["label-cleared"] = s12.getLabel(lm) === undefined;

  const s13 = SessionManager.inMemory();
  const lm13 = s13.appendMessage(userText("hello"));
  s13.appendLabelChange(lm13, "first");
  s13.appendLabelChange(lm13, "second");
  const lastLabelId = s13.appendLabelChange(lm13, "third");
  const lastLabelEntry13 = s13.getEntries().find((e) => e.id === lastLabelId);
  const msgNode13 = s13.getTree().find((n) => n.entry.id === lm13);
  caps["label-last-wins"] = { label: s13.getLabel(lm13), tsMatches: msgNode13.labelTimestamp === lastLabelEntry13.timestamp };

  const s14 = SessionManager.inMemory();
  const lm14a = s14.appendMessage(userText("hello"));
  const lm14b = s14.appendMessage(assistantText("hi", 2));
  const lb14a = s14.appendLabelChange(lm14a, "start");
  const lb14b = s14.appendLabelChange(lm14b, "response");
  const entries14 = s14.getEntries();
  const labA = entries14.find((e) => e.id === lb14a);
  const labB = entries14.find((e) => e.id === lb14b);
  const tree14 = s14.getTree();
  const nodeA = tree14.find((n) => n.entry.id === lm14a);
  const nodeB = nodeA.children.find((n) => n.entry.id === lm14b);
  caps["label-tree"] = {
    labelA: nodeA.label,
    tsA: nodeA.labelTimestamp === labA.timestamp,
    labelB: nodeB.label,
    tsB: nodeB.labelTimestamp === labB.timestamp,
  };

  const s15 = SessionManager.inMemory();
  const lm15a = s15.appendMessage(userText("hello"));
  const lm15b = s15.appendMessage(assistantText("hi", 2));
  const lb15a = s15.appendLabelChange(lm15a, "important");
  const lb15b = s15.appendLabelChange(lm15b, "also-important");
  const entries15 = s15.getEntries();
  const lab15a = entries15.find((e) => e.id === lb15a);
  const lab15b = entries15.find((e) => e.id === lb15b);
  s15.createBranchedSession(lm15b);
  const tree15 = s15.getTree();
  const node15a = tree15.find((n) => n.entry.id === lm15a);
  const node15b = node15a.children.find((n) => n.entry.id === lm15b);
  caps["label-branch-inmemory"] = {
    labelA: s15.getLabel(lm15a),
    labelB: s15.getLabel(lm15b),
    labelEntries: s15.getEntries().filter((e) => e.type === "label").length,
    tsA: node15a.labelTimestamp === lab15a.timestamp,
    tsB: node15b.labelTimestamp === lab15b.timestamp,
  };

  const s16 = SessionManager.inMemory();
  const lx = s16.appendMessage(userText("hello"));
  s16.appendLabelChange(lx, "checkpoint");
  caps["label-not-in-context"] = (() => {
    const ctx = s16.buildSessionContext();
    return { count: ctx.messages.length, role: ctx.messages[0]?.role };
  })();

  // session_info / getSessionName
  const s17 = SessionManager.inMemory();
  caps["session-name-none"] = s17.getSessionName() === undefined;
  s17.appendSessionInfo("  my\nname  ");
  caps["session-name"] = s17.getSessionName();
  s17.appendSessionInfo("   ");
  caps["session-name-cleared"] = s17.getSessionName() === undefined;

  // inMemory preloaded entries
  const buildStored = (build) => {
    const source = SessionManager.inMemory("/project");
    build(source);
    return source.getEntries();
  };
  const entriesA = buildStored((source) => {
    source.appendMessage(userText("hello"));
    source.appendModelChange("anthropic", "claude-opus-4-5");
    source.appendMessage(userText("again"));
  });
  const restoredA = SessionManager.inMemory("/project", undefined, entriesA);
  caps["preload-verbatim"] = st.canon(restoredA.getEntries()) === st.canon(entriesA);

  const entriesB = buildStored((source) => {
    source.appendMessage(userText("hello"));
    source.appendMessage(userText("again"));
  });
  const restoredB = SessionManager.inMemory("/project", undefined, entriesB);
  const appendedB = restoredB.appendMessage(userText("continued"));
  caps["preload-leaf"] = { leaf: restoredB.getLeafId() === appendedB, parent: restoredB.getEntry(appendedB).parentId === entriesB.at(-1).id };

  const entriesC = buildStored((source) => {
    for (let i = 0; i < 50; i++) source.appendMessage(userText(`message ${i}`));
  });
  const restoredC = SessionManager.inMemory("/project", undefined, entriesC);
  const appendedC = restoredC.appendMessage(userText("continued"));
  caps["preload-no-collision"] = entriesC.some((entry) => entry.id === appendedC) === false;

  const entriesD = buildStored((source) => {
    const firstId = source.appendMessage(userText("hello"));
    source.appendMessage(userText("abandoned"));
    source.branch(firstId);
    source.appendMessage(userText("kept"));
  });
  const restoredD = SessionManager.inMemory("/project", undefined, entriesD);
  const rootsD = restoredD.getTree();
  caps["preload-tree"] = { roots: rootsD.length, children: rootsD[0].children.length };

  let labelledId = "";
  const entriesE = buildStored((source) => {
    labelledId = source.appendMessage(userText("hello"));
    source.appendLabelChange(labelledId, "checkpoint");
  });
  const restoredE = SessionManager.inMemory("/project", undefined, entriesE);
  caps["preload-labels"] = restoredE.getLabel(labelledId);

  let keptId = "";
  const entriesF = buildStored((source) => {
    source.appendMessage(userText("dropped"));
    keptId = source.appendMessage(userText("kept"));
    source.appendCompaction("summary so far", keptId, 1000);
  });
  const restoredF = SessionManager.inMemory("/project", undefined, entriesF);
  caps["preload-compaction"] = restoredF.buildContextEntries().some((entry) => entry.id === keptId);

  const entriesG = buildStored((source) => source.appendMessage(userText("hello")));
  const restoredG = SessionManager.inMemory("/project", { id: "restored-session" }, entriesG);
  caps["preload-header-from-options"] = {
    id: restoredG.getSessionId(),
    headerId: restoredG.getHeader().id,
    cwd: restoredG.getHeader().cwd,
  };

  const entriesI = buildStored((source) => source.appendMessage(userText("hello")));
  const restoredI = SessionManager.inMemory("/project", undefined, entriesI);
  restoredI.appendMessage(userText("continued"));
  caps["preload-off-fs"] = { file: restoredI.getSessionFile() === undefined, persisted: restoredI.isPersisted() === false };

  const restoredJ = SessionManager.inMemory("/project", { id: "empty-session" }, []);
  caps["preload-empty"] = { id: restoredJ.getSessionId(), entries: restoredJ.getEntries().length, leaf: restoredJ.getLeafId() === null };

  const body = buildStored((source) => source.appendMessage(userText("hello")));
  const entriesK = [
    { type: "session", version: 3, id: "stored-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/stored" },
    ...body,
  ];
  const restoredK = SessionManager.inMemory("/project", { id: "ignored" }, entriesK);
  caps["preload-header-identity"] = { id: restoredK.getSessionId(), cwd: restoredK.getHeader().cwd };

  const entriesL = [
    { type: "session", version: 2, id: "v2-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/project" },
    { type: "message", id: "hookmsgid", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "hookMessage", content: "from a hook", timestamp: 1 } },
  ];
  const restoredL = SessionManager.inMemory("/project", undefined, entriesL);
  caps["preload-migrated"] = {
    version: restoredL.getHeader().version,
    role: restoredL.getEntries()[0].message.role,
    id: restoredL.getEntries()[0].id,
  };

  const entriesM = [
    { type: "message", id: "hookmsgid", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "hookMessage", content: "from a hook", timestamp: 1 } },
  ];
  const restoredM = SessionManager.inMemory("/project", undefined, entriesM);
  caps["preload-headerless-not-migrated"] = restoredM.getEntries()[0].message.role;

  // custom id grid
  const s20 = SessionManager.inMemory();
  s20.newSession({ id: "my-custom-id" });
  caps["custom-id"] = s20.getSessionId();
  const s21 = SessionManager.inMemory(process.cwd(), { id: "memory-session-id" });
  caps["custom-id-memory"] = { id: s21.getSessionId(), header: s21.getHeader().id, fileUndefined: s21.getSessionFile() === undefined };
  const s22 = SessionManager.inMemory();
  s22.newSession({ id: "abc-123_def.456" });
  caps["custom-id-punctuation"] = s22.getSessionId();
  const invalidIds = ["", "-abc", "abc-", "_abc", "abc_", ".abc", "abc.", "abc/def", "abc\\def", "abc def"];
  caps["custom-id-invalid-count"] = invalidIds.filter((id) => {
    const s = SessionManager.inMemory();
    try {
      s.newSession({ id });
      return false;
    } catch (error) {
      ERROR_CAPS["invalid-session-id"] = error.message;
      return true;
    }
  }).length;
  const s25 = SessionManager.inMemory();
  s25.newSession({ id: "header-test-id" });
  caps["custom-id-header"] = s25.getHeader().id;

  const createdDir = join(root, "created");
  mkdirSync(createdDir);
  const s27 = SessionManager.create(createdDir, createdDir, { id: "created-session-id" });
  caps["created-custom-id"] = {
    id: s27.getSessionId(),
    header: s27.getHeader().id,
    fileBase: basename(s27.getSessionFile()).replace(STAMP_RE, "<stamp>_"),
    exists: existsSync(s27.getSessionFile()),
  };

  for (const [k, v] of Object.entries(caps)) CANON_CAPS[`in-memory.${k}`] = st.canon(v);
  rmSync(root, { recursive: true, force: true });
}

// ---- error messages -----------------------------------------------------------

{
  const root = mkdtempSync(join(tmpdir(), "pi-sm-oracle-err-"));
  const st = makeScrub(root);
  const caps = {};
  try {
    assertValidSessionId("-bad-");
  } catch (error) {
    ERROR_CAPS["assert-session-id"] = error.message;
  }
  try {
    assertValidSessionId("valid-id.123");
    caps["assert-valid"] = true;
  } catch {
    caps["assert-valid"] = false;
  }

  const s = SessionManager.inMemory();
  s.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  try {
    s.branch("nonexistent");
  } catch (error) {
    ERROR_CAPS["branch-not-found"] = error.message;
  }
  try {
    s.branchWithSummary("nonexistent", "summary");
  } catch (error) {
    ERROR_CAPS["branch-summary-not-found"] = error.message;
  }
  try {
    s.appendLabelChange("non-existent", "label");
  } catch (error) {
    ERROR_CAPS["label-not-found"] = error.message;
  }
  try {
    s.createBranchedSession("nonexistent");
  } catch (error) {
    ERROR_CAPS["branched-session-not-found"] = error.message;
  }

  const emptySource = join(root, "empty-source.jsonl");
  writeFileSync(emptySource, "");
  try {
    SessionManager.forkFrom(emptySource, root, root);
  } catch (error) {
    ERROR_CAPS["fork-empty"] = st.canon(error.message);
  }
  const headerlessSource = join(root, "headerless.jsonl");
  writeFileSync(headerlessSource, '{"type":"message","id":"m1","parentId":null,"timestamp":"2025-01-01T00:00:00Z","message":{"role":"user","content":"x","timestamp":1}}\n');
  try {
    SessionManager.forkFrom(headerlessSource, root, root);
  } catch (error) {
    ERROR_CAPS["fork-no-header"] = st.canon(error.message);
  }

  CANON_CAPS["errors-assert"] = st.canon(caps);
  rmSync(root, { recursive: true, force: true });
}

out.canon = CANON_CAPS;
out.fileBytes = FILE_BYTES;
out.errors = ERROR_CAPS;

writeFileSync(new URL("./session_manager.oracle.json", import.meta.url), JSON.stringify(out, null, 1));
console.log("oracle written:", Object.keys(out).join(","));
