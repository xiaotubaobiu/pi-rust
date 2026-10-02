// Byte-oracle capture for the durable slice (upstream 2bbfcca43,
// @earendil-works/pi-durable 0.99.1): stages the UNMODIFIED upstream
// `packages/durable/src` and `packages/chord/src` TypeScript into a temp
// directory (hashing every file for the provenance manifest), rewrites the
// workspace package specifiers (`@earendil-works/chord[/delta|/context]`) to
// relative file URLs in the STAGED copies only, and executes the scenarios
// under Node's --experimental-strip-types.
//
// Determinism contract shared with the Rust port (src/durable):
//   - No wall-clock input: the storage/session surface stamps no timestamps;
//     record identity comes from the Session-global ID allocator
//     (nextId starts at 2; the root conversation reserves ID 1).
//   - No randomness, no network. The FileSystem capability is a thin
//     deterministic shim over node:fs implementing `env/index.ts`.
//
// Scenarios (mirrored one-to-one by
// `src/durable/session/tests.rs`):
//   1. `commit_bytes` — one Session commit staging the reserved root
//      conversation, a `pi.user` entry carrying a user message, a queued
//      input submission settled `unanswered`, and a pending task. Captures
//      the exact main.jsonl / task-4.jsonl line bytes and the round-tripped
//      entry record.
//   2. `document_bytes` — conversation-scoped document create (base), change
//      (delta), retirement (sidecar reclaimed). Captures doc-2.jsonl bytes
//      before retirement and the retirement marker line, plus snapshots.
//   3. `read_after_write` — the exact `ReadAfterWrite` message text.
//
// Output: durable_oracle.json (scenario records) + durable_oracle.manifest.json
// (staged-file SHA-256 provenance).
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const upstreamRoot = fileURLToPath(new URL("../../../../pi/", import.meta.url));
const durableSrc = path.join(upstreamRoot, "packages", "durable", "src");
const chordSrc = path.join(upstreamRoot, "packages", "chord", "src");

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "durable-oracle-"));
const durableOut = path.join(staging, "durable");
const chordOut = path.join(staging, "chord");
const aiUtilsOut = path.join(staging, "ai", "utils");
fs.mkdirSync(durableOut, { recursive: true });
fs.mkdirSync(chordOut, { recursive: true });

const manifest = { staged: [], substitutions: {} };

function stageDir(srcRoot, outRoot) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  walk(srcRoot);
  for (const file of files) {
    const rel = path.relative(srcRoot, file).replaceAll("\\", "/");
    const text = fs.readFileSync(file, "utf8");
    let stagedText = text;
    // Workspace package specifiers -> relative file URLs (staged copies only;
    // the manifest hashes the ORIGINAL text).
    stagedText = stagedText.replaceAll(
      '"@earendil-works/chord/delta"',
      JSON.stringify(pathToFileURL(path.join(chordOut, "delta", "index.ts")).href),
    );
    stagedText = stagedText.replaceAll(
      '"@earendil-works/chord/context"',
      JSON.stringify(pathToFileURL(path.join(chordOut, "context", "index.ts")).href),
    );
    stagedText = stagedText.replaceAll(
      /"@earendil-works\/chord"/g,
      JSON.stringify(pathToFileURL(path.join(chordOut, "index.ts")).href),
    );
    stagedText = stagedText.replaceAll(
      '"@earendil-works/pi-ai/utils/transcript"',
      JSON.stringify(pathToFileURL(path.join(aiUtilsOut, "transcript.ts")).href),
    );
    // Harness slice staging shims (disclosed): `harness/live.ts` re-exports
    // `convertPartial` from `generation.ts`, which pulls the whole pi-ai
    // model/stream surface. The port defers `settleSchedulerOutcome` with
    // the scheduler slice, so the staged copy drops that one function (and
    // its import) while every other export stays byte-identical.
    if (rel === "harness/live.ts") {
      stagedText = stagedText.replace(/import \{ convertPartial \} from "\.\/generation\.ts";\r?\n/, "");
      stagedText = stagedText.replace(/\/\*\*\r?\n \* Harness cleanup for a terminal outcome[\s\S]*$/, "");
      manifest.substitutions[rel] = "settleSchedulerOutcome deferred (scheduler slice): import + function removed";
    }
    if (stagedText !== text) {
      manifest.substitutions[rel] = "workspace specifier rewritten to staged file URL";
    }
    const out = path.join(outRoot, rel.replaceAll("/", path.sep));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, stagedText);
    manifest.staged.push({
      file: rel,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    });
  }
}

