// Byte-oracle capture for the coding-agent MCP extension slice (upstream
// 2bbfcca43, v0.99.1): stages the upstream `packages/coding-agent/src/
// extensions/mcp/{config,tools,resources,log}.ts` with their deterministic
// dependency closure (verbatim `core/mcp-servers.ts`, verbatim
// `core/tools/truncate.ts`, verbatim `packages/mcp/src/protocol/content.ts`)
// and executes them under Node's --experimental-strip-types with stubs for
// the module graph the port crops.
//
// Staged substitutions (the manifest hashes the ORIGINAL files):
//   - core/tools/render-utils.ts -> stub: formatToolCallWithArgs /
//     getTextOutput / replaceTabs are only used by the TUI renderCall /
//     renderResult component factories, which the Rust port crops.
//   - modes/interactive/components/keybinding-hints.ts -> stub (same reason).
//   - core/extensions/types.ts, pi-agent-core, pi-ai, typebox: type-only
//     imports, erased by type stripping.
//   - @earendil-works/pi-mcp / @earendil-works/pi-tui resolve through a
//     local node_modules shim: the former re-exports the verbatim staged
//     protocol/content.ts (toLlmContent), the latter is a Text stand-in only
//     referenced by the cropped renderers.
//   - ../../config.ts -> stub carrying CONFIG_DIR_NAME (".pi"), a fixed
//     getAgentDir, APP_NAME and VERSION.
//
// Determinism: no clocks (log formatting injects `new Date(FIXED_NOW)`), no
// randomness (every temp-file saver is a recorded fake), no network (server
// connections are fakes), no loopback listeners.
//
// Sanitization: scenario temp dirs are capture-host artifacts; every recorded
// string carries the `<root>` placeholder in their place (replays substitute
// their own base), like the extensions_delta_oracle.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const upstreamRoot = fileURLToPath(new URL("../../../../pi/", import.meta.url));
const codingAgentSrc = path.join(upstreamRoot, "packages", "coding-agent", "src");
const mcpPkgSrc = path.join(upstreamRoot, "packages", "mcp", "src");

const FIXED_NOW = 1758240000000;

const hashes = {};
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ext-oracle-"));
const stagedRoot = path.join(staging, "src");

