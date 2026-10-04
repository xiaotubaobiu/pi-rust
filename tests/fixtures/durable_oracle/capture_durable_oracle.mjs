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
//
// Tools/testing slice scenarios (mirrored one-to-one by
// `src/durable/tools/oracle_tests.rs` and
// `src/durable/testing/oracle_tests.rs`):
//   9.  `tools_decl_and_exec` — the four tool declarations (typebox schema
//       bytes) and execute() shapes over a deterministic exec/file shim.
//   10. `diff_surface` / `image_detect` / `path_utils` — edit-diff, image
//       sniffing, and path-resolution surfaces.
//   11. `testing_conformance` — recorded assertion traces of the storage
//       conformance suite over the in-memory backend.
//   12. `testing_benchmark` — benchmark seeder dataset and read/write tables.
// Assertion traces and execute records are recorded in a canonical form
// (object keys sorted, `undefined` → `null`); the Rust side canonicalizes
// identically, so key-order divergence cannot mask value divergence.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const upstreamRoot = fileURLToPath(new URL("../../../../pi/", import.meta.url));
// The read-only working tree is pinned at the v1.0.2 delta baseline
// (4c6fb7cfe); the v1.0.2-only `harness/provider.ts` is staged from the
// origin/main blob instead (disclosed in the manifest).
const PROVIDER_REF = "origin/main";

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "durable-oracle-"));
const durableOut = path.join(staging, "durable");
const chordOut = path.join(staging, "chord");
const aiUtilsOut = path.join(staging, "ai", "utils");
fs.mkdirSync(aiUtilsOut, { recursive: true });
fs.mkdirSync(durableOut, { recursive: true });
fs.mkdirSync(chordOut, { recursive: true });

const manifest = { staged: [], substitutions: {} };

// Staging source (disclosed): the fixture was captured against upstream
// 2bbfcca43, but the read-only working tree has since moved to the v1.0.2
// delta baseline (4c6fb7cfe) — files the capture needs (e.g.
// `harness/config.ts`) no longer exist there. The baseline sources are
// therefore staged from the PINNED 2bbfcca43 blobs (`git show`), which is
// byte-equivalent modulo CRLF: the committed capture hashed the autocrlf
// working-tree checkouts, blob staging hashes the LF repository bytes.
const BASELINE_REF = "2bbfcca43";

function gitShow(ref, repoPath) {
  return execFileSync("git", ["-C", upstreamRoot, "show", `${ref}:${repoPath}`], {
    maxBuffer: 1 << 26,
    encoding: "utf8",
  });
}

function stageDir(repoPrefix, outRoot, ref = BASELINE_REF) {
  const list = execFileSync(
    "git",
    ["-C", upstreamRoot, "ls-tree", "-r", "--name-only", ref, "--", repoPrefix],
    { maxBuffer: 1 << 26, encoding: "utf8" },
  )
    .split("\n")
    .filter((file) => file.endsWith(".ts"))
    .sort();
  for (const repoPath of list) {
    const rel = repoPath.slice(repoPrefix.length);
    const text = gitShow(ref, repoPath);
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
    stagedText = stagedText.replaceAll(
      '"@earendil-works/pi-ai/utils/retry"',
      JSON.stringify(pathToFileURL(path.join(aiUtilsOut, "retry.ts")).href),
    );
    stagedText = stagedText.replaceAll(
      '"@earendil-works/pi-ai/utils/validation"',
      JSON.stringify(pathToFileURL(path.join(aiUtilsOut, "validation.ts")).href),
    );
    stagedText = stagedText.replaceAll(
      '"@earendil-works/pi-ai/utils/uuid"',
      JSON.stringify(pathToFileURL(path.join(aiUtilsOut, "uuid.ts")).href),
    );
    // Harness slice staging shims (disclosed): the earlier slice staged
    // `harness/live.ts` without `settleSchedulerOutcome` (its `convertPartial`
    // dependency pulled the pi-ai surface before the retry/validation stubs
    // existed). The facade slice restores the staged file byte-identical; the
    // pi-ai utils now stage with the disclosed validation stub.
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

stageDir("packages/chord/src/", chordOut);
stageDir("packages/durable/src/", durableOut);
// v1.0.2-only file: stage the origin/main blob over the baseline tree (the
// workspace specifier is rewritten to the staged `utils/uuid.ts` like every
// other staged file).
{
  const rel = "harness/provider.ts";
  const text = gitShow(PROVIDER_REF, `packages/durable/src/${rel}`);
  const stagedText = text.replaceAll(
    '"@earendil-works/pi-ai/utils/uuid"',
    JSON.stringify(pathToFileURL(path.join(aiUtilsOut, "uuid.ts")).href),
  );
  const out = path.join(durableOut, ...rel.split("/"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, stagedText);
  manifest.staged.push({
    file: `packages/durable/src/${rel}`,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  });
  manifest.substitutions[`packages/durable/src/${rel}`] =
    "working tree pinned at the 4c6fb7cfe delta baseline: staged from the origin/main (200387122) blob via git show; workspace specifier rewritten to staged file URL";
}
manifest.staged.sort((a, b) => (a.file < b.file ? -1 : 1));

// Stage the pi-ai util files the harness modules use at runtime
// (`utils/transcript.ts` and `utils/retry.ts` verbatim; everything else is
// type-only and erased by --experimental-strip-types). `utils/validation.ts`
// needs the `typebox` package, which the staging environment does not ship;
// the staged copy is a disclosed passthrough stub (the byte-oracle scenarios
// only feed schema-valid arguments, so coercion is not exercised). Hashed for
// provenance like the durable/chord staging. Pinned to the same baseline
// blobs; `uuid.ts` — introduced for the v1.0.2 provider identity — comes
// from the origin/main blob its consumer was staged from.
for (const name of ["transcript.ts", "text.ts", "retry.ts"]) {
  const text = gitShow(BASELINE_REF, `packages/ai/src/utils/${name}`);
  fs.writeFileSync(path.join(aiUtilsOut, name), text);
  manifest.staged.push({
    file: `packages/ai/src/utils/${name}`,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  });
}
{
  const text = gitShow(PROVIDER_REF, "packages/ai/src/utils/uuid.ts");
  fs.writeFileSync(path.join(aiUtilsOut, "uuid.ts"), text);
  manifest.staged.push({
    file: "packages/ai/src/utils/uuid.ts (origin/main blob)",
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  });
}
{
  const original = gitShow(BASELINE_REF, "packages/ai/src/utils/validation.ts");
  manifest.staged.push({
    file: "packages/ai/src/utils/validation.ts",
    sha256: createHash("sha256").update(original, "utf8").digest("hex"),
  });
  manifest.substitutions["packages/ai/src/utils/validation.ts"] =
    "typebox unavailable in staging: validateToolArguments replaced with a passthrough stub (coercion not exercised by the scenarios)";
  const stub = `import type { Tool, ToolCall } from "../types.ts";
export function validateToolArguments(tool: Tool, call: ToolCall): ToolCall["arguments"] {
  return call.arguments;
}
`;
  fs.writeFileSync(path.join(aiUtilsOut, "validation.ts"), stub);
}
manifest.staged.sort((a, b) => (a.file < b.file ? -1 : 1));

// Stage the REAL jsdiff 8.0.4 (`tools/edit-diff.ts` imports `Diff.diffLines`
// and `Diff.createTwoFilesPatch` at runtime) from the vendored copy in this
// fixture directory (`vendor/diff`, unmodified `libesm` build + LICENSE,
// provenance-hashed like every other staged file).
{
  const vendorRoot = fileURLToPath(new URL("./vendor/diff", import.meta.url));
  const diffOut = path.join(staging, "node_modules", "diff");
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(vendorRoot, full).replaceAll("\\", "/");
        const text = fs.readFileSync(full);
        const out = path.join(diffOut, rel.replaceAll("/", path.sep));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, text);
        manifest.staged.push({
          file: `vendor/diff/${rel}`,
          sha256: createHash("sha256").update(text).digest("hex"),
        });
      }
    }
  };
  walk(vendorRoot);
  manifest.substitutions["node_modules/diff"] =
    "staged verbatim from the vendored jsdiff 8.0.4 libesm build (vendor/diff, hashed above)";
}