stageDir(chordSrc, chordOut);
stageDir(durableSrc, durableOut);
manifest.staged.sort((a, b) => (a.file < b.file ? -1 : 1));

// Stage the two pi-ai util files the harness prompt module uses at runtime
// (`utils/transcript.ts` -> `utils/text.ts`; everything else is type-only
// and erased by --experimental-strip-types). Hashed for provenance like the
// durable/chord staging.
const aiSrc = path.join(upstreamRoot, "packages", "ai", "src", "utils");
fs.mkdirSync(aiUtilsOut, { recursive: true });
for (const name of ["transcript.ts", "text.ts"]) {
  const text = fs.readFileSync(path.join(aiSrc, name), "utf8");
  fs.writeFileSync(path.join(aiUtilsOut, name), text);
  manifest.staged.push({
    file: `packages/ai/src/utils/${name}`,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  });
}
manifest.staged.sort((a, b) => (a.file < b.file ? -1 : 1));

const durableUrl = (rel) => pathToFileURL(path.join(durableOut, rel)).href;

// ─── Deterministic FileSystem shim (env/index.ts contract) ──────────────────
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function toFileInfo(p, name) {
  const stat = fs.statSync(p);
  return {
    name,
    path: p,
    kind: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

const fileSystemShim = {
  cwd: process.cwd(),
  async absolutePath(p) {
    return { ok: true, value: path.resolve(p) };
  },
  async joinPath(parts) {
    return { ok: true, value: path.join(...parts) };
  },
  async readTextFile(p) {
    try {
      return { ok: true, value: fs.readFileSync(p, "utf8") };
    } catch (error) {
      return fileFailure(p, error);
    }
  },
  async openTextLineReader() {
    return { ok: false, error: { code: "not_supported", message: "not needed by the oracle" } };
  },
  async readTextLines() {
    return { ok: false, error: { code: "not_supported", message: "not needed by the oracle" } };
  },
  async readBinaryFile(p) {
    try {
      return { ok: true, value: new Uint8Array(fs.readFileSync(p)) };
    } catch (error) {
      return fileFailure(p, error);
    }
  },
  async writeFile(p, content) {
    try {
      fs.writeFileSync(p, content);
      return { ok: true, value: undefined };
    } catch (error) {
      return fileFailure(p, error);
    }
  },
  async appendFile(p, content) {
    try {
      fs.appendFileSync(p, content);
      return { ok: true, value: undefined };
    } catch (error) {
      return fileFailure(p, error);
    }
  },
  async truncateFile(p, size) {
    try {
      fs.truncateSync(p, size);
      return { ok: true, value: undefined };
    } catch (error) {
      return fileFailure(p, error);
    }
  },
  async flushFile(p) {
    try {
      const handle = fs.openSync(p, "r+");
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      return { ok: true, value: undefined };
    } catch (error) {
      return fileFailure(p, error);
    }
  },
  async renameFile(a, b) {
    try {
      fs.renameSync(a, b);
      return { ok: true, value: undefined };
    } catch (error) {
      return fileFailure(a, error);
    }
  },
  async fileInfo(p) {
    try {
      return { ok: true, value: toFileInfo(p, path.basename(p)) };
    } catch (error) {
      return fileFailure(p, error);
    }
  },
  async listDir(p) {
    try {
      const items = fs
        .readdirSync(p, { withFileTypes: true })
        .map((entry) => toFileInfo(path.join(p, entry.name), entry.name));
      return { ok: true, value: items };
    } catch (error) {
      return fileFailure(p, error);
    }
  },
  async canonicalPath(p) {
    try {
      return { ok: true, value: fs.realpathSync(p) };
    } catch (error) {
      return fileFailure(p, error);
    }
  },
  async exists(p) {
    try {
      return { ok: true, value: fs.existsSync(p) };
    } catch {
      return { ok: true, value: false };
    }
  },
  async createDir(p, options) {
    try {
      fs.mkdirSync(p, { recursive: options?.recursive ?? false });
      return { ok: true, value: undefined };
    } catch (error) {
      return fileFailure(p, error);
    }
  },
  async remove(p, options) {
    try {
      fs.rmSync(p, { recursive: options?.recursive ?? false, force: options?.force ?? false });
      return { ok: true, value: undefined };
    } catch (error) {
      return fileFailure(p, error);
    }
  },
  async createTempDir(prefix) {
    return { ok: true, value: fs.mkdtempSync(path.join(os.tmpdir(), prefix ?? "durable-")) };
  },
  async createTempFile(options) {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "durable-file-")),
      (options?.prefix ?? "tmp") + (options?.suffix ?? ""),
    );
    fs.writeFileSync(file, "");
    return { ok: true, value: file };
  },
  async cleanup() {},
};