function stageFile(absSource, relTarget, substitutions = []) {
  let source = fs.readFileSync(absSource, "utf8");
  hashes[relTarget] = createHash("sha256").update(source).digest("hex");
  for (const [from, to] of substitutions) {
    if (!source.includes(from)) throw new Error(`staged substitution not found in ${relTarget}: ${from}`);
    source = source.split(from).join(to);
  }
  const target = path.join(stagedRoot, ...relTarget.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return target;
}

// --- staging ---------------------------------------------------------------

// Verbatim deterministic closure.
stageFile(path.join(codingAgentSrc, "core/mcp-servers.ts"), "core/mcp-servers.ts");
stageFile(path.join(codingAgentSrc, "core/tools/truncate.ts"), "core/tools/truncate.ts");
stageFile(path.join(mcpPkgSrc, "protocol/content.ts"), "vendor_pi_mcp_content.ts");

// The mcp extension modules, verbatim.
stageFile(path.join(codingAgentSrc, "extensions/mcp/config.ts"), "extensions/mcp/config.ts");
stageFile(path.join(codingAgentSrc, "extensions/mcp/tools.ts"), "extensions/mcp/tools.ts");
stageFile(path.join(codingAgentSrc, "extensions/mcp/resources.ts"), "extensions/mcp/resources.ts");
stageFile(path.join(codingAgentSrc, "extensions/mcp/log.ts"), "extensions/mcp/log.ts");

// Stubs (disclosed; see the header).
stageFile(path.join(codingAgentSrc, "core/tools/render-utils.ts"), "core/tools/render-utils.ts", [
  [
    `import * as os from "node:os";`,
    `// stubbed: TUI-only helpers (see capture header)\nconst os = {};`,
  ],
  [
    `import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";`,
    ``,
  ],
  [
    `import type { Theme } from "../../modes/interactive/theme/theme.ts";`,
    ``,
  ],
  [
    `import { stripAnsi } from "../../utils/ansi.ts";`,
    ``,
  ],
  [
    `import { resolvePath } from "../../utils/paths.ts";`,
    ``,
  ],
  [
    `import { sanitizeBinaryOutput } from "../../utils/shell.ts";`,
    ``,
  ],
]);

fs.mkdirSync(path.join(stagedRoot, "modes/interactive/components"), { recursive: true });
fs.writeFileSync(
  path.join(stagedRoot, "modes/interactive/components/keybinding-hints.ts"),
  "export function keyHint(): string { return \"<key-hint>\"; }\n",
);

fs.writeFileSync(
  path.join(stagedRoot, "config.ts"),
  [
    "// stubbed module graph (see capture header)",
    `export const CONFIG_DIR_NAME = ".pi";`,
    `export const APP_NAME = "pi";`,
    `export const VERSION = "0.99.1";`,
    `export function getAgentDir(): string { return "/agent/pi-agent"; }`,
    ``,
  ].join("\n"),
);

// node_modules shims for the bare-specifier value imports.
const nm = path.join(staging, "node_modules", "@earendil-works");
fs.mkdirSync(path.join(nm, "pi-mcp"), { recursive: true });
fs.writeFileSync(
  path.join(nm, "pi-mcp", "package.json"),
  JSON.stringify({ name: "@earendil-works/pi-mcp", type: "module", main: "index.mjs" }),
);
fs.writeFileSync(
  path.join(nm, "pi-mcp", "index.mjs"),
  `export { toLlmContent } from ${JSON.stringify(pathToFileURL(path.join(stagedRoot, "vendor_pi_mcp_content.ts")).href)};\n`,
);
fs.mkdirSync(path.join(nm, "pi-tui"), { recursive: true });
fs.writeFileSync(
  path.join(nm, "pi-tui", "package.json"),
  JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", main: "index.mjs" }),
);
fs.writeFileSync(
  path.join(nm, "pi-tui", "index.mjs"),
  `export class Text { constructor() {} setText() {} }\n`,
);

// --- module imports ---------------------------------------------------------

const load = (rel) => import(pathToFileURL(path.join(stagedRoot, ...rel.split("/"))).href);
const mcpConfig = await load("extensions/mcp/config.ts");
const mcpTools = await load("extensions/mcp/tools.ts");
const mcpResources = await load("extensions/mcp/resources.ts");
const mcpLog = await load("extensions/mcp/log.ts");
const coreServers = await load("core/mcp-servers.ts");
const truncateUtils = await load("core/tools/truncate.ts");

// --- scenario helpers -------------------------------------------------------

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mcp-ext-${name}-`));
  return dir;
}

function write(dir, name, text) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// The scenario temp dir is a capture-host artifact; recorded paths carry the
// stable "<root>" placeholder instead (same convention as the
// extensions_delta_oracle), so replays substitute their own base.
const sanitizeRoot = (dir) => (text) => String(text).split(dir).join("<root>");

function observedConfig(loaded, sanitize = (text) => text) {
  return {
    servers: loaded.servers.map((entry) => ({
      name: entry.name,
      source: sanitize(entry.source),
      scope: entry.scope ?? null,
      config: entry.config,
    })),
    autoEnableCodemode: loaded.autoEnableCodemode ?? null,
    errors: loaded.errors.map(sanitize),
  };
}

const scenarios = [];
const scenario = (name, observed) => scenarios.push({ name, observed });

// --- 1. config_load ---------------------------------------------------------

{
  const dir = tempDir("load");
  const agentDir = path.join(dir, "agent");
  const project = path.join(dir, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });

  const cases = [];
  const runCase = (name, options) => scenario(`config_load_${name}`, observedConfig(mcpConfig.loadMcpConfig(options), sanitizeRoot(dir)));

  // a) global only
  write(agentDir, "mcp.json", JSON.stringify({
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
      docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
      sentry: { url: "https://mcp.sentry.dev/mcp" },
    },
  }, null, 2));
  runCase("global_only", { agentDir, cwd: project, projectTrusted: false });

  // b) project override + autoEnableCodemode
  write(path.join(project, ".pi"), "mcp.json", JSON.stringify({
    mcpServers: {
      docs: { url: "https://other.example.com/mcp" },
      local: { command: "bun", args: ["server.ts"], exposure: "codemode-deferred" },
    },
    autoEnableCodemode: false,
  }, null, 2));
  runCase("project_override_trusted", { agentDir, cwd: project, projectTrusted: true });
  runCase("project_ignored_untrusted", { agentDir, cwd: project, projectTrusted: false });

  // c) disabled + exposure + toolExposure + timeout + description
  write(agentDir, "mcp.json", JSON.stringify({
    mcpServers: {
      off: { command: "x", enabled: false },
      shaped: {
        command: "x",
        exposure: "direct",
        toolExposure: { "se*": "deferred", "secret*": "hidden", exact: "codemode" },
        timeout: 30,
        description: "  tools for tests  ",
      },
      alias: { url: "https://x", exposure: "codemode-deferred", type: "streamable-http" },
    },
    autoEnableCodemode: true,
  }, null, 2));
  runCase("shapes", { agentDir, cwd: project, projectTrusted: false });

  // d) errors: malformed JSON
  write(agentDir, "mcp.json", "{");
  runCase("malformed_json", { agentDir, cwd: project, projectTrusted: false });

  // e) errors: wrong shapes
  write(agentDir, "mcp.json", JSON.stringify({ mcpServers: 5 }));
  runCase("mcpServers_number", { agentDir, cwd: project, projectTrusted: false });
  write(agentDir, "mcp.json", "[]");
  runCase("top_level_array", { agentDir, cwd: project, projectTrusted: false });
  write(agentDir, "mcp.json", JSON.stringify({ mcpServers: {}, autoEnableCodemode: "yes" }));
  runCase("autoEnableCodemode_string", { agentDir, cwd: project, projectTrusted: false });
  write(agentDir, "mcp.json", JSON.stringify({ mcpServers: {} }));
  runCase("no_mcpServers_key", { agentDir, cwd: project, projectTrusted: false });

  // f) per-server validation errors
  const badServers = {
    "bad name": { command: "x" },
    exposure: { command: "x", exposure: "nope" },
    toolExposure: { command: "x", toolExposure: 5 },
    toolEntry: { command: "x", toolExposure: { t: "no" } },
    enabled: { command: "x", enabled: "yes" },
    timeout: { command: "x", timeout: 0 },
    legacySse: { type: "sse", url: "https://x" },
    badUrl: { url: "ftp://x" },
    badHeaders: { url: "https://x", headers: 5 },
    badPort: { url: "https://x", oauth: { callbackPort: 0 } },
    badCallbackUrl: { url: "https://x", oauth: { callbackUrl: "https://x/cb" } },
    badArgs: { command: "x", args: [1] },
    badEnv: { command: "x", env: { A: 1 } },
    noTransport: {},
    entryNumber: 5,
  };
  write(agentDir, "mcp.json", JSON.stringify({ mcpServers: badServers }));
  runCase("validation_errors", { agentDir, cwd: project, projectTrusted: false });

  // g) missing files entirely
  runCase("missing_files", { agentDir: path.join(dir, "absent-agent"), cwd: path.join(dir, "absent-project"), projectTrusted: true });

}

// --- 2. config_update -------------------------------------------------------

{
  const observed = {};
  const dir = tempDir("update");
  // a) two-space file: enable→remove key, exposure set
  const twoSpace = write(dir, "two.json", JSON.stringify({
    mcpServers: { fs: { command: "npx", exposure: "direct" }, other: { command: "y" } },
    autoEnableCodemode: true,
  }, null, 2) + "\n");
  mcpConfig.updateMcpServerConfig(twoSpace, "fs", { enabled: false });
  mcpConfig.updateMcpServerConfig(twoSpace, "fs", { exposure: "deferred" });
  mcpConfig.updateMcpServerConfig(twoSpace, "other", { enabled: true, exposure: "codemode" });
  observed.two_space = fs.readFileSync(twoSpace, "utf8");

  // b) tab-indented file keeps its indentation
  const tabbed = write(dir, "tab.json", "{\n\t\"mcpServers\": {\n\t\t\"fs\": {\"command\": \"npx\"}\n\t}\n}\n");
  mcpConfig.updateMcpServerConfig(tabbed, "fs", { enabled: false, exposure: "hidden" });
  observed.tab = fs.readFileSync(tabbed, "utf8");

  // c) errors
  try {
    mcpConfig.updateMcpServerConfig(twoSpace, "missing", { enabled: true });
  } catch (error) {
    observed.update_missing = sanitizeRoot(dir)(error.message);
  }
  try {
    mcpConfig.updateMcpServerConfig(write(dir, "broken.json", "[]"), "fs", { enabled: true });
  } catch (error) {
    observed.update_broken = sanitizeRoot(dir)(error.message);
  }

  // d) add (creates directories), replace, remove
  const addPath = path.join(dir, "nested", "deep", "mcp.json");
  const addedFirst = mcpConfig.addMcpServerConfig(addPath, "fs", { command: "npx" });
  const addedSecond = mcpConfig.addMcpServerConfig(addPath, "fs", { command: "bun" });
  observed.add = { addedFirst, addedSecond, text: fs.readFileSync(addPath, "utf8") };
  observed.remove_existing = mcpConfig.removeMcpServerConfig(addPath, "fs");
  observed.remove_missing = mcpConfig.removeMcpServerConfig(addPath, "fs");
  observed.remove_absent_file = mcpConfig.removeMcpServerConfig(path.join(dir, "nope.json"), "fs");

  scenario("config_update", observed);
}

// --- 3. tool names ----------------------------------------------------------

{
  const observed = {};
  const hashSuffix = (server, tool) =>
    createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  observed.basic = mcpTools.createMcpToolName("docs", "search");
  observed.sanitized = mcpTools.createMcpToolName("my.server-1", "a.b/c");
  observed.unicode = mcpTools.createMcpToolName("s", "t\u00e9st");
  observed.taken = mcpTools.createMcpToolName("s", "a.b", (name) => name === "mcp__s__a_b");
  observed.taken_hash = hashSuffix("s", "a.b");
  const longTool = "t".repeat(200);
  const longName = mcpTools.createMcpToolName("s", longTool);
  observed.long = { length: longName.length, suffix: longName.slice(-9), expectedSuffix: `_${hashSuffix("s", longTool)}` };
  scenario("tool_names", observed);
}

// --- 4. tool definitions ----------------------------------------------------

{
  const observed = [];
  const tools = [
    {
      name: "search",
      description: "  Search the docs.  ",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "no.schema",
      inputSchema: { properties: {} },
      title: "Fallback title",
      annotations: { title: "Annotation title", readOnlyHint: true, destructiveHint: false, otherHint: true },
    },
    {
      name: "full",
      description: "Full tool",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", properties: { answer: { type: "string" } } },
    },
    {
      name: "hidden_override",
      description: "Hidden by toolExposure",
      inputSchema: { type: "string" },
    },
  ];
  const config = coreServers.validateMcpServerConfig("docs", {
    command: "x",
    exposure: "direct",
    toolExposure: { hidden_override: "hidden", "no.*": "deferred" },
  });
  for (const tool of tools) {
    const exposure = coreServers.getMcpToolExposure(config, tool.name);
    const definition = mcpTools.createMcpToolDefinition({
      server: "docs",
      tool,
      name: mcpTools.createMcpToolName("docs", tool.name),
      exposure,
      namespace: { name: "mcp__docs", description: "Docs tools", instructions: "Use search first" },
      timeoutMs: 45000,
      getClient: async () => ({ callTool: async () => { throw new Error("not called"); } }),
      readableResources: () => false,
    });
    observed.push({
      tool: tool.name,
      exposure,
      toToolExposure: mcpTools.toToolExposure(exposure),
      declaration: {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters,
        outputSchema: definition.outputSchema,
        exposure: definition.exposure,
        namespace: definition.namespace,
        annotations: definition.annotations ?? null,
      },
    });
  }
  scenario("tool_definitions", observed);
}

// --- 5. result conversion ---------------------------------------------------

{
  const saverCalls = [];
  const saver = async (data, extension) => {
    const call = { extension, length: data.length, text: typeof data === "string" ? data : null };
    saverCalls.push(call);
    return `/tmp/fake-output-${saverCalls.length}${extension}`;
  };
  const failingSaver = async () => {
    throw new Error("disk on fire");
  };
  const observed = { saverCalls };

  const convert = (name, server, tool, raw, options) => {
    // The client's `validateCallToolResult` normalizes `content` to `[]`;
    // mirror that before the converter sees the result.
    const result = { content: [], ...raw };
    return mcpTools.convertMcpResult(server, tool, result, options).then((value) => ({ name, value }));
  };

  const conversions = await Promise.all([
    convert("plain_text", "docs", "search", { content: [{ type: "text", text: "hello" }] }, { saveOutput: saver }),
    convert("multi_block_join", "docs", "search", { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, { saveOutput: saver }),
    convert("image", "docs", "pic", { content: [{ type: "image", data: "Zm9v", mimeType: "image/png" }] }, { saveOutput: saver }),
    convert("audio", "docs", "say", { content: [{ type: "audio", data: "Zm9v", mimeType: "audio/wav" }] }, { saveOutput: saver }),
    convert(
      "resource_link",
      "docs",
      "link",
      { content: [{ type: "resource_link", uri: "file:///a.txt", name: "a.txt", title: "A", mimeType: "text/plain", size: 2048, description: "A file" }] },
      { saveOutput: saver, readableResources: true },
    ),
    convert(
      "resource_link_unreadable",
      "docs",
      "link",
      { content: [{ type: "resource_link", uri: "file:///a.txt", name: "a.txt" }] },
      { saveOutput: saver, readableResources: false },
    ),
    convert(
      "embedded_text_resource",
      "docs",
      "read",
      { content: [{ type: "resource", resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "contents" } }] },
      { saveOutput: saver },
    ),
    convert(
      "embedded_json_blob",
      "docs",
      "read",
      { content: [{ type: "resource", resource: { uri: "https://x/a.json", mimeType: "application/json", blob: Buffer.from('{"k":1}').toString("base64") } }] },
      { saveOutput: saver },
    ),
    convert(
      "embedded_binary_blob",
      "docs",
      "read",
      { content: [{ type: "resource", resource: { uri: "https://x/a.bin", mimeType: "application/octet-stream", blob: Buffer.from([0, 1, 2, 3]).toString("base64") } }] },
      { saveOutput: saver },
    ),
    convert(
      "embedded_binary_save_fails",
      "docs",
      "read",
      { content: [{ type: "resource", resource: { uri: "https://x/a.bin", blob: Buffer.from([9]).toString("base64") } }] },
      { saveOutput: failingSaver },
    ),
    convert("structured_only", "docs", "structured", { structuredContent: { answer: 42 } }, { saveOutput: saver }),
    convert(
      "is_error_no_text",
      "docs",
      "boom",
      { content: [], structuredContent: { code: 7 }, isError: true },
      { saveOutput: saver },
    ),
    convert(
      "is_error_with_text",
      "docs",
      "boom",
      { content: [{ type: "text", text: "explicit failure" }], isError: true },
      { saveOutput: saver },
    ),
    convert("_meta_dropped", "docs", "meta", { content: [{ type: "text", text: "x" }], _meta: { hidden: true } }, { saveOutput: saver }),
    convert("empty", "docs", "empty", {}, { saveOutput: saver }),
    convert("truncated", "docs", "big", { content: [{ type: "text", text: "a".repeat(30000) }, { type: "image", data: "Zm9v", mimeType: "image/png" }] }, { saveOutput: saver }),
    convert("truncate_save_fails", "docs", "big", { content: [{ type: "text", text: "b".repeat(30000) }] }, { saveOutput: failingSaver }),
  ]);
  observed.conversions = conversions;
  scenario("result_conversion", observed);
}

// --- 6. resources tools -----------------------------------------------------

{
  const observed = {};
  const mkServer = (name, data) => ({
    name,
    timeoutMs: 1234,
    resourcesPage: async (cursor) => {
      if (data.failPage) throw new Error(`page failed: ${name}`);
      const items = (cursor ? data.resources.slice(1) : data.resources);
      return { resources: items, nextCursor: cursor ? undefined : data.nextCursor };
    },
    resourceTemplatesPage: async (cursor) => {
      if (data.failPage) throw new Error(`templates failed: ${name}`);
      const items = (cursor ? data.templates.slice(1) : data.templates);
      return { resourceTemplates: items, nextCursor: cursor ? undefined : data.nextCursor };
    },
    allResources: async () => {
      if (data.failAll) throw new Error(`all failed: ${name}`);
      return data.resources;
    },
    allResourceTemplates: async () => {
      if (data.failAll) throw new Error(`all templates failed: ${name}`);
      return data.templates;
    },
    readResource: async (uri) => {
      if (data.failRead) throw new Error(`read failed: ${name}`);
      if (uri === "file:///empty") return { contents: [] };
      return { contents: data.contents ?? [{ uri, mimeType: "text/plain", text: `content of ${uri}` }] };
    },
  });

  const alpha = mkServer("alpha", {
    resources: [
      { uri: "ui://app/main", name: "app", mimeType: "text/html" },
      { uri: "file:///a.txt", name: "a.txt", title: "A", description: "File a", mimeType: "text/plain", size: 3, _meta: { hidden: true }, icons: [{ src: "x" }] },
      { uri: "file:///b.html", name: "b.html", mimeType: "application/xhtml+xml; profile=mcp-app" },
      { uri: "file:///c.md", name: "c.md", mimeType: "text/markdown" },
    ],
    templates: [
      { uriTemplate: "file:///{path}", name: "path", _meta: { x: 1 } },
      { uriTemplate: "ui://app/{view}", name: "view" },
    ],
    nextCursor: "page-2",
    contents: [
      { uri: "file:///a.txt", mimeType: "text/plain", text: "first" },
      { uri: "file:///b.txt", mimeType: "text/plain", text: "second" },
    ],
  });
  const beta = mkServer("Beta", {
    resources: [{ uri: "file:///z.bin", name: "z.bin", mimeType: "application/octet-stream" }],
    templates: [],
    failAll: true,
    failPage: true,
    failRead: true,
  });

  const servers = () => [alpha, beta];
  const definitions = mcpResources.createMcpResourceToolDefinitions({
    exposure: "direct",
    servers,
  });
  observed.definitions = definitions.map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    outputSchema: definition.outputSchema,
    exposure: definition.exposure,
    annotations: definition.annotations ?? null,
  }));

  const execute = async (definition, params) => {
    try {
      const result = await definition.execute("call-1", params, undefined, undefined, {});
      return { ok: true, content: result.content, details: result.details, structuredContent: result.structuredContent, isError: result.isError ?? null };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };
  const [listResources, listTemplates, readResource] = definitions;

  observed.list_all = await execute(listResources, {});
  observed.list_one = await execute(listResources, { server: "alpha" });
  observed.list_one_page2 = await execute(listResources, { server: "alpha", cursor: "page-2" });
  observed.list_unknown_server = await execute(listResources, { server: "gamma" });
  observed.list_cursor_without_server = await execute(listResources, { cursor: "page-2" });
  observed.list_bad_param = await execute(listResources, { server: 5 });
  observed.templates_all = await execute(listTemplates, {});
  observed.templates_one = await execute(listTemplates, { server: "alpha" });
  observed.read_multi = await execute(readResource, { server: "alpha", uri: "file:///a.txt" });
  observed.read_single = await execute(readResource, { server: "alpha", uri: "file:///only" });
  observed.read_empty = await execute(readResource, {
    server: "alpha",
    uri: "file:///empty",
    __contents: [],
  });
  observed.read_missing_args = await execute(readResource, {});
  observed.read_unknown_server = await execute(readResource, { server: "gamma", uri: "x" });
  observed.read_failed = await execute(readResource, { server: "Beta", uri: "x" });

  scenario("resources_tools", observed);
}

// --- 7. log formatting ------------------------------------------------------

{
  const now = new Date(FIXED_NOW);
  const observed = {
    plain: mcpLog.formatMcpLogMessage("docs", { level: "debug", logger: "db", data: "ready" }, now),
    defaults: mcpLog.formatMcpLogMessage("docs", { data: { a: 1 } }, now),
    no_data: mcpLog.formatMcpLogMessage("docs", { level: "warn" }, now),
    non_record: mcpLog.formatMcpLogMessage("docs", "raw string", now),
    number_data: mcpLog.formatMcpLogMessage("docs", 42, now),
    newlines: mcpLog.formatMcpLogMessage("docs", { data: "a\nb\r\nc" }, now),
    empty_logger: mcpLog.formatMcpLogMessage("docs", { logger: "", data: "x" }, now),
  };
  scenario("log_format", observed);
}

// --- 8. truncate middle + format size (shared with the ported tool bridge) --

{
  const observed = {
    short: truncateUtils.truncateMiddle("hello world", 100),
    exact: truncateUtils.truncateMiddle("hello world", 11),
    ascii: truncateUtils.truncateMiddle("hello world", 5),
    multibyte: truncateUtils.truncateMiddle("héllo wörld — ünïcode ✓✓", 10),
    lines: truncateUtils.truncateMiddle("a\nb\nc\n", 4),
    sizes: [0, 512, 1023, 1024, 1025, 1048575, 1048576, 2097152].map((bytes) => truncateUtils.formatSize(bytes)),
  };
  scenario("truncate_middle", observed);
}

// --- write ------------------------------------------------------------------

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "oracle");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "mcp_extension_oracle.json"),
  JSON.stringify({ fixedNow: FIXED_NOW, scenarios }, null, 2) + "\n",
);
fs.writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify({ upstream: "pi@2bbfcca43", sha256: hashes }, null, 2) + "\n",
);
console.log(`captured ${scenarios.length} scenarios -> ${outDir}`);