// Stage a minimal `typebox` module so the tools slice's runtime `Type` calls
// resolve (`bash.ts`/`read.ts`/`write.ts`/`edit.ts` import { Type } from
// "typebox"; the package is not installed in the staging environment). The
// stub reproduces typebox 1.3.27's emitted schema JSON byte-for-byte for the
// combinators the tools use (`Type.Object` emits `{type, required?, properties,
// ...options}`, optional properties are marked with a symbol key that
// `JSON.stringify` drops, verified against the real package); the emitted
// declarations are pinned by the `tools_decl` scenario.
{
  const typeboxOut = path.join(staging, "node_modules", "typebox");
  fs.mkdirSync(typeboxOut, { recursive: true });
  const stub =
    `// Staged typebox stub (disclosed): reproduces typebox 1.3.27 emission for\n` +
    `// the Type.{Object,String,Number,Array,Optional} combinators the durable\n` +
    `// tools use; symbol-keyed markers never reach JSON.stringify.\n` +
    `const GlobalObject = globalThis.Object;\n` +
    `const OPTIONAL = Symbol("typebox.optional");\n` +
    `export const Optional = (schema) => ({ ...schema, [OPTIONAL]: "Optional" });\n` +
    `export const String = (options = {}) => ({ type: "string", ...options });\n` +
    `export const Number = (options = {}) => ({ type: "number", ...options });\n` +
    `export const Array = (items, options = {}) => ({ type: "array", items, ...options });\n` +
    `export const Object = (properties, options = {}) => {\n` +
    `  const required = GlobalObject.keys(properties).filter((key) => !(OPTIONAL in properties[key]));\n` +
    `  return { type: "object", ...(required.length > 0 ? { required } : {}), properties, ...options };\n` +
    `};\n` +
    `export const Type = { Object, Array, String, Number, Optional };\n` +
    `export default Type;\n`;
  const lockText = fs.readFileSync(path.join(upstreamRoot, "package-lock.json"), "utf8");
  const lockPin = lockText.match(/"node_modules\/typebox": \{\n\s*"version": "([^"]+)"/);
  manifest.staged.push({
    file: "node_modules/typebox/index.mjs (staged stub; pinned upstream version " +
      (lockPin ? lockPin[1] : "unknown") + ")",
    sha256: createHash("sha256").update(stub, "utf8").digest("hex"),
  });
  manifest.substitutions["node_modules/typebox"] =
    "typebox unavailable in staging: Type.{Object,String,Number,Array,Optional} stub reproducing typebox 1.3.27 emission (schema bytes pinned by the tools_decl scenario)";
  fs.writeFileSync(path.join(typeboxOut, "index.mjs"), stub);
  fs.writeFileSync(
    path.join(typeboxOut, "package.json"),
    JSON.stringify({ name: "typebox", version: "1.3.27", type: "module", main: "./index.mjs", exports: { ".": "./index.mjs" } }, null, 2) + "\n",
  );
}

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
      // env/node.ts `writeFile` creates parent directories; the shim matches.
      fs.mkdirSync(path.dirname(String(p)), { recursive: true });
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

// ─── Scenario 7: scheduler decision grids (probe task state machine) ────────
const { TaskScheduler } = await import(durableUrl("harness/scheduler.ts"));
const { createRegistry } = await import(durableUrl("harness/registry.ts"));

const scenario7Dir = path.join(staging, "scenario7");
fs.mkdirSync(scenario7Dir, { recursive: true });
const storage7 = await JsonlStorage.open(scenario7Dir, fileSystemShim, BACKGROUND, {});
const session7 = createSession(storage7);
const registry7 = createRegistry();

// A probe task with two phases: `run` records durable progress once, then
// completes; `wait` parks on another task with `allSettled`.
let probePhases = {};
const probeTaskToken = {
  definition: {
    name: "probe",
    version: 1,
    initial: () => ({ phase: "run", steps: 0 }),
    phases: {
      run: async (task, runtime, context) => {
        const steps = task.state.checkpoint.steps;
        await runtime.commit(async (tx) => {
          const record = await tx.task(task.id);
          const checkpoint = { phase: "run", steps: steps + 1 };
          if (steps + 1 >= 2) {
            return { status: "terminal", outcome: { status: "completed", result: { steps: steps + 1 } } };
          }
          return { status: "running", checkpoint };
        }, context);
      },
    },
    abort: async () => {},
  },
};
// Replace the registry's probe registration token (the registry starts with
// built-ins only; probes are added through tasks.add).
const probes = { probe: probeTaskToken };
const registryAdd = {
  snapshot: () => ({
    ...registry7.snapshot(),
    task: (name) => probes[name] ?? registry7.snapshot().task(name),
  }),
  subscribe: () => () => {},
};