function fileFailure(p, error) {
  const code =
    error.code === "ENOENT"
      ? "not_found"
      : error.code === "EACCES" || error.code === "EPERM"
        ? "permission_denied"
        : error.code === "ENOTDIR"
          ? "not_directory"
          : error.code === "EISDIR"
            ? "is_directory"
            : "unknown";
  return { ok: false, error: { code, message: `${code}: ${path.basename(String(p))}`, path: String(p) } };
}

// ─── Scenario 1: commit bytes ───────────────────────────────────────────────
const { JsonlStorage } = await import(durableUrl("storage/jsonl/storage.ts"));
const { createSession } = await import(durableUrl("session/session.ts"));
const { ROOT_CONVERSATION_ID } = await import(durableUrl("types.ts"));
const { BACKGROUND_CONTEXT } = await import(durableUrl("../chord/context/index.ts").replace("durable/../chord", "chord"));
const { UserEntry } = await import(durableUrl("entries.ts"));

const BACKGROUND = (await import(pathToFileURL(path.join(chordOut, "context", "index.ts")).href)).BACKGROUND_CONTEXT; // plain background context; no signals

const scenario1Dir = path.join(staging, "scenario1");
fs.mkdirSync(scenario1Dir, { recursive: true });
const storage1 = await JsonlStorage.open(scenario1Dir, fileSystemShim, BACKGROUND, {});
const session1 = createSession(storage1);

const probeTask = {
  definition: {
    name: "probe",
    version: 1,
    initial: () => ({ phase: "idle" }),
    phases: {},
    abort: async () => {},
  },
};

const committed = await session1.commitWith(async (tx) => {
  const record = await tx.createRootConversation();
  const entry = await tx.appendEntry(record.id, {
    kind: UserEntry.kind,
    model: [{ role: "user", content: "hi", timestamp: 1758240000000 }],
  });
  const submission = await tx.createSubmission({
    conversationId: record.id,
    type: "input",
    status: "queued",
  });
  const taskId = await tx.createTask(probeTask, { n: 1 }, { ownership: { kind: "conversation" }, conversationId: record.id });
  tx.settleSubmission(submission.id, { status: "unanswered", reason: "withdrawn" });
  return { record, entry, submission, taskId };
}, BACKGROUND);

