// Byte-oracle capture for the ai-delta slice (upstream 2bbfcca43, baseline
// 590144609): copies the UNMODIFIED upstream TypeScript dependency closure
// into a temp directory (hashing every file for the provenance manifest) and
// executes it under Node's --experimental-strip-types with deterministic
// stubs (Date.now, Math.random).
//
// Scenarios captured into ai_delta_oracle.json:
// 1. llama-cpp-classify pure functions (renderQuestion, labelProbabilities,
//    peakConfidence, answerFromProbabilities, llamaServerRoot, error texts).
// 2. system-one classify (typesafe + cloudflare transports) over an injected
//    fetch: request URL/method/headers/body and parsed results, including
//    catalog-priced usage and canned error paths.
// 3. model-catalog flatten (chat/image/classifier) over every embedded data
//    shard plus synthetic mixed entries.
// 4. sampling-params surface (v1.0.2 delta, upstream 200387122):
//    resolveSamplingParams / clampThinkingLevel grids and the
//    buildBaseOptions merge over `api/simple-options.ts`. Disclosed: the
//    closure for THIS scenario is materialized from the `origin/main` BLOBS
//    (`git show`, hashing the blob bytes) because the read-only working tree
//    is pinned at the delta baseline 4c6fb7cfe; unavailable bare specifiers
//    inside its `models.ts` closure (provider SDKs) resolve to generated
//    stub modules whose exports are never invoked by the pure functions
//    under test.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const upstreamRoot = fileURLToPath(new URL("../../../../pi/", import.meta.url));
const aiSrc = path.join(upstreamRoot, "packages", "ai", "src");

// The dependency closures (entry files relative to packages/ai/src); the
// transitive relative imports are copied verbatim.
const CLOSURES = {
  llamaCpp: ["api/llama-cpp-classify.ts"],
  systemOne: [
    "api/system-one-shared.ts",
    "api/typesafe-system-one.ts",
    "api/cloudflare-workers-ai-system-one.ts",
  ],
  catalog: ["model-catalog.ts"],
};

const hashes = {};
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ai-delta-oracle-"));
const stagedRoot = path.join(staging, "packages", "ai", "src");

function copyClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.pop().split(path.sep).join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(aiSrc, ...rel.split("/"));
    const source = fs.readFileSync(abs, "utf8");
    hashes[`packages/ai/src/${rel}`] = createHash("sha256").update(source).digest("hex");
    const target = path.join(stagedRoot, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    for (const [, spec] of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      if (spec.endsWith(".ts")) {
        queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// v1.0.2 sampling closure: staged from origin/main blobs with bare-specifier
// stubs (see the header). Kept fully separate from the baseline closures so
// their provenance stays byte-identical to the 2bbfcca43 capture.
// ---------------------------------------------------------------------------
const GIT_REF = "origin/main";
const samplingHashes = {};
const samplingBare = new Map(); // bare specifier -> imported names
let samplingStaging;
let samplingRoot;

function gitShow(rel) {
  return execFileSync(
    "git",
    ["-C", upstreamRoot, "show", `${GIT_REF}:packages/ai/src/${rel}`],
    { maxBuffer: 1 << 26, encoding: "utf8" },
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectBareNames(spec, source) {
  const names = samplingBare.get(spec) ?? new Set();
  const named = new RegExp(
    "import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s+\"" + escapeRegExp(spec) + "\"",
    "g",
  );
  for (const match of source.matchAll(named)) {
    if (match[1]) continue; // `import type` — erased by strip-types
    for (const part of match[2].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (!name || name.startsWith("type ")) continue;
      names.add(name);
    }
  }
  const defaulted = new RegExp(
    "import\\s+(\\w+)\\s+from\\s+\"" + escapeRegExp(spec) + "\"",
    "g",
  );
  for (const match of source.matchAll(defaulted)) names.add("default");
  samplingBare.set(spec, names);
}

function copySamplingClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.pop().split(path.sep).join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = gitShow(rel);
    samplingHashes[`packages/ai/src/${rel}`] = createHash("sha256").update(source).digest("hex");
    const target = path.join(samplingRoot, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    for (const match of source.matchAll(/^\s*import\s+(?:type\s+)?([\s\S]*?)\s+from\s+"([^"]+)"/gm)) {
      const [, names, spec] = match;
      if (!spec.startsWith(".")) {
        if (!spec.startsWith("node:")) collectBareNames(spec, source);
        continue;
      }
      if (!spec.endsWith(".ts")) continue;
      if (names.trim().startsWith("*")) continue; // namespace: no module object
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
    for (const match of source.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
      const spec = match[1];
      if (!spec.startsWith(".")) {
        if (!spec.startsWith("node:")) collectBareNames(spec, source);
        continue;
      }
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
  }
}

async function stageSamplingClosure() {
  samplingStaging = fs.mkdtempSync(path.join(os.tmpdir(), "ai-delta-sampling-"));
  samplingRoot = path.join(samplingStaging, "packages", "ai", "src");
  copySamplingClosure("api/simple-options.ts");

  // Generated stub modules for the closure's bare specifiers (provider SDKs
  // and telemetry): every runtime-imported name resolves to a benign
  // self-referential proxy; the pure functions under test never invoke them.
  const stubDir = path.join(samplingStaging, "stubs");
  fs.mkdirSync(stubDir, { recursive: true });
  for (const [spec, names] of samplingBare) {
    const lines = [
      "// Generated bare-specifier stub (disclosed in the manifest).",
      "const anyFactory = () => new Proxy(function () {}, {",
      "  get: (_target, property) => (property === Symbol.toPrimitive ? () => \"\" : anyFactory()),",
      "  apply: () => anyFactory(),",
      "});",
    ];
    for (const name of names) {
      if (name === "default") lines.push("export default anyFactory();");
      else lines.push(`export const ${name} = anyFactory();`);
    }
    fs.writeFileSync(path.join(stubDir, encodeURIComponent(spec) + ".mjs"), lines.join("\n") + "\n");
  }
  const hookSource = [
    'import { pathToFileURL } from "node:url";',
    `const stubDir = ${JSON.stringify(stubDir)};`,
    "export async function resolve(specifier, context, next) {",
    "  if (!specifier.startsWith(\".\") && !specifier.startsWith(\"node:\") && !specifier.startsWith(\"file:\")) {",
    "    return {",
    "      url: pathToFileURL(stubDir + \"/\" + encodeURIComponent(specifier) + \".mjs\").href,",
    "      shortCircuit: true,",
    "    };",
    "  }",
    "  return next(specifier, context);",
    "}",
  ].join("\n");
  fs.writeFileSync(path.join(samplingStaging, "hook.mjs"), hookSource);
  const { register } = await import("node:module");
  register(pathToFileURL(path.join(samplingStaging, "hook.mjs")).href);
}

for (const entries of Object.values(CLOSURES)) {
  for (const entry of entries) copyClosure(entry);
}

// Determinism stubs (the staged modules run in this process).
const FIXED_NOW = 1758240000000;
Date.now = () => FIXED_NOW;
Math.random = () => 0.5;

const stagedUrl = (rel) => pathToFileURL(path.join(stagedRoot, ...rel.split("/"))).href;

const out = {};

// ---------------------------------------------------------------------------
// 1. llama-cpp-classify pure functions
// ---------------------------------------------------------------------------
{
  const ns = await import(stagedUrl("api/llama-cpp-classify.ts"));
  const state = { alpha: 1, beta: [true, false], gamma: { deep: "x" } };
  const contextObj = {
    state,
    questions: {
      choice1: {
        type: "choice",
        instructions: "Pick the best option.",
        criteria: { cost: "Cheap", quality: "Accurate", speed: "Fast" },
      },
      score1: {
        type: "score",
        instructions: "Rate the reply.",
        criteria: ["Bad", "OK", "Great"],
      },
      bool1: {
        type: "bool",
        instructions: "Is the state positive?",
        criteria: { true: "Yes it is", false: "No it is not" },
      },
    },
  };
  const rendered = {};
  for (const id of Object.keys(contextObj.questions)) {
    rendered[id] = ns.renderQuestion(contextObj, id);
  }
  const attempt = (run) => {
    try {
      const value = run();
      return value === undefined ? null : value;
    } catch (error) {
      return error.message;
    }
  };
  out.llamaCpp = {
    llamaServerRoot: [
      "https://api.example.com/v1",
      "https://api.example.com/v1/",
      "https://api.example.com",
      "http://localhost:8080/v1/",
    ].map(ns.llamaServerRoot),
    renderQuestion: rendered,
    labelProbabilities: [
      ns.labelProbabilities([0.1, 0.4, 0.9], 1),
      ns.labelProbabilities([0.1, 0.4, 0.9], 2),
      ns.labelProbabilities([-1e30, -2, -2], 1),
    ],
    peakConfidence: [
      ns.peakConfidence([0.5, 0.5]),
      ns.peakConfidence([1.0, 0.0, 0.0]),
      ns.peakConfidence([0.4, 0.4, 0.2]),
    ],
    answerFromProbabilities: [
      ns.answerFromProbabilities(contextObj.questions.choice1, rendered.choice1.keys, [0.6, 0.3, 0.1]),
      ns.answerFromProbabilities(contextObj.questions.score1, rendered.score1.keys, [0.1, 0.2, 0.7]),
      ns.answerFromProbabilities(contextObj.questions.bool1, rendered.bool1.keys, [0.9, 0.1]),
    ],
    renderQuestionErrors: [
      attempt(() =>
        ns.renderQuestion(
          { state: {}, questions: { x: { type: "choice", instructions: "i", criteria: { a: "1" } } } },
          "x",
        ),
      ),
      attempt(() =>
        ns.renderQuestion(
          { state: {}, questions: { x: { type: "score", instructions: "i", criteria: ["a"] } } },
          "x",
        ),
      ),
      attempt(() => ns.renderQuestion({ state: {}, questions: {} }, "missing")),
    ],
  };
}

// ---------------------------------------------------------------------------
// 2. system-one classify over an injected fetch
// ---------------------------------------------------------------------------
{
  const typesafe = await import(stagedUrl("api/typesafe-system-one.ts"));
  const cloudflare = await import(stagedUrl("api/cloudflare-workers-ai-system-one.ts"));

  const classifierModel = {
    id: "jev-1",
    name: "Jev 1",
    api: "typesafe-system-one",
    provider: "typesafe",
    baseUrl: "https://api.typesafe.example/v1/",
    input: ["text"],
    cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0.4 },
    contextWindow: 128000,
    type: "classifier",
  };
  const cloudflareModel = {
    ...classifierModel,
    id: "jev-cf",
    api: "cloudflare-workers-ai-system-one",
    provider: "cloudflare-workers-ai",
    baseUrl: "https://api.cloudflare.example/client/v4/accounts/acc123/ai",
  };

  const contextObj = {
    state: { channel: "support", turns: 3 },
    questions: {
      q1: { type: "choice", instructions: "Tone?", criteria: { polite: "Kind", rude: "Harsh" } },
      q2: { type: "score", instructions: "Quality?", criteria: ["Low", "High"] },
      q3: { type: "bool", instructions: "Resolved?", criteria: { true: "Yes", false: "No" } },
    },
  };

  const requests = [];
  const canned = new Map();
  function recordingFetch(label) {
    return async (url, init) => {
      requests.push({
        label,
        url: String(url),
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      const next = canned.get(label);
      if (!next) throw Error(`no canned response for ${label}`);
      if (next.status !== undefined) {
        return {
          ok: false,
          status: next.status,
          headers: new Map([["retry-after", "0"]]),
          text: async () => next.body ?? "",
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => next.body,
      };
    };
  }

  const typesafeBody = {
    answers: {
      q1: { type: "choice", choice: "polite", probabilities: { polite: 0.8, rude: 0.2 }, confidence: 0.6 },
      q2: { type: "score", score: 1, confidence: 0.5 },
      q3: { type: "noul", noul: 0.75 },
    },
    usage: { input_tokens: 1500, output_tokens: 50 },
  };
  const cloudflareBody = {
    success: true,
    result: {
      state: "Completed",
      result: {
        answers: {
          q1: { type: "choice", choice: "rude", probabilities: { polite: 0.25, rude: 0.75 }, confidence: 0.5 },
          q2: { type: "score", score: 0, confidence: 1 },
          q3: { type: "noul", noul: 0.1 },
        },
        usage: { input_tokens: 0, output_tokens: 12 },
      },
    },
  };
  const errorCans = {
    "typesafe-error": { status: 503, body: '{"error":"boom"}' },
    "cloudflare-not-complete": { body: { success: true, result: { state: "Running" } } },
    "cloudflare-failed": {
      body: { success: false, errors: [{ message: "first" }, { code: 7 }, { message: "second" }] },
    },
    "typesafe-missing-answer": {
      body: { answers: { q1: typesafeBody.answers.q1, q2: typesafeBody.answers.q2 } },
    },
  };

  const baseOptions = { apiKey: "sk-test", maxRetries: 0 };

  async function run(label, fn, model) {
    requests.length = 0;
    const cannedBody = errorCans[label] ?? { body: label === "typesafe" ? typesafeBody : cloudflareBody };
    canned.set(label, cannedBody);
    const result = await fn(model, contextObj, { ...baseOptions, fetch: recordingFetch(label) });
    return { canned: cannedBody.body ?? cannedBody, requests: requests.slice(), result };
  }

  out.systemOne = {
    typesafe: await run("typesafe", typesafe.classify, classifierModel),
    cloudflare: await run("cloudflare", cloudflare.classify, cloudflareModel),
    errors: [
      await run("typesafe-error", typesafe.classify, classifierModel),
      await run("cloudflare-not-complete", cloudflare.classify, cloudflareModel),
      await run("cloudflare-failed", cloudflare.classify, cloudflareModel),
      await run("typesafe-missing-answer", typesafe.classify, classifierModel),
    ],
  };
}

// ---------------------------------------------------------------------------
// 3. model-catalog flatten over every embedded data shard
// ---------------------------------------------------------------------------
{
  const catalog = await import(stagedUrl("model-catalog.ts"));
  const dataDir = path.join(aiSrc, "providers", "data");
  const files = fs.readdirSync(dataDir).filter((name) => name.endsWith(".json")).sort();
  const sorted = (record) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const shards = {};
  for (const file of files) {
    const groups = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
    shards[file.replace(/\.json$/, "")] = {
      chat: sorted(catalog.flattenChatModelCatalog("p", groups)),
      image: sorted(catalog.flattenImageModelCatalog("p", groups)),
      classifier: sorted(catalog.flattenClassifierModelCatalog("p", groups)),
    };
  }

  // Synthetic mixed entries exercise the per-type filter for future data
  // (upstream runtime semantics: strict `type === type` equality).
  const synthetic = {
    "openai-completions": {
      v1: {
        id: "v1", name: "V1", api: "openai-completions", provider: "p",
        baseUrl: "https://p.example", type: "chat", reasoning: false,
        input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8, maxTokens: 4,
      },
      v2: {
        id: "v2", name: "V2", api: "openai-completions", provider: "p",
        baseUrl: "https://p.example", reasoning: false,
        input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8, maxTokens: 4,
      },
    },
    "openrouter-images": {
      i1: {
        id: "i1", name: "I1", api: "openrouter-images", provider: "p",
        baseUrl: "https://p.example", type: "image", input: ["text"], output: ["image"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    },
    "typesafe-system-one": {
      c1: {
        id: "c1", name: "C1", api: "typesafe-system-one", provider: "p",
        baseUrl: "https://p.example", type: "classifier", input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16,
      },
    },
  };
  shards["<synthetic>"] = {
    chat: catalog.flattenChatModelCatalog("p", synthetic),
    image: catalog.flattenImageModelCatalog("p", synthetic),
    classifier: catalog.flattenClassifierModelCatalog("p", synthetic),
  };
  out.modelCatalog = shards;
}

// ---------------------------------------------------------------------------
// 4. v1.0.2 sampling-params surface (origin/main simple-options.ts)
// ---------------------------------------------------------------------------
{
  await stageSamplingClosure();
  const ns = await import(
    pathToFileURL(path.join(samplingRoot, "api", "simple-options.ts")).href
  );

  const fullModel = {
    id: "custom-model",
    name: "Custom Model",
    api: "openai-completions",
    provider: "custom",
    baseUrl: "https://api.example.com/v1",
    reasoning: true,
    thinkingLevelMap: { low: null, medium: null },
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    samplingParams: { temperature: 1, top_p: 0.95 },
    samplingParamsByThinkingLevel: {
      high: { temperature: 0.8, top_k: 64 },
      off: { temperature: 0.7 },
    },
  };
  const bareModel = { ...fullModel };
  delete bareModel.samplingParams;
  delete bareModel.samplingParamsByThinkingLevel;
  const noLevelsModel = { ...fullModel };
  delete noLevelsModel.samplingParamsByThinkingLevel;
  const nonReasoningModel = { ...fullModel, reasoning: false };

  const request = { top_k: 1 };
  const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const models = {
    full: fullModel,
    bare: bareModel,
    noLevels: noLevelsModel,
    nonReasoning: nonReasoningModel,
  };

  // resolveSamplingParams grid: model shape x thinking level x request keys.
  const resolve = [];
  for (const [modelName, model] of Object.entries(models)) {
    for (const level of levels) {
      for (const requestParams of [undefined, request]) {
        resolve.push({
          model: modelName,
          level,
          request: requestParams === undefined ? null : requestParams,
          result: json(ns.resolveSamplingParams(model, level, requestParams)),
        });
      }
    }
  }

  // clampThinkingLevel grid + the supported set it derives from (models.ts).
  const modelsNs = await import(
    pathToFileURL(path.join(samplingRoot, "models.ts")).href
  );
  const supported = {};
  const clamped = {};
  for (const [modelName, model] of Object.entries(models)) {
    supported[modelName] = modelsNs.getSupportedThinkingLevels(model);
    clamped[modelName] = Object.fromEntries(
      levels.map((level) => [level, modelsNs.clampThinkingLevel(model, level)]),
    );
  }

  // buildBaseOptions: the simple-path base for a reasoning request with
  // per-request keys (the samplingParams member is the resolved merge) and
  // for a bare model without any sampling configuration.
  const contextObj = { systemPrompt: undefined, messages: [], tools: undefined };
  const base = json(
    ns.buildBaseOptions(fullModel, contextObj, {
      reasoning: "low",
      samplingParams: { top_p: 0.5 },
    }),
  );
  const baseBare = json(
    ns.buildBaseOptions(bareModel, contextObj, { reasoning: "low" }),
  );

  out.samplingParams = { resolve, supported, clamped, base, baseBare };
}

const fixtureDir = fileURLToPath(new URL(".", import.meta.url));
fs.writeFileSync(path.join(fixtureDir, "ai_delta_oracle.json"), JSON.stringify(out, null, 1));
const manifest = {
  upstream: "2bbfcca43 (v0.99.1); samplingParams scenario from origin/main (200387122, v1.0.2)",
  baseline: "590144609",
  fixedNow: FIXED_NOW,
  method: "verbatim dependency closure executed under node --experimental-strip-types",
  sources: Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  samplingClosure: {
    ref: GIT_REF,
    disclosed:
      "staged from origin/main blobs via git show (read-only working tree pinned at the 4c6fb7cfe baseline); bare specifiers inside the models.ts closure (provider SDKs, telemetry, typebox, partial-json) resolve to generated stub modules never invoked by the pure functions under test",
    sources: Object.fromEntries(
      Object.entries(samplingHashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    stubbedSpecifiers: [...samplingBare.keys()].sort(),
  },
};
fs.writeFileSync(
  path.join(fixtureDir, "ai_delta_oracle.manifest.json"),
  JSON.stringify(manifest, null, 1),
);
fs.rmSync(staging, { recursive: true, force: true });
console.log("captured", Object.keys(out).join(","), "sources:", Object.keys(hashes).length);