let reportLog7 = [];
const scheduler7 = new TaskScheduler({
  session: session7,
  storage: storage7,
  registry: registryAdd,
  models: undefined,
  env: undefined,
  now: () => 1758240010000,
  report: (error) => reportLog7.push(error.message),
  settleOutcome: async () => {},
  withdrawInputs: async () => {},
  conversation: async () => undefined,
  context: BACKGROUND,
});
await scheduler7.open(BACKGROUND);

const probeConversation = await session7.commitWith(async (tx) => {
  const record = await tx.createRootConversation();
  return record;
}, BACKGROUND);
const probeTaskId = await session7.commitWith(async (tx) => {
  return tx.createTask(probeTaskToken, { n: 1 }, { ownership: { kind: "conversation" }, conversationId: probeConversation.id });
}, BACKGROUND);
scheduler7.resume();
const probeSettled = await scheduler7.waitForTask(probeTaskId, BACKGROUND);

// Blocked grid: a task whose kind has no registered definition, one with a
// too-old definition, and one whose migration fails.
const oldVersionTask = {
  definition: {
    name: "oldish",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {},
    abort: async () => {},
  },
};
const newerNoMigrate = {
  definition: {
    name: "oldish",
    version: 2,
    initial: () => ({ phase: "run" }),
    phases: {},
    abort: async () => {},
  },
};
probes.oldish = oldVersionTask;
const oldishId = await session7.commitWith(async (tx) => {
  return tx.createTask(oldVersionTask, {}, { ownership: { kind: "conversation" }, conversationId: probeConversation.id });
}, BACKGROUND);
probes.oldish = newerNoMigrate;
const inspection7 = await scheduler7.inspect(registryAdd.snapshot());
const inspectionGrid = inspection7.tasks.map((entry) => ({
  kind: entry.record.kind,
  state: entry.state,
})).sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0));

// Orphan grid: abort a task no definition can take.
probes.oldish = undefined;
const orphanResult = await scheduler7.abort(oldishId, BACKGROUND);
const orphanRecord = await storage7.task(oldishId, BACKGROUND);

const scheduler_grids = {
  probeSettled: {
    id: probeSettled.id,
    kind: probeSettled.kind,
    state: probeSettled.state,
  },
  inspectionGrid,
  orphan: {
    abortResult: orphanResult,
    state: orphanRecord.state,
  },
  reportLog: reportLog7,
};
await session7.close(BACKGROUND);

// ─── Scenario 8: submissions state machine ──────────────────────────────────
const { Submissions } = await import(durableUrl("harness/submissions.ts"));
const { startRun } = await import(durableUrl("harness/generation.ts"));

const scenario8Dir = path.join(staging, "scenario8");
fs.mkdirSync(scenario8Dir, { recursive: true });
const storage8 = await JsonlStorage.open(scenario8Dir, fileSystemShim, BACKGROUND, {});
const session8 = createSession(storage8);
await session8.commitWith(async (tx) => {
  await tx.createRootConversation();
}, BACKGROUND);
const generationTask8 = (await import(durableUrl("harness/generation.ts"))).GenerationTask;
const generationProbes = { "pi.generation": generationTask8 };
let resumeCount8 = 0;
const submissions8 = new Submissions(
  session8,
  storage8,
  () => 1758240020000,
  () => { resumeCount8 += 1; },
);
// Idle input path: places a user entry, creates a placed submission, starts
// a run. The generation task itself is never scheduled (no scheduler), so
// the live run record stands.
const idleInput = await submissions8.submit(1, { type: "input", content: "hello" }, BACKGROUND);
const idleInputRecord = await storage8.submission(idleInput.id, BACKGROUND);
const liveDoc8 = await session8.snapshot((await import(durableUrl("harness/live.ts"))).LiveDoc, 1, BACKGROUND);
// Busy steer path.
const steer = await submissions8.submit(1, { type: "input", content: "steer me", whenBusy: "steer" }, BACKGROUND);
const steerRecord = await storage8.submission(steer.id, BACKGROUND);
// Busy follow-up path.
const followUp = await submissions8.submit(1, { type: "input", content: "follow up", whenBusy: "followUp" }, BACKGROUND);
const followUpRecord = await storage8.submission(followUp.id, BACKGROUND);
// Busy reject path.
let busyError = null;
try {
  await submissions8.submit(1, { type: "input", content: "nope", whenBusy: "reject" }, BACKGROUND);
} catch (error) {
  busyError = { name: error.name, message: error.message };
}
// Request-id dedup.
const dedup1 = await submissions8.submit(1, { type: "input", content: "once", requestId: "req-1" }, BACKGROUND);
const dedup2 = await submissions8.submit(1, { type: "input", content: "once", requestId: "req-1" }, BACKGROUND);
// Queued write path.
const queuedWrite = await submissions8.submit(1, { type: "write", entry: { kind: "note", data: { text: "w" } } }, BACKGROUND);
const queuedWriteRecord = await storage8.submission(queuedWrite.id, BACKGROUND);
// Withdraw the steer.
const steerAbort = await submissions8.abort(steer.id, BACKGROUND, 1);
const steerAfterAbort = await storage8.submission(steer.id, BACKGROUND);
// Wait on the idle input (it settles only when a generation ends; assert the
// placed state here).
const placedStatus = await submissions8.status(idleInput.id, BACKGROUND);

const submissions_state = {
  resumeCount: resumeCount8,
  idleInput: idleInputRecord,
  liveRun: liveDoc8?.run ?? null,
  steer: steerRecord,
  followUp: followUpRecord,
  busyReject: busyError,
  dedup: { first: dedup1.id, second: dedup2.id, same: dedup1.id === dedup2.id },
  queuedWrite: queuedWriteRecord,
  steerAbort,
  steerAfterAbort,
  placedStatus: placedStatus.status,
};
await session8.close(BACKGROUND);

