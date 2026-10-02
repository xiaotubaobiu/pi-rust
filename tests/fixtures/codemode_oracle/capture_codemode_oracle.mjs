// Captures the codemode byte oracle against the VERBATIM upstream TypeScript
// (pi @ 2bbfcca43, pi-codemode 0.99.1):
//
//   Part A — script execution through the real upstream runtime
//     (`CodemodeSandbox` from the verbatim library closure under `src/`, the
//     quickjs-wasi worker, prelude generated from `prelude-source.ts`).
//   Part B — the extension's model-facing description pipeline
//     (`createCodemodeDescription` & co. from the verbatim
//     `upstream-closure/extensions/codemode/tool.ts`, whose non-pure module
//     graph — typebox aside — is stubbed; see the upstream-closure stubs).
//   Part C — `parseCodemodeSource` outcomes (the invalid-JSON message embeds
//     V8's `JSON.parse` text; the Rust port classifies that case instead).
//
// Non-determinism is trimmed at capture time: call durations (`performance.now`)
// are normalized to `0`; everything else (values, output items, call names and
// statuses, error kinds/names/messages/stacks) is pinned byte-exactly.
//
// Run: node --experimental-strip-types capture_codemode_oracle.mjs
// Writes codemode_oracle.json.

import { CodemodeSandbox } from "./src/index.ts";
import { renderToolSample } from "./src/declarations.ts";
import { parseCodemodeSource } from "./src/source.ts";
import {
  createCodemodeDescription,
  toCodemodeDeclaration,
  codemodeSchema,
  MODEL_GLOBAL_DECLARATIONS,
} from "./upstream-closure/extensions/codemode/tool.ts";
import { writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Shared tool fixtures (Part A). Deterministic executions only.
// ---------------------------------------------------------------------------

const inputSchema = {
  type: "object",
  properties: {
    a: { type: "number", description: "Left operand" },
    b: { type: "number" },
  },
  required: ["a", "b"],
};

const tools = [
  {
    name: "add",
    description: "Adds two numbers.",
    inputSchema,
    outputSchema: {
      type: "object",
      properties: { sum: { type: "number" } },
      required: ["sum"],
    },
    execute: async (args) => {
      if (typeof args?.a !== "number" || typeof args?.b !== "number") {
        throw new Error("add expects numeric a and b");
      }
      return { sum: args.a + args.b };
    },
  },
  {
    name: "echo",
    description: "Returns the arguments unchanged.",
    inputSchema: true,
    execute: async (args) => args ?? null,
  },
  {
    name: "fail",
    description: "Always throws.",
    inputSchema: undefined,
    execute: async () => {
      throw new Error("tool boom");
    },
  },
  {
    name: "fail_string",
    description: "Throws a non-Error value.",
    execute: async () => {
      throw "plain string throw";
    },
  },
  {
    name: "pending",
    description: "Never settles.",
    execute: () => new Promise(() => {}),
  },
  {
    name: "slow_add",
    description: "Adds after a short delay.",
    inputSchema,
    execute: async (args) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { sum: args.a + args.b };
    },
  },
];

const globals = [
  {
    name: "helper",
    description: "Wraps a value.",
    inputSchema: true,
    execute: async (args) => ({ wrapped: args === undefined ? null : args }),
  },
  {
    name: "spread_all",
    description: "Returns all call arguments.",
    spread: true,
    execute: async (args) => args,
  },
  {
    name: "ns.member",
    description: "Namespaced member.",
    inputSchema: true,
    execute: async (args) => `member:${JSON.stringify(args ?? null)}`,
  },
];

// The samples the host hands the sandbox (upstream execute.ts builds them with
// `renderToolSample(toCodemodeDeclaration(tool))`).
const samples = new Map(
  tools.map((tool) => [
    tool.name,
    renderToolSample({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    }),
  ]),
);