const mainText = fs.readFileSync(path.join(scenario1Dir, "main.jsonl"), "utf8");
const sidecarName = `task-${committed.taskId}.jsonl`;
const sidecarText = fs.readFileSync(path.join(scenario1Dir, sidecarName), "utf8");
const entryRead = await storage1.entry(committed.entry.id, BACKGROUND);

const commit_bytes = {
  rootConversationId: ROOT_CONVERSATION_ID,
  ids: {
    conversation: committed.record.id,
    entry: committed.entry.id,
    submission: committed.submission.id,
    task: committed.taskId,
  },
  mainLines: mainText.split("\n").slice(0, -1),
  sidecarFile: sidecarName,
  sidecarLines: sidecarText.split("\n").slice(0, -1),
  entryRecord: entryRead.entry,
  entryCommitSeq: entryRead.commitSeq,
};
session1.close && (await session1.close(BACKGROUND));

// ─── Scenario 2: document create/change/retire bytes ────────────────────────
const scenario2Dir = path.join(staging, "scenario2");
fs.mkdirSync(scenario2Dir, { recursive: true });
const storage2 = await JsonlStorage.open(scenario2Dir, fileSystemShim, BACKGROUND, {});
const session2 = createSession(storage2);

const counterDoc = {
  definition: {
    kind: "counter",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ count: 0 }),
  },
};

await session2.commitWith(async (tx) => {
  await tx.createRootConversation();
}, BACKGROUND);

await session2.commitWith(async (tx) => {
  const draft = await tx.doc(counterDoc, 1, BACKGROUND);
  draft.count = 2;
}, BACKGROUND);

const snapshotAfterCreate = await session2.snapshot(counterDoc, 1, BACKGROUND);
const docTextAfterCreate = fs.readFileSync(path.join(scenario2Dir, "doc-2.jsonl"), "utf8");

await session2.commitWith(async (tx) => {
  const draft = await tx.doc(counterDoc, 1, BACKGROUND);
  draft.count = 5;
}, BACKGROUND);

const snapshotAfterChange = await session2.snapshot(counterDoc, 1, BACKGROUND);
const docTextAfterChange = fs.readFileSync(path.join(scenario2Dir, "doc-2.jsonl"), "utf8");

await session2.commitWith(async (tx) => {
  await tx.retireDoc(counterDoc, 1, BACKGROUND);
}, BACKGROUND);

const snapshotAfterRetire = await session2.snapshot(counterDoc, 1, BACKGROUND);
const main2Text = fs.readFileSync(path.join(scenario2Dir, "main.jsonl"), "utf8");
const sidecarExistsAfterRetire = fs.existsSync(path.join(scenario2Dir, "doc-2.jsonl"));

const document_bytes = {
  snapshotAfterCreate,
  docLinesAfterCreate: docTextAfterCreate.split("\n").slice(0, -1),
  snapshotAfterChange,
  docLinesAfterChange: docTextAfterChange.split("\n").slice(0, -1),
  snapshotAfterRetire,
  sidecarExistsAfterRetire,
  mainLines: main2Text.split("\n").slice(0, -1),
};

// ─── Scenario 3: read-after-write message ───────────────────────────────────
let raw_error = null;
try {
  await session2.commitWith(async (tx) => {
    await tx.createRootConversation();
    await tx.conversation(1);
  }, BACKGROUND);
} catch (error) {
  raw_error = { name: error.name, message: error.message };
}
const read_after_write = { error: raw_error };

// ─── Scenario 4: harness built-in documents (config / usage / inbox) ────────
const { ConversationConfig } = await import(durableUrl("harness/config.ts"));
const { UsageDoc, addUsage } = await import(durableUrl("harness/usage.ts"));
const { InboxDoc, prepareBoundary, applyBoundary } = await import(durableUrl("harness/inbox.ts"));
const { LiveDoc } = await import(durableUrl("harness/live.ts"));