// ─── Scenario 9: tools declarations and execute shapes ─────────────────────
// Determinism contract for the tools scenarios: `exec` never spawns a shell;
// a table keyed by command text returns canned chunks / exit codes / spill
// paths, and the exact options each call received are recorded.
function canonical(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

const EXEC_STUB = {
  "echo oracle-ok": { chunks: ["out1\n", "err1\n"], exitCode: 0 },
  "echo oracle-spill": { chunks: ["chunk-a\n", "chunk-b\n"], exitCode: 0, spillPath: "/tmp/durable-oracle-spill.txt" },
  "exit 3": { chunks: ["boom\n"], exitCode: 3 },
  "sleep oracle-timeout": { chunks: ["partial\n"], error: { code: "timeout", message: "timed out" } },
  "sleep oracle-abort": { chunks: [], error: { code: "aborted", message: "aborted" } },
  "bad oracle-spawn": { chunks: [], error: { code: "spawn_error", message: "spawn failed" } },
};

function makeExecEnv(shim, execLog) {
  return {
    ...shim,
    async exec(command, options, context) {
      execLog.push({
        command,
        cwd: options?.cwd,
        envKeys: Object.keys(options?.env ?? {}),
        inheritEnv: options?.inheritEnv,
        timeout: options?.timeout,
        spill: options?.spill,
        hasOnOutput: typeof options?.onOutput === "function",
      });
      const spec = EXEC_STUB[command] ?? { chunks: [], exitCode: 0 };
      for (const chunk of spec.chunks) options?.onOutput?.(chunk);
      if (spec.error) return { ok: false, error: spec.error };
      return {
        ok: true,
        value: { exitCode: spec.exitCode ?? 0, spillPath: spec.spillPath },
      };
    },
  };
}

function fakeApi(env, sink, isEnded) {
  const assertLive = () => {
    if (isEnded()) throw new Error("The tool call has settled");
  };
  return {
    taskId: 7,
    conversationId: 1,
    callId: "call-1",
    env,
    output(text) {
      assertLive();
      sink.outputs.push(text);
    },
    diagnostic(diagnostic) {
      assertLive();
      sink.diagnostics.push(diagnostic);
    },
    details() {
      assertLive();
      return Promise.resolve();
    },
    commit() {
      assertLive();
      return Promise.resolve(null);
    },
    memo() {
      assertLive();
      return Promise.resolve(undefined);
    },
    createTask() {
      assertLive();
      return Promise.resolve(99);
    },
    getTask() {
      assertLive();
      return Promise.resolve(undefined);
    },
    waitForTask() {
      assertLive();
      return Promise.resolve(undefined);
    },
    conversation() {
      assertLive();
      return Promise.resolve(undefined);
    },
  };
}

async function runToolExecute(tool, args, env, context = BACKGROUND) {
  const sink = { outputs: [], diagnostics: [] };
  let ended = false;
  const api = fakeApi(env, sink, () => ended);
  let result;
  let thrown = null;
  try {
    result = await tool.execute(args, api, context);
  } catch (error) {
    thrown = { name: error.name, message: error.message };
  }
  ended = true;
  return canonical({
    result: result === undefined ? null : result,
    thrown,
    outputs: sink.outputs,
    diagnostics: sink.diagnostics,
  });
}

const tools = await import(durableUrl("tools/index.ts"));
const chordContext = await import(
  pathToFileURL(path.join(chordOut, "context", "index.ts")).href
);
const toolsPathUtils = await import(durableUrl("tools/path-utils.ts"));
const toolsEditDiff = await import(durableUrl("tools/edit-diff.ts"));
const toolsImage = await import(durableUrl("tools/image.ts"));
const toolsEnv = await import(durableUrl("tools/env.ts"));

const bashTool = tools.createBashTool();
const readTool = tools.createReadTool();
const writeTool = tools.createWriteTool();
const editTool = tools.createEditTool();

const tools_decl = canonical([
  { name: bashTool.name, description: bashTool.description, parameters: bashTool.parameters, outputLimits: bashTool.outputLimits ?? null },
  { name: readTool.name, description: readTool.description, parameters: readTool.parameters, outputLimits: readTool.outputLimits ?? null },
  { name: writeTool.name, description: writeTool.description, parameters: writeTool.parameters, outputLimits: writeTool.outputLimits ?? null },
  { name: editTool.name, description: editTool.description, parameters: editTool.parameters, outputLimits: editTool.outputLimits ?? null },
]);

// requireEnv without an environment.
const tools_env_error = (() => {
  try {
    toolsEnv.requireEnv(fakeApi(undefined, { outputs: [], diagnostics: [] }, () => false));
    return null;
  } catch (error) {
    return { name: error.name, message: error.message };
  }
})();

const scenario9Dir = path.join(staging, "scenario9");
fs.mkdirSync(scenario9Dir, { recursive: true });
const scenario10Dir = path.join(staging, "scenario10");
fs.mkdirSync(scenario10Dir, { recursive: true });
const execLog = [];
const toolPathShim = {
  ...fileSystemShim,
  cwd: scenario9Dir,
  // env/node.ts  resolves against the environment's cwd.
  async absolutePath(p) {
    return { ok: true, value: path.resolve(scenario9Dir, String(p)) };
  },
};
const toolEnv = makeExecEnv(toolPathShim, execLog);

const bash_ok = await runToolExecute(bashTool, { command: "echo oracle-ok" }, toolEnv);
const bash_spill = await runToolExecute(bashTool, { command: "echo oracle-spill" }, toolEnv);
const bash_nonzero = await runToolExecute(bashTool, { command: "exit 3" }, toolEnv);
const bash_timeout = await runToolExecute(bashTool, { command: "sleep oracle-timeout", timeout: 5 }, toolEnv);
const bash_unknown_error = await runToolExecute(bashTool, { command: "bad oracle-spawn" }, toolEnv);
const bash_prefix_prepare = await runToolExecute(
  tools.createBashTool({
    commandPrefix: "set -e",
    prepare(execution) {
      execution.cwd = path.join(scenario9Dir, "prepared");
      execution.env.PREPARED = "1";
    },
  }),
  { command: "echo oracle-ok" },
  toolEnv,
);
const bash_timeout_invalid = await runToolExecute(bashTool, { command: "echo x", timeout: 0 }, toolEnv);
const bash_timeout_too_large = await runToolExecute(bashTool, { command: "echo x", timeout: 2147483647 }, toolEnv);

const abortedController = new AbortController();
abortedController.abort();
const abortedContext = chordContext.withAbortSignal(abortedController.signal, BACKGROUND);
const bash_aborted_with_signal = await runToolExecute(bashTool, { command: "sleep oracle-abort" }, toolEnv, abortedContext);
const bash_aborted_without_signal = await runToolExecute(bashTool, { command: "sleep oracle-abort" }, toolEnv);

fs.writeFileSync(path.join(scenario9Dir, "one-two-three.txt"), "one\ntwo\nthree", "utf8");
const read_basic = await runToolExecute(readTool, { path: "one-two-three.txt" }, toolEnv);
const read_offset_limit = await runToolExecute(readTool, { path: "one-two-three.txt", offset: 2, limit: 1 }, toolEnv);
const read_offset_beyond = await runToolExecute(readTool, { path: "one-two-three.txt", offset: 99 }, toolEnv);
fs.writeFileSync(
  path.join(scenario9Dir, "many-lines.txt"),
  Array.from({ length: 2500 }, (_, i) => `line-${i}`).join("\n") + "\n",
  "utf8",
);
const read_truncated_lines = await runToolExecute(readTool, { path: "many-lines.txt" }, toolEnv);
fs.writeFileSync(path.join(scenario9Dir, "huge-line.txt"), "x".repeat(60000) + "\nsecond\n", "utf8");
const read_huge_line = await runToolExecute(readTool, { path: "huge-line.txt" }, toolEnv);
fs.writeFileSync(path.join(scenario9Dir, "picture.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]), "binary");
const read_unsupported_image = await runToolExecute(readTool, { path: "picture.png" }, toolEnv);

const write_basic = await runToolExecute(writeTool, { path: "out/write-target.txt", content: "written-1\n" }, toolEnv);
const writeFileBytes1 = fs.readFileSync(path.join(scenario9Dir, "out", "write-target.txt"), "utf8");
const write_overwrite = await runToolExecute(writeTool, { path: "out/write-target.txt", content: "written-2" }, toolEnv);
const writeFileBytes2 = fs.readFileSync(path.join(scenario9Dir, "out", "write-target.txt"), "utf8");

fs.writeFileSync(path.join(scenario9Dir, "edit-me.txt"), "alpha\nbeta\ngamma\nbeta again\n", "utf8");
const edit_two_blocks = await runToolExecute(
  editTool,
  {
    path: "edit-me.txt",
    edits: [
      { oldText: "alpha\nbeta", newText: "ALPHA\nBETA" },
      { oldText: "gamma", newText: "GAMMA" },
    ],
  },
  toolEnv,
);
const editMeBytes = fs.readFileSync(path.join(scenario9Dir, "edit-me.txt"), "utf8");
fs.writeFileSync(path.join(scenario9Dir, "fuzzy.txt"), "value = \u201Cquoted\u201D end\n", "utf8");
const edit_fuzzy = await runToolExecute(
  editTool,
  { path: "fuzzy.txt", edits: [{ oldText: '"quoted"', newText: '"QUOTED"' }] },
  toolEnv,
);
const fuzzyBytes = fs.readFileSync(path.join(scenario9Dir, "fuzzy.txt"), "utf8");
fs.writeFileSync(path.join(scenario9Dir, "crlf.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");
fs.writeFileSync(path.join(scenario9Dir, "dup.txt"), "two\nmore two\n", "utf8");
fs.writeFileSync(path.join(scenario9Dir, "nochange.txt"), "two\n", "utf8");
const edit_duplicate = await runToolExecute(
  editTool,
  { path: "dup.txt", edits: [{ oldText: "two", newText: "x" }] },
  toolEnv,
);
const edit_no_change = await runToolExecute(
  editTool,
  { path: "nochange.txt", edits: [{ oldText: "two", newText: "two" }] },
  toolEnv,
);
const edit_crlf = await runToolExecute(
  editTool,
  { path: "crlf.txt", edits: [{ oldText: "two", newText: "TWO" }] },
  toolEnv,
);
const crlfBytes = fs.readFileSync(path.join(scenario9Dir, "crlf.txt"), "utf8");
const edit_not_found = await runToolExecute(
  editTool,
  { path: "crlf.txt", edits: [{ oldText: "absent", newText: "x" }] },
  toolEnv,
);
const edit_empty_old = await runToolExecute(
  editTool,
  { path: "crlf.txt", edits: [{ oldText: "", newText: "x" }] },
  toolEnv,
);
const edit_missing_file = await runToolExecute(
  editTool,
  { path: "absent-file.txt", edits: [{ oldText: "a", newText: "b" }] },
  toolEnv,
);
const edit_directory = await runToolExecute(
  editTool,
  { path: "out", edits: [{ oldText: "a", newText: "b" }] },
  toolEnv,
);

const tools_execute = scrubStaging(canonical({
  execLog,
  requireEnvError: tools_env_error,
  bashOk: bash_ok,
  bashSpill: bash_spill,
  bashNonzero: bash_nonzero,
  bashTimeout: bash_timeout,
  bashUnknownError: bash_unknown_error,
  bashPrefixPrepare: bash_prefix_prepare,
  bashTimeoutInvalid: bash_timeout_invalid,
  bashTimeoutTooLarge: bash_timeout_too_large,
  bashAbortedWithSignal: bash_aborted_with_signal,
  bashAbortedWithoutSignal: bash_aborted_without_signal,
  readBasic: read_basic,
  readOffsetLimit: read_offset_limit,
  readOffsetBeyond: read_offset_beyond,
  readTruncatedLines: read_truncated_lines,
  readHugeLine: read_huge_line,
  readUnsupportedImage: read_unsupported_image,
  writeBasic: write_basic,
  writeFileBytes1,
  writeOverwrite: write_overwrite,
  writeFileBytes2,
  editTwoBlocks: edit_two_blocks,
  editMeBytes,
  editFuzzy: edit_fuzzy,
  fuzzyBytes,
  editCrlf: edit_crlf,
  crlfBytes,
  editNotFound: edit_not_found,
  editDuplicate: edit_duplicate,
  editEmptyOld: edit_empty_old,
  editNoChange: edit_no_change,
  editMissingFile: edit_missing_file,
  editDirectory: edit_directory,
}));

const tools_decl_and_exec = { tools_decl, tools_execute };

// ─── Scenario 10: edit-diff / image / path-utils surfaces ──────────────────
const diff_surface = canonical({
  detectLineEnding: [
    toolsEditDiff.detectLineEnding("a\r\nb\n"),
    toolsEditDiff.detectLineEnding("a\nb\r\n"),
    toolsEditDiff.detectLineEnding("no endings"),
    toolsEditDiff.detectLineEnding("lone \r cr"),
  ],
  normalizeToLf: toolsEditDiff.normalizeToLF("a\r\nb\rc\nd"),
  restoreLineEndings: toolsEditDiff.restoreLineEndings("a\nb", "\r\n"),
  normalizeForFuzzyMatch: toolsEditDiff.normalizeForFuzzyMatch(
    "“quoted” \u00A0 en–dash — em  \n z\u205Fw",
  ),
  stripBom: toolsEditDiff.stripBom("\uFEFFbody"),
  fuzzyExact: toolsEditDiff.fuzzyFindText("abc def", "def"),
  fuzzyFuzzy: toolsEditDiff.fuzzyFindText("x = \u201Cq\u201D;", '"q"'),
  fuzzyMiss: toolsEditDiff.fuzzyFindText("abc", "zzz"),
  applyTwoEdits: toolsEditDiff.applyEditsToNormalizedContent(
    "one\ntwo\nthree\ntwo again\n",
    [
      { oldText: "one\ntwo", newText: "ONE\nTWO" },
      { oldText: "three", newText: "THREE" },
    ],
    "f.txt",
  ),
  applyFuzzyOverlay: toolsEditDiff.applyEditsToNormalizedContent(
    "x = \u201Cv\u201D ;  \ny\n",
    [{ oldText: '"v"', newText: '"W"' }],
    "f.txt",
  ),
  unifiedPatch: toolsEditDiff.generateUnifiedPatch(
    "f.txt",
    "keep\nchange-from\nkeep2\nkeep3\nkeep4\nkeep5\nchange-to\nkeep6\n",
    "keep\nchange-from-edited\nkeep2\nkeep3\nkeep4\nkeep5\nchange-to\nkeep6\n",
  ),
  unifiedPatchNoNewline: toolsEditDiff.generateUnifiedPatch(
    "g.txt",
    "a\nb",
    "a\nc",
  ),
  diffString: toolsEditDiff.generateDiffString(
    "l0\nl1\nl2\nl3\nl4\nold\nl6\nl7\nl8\nl9\nl10\nnew-tail\n",
    "l0\nl1\nl2\nl3\nl4\nNEW\nl6\nl7\nl8\nl9\nl10\nNEW-TAIL\n",
  ),
});

const image_detect = canonical([
  { name: "jpeg", bytes: [0xff, 0xd8, 0xff, 0xe0, 0, 5], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 5])) },
  { name: "jpeg-lossless", bytes: [0xff, 0xd8, 0xff, 0xf7], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xf7])) },
  { name: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])) },
  { name: "png-short", bytes: [0x89, 0x50, 0x4e, 0x47], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) },
  { name: "png-bad-ihdr", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 12, 73, 72, 68, 82], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 12, 73, 72, 68, 82])) },
  { name: "png-animated", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1, 97, 99, 84, 76, 1], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1, 97, 99, 84, 76, 1])) },
  { name: "png-idat-first", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 5, 73, 68, 65, 84], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 5, 73, 68, 65, 84])) },
  { name: "gif87a", bytes: [...Buffer.from("GIF87a")], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array(Buffer.from("GIF87a"))) },
  { name: "gif89a", bytes: [...Buffer.from("GIF89a")], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array(Buffer.from("GIF89a"))) },
  { name: "gif88a", bytes: [...Buffer.from("GIF88a")], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array(Buffer.from("GIF88a"))) },
  { name: "webp", bytes: [...Buffer.from("RIFF0000WEBPVP8 ")], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array(Buffer.from("RIFF0000WEBPVP8 "))) },
  { name: "bmp-24", bytes: [0x42, 0x4d, 46, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0, 1, 0, 1, 0, 24, 0, 0, 0], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([0x42, 0x4d, 46, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0, 1, 0, 1, 0, 24, 0, 0, 0])) },
  { name: "bmp-bad-planes", bytes: [0x42, 0x4d, 46, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0, 1, 0, 2, 0, 24, 0, 0, 0], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([0x42, 0x4d, 46, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0, 1, 0, 2, 0, 24, 0, 0, 0])) },
  { name: "bmp-core", bytes: [0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 26, 0, 0, 0, 12, 0, 0, 0, 1, 0, 1, 0, 1, 0, 8, 0], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 26, 0, 0, 0, 12, 0, 0, 0, 1, 0, 1, 0, 1, 0, 8, 0])) },
  { name: "bmp-truncated", bytes: [0x42, 0x4d], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([0x42, 0x4d])) },
  { name: "empty", bytes: [], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array([])) },
  { name: "text", bytes: [...Buffer.from("plain text")], mime: toolsImage.detectSupportedImageMimeType(new Uint8Array(Buffer.from("plain text"))) },
]);