async function runScenario(name, { code, store, timeoutMs, memoryLimitBytes, sandboxOptions }) {
  const sandbox = new CodemodeSandbox({
    tools: [...(sandboxOptions?.tools ?? tools)],
    globals: [...(sandboxOptions?.globals ?? globals)],
    timeoutMs: timeoutMs ?? Number.POSITIVE_INFINITY,
    memoryLimitBytes: memoryLimitBytes ?? 256 * 1024 * 1024,
  });
  const callNames = new Set(tools.map((tool) => tool.name));
  try {
    const result = await sandbox.execute(code, { store: store ?? {} });
    return {
      name,
      // The exact inputs, so replays run the same script with the same
      // sandbox options (byte-identical to the templates above).
      input: {
        code,
        ...(store ? { store } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(memoryLimitBytes !== undefined ? { memoryLimitBytes } : {}),
      },
      ok: result.ok,
      valueJson: result.ok && result.value !== undefined ? JSON.stringify(result.value) : undefined,
      output: result.output,
      // durationMs is wall-clock; pinned to 0 (the Rust replay asserts >= 0).
      calls: result.calls.map((call) => ({
        name: call.name,
        status: call.status,
        durationMs: 0,
      })),
      // Unknown-name calls that race with finish() are dropped from `calls`
      // upstream too; nothing to pin there.
      callNamesPinned: result.calls.every((call) => callNames.has(call.name)),
      storeWrites: result.ok ? result.storeWrites : undefined,
      error: result.ok ? undefined : result.error,
    };
  } finally {
    await sandbox.close();
  }
}

// ---------------------------------------------------------------------------
// Part A scenarios
// ---------------------------------------------------------------------------

const partA = [];

partA.push(
  await runScenario("simple_call", {
    code: "const r = await tools.add({ a: 2, b: 40 });\nreturn r;",
  }),
);

partA.push(
  await runScenario("await_all_and_echo", {
    code: `const [a, b] = await Promise.all([tools.add({ a: 1, b: 1 }), tools.echo({ x: [1, 2, { y: null }] })]);
return [a.sum, b.x];`,
  }),
);

partA.push(
  await runScenario("console_and_text", {
    code: `console.log("hi", 42, true, undefined, null);
console.error("to-stderr");
text("plain");
text(3.14);
text([1, "two"]);
text({ key: "value", nested: { n: 1 } });
image("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
image({ image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" });
return "done";`,
  }),
);

partA.push(
  await runScenario("all_tools_metadata", {
    code: "return ALL_TOOLS.map((entry) => ({ name: entry.name, description: entry.description }));",
  }),
);

partA.push(
  await runScenario("globals_and_namespaces", {
    code: `const h = await helper({ v: 5 });
const m = await ns.member({ v: 6 });
const s = await spread_all(1, "two", true);
return [h, m, s];`,
  }),
);

partA.push(
  await runScenario("tool_error_script", {
    code: 'const before = await tools.add({ a: 1, b: 2 });\ntext(before.sum);\nawait tools.fail({});',
  }),
);

partA.push(
  await runScenario("tool_error_non_error_throw", {
    code: 'await tools.fail_string({});',
  }),
);

partA.push(
  await runScenario("unknown_tool", {
    code: 'await tools.nope({});',
  }),
);

partA.push(
  await runScenario("store_load_roundtrip", {
    code: `store("k", [1, "two", null]);
store("gone", undefined);
const seed = load("seed");
const missing = load("absent");
return { seed, missing };`,
    store: { seed: { n: 1, tags: ["a", "b"] } },
  }),
);

partA.push(
  await runScenario("store_value_over_limit", {
    code: `try {
  store("big", "x".repeat(256 * 1024 + 1));
  return "stored";
} catch (error) {
  return { name: error.name, message: error.message };
}`,
  }),
);

partA.push(
  await runScenario("parse_error", {
    code: "const x = ;",
  }),
);

partA.push(
  await runScenario("runtime_type_error", {
    code: 'const value = null;\nreturn value.foo;',
  }),
);

partA.push(
  await runScenario("stalled_script", {
    code: 'text("waiting");\nawait new Promise(() => {});',
  }),
);

partA.push(
  await runScenario("exit_early", {
    code: 'text("before");\nexit();\ntext("after");',
  }),
);

partA.push(
  await runScenario("exit_with_value", {
    code: 'exit({ early: true, reason: null });',
  }),
);

partA.push(
  await runScenario("unawaited_call_cancelled", {
    code: 'tools.pending({});\ntext("returned anyway");',
  }),
);

partA.push(
  await runScenario("timeout_loop", {
    code: "while (true) {}",
    timeoutMs: 120,
  }),
);

partA.push(
  await runScenario("json_number_formatting", {
    code: `return {
  s: JSON.stringify({ b: 1, a: [1, 2, null, "x\\u0000"] }),
  f: 0.1 + 0.2,
  big: 1e21,
  safe: 2 ** 53,
  special: [NaN, Infinity].map(String),
  date: new Date(0).toISOString(),
  negative: JSON.stringify(-0),
};`,
  }),
);

partA.push(
  await runScenario("bigint_text_fails", {
    code: "text(1n);",
  }),
);

partA.push(
  await runScenario("throw_non_error_value", {
    code: 'throw "plain";',
  }),
);

partA.push(
  await runScenario("deep_recursion_range_error", {
    code: "(function f() { f(); })();",
  }),
);

partA.push(
  await runScenario("memory_limit", {
    code: `const chunks = [];
while (true) chunks.push("x".repeat(1024));`,
    memoryLimitBytes: 1024 * 1024,
  }),
);

partA.push(
  await runScenario("nested_promises_and_catch", {
    code: `try {
  await tools.fail({});
} catch (error) {
  text(\`caught: \${error.message}\`);
}
const slow = await Promise.allSettled([tools.add({ a: 3, b: 4 }), tools.fail({ z: 1 })]);
return slow.map((entry) => (entry.status === "fulfilled" ? entry.value : entry.reason.message));`,
  }),
);

// ---------------------------------------------------------------------------
// Part B: the extension description pipeline (verbatim captured tool.ts)
// ---------------------------------------------------------------------------

const extensionTools = [
  {
    name: "read",
    description: "Read a file from disk.\nSupports offsets and line ranges.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path" },
        offset: { type: "number", description: "1-based line to start from" },
        limit: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "bash",
    description: "Run a shell command.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "mcp__docs__search",
    description: "Search the docs.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "mcp__docs__fetch_page",
    description: "Fetch one docs page.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "mcp__docs__call_tool_result",
    description: "Returns a full MCP CallToolResult.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    outputSchema: {
      type: "object",
      properties: {
        content: { type: "array", items: { type: "object" } },
        isError: { type: "boolean" },
        _meta: { type: "object" },
        structuredContent: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
      required: ["content", "isError", "_meta"],
    },
  },
  {
    name: "my-tool",
    description: "Name needs identifier normalization.",
    parameters: { type: "string" },
  },
];