const configInitial = ConversationConfig.definition.initial();
const configDocSurface = {
  kind: ConversationConfig.definition.kind,
  version: ConversationConfig.definition.version,
  scope: ConversationConfig.definition.scope,
  history: ConversationConfig.definition.history,
  fork: ConversationConfig.definition.fork,
};
const usageInitial = UsageDoc.definition.initial();
const liveInitial = LiveDoc.definition.initial();
const liveCheckpointRunning = { generation: undefined, tools: [{ callId: "a", name: "bash", status: "running" }] };
const liveCheckpointIdle = { generation: undefined, tools: [{ callId: "a", name: "bash", status: "done" }] };

const usageTotal = structuredClone(usageInitial.models);
// First entry for a key takes strict JSON of the usage (`recordUsage`);
// later entries add every counter (`addUsage`).
usageTotal["gpt-x/gpt-5"] = {
  input: 10, output: 5, cacheRead: 0, cacheWrite: 2, totalTokens: 15,
  cost: { input: 0.5, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.75 },
};
addUsage(usageTotal["gpt-x/gpt-5"], {
  input: 7, output: 3, cacheRead: 1, cacheWrite: 0, cacheWrite1h: 4, reasoning: 2, totalTokens: 10,
  cost: { input: 0.25, output: 0.25, cacheRead: 0.1, cacheWrite: 0, total: 0.6 },
});

const scenario4Dir = path.join(staging, "scenario4");
fs.mkdirSync(scenario4Dir, { recursive: true });
const storage4 = await JsonlStorage.open(scenario4Dir, fileSystemShim, BACKGROUND, {});
const session4 = createSession(storage4);

await session4.commitWith(async (tx) => {
  await tx.createRootConversation();
}, BACKGROUND);

const boundary4 = await session4.commitWith(async (tx) => {
  // A boundary reads tables, so it is prepared before the commit's first
  // table write (`inbox.ts` note); the conversation exists from the prior
  // commit.
  const boundary = await prepareBoundary(tx, 1, BACKGROUND);
  // Durable submissions first (like `submissions.ts`), then their inbox
  // items: a passive write, a steer, and a follow-up.
  const writeSubmission = await tx.createSubmission({ conversationId: 1, type: "write", status: "queued" });
  const steerSubmission = await tx.createSubmission({ conversationId: 1, type: "input", status: "queued" });
  const followUpSubmission = await tx.createSubmission({ conversationId: 1, type: "input", status: "queued" });
  boundary.inbox.items.push(
    { id: writeSubmission.id, mode: "write", entry: { kind: "note", data: { text: "w" } } },
    { id: steerSubmission.id, mode: "steer", content: "s" },
    { id: followUpSubmission.id, mode: "followUp", content: "f" },
  );
  const result = await applyBoundary(tx, boundary, "final", 1758240001000, BACKGROUND);
  const usageDraft = await tx.doc(UsageDoc, 1, BACKGROUND);
  Object.assign(usageDraft.models, usageTotal);
  const inboxDraft = await tx.doc(InboxDoc, 1, BACKGROUND);
  const configDraft = await tx.doc(ConversationConfig, 1, BACKGROUND);
  configDraft.activeTools = ["bash", "read"];
  configDraft.steeringMode = "all";
  return {
    result,
    submissionIds: [writeSubmission.id, steerSubmission.id, followUpSubmission.id],
    inboxItems: JSON.parse(JSON.stringify(inboxDraft.items)),
    usageDoc: JSON.parse(JSON.stringify(usageDraft)),
    configDoc: JSON.parse(JSON.stringify(configDraft)),
  };
}, BACKGROUND);

const submissionReads = [];
for (const id of boundary4.submissionIds) {
  submissionReads.push(await storage4.submission(id, BACKGROUND));
}