const pathEnv = {
  ...fileSystemShim,
  cwd: scenario10Dir,
  // env/node.ts  resolves against the environment's cwd.
  async absolutePath(p) {
    return { ok: true, value: path.resolve(scenario10Dir, String(p)) };
  },
};
fs.writeFileSync(path.join(scenario10Dir, "re ad.txt"), "spacey", "utf8");
fs.writeFileSync(path.join(scenario10Dir, "photo\u202FAM.txt"), "narrow", "utf8");
fs.writeFileSync(path.join(scenario10Dir, "apostrophe.txt"), "quote", "utf8");

function scrubStaging(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) =>
      typeof entry === "string"
        ? entry
            .split(scenario9Dir + path.sep)
            .join("<scenario9>/")
            .split(scenario9Dir)
            .join("<scenario9>")
            .split(scenario10Dir + path.sep)
            .join("<scenario10>/")
            .split(scenario10Dir)
            .join("<scenario10>")
        : entry,
    ),
  );
}

const path_utils = scrubStaging(canonical({
  resolveToolPath: [
    await toolsPathUtils.resolveToolPath(pathEnv, "re ad.txt", BACKGROUND),
    await toolsPathUtils.resolveToolPath(pathEnv, "@re ad.txt", BACKGROUND),
    await toolsPathUtils.resolveToolPath(pathEnv, "re\u00A0ad.txt", BACKGROUND),
  ],
  resolveReadToolPath: [
    await toolsPathUtils.resolveReadToolPath(pathEnv, "re ad.txt", BACKGROUND),
    await toolsPathUtils.resolveReadToolPath(pathEnv, "photo AM.txt", BACKGROUND),
    await toolsPathUtils.resolveReadToolPath(pathEnv, "apostrophe.txt", BACKGROUND),
    await toolsPathUtils.resolveReadToolPath(pathEnv, "missing.txt", BACKGROUND),
  ],
}));