const namespaces = new Map([
  ["mcp__docs__search", { name: "mcp__docs", description: "Documentation tools", instructions: "Presearch first." }],
  ["mcp__docs__fetch_page", { name: "mcp__docs", description: "Documentation tools", instructions: "Presearch first." }],
  ["mcp__docs__call_tool_result", { name: "mcp__docs", description: "Documentation tools", instructions: "Presearch first." }],
]);

// Serialize description options so replays can rebuild them (upstream
// CodemodeDescriptionOptions): namespaces map tool name → namespace object,
// deferred is a Set of tool names.
function descriptionOptions({ models, withNamespaces, deferred, inlineBudget } = {}) {
  return {
    ...(models ? { models: true } : {}),
    ...(withNamespaces
      ? {
          namespaces: Object.fromEntries(
            extensionTools
              .filter((tool) => namespaces.has(tool.name))
              .map((tool) => [tool.name, namespaces.get(tool.name)]),
          ),
        }
      : {}),
    ...(deferred ? { deferred: [...deferred] } : {}),
    ...(inlineBudget !== undefined ? { inlineBudget } : {}),
  };
}

const partB = {
  empty: {
    options: descriptionOptions(),
    description: createCodemodeDescription([]),
  },
  models_only: {
    options: descriptionOptions({ models: true }),
    description: createCodemodeDescription([], { models: true }),
  },
  full: {
    options: descriptionOptions({ models: true, withNamespaces: true }),
    description: createCodemodeDescription(extensionTools, {
      models: true,
      namespaces,
    }),
  },
  no_namespaces: {
    options: descriptionOptions(),
    description: createCodemodeDescription(extensionTools),
  },
  deferred: {
    options: descriptionOptions({ withNamespaces: true, deferred: new Set(["mcp__docs__fetch_page"]) }),
    description: createCodemodeDescription(extensionTools, {
      namespaces,
      deferred: new Set(["mcp__docs__fetch_page"]),
    }),
  },
  budget_tight: {
    options: descriptionOptions({ models: true, withNamespaces: true, inlineBudget: 220 }),
    description: createCodemodeDescription(extensionTools, {
      models: true,
      namespaces,
      inlineBudget: 220,
    }),
  },
  budget_partial: {
    options: descriptionOptions({ withNamespaces: true, inlineBudget: 90 }),
    description: createCodemodeDescription(extensionTools, {
      namespaces,
      inlineBudget: 90,
    }),
  },
  // The exact tool JSON the descriptions were built from (upstream
  // `AgentTool`s at the JSON seam; `outputSchema` present only where set).
  extension_tools_json: extensionTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  })),
  samples: Object.fromEntries(
    extensionTools.map((tool) => [tool.name, renderToolSample(toCodemodeDeclaration(tool))]),
  ),
  codemode_schema_json: JSON.stringify(codemodeSchema),
  model_global_declarations_json: JSON.stringify(MODEL_GLOBAL_DECLARATIONS),
};