const harness_docs = {
  configInitial,
  configDocSurface,
  usageInitial,
  liveInitial,
  liveCheckpointIdleIsBase: LiveDoc.definition.checkpointWhen(liveCheckpointIdle),
  liveCheckpointRunningIsNotBase: LiveDoc.definition.checkpointWhen(liveCheckpointRunning),
  usageTotal,
  boundaryResult: boundary4.result,
  inboxItemsAfter: boundary4.inboxItems,
  usageDocAfter: boundary4.usageDoc,
  configDocAfter: boundary4.configDoc,
  submissions: submissionReads,
};
session4.close && (await session4.close(BACKGROUND));

// ─── Scenario 5: prompt section replay + pi.system planning ─────────────────
const { replaySections, planSystemEntries } = await import(durableUrl("harness/prompt.ts"));

const replayInput = [
  { role: "system", content: "base", sections: { tools: "old", skills: null, extra: "keep" }, timestamp: 1 },
  { role: "system", content: "", sections: { tools: "new" }, timestamp: 2 },
];
const replayed = replaySections(replayInput);
const plannedBaseline = planSystemEntries(
  {
    head: { kind: "pi.system", id: 7, conversationId: 1, head: 7 },
    entries: [{ kind: "pi.system", id: 7, conversationId: 1, head: 7 }],
    messages: [],
  },
  new Map([["tools", "Use tools carefully."], ["safety", "Be safe"]]),
  [{ name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } } } }],
  1758240002000,
);
const plannedPatch = planSystemEntries(
  {
    head: undefined,
    entries: [],
    messages: [
      { role: "system", content: "", sections: { tools: "Use tools carefully.", skills: null }, timestamp: 3 },
    ],
  },
  new Map([["tools", "Use tools carefully v2"]]),
  [],
  1758240003000,
);

const prompt_plan = {
  replayed: Object.fromEntries(replayed),
  replayedOrder: [...replayed.keys()],
  plannedBaseline,
  plannedPatch,
};

// ─── Scenario 6: output bounding / sanitizing / truncation ──────────────────
const { boundOutput, sanitizeOutput } = await import(durableUrl("harness/output.ts"));
const { truncateHead, utf8ByteLength, formatSize } = await import(durableUrl("truncate.ts"));

const longText = "one\ntwo\nthree\nfour\nfive\n";
const output_bound = {
  headLines: boundOutput(longText, { maxBytes: 1024, maxLines: 2, retain: "head" }),
  tailLines: boundOutput(longText, { maxBytes: 1024, maxLines: 2, retain: "tail" }),
  headBytesCut: boundOutput(longText, { maxBytes: 8, maxLines: 100, retain: "head" }),
  tailBytesCut: boundOutput(longText, { maxBytes: 8, maxLines: 100, retain: "tail" }),
  unicodeCut: boundOutput("é\n한\n", { maxBytes: 3, maxLines: 10, retain: "head" }),
  sanitized: sanitizeOutput("a\u0000b\u0007c\td\ne\uFFFAf"),
  truncateHead: truncateHead("a\nb\nc\nd\n", { maxLines: 2, maxBytes: 100 }),
  truncateHeadBytes: truncateHead("abc\ndef\nghi", { maxLines: 100, maxBytes: 7 }),
  utf8ByteLength: utf8ByteLength("héllo"),
  formatSize: [formatSize(512), formatSize(2048), formatSize(3 * 1024 * 1024)],
};

// ─── Emit ───────────────────────────────────────────────────────────────────
const oracle = { commit_bytes, document_bytes, read_after_write, harness_docs, prompt_plan, output_bound };
const outDir = fileURLToPath(new URL(".", import.meta.url));
fs.writeFileSync(path.join(outDir, "durable_oracle.json"), JSON.stringify(oracle, null, 2) + "\n");
fs.writeFileSync(
  path.join(outDir, "durable_oracle.manifest.json"),
  JSON.stringify({ ...manifest, stagedCount: manifest.staged.length }, null, 2) + "\n",
);
console.log("durable oracle captured:", Object.keys(oracle).join(", "));
console.log("staged files:", manifest.staged.length);