// ─── Scenario 11: storage conformance traces ───────────────────────────────
const { MemoryStorage } = await import(durableUrl("storage/memory.ts"));
const { createStorageConformance } = await import(durableUrl("testing/storage-conformance.ts"));

function structuralEqual(left, right) {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "number") {
    return Number.isNaN(left) && Number.isNaN(right);
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && structuralEqual(left[key], right[key]));
}

function partialEqual(actual, expected) {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    return structuralEqual(actual, expected);
  }
  if (actual === null || typeof actual !== "object") return false;
  return Object.keys(expected).every((key) =>
    Object.hasOwn(actual, key) && partialEqual(actual[key], expected[key]),
  );
}

function recordingAssertions(steps) {
  const fail = () => {
    throw new Error("conformance assertion failed");
  };
  // Snapshot at push time: recorded values must not change when the case
  // later mutates a returned record (JS holds references otherwise).
  const snapshot = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
  return {
    ok(value, message) {
      steps.push({ method: "ok", value, message: message ?? null });
      if (!value) fail();
    },
    strictEqual(actual, expected) {
      steps.push({ method: "strictEqual", actual: snapshot(actual), expected: snapshot(expected) });
      if (!structuralEqual(actual, expected)) fail();
    },
    deepEqual(actual, expected) {
      steps.push({ method: "deepEqual", actual: snapshot(actual), expected: snapshot(expected) });
      if (!structuralEqual(actual, expected)) fail();
    },
    partialDeepEqual(actual, expected) {
      steps.push({ method: "partialDeepEqual", actual: snapshot(actual), expected: snapshot(expected) });
      if (!partialEqual(actual, expected)) fail();
    },
    greaterThan(actual, expected) {
      steps.push({ method: "greaterThan", actual, expected });
      if (!(actual > expected)) fail();
    },
    async rejects(operation, messageIncludes) {
      let matched = false;
      try {
        await operation;
      } catch (error) {
        matched = String(error && error.message !== undefined ? error.message : error).includes(
          messageIncludes,
        );
      }
      steps.push({ method: "rejects", messageIncludes, matched });
      if (!matched) fail();
    },
  };
}