// ---------------------------------------------------------------------------
// Part C: parseCodemodeSource
// ---------------------------------------------------------------------------

function parseCase(input) {
  try {
    const parsed = parseCodemodeSource(input);
    return { ok: true, code: parsed.code, options: parsed.options };
  } catch (error) {
    return {
      ok: false,
      name: error.name,
      message: error.message,
      isCodemodeSourceError: error.name === "CodemodeSourceError",
    };
  }
}

const partC = {
  plain: parseCase("return 1;\n"),
  options: parseCase('// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}\nreturn 1;'),
  options_no_space: parseCase('// @options:{"timeout_ms": 5}\nreturn 1;'),
  options_indent: parseCase('  // @options: {"max_output_tokens": 0}\nreturn 1;'),
  empty_input: parseCase("   \n"),
  only_options: parseCase('// @options: {"max_output_tokens": 100}'),
  options_with_body_whitespace: parseCase('// @options: {}\n   \n'),
  unknown_field: parseCase('// @options: {"nope": 1}\nreturn 1;'),
  zero_timeout: parseCase('// @options: {"timeout_ms": 0}\nreturn 1;'),
  huge_timeout: parseCase('// @options: {"timeout_ms": 2147483648}\nreturn 1;'),
  boundary_timeout: parseCase('// @options: {"timeout_ms": 2147483647}\nreturn 1;'),
  negative_tokens: parseCase('// @options: {"max_output_tokens": -1}\nreturn 1;'),
  float_tokens: parseCase('// @options: {"max_output_tokens": 1.5}\nreturn 1;'),
  array_options: parseCase("// @options: [1]\nreturn 1;"),
  invalid_json: parseCase("// @options: {bad json}\nreturn 1;"),
  crlf_first_line: parseCase('// @options: {"max_output_tokens": 7}\r\nreturn 1;'),
  no_newline_after_prefix: parseCase("// @options:"),
  non_object_tokens: parseCase('// @options: "text"\nreturn 1;'),
};

// ---------------------------------------------------------------------------
// Write the oracle
// ---------------------------------------------------------------------------

const oracle = {
  meta: {
    upstream: "pi @ 2bbfcca43",
    piCodemode: "0.99.1",
    node: process.version,
    quickjsWasmSha256: "see codemode_oracle.manifest.json",
    durationMsPinnedTo: 0,
  },
  partA,
  partB,
  partC,
};

await writeFile(
  new URL("./codemode_oracle.json", import.meta.url),
  JSON.stringify(oracle, null, 2) + "\n",
  "utf8",
);
console.log("captured", partA.length, "execution scenarios;",
  Object.keys(partB).length, "description scenarios;",
  Object.keys(partC).length, "source-parsing scenarios");