const CONFORMANCE_CASES = [
  "reserves ID 1 for the immutable root conversation",
  "commits mixed table writes atomically and rolls all of them back on failure",
  "detaches retained writes and every returned record",
  "detaches prototype-like JSON keys without changing object prototypes",
  "indexes entries committed out of ID order",
  "continues an entry cursor below its last item after a newer commit",
  "paginates conversations by opaque cursor in ascending ID order",
  "filters and pages conversations by durable owner edges",
  "replaces complete task records and pages filtered task scans",
  "stores owners and scans waiting and completing tasks by status",
  "indexes logical addresses and exact-scope scans independently",
  "keeps one global record ID namespace and rejects exhausted ID minting",
  "rejects every operation after close",
];

const testing_conformance = [];
for (const name of CONFORMANCE_CASES) {
  const steps = [];
  let error = null;
  try {
    const storage = new MemoryStorage();
    const cases = createStorageConformance({
      assertions: recordingAssertions(steps),
      withStorage: async (use) => {
        await use(storage);
      },
    });
    const testCase = cases.find((candidate) => candidate.name === name);
    if (!testCase) throw new Error(`missing conformance case: ${name}`);
    await testCase.run();
  } catch (thrown) {
    error = thrown.message;
  }
  testing_conformance.push({ name, steps: JSON.parse(JSON.stringify(canonical(steps))), error });
}

// ─── Scenario 12: storage benchmark seeders and tables ─────────────────────
const bench = await import(durableUrl("testing/storage-benchmark.ts"));
const TINY_SCALE = { name: "tiny", entryCount: 8, taskCount: 6, documentCount: 4 };

const benchStorage = new MemoryStorage();
const benchDataset = await bench.seedStorageBenchmark(benchStorage, TINY_SCALE);
const testing_benchmark = {
  memoryScales: canonical(bench.STORAGE_MEMORY_SCALES),
  timingScale: canonical(bench.TIMING_SCALE),
  primaryRecordCounts: {
    scale1k: bench.storageBenchmarkPrimaryRecordCount(bench.STORAGE_MEMORY_SCALES[0]),
    timing: bench.storageBenchmarkPrimaryRecordCount(bench.TIMING_SCALE),
    tiny: bench.storageBenchmarkPrimaryRecordCount(TINY_SCALE),
  },
  dataset: canonical({
    firstEntryId: benchDataset.firstEntryId,
    filteredTaskCount: benchDataset.filteredTaskCount,
    exactDocumentId: benchDataset.exactDocumentId,
    exactDocumentKey: benchDataset.exactDocumentKey,
    replayDocumentIds: Object.fromEntries(
      Object.entries(benchDataset.replayDocumentIds).map(([tail, id]) => [tail, id]),
    ),
    historicalDocumentId: benchDataset.historicalDocumentId,
    ancientAt: benchDataset.ancientAt,
    recentAt: benchDataset.recentAt,
    deepestConversationId: benchDataset.deepestConversationId,
    ancestorHeadEntryId: benchDataset.ancestorHeadEntryId,
  }),
  readBenchmarks: [],
  writeBenchmarks: [],
};
for (const readBenchmark of bench.STORAGE_READ_BENCHMARKS) {
  testing_benchmark.readBenchmarks.push({
    name: readBenchmark.name,
    run: await readBenchmark.run(benchStorage, benchDataset),
    expected: readBenchmark.expected(benchDataset),
  });
}
const writeStorage = new MemoryStorage();
await bench.seedStorageWriteBenchmark(writeStorage);
for (const writeBenchmark of bench.STORAGE_WRITE_BENCHMARKS) {
  testing_benchmark.writeBenchmarks.push({
    name: writeBenchmark.name,
    expected: writeBenchmark.expected,
    run: await writeBenchmark.run(writeStorage),
  });
}


// ─── Scenario 13: provider session identity (v1.0.2) ───────────────────────
// Mirrored one-to-one by `src/durable/harness/provider.rs` tests. Raw
// identities are NOT recorded (`uuidv7()` mixes wall clock + randomness, and
// the durable capture keeps its no-clock/no-random contract); the recorded
// contract is the definition surface, the v7 shape, and the identity
// relations across the lifecycle.
{
  const { ProviderDoc, ensureProviderSessionId } = await import(
    durableUrl("harness/provider.ts")
  );

  const scenario13Dir = path.join(staging, "scenario13");
  fs.mkdirSync(scenario13Dir, { recursive: true });
  const storage13 = await JsonlStorage.open(scenario13Dir, fileSystemShim, BACKGROUND, {});
  const session13 = createSession(storage13);

  const root13 = await session13.commitWith(async (tx) => {
    return tx.createRootConversation();
  }, BACKGROUND);

  // A minimal TaskRuntime over the Session: `snapshot` + `commit` are the
  // only operations `ensureProviderSessionId` uses.
  function runtimeFor(conversationId) {
    return {
      conversationId,
      snapshot: (doc, id, ctx) => session13.snapshot(doc, id, ctx),
      commit: (change, ctx) => session13.commitWith(change, ctx),
    };
  }

  const runtime13 = runtimeFor(root13.id);
  const first = await ensureProviderSessionId(runtime13, BACKGROUND);
  const second = await ensureProviderSessionId(runtime13, BACKGROUND);
  const stored13 = await session13.snapshot(ProviderDoc, root13.id, BACKGROUND);
  const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

  // Legacy conversation: retire `pi.provider`, then the next request
  // migrates a fresh identity in.
  await session13.commitWith(async (tx) => {
    await tx.retireDoc(ProviderDoc, root13.id, BACKGROUND);
  }, BACKGROUND);
  const retired13 = await session13.snapshot(ProviderDoc, root13.id, BACKGROUND);
  const migrated = await ensureProviderSessionId(runtime13, BACKGROUND);

  // A fork starts a fresh identity instead of copying its parent
  // (`fork: "initial"`).
  const entry13 = await session13.commitWith(async (tx) => {
    return (await tx.appendEntry(root13.id, {
      kind: UserEntry.kind,
      model: [{ role: "user", content: "hello", timestamp: 1758240000000 }],
    })).id;
  }, BACKGROUND);
  const fork13 = await session13.commitWith(async (tx) => {
    return tx.forkConversation(root13.id, entry13, { ownership: { kind: "ownerless" } });
  }, BACKGROUND);
  const forkIdentity = await ensureProviderSessionId(runtimeFor(fork13.id), BACKGROUND);

  const definition = ProviderDoc.definition;
  const relations = {
    stable: first === second,
    migratedDiffers: migrated !== first,
    forkDiffers: forkIdentity !== first,
  };
  const lifecycle = {
    fresh: {
      stable: relations.stable,
      uuidV7Shape: UUID_V7.test(first),
      matchesStored: stored13 !== undefined && stored13.sessionId === first,
    },
    legacy: {
      absentAfterRetire: retired13 === undefined,
      freshIdentity: UUID_V7.test(migrated) && relations.migratedDiffers,
    },
    fork: {
      freshIdentity: UUID_V7.test(forkIdentity) && relations.forkDiffers,
    },
    relations,
  };
  for (const value of [
    lifecycle.fresh.stable,
    lifecycle.fresh.uuidV7Shape,
    lifecycle.fresh.matchesStored,
    lifecycle.legacy.absentAfterRetire,
    lifecycle.legacy.freshIdentity,
    lifecycle.fork.freshIdentity,
    ...Object.values(relations),
  ]) {
    if (value !== true) throw new Error(`provider_identity lifecycle expectation failed: ${JSON.stringify(lifecycle)}`);
  }
  await session13.close(BACKGROUND);

  const provider_identity = {
    definition: {
      kind: definition.kind,
      version: definition.version,
      scope: definition.scope,
      history: definition.history,
      fork: definition.fork,
    },
    initial: {
      keys: Object.keys(definition.initial()),
      sessionIdIsUuidV7: UUID_V7.test(definition.initial().sessionId),
    },
    checkpointWhenAlwaysTrue: definition.checkpointWhen({}, [], { deltasSinceBase: 0 }) === true,
    lifecycle,
  };
  var provider_identity_out = provider_identity;
}

const oracle = { commit_bytes, document_bytes, read_after_write, harness_docs, prompt_plan, output_bound, scheduler_grids, submissions_state, tools_decl_and_exec, diff_surface, image_detect, path_utils, testing_conformance, testing_benchmark, provider_identity: provider_identity_out };
// ─── Emit ───────────────────────────────────────────────────────────────────
const outDir = fileURLToPath(new URL(".", import.meta.url));
fs.writeFileSync(path.join(outDir, "durable_oracle.json"), JSON.stringify(oracle, null, 2) + "\n");
fs.writeFileSync(
  path.join(outDir, "durable_oracle.manifest.json"),
  JSON.stringify({ ...manifest, stagedCount: manifest.staged.length }, null, 2) + "\n",
);
console.log("durable oracle captured:", Object.keys(oracle).join(", "));
console.log("staged files:", manifest.staged.length);
