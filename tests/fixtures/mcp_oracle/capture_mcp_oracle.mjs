// Byte-oracle capture for the mcp slice (upstream 2bbfcca43, v0.99.1): copies
// the UNMODIFIED upstream `packages/mcp/src` TypeScript (the package has NO
// runtime dependencies besides cross-spawn) into a temp directory, hashing
// every file for the provenance manifest, and executes it under Node's
// --experimental-strip-types with deterministic stubs.
//
// Determinism contract shared with the Rust port (src/mcp):
//   - Date.now -> 1758240000000 (constant FIXED_NOW).
//   - globalThis.crypto.getRandomValues -> deterministic stream: draw k fills
//     byte[i] = (k*32 + i) & 0xFF. The draw counter RESETS TO ZERO at the
//     start of every scenario; draws are sequential within a scenario.
//     crypto.subtle is the REAL WebCrypto, so captured PKCE challenges are
//     the true SHA-256 of the deterministic verifiers; the Rust side pins
//     them as constants.
//   - Math.random is never used by the package.
//   - globalThis.fetch is NEVER patched; every HTTP scenario injects a
//     recorder fetch through the package's own `fetch` options (no network).
//     The one real loopback listener is the OAuth callback server, hit with
//     raw sockets (Node's undici does not honor *_PROXY env vars; the Rust
//     side likewise uses raw tokio TCP).
//
// One DOCUMENTED textual substitution in the STAGED copies only (the
// manifest hashes the ORIGINAL files):
//   - packages/mcp/src/transports/stdio.ts: `import crossSpawn from
//     "cross-spawn"` -> `import { spawn as crossSpawn } from
//     "node:child_process"`.
//     ESM bare specifiers cannot resolve without node_modules; the stdio
//     scenarios spawn a direct executable (node.exe), where cross-spawn
//     delegates to node's spawn with identical options, so behavior is
//     unchanged.
//
// Framing note: upstream stdio framing is NEWLINE-DELIMITED JSON
// (`JSON.stringify(message) + "\n"` per direction), NOT LSP-style
// Content-Length framing. The raw stdin bytes the fixture server records are
// the byte oracle for the Rust transport.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { createHash } from "node:crypto";
import { webcrypto } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const upstreamRoot = fileURLToPath(new URL("../../../../pi/", import.meta.url));
const mcpSrc = path.join(upstreamRoot, "packages", "mcp", "src");

const FIXED_NOW = 1758240000000;

const hashes = {};
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oracle-"));
const stagedRoot = path.join(staging, "packages", "mcp", "src");

// --- staging ---------------------------------------------------------------

function stageFile(rel, substitutions = []) {
  const abs = path.join(mcpSrc, ...rel.split("/"));
  let source = fs.readFileSync(abs, "utf8");
  hashes[`packages/mcp/src/${rel}`] = createHash("sha256").update(source).digest("hex");
  for (const [from, to] of substitutions) {
    if (!source.includes(from)) throw new Error(`staged substitution not found in ${rel}: ${from}`);
    source = source.split(from).join(to);
  }
  const target = path.join(stagedRoot, ...rel.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

for (const rel of [
  "auth-provider.ts", "client.ts", "index.ts",
  "oauth/callback.ts", "oauth/discovery.ts", "oauth/errors.ts", "oauth/flow.ts",
  "oauth/index.ts", "oauth/provider.ts", "oauth/types.ts",
  "protocol/content.ts", "protocol/jsonrpc.ts", "protocol/types.ts",
  "testing/index.ts",
  "transports/in-memory.ts", "transports/stdio.ts", "transports/streamable-http.ts",
  "transports/transport.ts",
]) {
  stageFile(rel, rel === "transports/stdio.ts"
    ? [['import crossSpawn from "cross-spawn";', 'import { spawn as crossSpawn } from "node:child_process";']]
    : []);
}

const mcp = await import(pathToFileURL(path.join(stagedRoot, "index.ts")).href);
const oauth = await import(pathToFileURL(path.join(stagedRoot, "oauth", "index.ts")).href);
// `createInMemoryTransportPair` lives on the ./testing entry, not the root.
const testing = await import(pathToFileURL(path.join(stagedRoot, "testing", "index.ts")).href);
// The oauth parse* validators are internal to the package (not re-exported by
// oauth/index.ts); import the module directly for the capture.
const oauthTypes = await import(pathToFileURL(path.join(stagedRoot, "oauth", "types.ts")).href);
// `consumeSseStream` is exported by the streamable-http module but not
// re-exported from the root entry; import the module directly for the capture.
const streamableHttp = await import(pathToFileURL(path.join(stagedRoot, "transports", "streamable-http.ts")).href);

// --- deterministic stubs ---------------------------------------------------

let rngDraw = 0;
const draw = (n) => {
  const k = rngDraw++;
  return Buffer.from({ length: n }, (_, i) => (k * 32 + i) & 0xFF);
};
// globalThis.crypto is getter-only in modern Node; replace via defineProperty.
const deterministicCrypto = {
  getRandomValues(array) {
    const bytes = draw(array.byteLength);
    for (let i = 0; i < array.byteLength; i++) array[i] = bytes[i];
    return array;
  },
  subtle: webcrypto.subtle,
};
Object.defineProperty(globalThis, "crypto", { value: deterministicCrypto, configurable: true });
Date.now = () => FIXED_NOW;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scenarios = {};
const only = process.env.MCP_ORACLE_ONLY ? process.env.MCP_ORACLE_ONLY.split(",") : null;
async function scenario(name, fn) {
  if (only && !only.includes(name)) return;
  rngDraw = 0; // per-scenario RNG reset (see manifest)
  try {
    scenarios[name] = await fn();
  } catch (error) {
    scenarios[name] = { __captureError: String(error?.stack ?? error) };
  }
}


const json = (value) => JSON.parse(JSON.stringify(value));
const str = (value) => JSON.stringify(value);

// A recorder fetch: records {url, method, headers, body} per request and
// answers via handler(url, record, index) -> {status, headers, body|chunks,
// delayMs?}. Throwing from the handler rejects the fetch (network failure).
function recorderFetch(handler) {
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const headers = {};
    if (init.headers) {
      const raw = init.headers;
      if (typeof raw.forEach === "function") raw.forEach((value, key) => { headers[key] = value; });
      else for (const [key, value] of Object.entries(raw)) headers[key] = value;
    }
    let body;
    if (init.body !== undefined) body = typeof init.body === "string" ? init.body : String(init.body);
    const record = { url: url.href, method: init.method ?? "GET", headers, body };
    requests.push(record);
    const answer = await handler(url, record, requests.length - 1);
    if (answer instanceof Error) throw answer;
    const chunks = answer.chunks ?? (answer.body !== undefined ? [answer.body] : []);
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        }
        controller.close();
      },
    });
    if (answer.delayMs) await sleep(answer.delayMs);
    return new Response(stream, { status: answer.status ?? 200, headers: new Headers(answer.headers ?? {}) });
  };
  return { fetch, requests };
}

// A fake in-memory MCP server (mirrors upstream test helpers): records every
// received message, dispatches to per-method handlers over a microtask.
async function memoryServer() {
  const pair = testing.createInMemoryTransportPair();
  const messages = [];
  const handlers = new Map();
  pair.server.onMessage((message) => {
    messages.push(json(message));
    if (!("id" in message) || !("method" in message)) return;
    const request = message;
    queueMicrotask(async () => {
      try {
        if (!handlers.has(request.method)) throw new mcp.McpError(-32601, `Method not found: ${request.method}`);
        const result = await handlers.get(request.method)(request);
        await pair.server.send({ jsonrpc: "2.0", id: request.id, result: result === undefined ? {} : result });
      } catch (error) {
        const e = error instanceof mcp.McpError ? error : new mcp.McpError(-32603, String(error));
        await pair.server.send({ jsonrpc: "2.0", id: request.id, error: { code: e.code, message: e.message, data: e.data } });
      }
    });
  });
  await pair.server.start();
  handlers.set("initialize", () => ({
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: "test-server", version: "1.0.0" },
    instructions: "Use test tools.",
  }));
  // The McpClient's own default handler answers ping with {}.
  handlers.set("ping", () => ({}));
  return { pair, messages, handlers };
}

// ---------------------------------------------------------------------------
// 1. protocol/jsonrpc.ts
// ---------------------------------------------------------------------------
await scenario("jsonrpc", async () => {
  const out = { errorCodes: mcp.JSON_RPC_ERROR_CODES, parse: [] };
  const cases = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: "abc", method: "m", params: { a: 1 } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "n", params: [1, 2] },
    { jsonrpc: "2.0", id: 2, result: { ok: true } },
    { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "no" } },
    { jsonrpc: "2.0", id: 2, error: { code: -1, message: "d", data: { x: 1 } } },
    { jsonrpc: "2.0", id: 2, result: {}, error: { code: 1, message: "both" } },
    { jsonrpc: "2.0", id: 2, error: { code: "x", message: "bad code" } },
    { jsonrpc: "2.0", id: 2, error: { message: "no code" } },
    { jsonrpc: "2.0", id: 2, error: "string error" },
    { jsonrpc: "2.0", id: 2 },
    { jsonrpc: "2.0", id: 1.5, method: "m" },
    { jsonrpc: "2.0", id: 1, method: "m", result: {} },
    { jsonrpc: "1.0", id: 1, method: "m" },
    { jsonrpc: "2.0", id: true, method: "m" },
    { jsonrpc: "2.0", method: "m", id: undefined },
    { jsonrpc: "2.0" },
    [1, 2],
    "text",
    null,
    42,
    { jsonrpc: "2.0", id: 2000, method: "m" },
  ];
  for (const value of cases) {
    try {
      const parsed = mcp.parseJsonRpcMessage(value);
      out.parse.push({ input: value, ok: parsed });
    } catch (error) {
      out.parse.push({ input: value, errorName: error.name, errorCode: error.code, errorMessage: error.message });
    }
  }
  const mcpError = new mcp.McpError(-32000, "custom failure", { detail: 1 });
  const noData = new mcp.McpError(-32001, "no data");
  out.errors = {
    mcp: { name: mcpError.name, code: mcpError.code, message: mcpError.message, data: mcpError.data },
    mcpNoData: { name: noData.name, code: noData.code, message: noData.message, data: noData.data },
    connectionClosed: (() => { const e = new mcp.McpConnectionClosedError(); return { name: e.name, message: e.message }; })(),
    connectionClosedCustom: (() => { const e = new mcp.McpConnectionClosedError("MCP client is idle"); return { name: e.name, message: e.message }; })(),
    timeout: (() => { const e = new mcp.McpTimeoutError(30000); return { name: e.name, message: e.message, timeoutMs: e.timeoutMs }; })(),
    abort: (() => { const e = new mcp.McpAbortError(); return { name: e.name, message: e.message }; })(),
  };
  // JSON.stringify drops data:undefined, pinning error-object key order.
  out.errorObjectStringify = JSON.stringify({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "boom", data: undefined } });
  return out;
});

// ---------------------------------------------------------------------------
// 2. client.ts handshake + lifecycle
// ---------------------------------------------------------------------------
await scenario("client_handshake", async () => {
  const { pair, messages } = await memoryServer();
  const client = new mcp.McpClient({
    name: "pi", version: "1.2.3", title: "Pi",
    capabilities: { sampling: {} },
    roots: [{ uri: "file:///work", name: "work" }],
  });
  const result = await client.connect(pair.client);
  const out = {
    // Key-order oracle for the initialize request and initialized notification.
    initializeSent: str(messages[0]),
    initializedSent: str(messages[1]),
    protocolVersion: client.protocolVersion,
    serverInfo: client.serverInfo,
    serverCapabilities: client.serverCapabilities,
    instructions: client.instructions,
    connectionState: client.connectionState,
    result: json(result),
  };
  await client.ping();
  out.afterHandshake = messages.slice(2).map(str);
  await client.close();
  out.stateAfterClose = client.connectionState;
  // Closing twice is fine; connecting again from closed fails.
  try { await client.connect(pair.client); } catch (error) { out.reconnectError = error.message; }
  return out;
});

await scenario("client_state_errors", async () => {
  const out = {};
  const idle = new mcp.McpClient({ name: "pi", version: "1" });
  try { await idle.request("ping"); } catch (error) { out.requestIdle = { name: error.name, message: error.message }; }
  try { await idle.notify("x"); } catch (error) { out.notifyIdle = { name: error.name, message: error.message }; }
  const { pair } = await memoryServer();
  const client = new mcp.McpClient({ name: "pi", version: "1" });
  await client.connect(pair.client);
  try { await client.connect(pair.client); } catch (error) { out.connectTwice = error.message; }
  // Unsupported protocol version.
  const pair2 = testing.createInMemoryTransportPair();
  await pair2.server.start();
  pair2.server.onMessage((message) => {
    if (message.method === "initialize") {
      void pair2.server.send({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "1999-01-01", capabilities: {}, serverInfo: { name: "s", version: "0" } },
      });
    }
  });
  const badVersion = new mcp.McpClient({ name: "pi", version: "1" });
  try { await badVersion.connect(pair2.client); } catch (error) { out.unsupportedVersion = error.message; }
  // Invalid initialize result.
  const pair3 = testing.createInMemoryTransportPair();
  await pair3.server.start();
  pair3.server.onMessage((message) => {
    if (message.method === "initialize") {
      void pair3.server.send({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: 4, version: "0" } },
      });
    }
  });
  const badInit = new mcp.McpClient({ name: "pi", version: "1" });
  try { await badInit.connect(pair3.client); } catch (error) { out.invalidInitialize = { name: error.name, code: error.code, message: error.message }; }
  return out;
});

// ---------------------------------------------------------------------------
// 3. client.ts request/notify shapes
// ---------------------------------------------------------------------------
await scenario("client_request_shapes", async () => {
  const { pair, messages, handlers } = await memoryServer();
  const client = new mcp.McpClient({ name: "pi", version: "1" });
  await client.connect(pair.client);
  handlers.set("tools/list", () => ({ tools: [{ name: "a", inputSchema: { type: "object" } }], _meta: { total: 1 } }));
  handlers.set("tools/call", (request) => {
    if (request.params?.name === "echo") return { content: [{ type: "text", text: "hi" }], structuredContent: { v: 1 } };
    return { structuredContent: { only: "structured" } };
  });
  handlers.set("resources/read", () => ({ contents: [{ uri: "file:///x", text: "data" }] }));
  let resourcePages = 0;
  handlers.set("resources/list", () => {
    resourcePages++;
    if (resourcePages === 1) return { resources: [{ uri: "file:///a", name: "a" }, { uri: "file:///b" }] };
    return { resources: [{ uri: "file:///c" }], nextCursor: "page2" };
  });
  handlers.set("resources/templates/list", () => ({ resourceTemplates: [{ uriTemplate: "t://{x}" }] }));
  const out = {};
  await client.listTools();
  const echo = await client.callTool("echo", { text: "hello" });
  const bare = await client.callTool("noargs");
  const read = await client.readResource("file:///x");
  const resources = await client.listResources();
  const templates = await client.listResourceTemplates();
  out.requests = {
    toolsList: str(messages.find((m) => m.method === "tools/list")),
    toolsCallWithArgs: str(messages.find((m) => m.method === "tools/call" && m.params?.name === "echo")),
    toolsCallBare: str(messages.find((m) => m.method === "tools/call" && m.params?.name === "noargs")),
    resourcesRead: str(messages.find((m) => m.method === "resources/read")),
    resourcesListPage1: str(messages.find((m) => m.method === "resources/list" && !m.params)),
    resourcesListPage2: str(messages.find((m) => m.method === "resources/list" && m.params?.cursor === "page2")),
    resourcesTemplates: str(messages.find((m) => m.method === "resources/templates/list")),
  };
  out.callToolEcho = json(echo);
  out.callToolBare = json(bare); // content defaulted to []
  out.readResource = json(read);
  out.resources = json(resources); // second resource name defaults to uri
  out.templates = json(templates); // template name defaults to uriTemplate
  // Plain request with params and id continuity.
  handlers.set("custom/method", (request) => ({ saw: request.params }));
  out.custom = json(await client.request("custom/method", { z: 1, a: 2 }));
  out.allRequestIds = messages.filter((m) => "id" in m).map((m) => m.id);
  await client.close();
  return out;
});

await scenario("client_pagination", async () => {
  const { pair, messages, handlers } = await memoryServer();
  const client = new mcp.McpClient({ name: "pi", version: "1" });
  await client.connect(pair.client);
  const out = {};
  let pages = 0;
  handlers.set("tools/list", () => {
    pages++;
    if (pages === 1) return { tools: [{ name: "a", inputSchema: {} }], nextCursor: "c1" };
    return { tools: [{ name: "b", inputSchema: {} }], nextCursor: "c1" }; // duplicate cursor
  });
  try { await client.listTools(); } catch (error) { out.duplicateCursor = error.message; }
  handlers.set("tools/list", (request) => {
    const cursor = request.params?.cursor;
    if (!cursor) return { tools: [{ name: "0", inputSchema: {} }], nextCursor: "p1" };
    if (cursor === "p1") return { tools: [{ name: "1", inputSchema: {} }], nextCursor: "p2" };
    return { tools: [{ name: "2", inputSchema: {} }] };
  });
  out.multiPage = json(await client.listTools());
  // Single-page surfaces with cursors.
  let pageCalls = 0;
  handlers.set("resources/list", () => {
    pageCalls++;
    return pageCalls === 1
      ? { resources: [{ uri: "file:///1", name: "one" }], nextCursor: "z" }
      : { resources: [{ uri: "file:///2", name: "two" }] };
  });
  const firstPage = await client.listResourcesPage();
  const secondPage = await client.listResourcesPage(firstPage.nextCursor);
  out.resourcesPages = [json(firstPage), json(secondPage)];
  out.pageRequests = messages.filter((m) => m.method === "resources/list").map(str);
  // Validation failures.
  handlers.set("tools/list", () => ({ tools: "not an array" }));
  try { await client.listTools(); } catch (error) { out.invalidList = { name: error.name, code: error.code, message: error.message }; }
  handlers.set("tools/list", () => ({ tools: [{ inputSchema: {} }] }));
  try { await client.listTools(); } catch (error) { out.invalidEntry = { code: error.code, message: error.message }; }
  handlers.set("tools/list", () => ({ tools: [], nextCursor: 5 }));
  try { await client.listTools(); } catch (error) { out.invalidCursor = { code: error.code, message: error.message }; }
  handlers.set("resources/read", () => ({ contents: [{ uri: "file:///x" }] }));
  try { await client.readResource("file:///x"); } catch (error) { out.invalidContents = { code: error.code, message: error.message }; }
  handlers.set("tools/call", () => ({ content: "nope" }));
  try { await client.callTool("x"); } catch (error) { out.invalidCallResult = { code: error.code, message: error.message }; }
  handlers.set("tools/call", () => ({ content: [], structuredContent: [1] }));
  try { await client.callTool("x"); } catch (error) { out.invalidStructured = { code: error.code, message: error.message }; }
  await client.close();
  return out;
});

// ---------------------------------------------------------------------------
// 4. client.ts progress, cancellation, timeout
// ---------------------------------------------------------------------------
await scenario("client_progress", async () => {
  const { pair, messages, handlers } = await memoryServer();
  const client = new mcp.McpClient({ name: "pi", version: "1" });
  await client.connect(pair.client);
  const out = {};
  const progressEvents = [];
  handlers.set("long/op", (request) => {
    out.longOpRequest = str(request);
    const token = request.params?._meta?.progressToken;
    return new Promise((resolve) => {
      setTimeout(() => {
        void pair.server.send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2, message: "half" } });
        setTimeout(() => {
          void pair.server.send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 2 } });
          resolve({ done: true });
        }, 10);
      }, 10);
    });
  });
  const result = await client.request("long/op", { q: 1 }, {
    onProgress: (progress) => progressEvents.push(json(progress)),
    timeoutMs: 5000,
  });
  out.result = json(result);
  out.progressEvents = progressEvents;
  // A progress notification for an unknown token is ignored.
  await pair.server.send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 9999, progress: 1 } });
  await sleep(20);
  await client.close();
  return out;
});

await scenario("client_abort_and_timeout", async () => {
  const { pair, messages, handlers } = await memoryServer();
  const client = new mcp.McpClient({ name: "pi", version: "1" });
  await client.connect(pair.client);
  const out = {};
  handlers.set("slow", () => new Promise(() => {})); // never answers

  // Abort with a custom reason string (deterministic across runtimes).
  const controller = new AbortController();
  const pending = client.request("slow", undefined, { signal: controller.signal });
  await sleep(10);
  controller.abort("user cancelled");
  try { await pending; } catch (error) { out.abortError = { name: error.name, message: error.message }; }
  await sleep(10);
  out.cancelNotifications = messages.filter((m) => m.method === "notifications/cancelled").map(str);

  // Timeout: silent server, timeoutMs=10 -> McpTimeoutError + cancellation.
  try { await client.request("slow", undefined, { timeoutMs: 10 }); } catch (error) {
    out.timeoutError = { name: error.name, message: error.message, timeoutMs: error.timeoutMs };
  }
  await sleep(10);
  out.afterTimeoutCancels = messages.filter((m) => m.method === "notifications/cancelled").map(str);

  // timeoutMs=0 disables the timer entirely: the same request still resolves
  // when the answer finally arrives.
  handlers.set("eventual", () => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 40)));
  out.zeroTimeout = json(await client.request("eventual", undefined, { timeoutMs: 0 }));

  // Aborting before sending fails fast.
  const preAborted = new AbortController();
  preAborted.abort("early");
  try { await client.request("slow", undefined, { signal: preAborted.signal }); } catch (error) {
    out.preAborted = { name: error.name, message: error.message };
  }
  // initialize can never be cancelled (spec).
  await client.close();
  return out;
});

// ---------------------------------------------------------------------------
// 5. client.ts serving server requests + notifications
// ---------------------------------------------------------------------------
await scenario("client_server_requests", async () => {
  const { pair, messages, handlers } = await memoryServer();
  const client = new mcp.McpClient({ name: "pi", version: "1", roots: [{ uri: "file:///w", name: "w" }, { uri: "file:///x" }] });
  handlers.set("initialize", () => ({
    protocolVersion: "2025-06-18", capabilities: { roots: { listChanged: true } },
    serverInfo: { name: "s", version: "1" },
  }));
  await client.connect(pair.client);
  const out = {};
  // The server side of the pair answers ping/roots via the client handlers:
  // deliver requests directly at the client transport.
  const serverSend = (message) => pair.server.send(message);
  let nextServerId = 100;
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = nextServerId++;
      // The client's responses arrive at the SERVER side of the pair.
      const off = pair.server.onMessage((message) => {
        if ("id" in message && message.id === id) { off(); resolve(message); }
      });
      void serverSend({ jsonrpc: "2.0", id, method, params });
    });
  out.pingResponse = str(await ask("ping"));
  out.rootsResponse = str(await ask("roots/list"));
  // Handler returning null -> result {}.
  client.setRequestHandler("sample", () => null);
  out.nullHandlerResponse = str(await ask("sample", { a: 1 }));
  // Handler throwing McpError with data.
  client.setRequestHandler("fail", () => { throw new mcp.McpError(-32000, "no can do", { hint: "try again" }); });
  out.mcpErrorResponse = str(await ask("fail"));
  // Handler throwing a plain Error -> internalError without data.
  client.setRequestHandler("fail2", () => { throw new Error("plain boom"); });
  out.plainErrorResponse = str(await ask("fail2"));
  // Unknown method -> methodNotFound.
  out.notFoundResponse = str(await ask("no/such/method"));
  // Rootless client has no roots/list handler.
  const pair2 = testing.createInMemoryTransportPair();
  await pair2.server.start();
  pair2.server.onMessage((message) => {
    if (message.method === "initialize") {
      void pair2.server.send({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s", version: "1" } },
      });
    }
  });
  const client2 = new mcp.McpClient({ name: "p", version: "1" });
  await client2.connect(pair2.client);
  const noRoots = await new Promise((resolve) => {
    const off = pair2.server.onMessage((message) => {
      if ("id" in message && message.id === 500) { off(); resolve(message); }
    });
    void pair2.server.send({ jsonrpc: "2.0", id: 500, method: "roots/list" });
  });
  out.noRootsResponse = str(noRoots);
  // Notifications reach listeners; throwing listeners surface on error.
  const seen = [];
  const offNotify = client.onNotification("custom/event", (params) => { if (params.bad) throw new Error("listener boom"); seen.push(json(params)); });
  const errors = [];
  client.onError((error) => errors.push(error.message));
  void pair.server.send({ jsonrpc: "2.0", method: "custom/event", params: { v: 1 } });
  void pair.server.send({ jsonrpc: "2.0", method: "custom/event", params: { bad: true } });
  await sleep(20);
  out.notifications = seen;
  out.listenerErrors = errors;
  offNotify();
  void pair.server.send({ jsonrpc: "2.0", method: "custom/event", params: { v: 2 } });
  await sleep(20);
  out.afterUnsubscribe = seen;
  // Unknown response id and invalid message.
  void pair.server.send({ jsonrpc: "2.0", id: 424242, result: {} });
  void pair.server.send({ jsonrpc: "2.0", id: 424243, method: 7 });
  await sleep(20);
  out.errorListener = errors;
  await client.close();
  return out;
});

await scenario("client_transport_close", async () => {
  const { pair, handlers } = await memoryServer();
  const client = new mcp.McpClient({ name: "pi", version: "1" });
  await client.connect(pair.client);
  const out = {};
  handlers.set("slow", () => new Promise(() => {}));
  const pending = client.request("slow").catch((error) => ({ name: error.name, message: error.message }));
  const closeEvents = [];
  client.onClose(() => closeEvents.push("closed"));
  await pair.client.close(); // transport drops mid-request
  out.rejected = await pending;
  out.closeEvents = closeEvents;
  out.state = client.connectionState;
  try { await client.ping(); } catch (error) { out.pingAfterClose = { name: error.name, message: error.message }; }
  // Second close is a no-op; close listeners do not re-fire.
  await client.close();
  out.closeEventsAfterDoubleClose = closeEvents;
  return out;
});

// ---------------------------------------------------------------------------
// 6. protocol/content.ts
// ---------------------------------------------------------------------------
await scenario("content", async () => {
  const out = { blocks: [] };
  const results = [
    { content: [{ type: "text", text: "plain" }] },
    { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
    { content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }] },
    { content: [{ type: "resource_link", uri: "file:///x", name: "x" }] },
    { content: [{ type: "resource", resource: { uri: "file:///t", text: "inner" } }] },
    { content: [{ type: "resource", resource: { uri: "file:///i", blob: "AAAA", mimeType: "image/jpeg" } }] },
    { content: [{ type: "resource", resource: { uri: "file:///b", blob: "AAAA" } }] },
    { content: [{ type: "resource", resource: { uri: "file:///b", blob: "AAAA", mimeType: "application/pdf" } }] },
    { content: [{ type: "weird", extra: true }] },
    { content: [] , structuredContent: { answer: 42, nested: { a: [1, 2] } } },
    { content: [{ type: "text", text: "keep" }], structuredContent: { ignored: true } },
    { structuredContent: { only: true } },
  ];
  for (const result of results) out.blocks.push(json(mcp.toLlmContent(result)));
  return out;
});

// ---------------------------------------------------------------------------
// 7. transports/stdio.ts over a real spawned fixture
// ---------------------------------------------------------------------------

// The stdio fixture: records raw stdin bytes, answers NDJSON, writes a report
// on exit. Modes:
//   serve   - answer initialize/tools/list/tools/call/ping; record raw bytes.
//   chaos   - emit split/invalid/hostile frames per argv plan, then exit with
//             a trailing partial message.
//   stderr  - emit stderr chunks (including a long one) and exit.
const stdioFixture = `import { createInterface } from "node:readline";
import * as fs from "node:fs";

const [reportPath, mode] = process.argv.slice(2);
const raw = [];
process.stdin.on("data", (chunk) => raw.push(...chunk));
let plan = mode === "chaos" ? JSON.parse(fs.readFileSync(process.argv[4], "utf8")) : null;

const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

if (mode === "stderr") {
  console.error("stdio fixture ready");
  process.stderr.write("a".repeat(300));
  process.stdin.once("end", () => {
    fs.writeFileSync(reportPath, JSON.stringify({ stderrDone: true }));
    process.exit(0);
  });
} else if (mode === "chaos") {
  // Send the plan chunk by chunk with tiny delays so the client sees
  // fragmented data events, then leave a trailing partial line and exit.
  (async () => {
    for (const step of plan) {
      if (step === "partial") { process.stdout.write('{"jsonrpc":"2.0","id":9,"res'); }
      else { process.stdout.write(step); await new Promise((r) => setTimeout(r, 15)); }
    }
    process.exit(0);
  })();
} else {
  console.error("stdio fixture ready");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    raw.push(...Buffer.from(line + "\\n", "utf8")); // replaced below (raw already covers)
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (!("id" in message)) continue;
    if (message.method === "initialize") {
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stdio-fixture", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      write({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
    } else if (message.method === "tools/call") {
      write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(message.params.arguments.text) }] } });
    } else if (message.method === "ping") {
      write({ jsonrpc: "2.0", id: message.id, result: {} });
    } else {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
    }
  }
  fs.writeFileSync(reportPath, JSON.stringify({ receivedText: Buffer.from(raw).toString("utf8"), receivedHex: Buffer.from(raw).toString("hex") }));
}
`;

fs.writeFileSync(path.join(staging, "stdio-fixture.mjs"), stdioFixture.replace('raw.push(...Buffer.from(line + "\\n", "utf8")); // replaced below (raw already covers)\n    ', ""));

await scenario("stdio_serve", async () => {
  const reportPath = path.join(staging, "stdio-report.json");
  const stderrChunks = [];
  const transport = new mcp.StdioTransport({
    command: process.execPath,
    args: [path.join(staging, "stdio-fixture.mjs"), reportPath, "serve"],
    onStderr: (chunk) => stderrChunks.push(chunk),
  });
  const client = new mcp.McpClient({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  const called = await client.callTool("echo", { text: "hello" });
  await client.ping();
  const out = {
    pidIsNumber: typeof transport.pid === "number",
    tools: json(tools),
    called: json(called),
  };
  await sleep(20);
  await client.close();
  out.stderrContainsReady = stderrChunks.join("").includes("stdio fixture ready");
  out.stderrBufferContainsReady = transport.stderr.includes("stdio fixture ready");
  out.stateAfterClose = client.connectionState;
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  // THE byte oracle: exactly what the client wrote to the server's stdin.
  out.clientToServerText = report.receivedText;
  out.clientToServerHex = report.receivedHex;
  return out;
});

await scenario("stdio_chaos", async () => {
  const planPath = path.join(staging, "chaos-plan.json");
  const plan = [
    // initialize answer, split into three data events
    str({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "c", version: "1" } } }).slice(0, 20),
    str({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "c", version: "1" } } }).slice(20, 60),
    str({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "c", version: "1" } } }).slice(60) + "\r\n",
    // blank lines are skipped
    "\n\n",
    // valid notification
    str({ jsonrpc: "2.0", method: "custom/n" }) + "\n",
    // invalid JSON line
    "{not json}\n",
    // valid JSON but invalid JSON-RPC
    str({ hello: "world" }) + "\n",
    str({ jsonrpc: "2.0", method: 5 }) + "\n",
    // response for an unknown request id
    str({ jsonrpc: "2.0", id: 777, result: {} }) + "\n",
    // whitespace-only line
    "   \n",
    // trailing partial message, then the process exits
    "partial",
  ];
  fs.writeFileSync(planPath, JSON.stringify(plan));
  const transport = new mcp.StdioTransport({
    command: process.execPath,
    args: [path.join(staging, "stdio-fixture.mjs"), path.join(staging, "chaos-report.json"), "chaos", planPath],
  });
  const client = new mcp.McpClient({ name: "c", version: "1" });
  const errors = [];
  const notifications = [];
  client.onError((error) => errors.push({ name: error.name, message: error.message }));
  client.onNotification("custom/n", (params) => notifications.push(json(params)));
  await client.connect(transport);
  await sleep(300);
  await client.close();
  return { errors, notifications };
});

await scenario("stdio_oversize", async () => {
  // A fixture that writes one over-limit line and one over-limit unterminated
  // buffer, then a healthy line proving the buffer reset. Driven at the
  // transport level (the fixture speaks no MCP).
  const fixture = `import * as fs from "node:fs";
const [reportPath] = process.argv.slice(2);
const write = (text) => process.stdout.write(text);
write('{"pad":"' + "x".repeat(120) + '","jsonrpc":"2.0","id":1,"result":{}}' + "\\n");
write("y".repeat(150));
await new Promise((r) => setTimeout(r, 40));
write('{"jsonrpc":"2.0","method":"after/reset"}' + "\\n");
await new Promise((r) => setTimeout(r, 40));
fs.writeFileSync(reportPath, JSON.stringify({ done: true }));
process.exit(0);
`;
  fs.writeFileSync(path.join(staging, "oversize-fixture.mjs"), fixture);
  const transport = new mcp.StdioTransport({
    command: process.execPath,
    args: [path.join(staging, "oversize-fixture.mjs"), path.join(staging, "oversize-report.json")],
    maxMessageBytes: 100,
  });
  const errors = [];
  const messages = [];
  transport.onMessage((message) => messages.push(json(message)));
  transport.onError((error) => errors.push(error.message));
  await transport.start();
  await sleep(300);
  await transport.close();
  return { errors, messages };
});

await scenario("stdio_stderr_cap", async () => {
  const fixture = `process.stderr.write("short|");
process.stderr.write("L".repeat(200) + "|");
process.stderr.write("tail");
process.stdin.once("end", () => process.exit(0));
`;
  fs.writeFileSync(path.join(staging, "stderr-fixture.mjs"), fixture);
  const chunks = [];
  const transport = new mcp.StdioTransport({
    command: process.execPath,
    args: [path.join(staging, "stderr-fixture.mjs")],
    maxStderrBytes: 100,
    onStderr: (chunk) => chunks.push(chunk),
  });
  await transport.start();
  await sleep(150);
  await transport.close();
  return { chunks, stderrBuffer: transport.stderr, stderrBufferLength: transport.stderr.length };
});

await scenario("stdio_spawn_failure", async () => {
  const transport = new mcp.StdioTransport({ command: "definitely-not-a-real-command-xyz" });
  try {
    await transport.start();
    return { started: true };
  } catch (error) {
    return { started: false, errorKind: error.code ?? error.name, startedFlag: true };
  }
});

// ---------------------------------------------------------------------------
// 8. transports/streamable-http.ts
// ---------------------------------------------------------------------------
const serverInfo = { name: "http-fixture", version: "2.0" };
const initializeResult = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo };
const initializeResponse = { jsonrpc: "2.0", id: 1, result: initializeResult };

function httpHandler(requests) {
  return (url, record) => {
    if (record.method === "POST") {
      const message = JSON.parse(record.body);
      if (message.method === "initialize") {
        return { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" }, body: str(initializeResponse) };
      }
      if (message.method === "tools/list") {
        return { status: 200, headers: { "content-type": "application/json" }, body: str({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }) };
      }
      if (message.method === "tools/call") {
        return { status: 200, headers: { "content-type": "application/json" }, body: str({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "hello" }] } }) };
      }
      return { status: 202 };
    }
    if (record.method === "GET") return { status: 405 };
    if (record.method === "DELETE") return { status: 200, body: "" };
    return { status: 404, body: "" };
  };
}

await scenario("http_json_roundtrip", async () => {
  const { fetch, requests } = recorderFetch(httpHandler());
  const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/mcp", fetch, openGetStream: false });
  const client = new mcp.McpClient({ name: "http-test", version: "1.0.0" });
  const result = await client.connect(transport);
  const tools = await client.listTools();
  const called = await client.callTool("echo", { text: "hello" });
  await client.notify("status/update", { s: 1 });
  const sessionId = transport.sessionId;
  await client.close();
  return {
    connectResult: json(result),
    tools: json(tools),
    called: json(called),
    sessionId,
    requests,
  };
});

await scenario("http_sse_response", async () => {
  // tools/call answered over an SSE response stream, split across chunks.
  const { fetch, requests } = recorderFetch((url, record) => {
    if (record.method === "POST") {
      const message = JSON.parse(record.body);
      if (message.method === "initialize") {
        return { status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "sse-session" }, chunks: [`event: message\ndata: ${str(initializeResponse)}\n\n`] };
      }
      if (message.method === "tools/call") {
        const answer = { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "sse" }] } };
        return { status: 200, headers: { "content-type": "text/event-stream" }, chunks: ["data: not json\n\n", `data: ${str(answer).slice(0, 30)}`, `${str(answer).slice(30)}\n\n`] };
      }
      return { status: 202 };
    }
    return { status: 405 };
  });
  const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/sse", fetch, openGetStream: false });
  const client = new mcp.McpClient({ name: "http-test", version: "1.0.0" });
  const errors = [];
  client.onError((error) => errors.push(error.message));
  await client.connect(transport);
  const called = await client.callTool("echo");
  await sleep(20);
  await client.close();
  return { called: json(called), errors, requests: requests.map((r) => ({ method: r.method, body: r.body })) };
});

await scenario("http_status_classification", async () => {
  const out = {};
  // 401 with challenge.
  {
    const { fetch } = recorderFetch(() => ({ status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://example.com/meta"' }, body: "login required" }));
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/a", fetch, openGetStream: false });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    try { await client.connect(transport); } catch (error) {
      out.authRequired = { name: error.name, status: error.status, body: error.body, wwwAuthenticate: error.wwwAuthenticate, message: error.message };
    }
  }
  // 404 without a session -> plain HTTP error; with a session -> session expired.
  {
    const { fetch } = recorderFetch(() => ({ status: 404, body: "gone" }));
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/b", fetch, openGetStream: false });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    try { await client.connect(transport); } catch (error) { out.notFound = { name: error.name, status: error.status, message: error.message }; }
  }
  {
    const { fetch } = recorderFetch((url, record) => {
      if (record.method !== "POST") return { status: 405 };
      const message = JSON.parse(record.body);
      if (message.method === "initialize") {
        return { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s" }, body: str(initializeResponse) };
      }
      if (message.method === "ping") return { status: 404, body: "gone" };
      return { status: 202 }; // notifications/initialized
    });
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/c", fetch, openGetStream: false });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    await client.connect(transport);
    try { await client.ping(); } catch (error) { out.sessionExpired = { name: error.name, status: error.status, message: error.message }; }
    await client.close();
  }
  // 500 with a very long body: describeHttpFailure truncation.
  {
    const long = "z".repeat(900);
    const { fetch } = recorderFetch(() => ({ status: 500, body: long }));
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/d", fetch, openGetStream: false });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    try { await client.connect(transport); } catch (error) {
      out.serverError = { status: error.status, message: error.message, messageLength: error.message.length, bodyLength: error.body.length };
    }
  }
  // 202 for a request (no response body).
  {
    let first = true;
    const { fetch } = recorderFetch(() => {
      if (first) { first = false; return { status: 200, headers: { "content-type": "application/json" }, body: str(initializeResponse) }; }
      return { status: 202 };
    });
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/e", fetch, openGetStream: false });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    await client.connect(transport);
    try { await client.ping(); } catch (error) { out.acceptedWithoutResponse = { name: error.name, status: error.status, message: error.message }; }
    await client.close();
  }
  // Unsupported content type.
  {
    let first = true;
    const { fetch } = recorderFetch(() => {
      if (first) { first = false; return { status: 200, headers: { "content-type": "application/json" }, body: str(initializeResponse) }; }
      return { status: 200, headers: { "content-type": "text/plain" }, body: "hi" };
    });
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/f", fetch, openGetStream: false });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    await client.connect(transport);
    try { await client.ping(); } catch (error) { out.unsupportedType = { status: error.status, message: error.message }; }
    await client.close();
  }
  // JSON array response body.
  {
    let first = true;
    const { fetch } = recorderFetch(() => {
      if (first) { first = false; return { status: 200, headers: { "content-type": "application/json" }, body: str(initializeResponse) }; }
      return { status: 200, headers: { "content-type": "application/json" }, body: `[${str({ jsonrpc: "2.0", method: "n1" })}, ${str({ jsonrpc: "2.0", method: "n2" })}]` };
    });
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/g", fetch, openGetStream: false });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    const notifications = [];
    client.onNotification("n1", () => notifications.push("n1"));
    client.onNotification("n2", () => notifications.push("n2"));
    await client.connect(transport);
    await client.ping().catch(() => {});
    await sleep(20);
    await client.close();
    out.arrayBodyNotifications = notifications;
  }
  return out;
});

await scenario("http_stream_failures", async () => {
  const out = {};
  // SSE response stream with invalid JSON, no event ids -> fails this request
  // only, with the synthetic internalError response.
  {
    const { fetch } = recorderFetch((url, record) => {
      if (record.method === "POST") {
        const message = JSON.parse(record.body);
        if (message.method === "initialize") {
          return { status: 200, headers: { "content-type": "application/json" }, body: str(initializeResponse) };
        }
        return { status: 200, headers: { "content-type": "text/event-stream" }, chunks: ["data: not json\n\n", "data: also not\n\n"] };
      }
      return { status: 405 };
    });
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/h", fetch, openGetStream: false });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    const errors = [];
    client.onError((error) => errors.push(error.message));
    await client.connect(transport);
    try { await client.ping(); } catch (error) { out.badSse = { name: error.name, code: error.code, message: error.message }; }
    await sleep(20);
    out.errorListenerDuringBadSse = errors;
    await client.close();
  }
  // Stream ends without any events -> "stream ended without a response".
  {
    const { fetch } = recorderFetch((url, record) => {
      if (record.method === "POST") {
        const message = JSON.parse(record.body);
        if (message.method === "initialize") {
          return { status: 200, headers: { "content-type": "application/json" }, body: str(initializeResponse) };
        }
        return { status: 200, headers: { "content-type": "text/event-stream" }, chunks: [": keepalive\n\n"] };
      }
      return { status: 405 };
    });
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/i", fetch, openGetStream: false });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    await client.connect(transport);
    try { await client.ping(); } catch (error) { out.emptyStream = { code: error.code, message: error.message }; }
    await sleep(20);
    await client.close();
  }
  // Resumption: priming id + retry, stream breaks, GET resume with
  // Last-Event-ID answers the request.
  {
    const resumeHeaders = [];
    const { fetch, requests } = recorderFetch((url, record) => {
      if (record.method === "POST") {
        const message = JSON.parse(record.body);
        if (message.method === "initialize") {
          return { status: 200, headers: { "content-type": "application/json" }, body: str(initializeResponse) };
        }
        return { status: 200, headers: { "content-type": "text/event-stream" }, chunks: ["id: 1\nretry: 5\ndata:\n\n"] };
      }
      if (record.method === "GET") {
        resumeHeaders.push(record.headers["last-event-id"]);
        const answer = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "resumed" }] } };
        return { status: 200, headers: { "content-type": "text/event-stream" }, chunks: [`id: 2\ndata: ${str(answer)}\n\n`] };
      }
      return { status: 405 };
    });
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/j", fetch, openGetStream: false, reconnect: { initialDelayMs: 1, maxDelayMs: 4, maxRetries: 2 } });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    await client.connect(transport);
    const called = await client.callTool("echo");
    await sleep(20);
    await client.close();
    out.resume = { called: json(called), resumeHeaders };
    out.resumeRequestLog = requests.filter((r) => r.method === "GET").map((r) => r.headers);
  }
  return out;
});

await scenario("http_get_stream", async () => {
  const out = {};
  // GET stream opened after notifications/initialized; server events delivered.
  {
    const { fetch, requests } = recorderFetch((url, record) => {
      if (record.method === "POST") {
        const message = JSON.parse(record.body);
        if (message.method === "initialize") {
          return { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "gs" }, body: str(initializeResponse) };
        }
        return { status: 202 };
      }
      if (record.method === "GET") {
        // Never-ending stream delivering one server notification.
        const stream = new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(`data: ${str({ jsonrpc: "2.0", method: "server/push", params: { v: 1 } })}\n\n`));
            }, 15);
          },
        });
        return { status: 200, headers: { "content-type": "text/event-stream" }, body: stream };
      }
      return { status: 200, body: "" };
    });
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/k", fetch });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    const pushes = [];
    client.onNotification("server/push", (params) => pushes.push(json(params)));
    await client.connect(transport);
    await client.notify("status/update", {});
    await sleep(60);
    out.pushes = pushes;
    out.getSessionHeaders = requests.filter((r) => r.method === "GET").map((r) => r.headers);
    await client.close();
    out.deleteRequests = requests.filter((r) => r.method === "DELETE").map((r) => ({ headers: r.headers }));
  }
  // 405 GET stream: silent, transport still works.
  {
    const { fetch, requests } = recorderFetch((url, record) => {
      if (record.method === "POST") {
        const message = JSON.parse(record.body);
        if (message.method === "initialize") {
          return { status: 200, headers: { "content-type": "application/json" }, body: str(initializeResponse) };
        }
        return { status: 202 };
      }
      return { status: 405 };
    });
    const transport = new mcp.StreamableHttpTransport({ url: "http://mcp.test/l", fetch });
    const client = new mcp.McpClient({ name: "t", version: "1" });
    const errors = [];
    client.onError((error) => errors.push(error.message));
    await client.connect(transport);
    await sleep(30);
    await client.close();
    out.noGetStreamErrors = errors;
    out.getAttempts = requests.filter((r) => r.method === "GET").length;
  }
  return out;
});

await scenario("http_auth_provider", async () => {
  const out = {};
  let unauthorizedCalls = 0;
  let tokens = "stale-token";
  const { fetch, requests } = recorderFetch((url, record) => {
    if (record.method !== "POST") return { status: 405 };
    if (record.headers.authorization === "Bearer fresh-token") {
      const message = JSON.parse(record.body);
      if (message.method === "initialize") {
        return { status: 200, headers: { "content-type": "application/json" }, body: str(initializeResponse) };
      }
      if ("id" in message) {
        return { status: 200, headers: { "content-type": "application/json" }, body: str({ jsonrpc: "2.0", id: message.id, result: {} }) };
      }
      return { status: 202 };
    }
    return { status: 401, headers: { "www-authenticate": "Bearer" }, body: "auth required" };
  });
  const transport = new mcp.StreamableHttpTransport({
    url: "http://mcp.test/m",
    fetch,
    openGetStream: false,
    authProvider: {
      token: async () => tokens,
      onUnauthorized: async (context) => {
        unauthorizedCalls++;
        out.firstContext = { serverUrl: String(context.serverUrl), token: context.token };
        tokens = "fresh-token";
      },
    },
  });
  const client = new mcp.McpClient({ name: "t", version: "1" });
  await client.connect(transport);
  await client.ping();
  out.unauthorizedCalls = unauthorizedCalls;
  out.requestAuthHeaders = requests.map((r) => r.headers.authorization);
  await client.close();
  return out;
});

await scenario("sse_parser", async () => {
  const out = { cases: [] };
  async function run(name, chunks, options = {}) {
    const events = [];
    const ids = [];
    const retries = [];
    let error;
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        if (!options.leaveOpen) controller.close();
      },
    });
    try {
      await streamableHttp.consumeSseStream(stream, {
        maxEventBytes: options.maxEventBytes,
        onEvent: (event) => events.push(json(event)),
        onId: (id) => ids.push(id),
        onRetry: (delayMs) => retries.push(delayMs),
      });
    } catch (e) { error = e.message; }
    out.cases.push({ name, events, ids, retries, error });
  }
  await run("basic", ["data: hello\n\n"]);
  await run("crlf", ["data: a\r\n\r\ndata: b\r\nevent: tick\r\n\r\n"]);
  await run("multiline_data", ["data: one\ndata: two\ndata: three\n\n"]);
  await run("comment_and_bom", ["\uFEFF: comment\ndata: after bom\n\n"]);
  await run("space_stripping", ["data:    padded   \n\n"]);
  await run("no_colon_line", ["data\n\ndata: x\n\n"]);
  await run("id_and_retry", ["id: 42\nretry: 2500\ndata: x\n\n", "id: bad\0id\ndata: y\n\n", "retry: 1.5\ndata: z\n\n", "retry: -3\ndata: w\n\n"]);
  await run("id_without_data", ["id: prime\n\n", "data: real\n\n"]);
  await run("event_type_filtered_later", ["event: custom\ndata: {}\n\n"]);
  await run("fragmented", ["dat", "a: fr", "agmented\n", "\n"]);
  await run("no_trailing_newline", ["data: tail"]);
  await run("crlf_split_across_chunks", ["data: x\r", "\n\r", "\n"]);
  await run("max_event_bytes", ["data: " + "x".repeat(30) + "\n\n"], { maxEventBytes: 10 });
  await run("max_buffer_bytes", ["z".repeat(30)], { maxEventBytes: 10 });
  await run("many_short_data_lines", Array.from({ length: 12 }, () => "data: ab\n").concat(["\n"]), { maxEventBytes: 20 });
  return out;
});

// ---------------------------------------------------------------------------
// 9. oauth
// ---------------------------------------------------------------------------
await scenario("oauth_parsing", async () => {
  const out = {};
  out.wwwAuthenticate = [
    null,
    "Bearer",
    'Bearer resource_metadata="https://rs.example/meta", scope="a b", error="insufficient_scope", error_description="need more"',
    "Bearer resource_metadata=not-a-url scope=a",
    "DPoP error=test",
    "Basic realm=x",
    "bearer scope=one",
  ].map((header) => {
    const parsed = oauth.parseWwwAuthenticate(header);
    return { header, resourceMetadataUrl: parsed.resourceMetadataUrl ? parsed.resourceMetadataUrl.href : undefined, scope: parsed.scope, error: parsed.error, errorDescription: parsed.errorDescription };
  });
  const protectedResource = {
    resource: "https://rs.example/mcp",
    authorization_servers: ["https://as.example"],
    scopes_supported: ["read", "write"],
    custom_future_field: { v: 1 },
  };
  out.protectedResource = oauthTypes.parseProtectedResourceMetadata(protectedResource);
  try { oauthTypes.parseProtectedResourceMetadata({}); } catch (error) { out.protectedResourceInvalid = error.message; }
  const asMetadata = {
    issuer: "https://as.example/",
    authorization_endpoint: "https://as.example/authorize",
    token_endpoint: "https://as.example/token",
    registration_endpoint: "https://as.example/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    extra: "kept",
  };
  out.authorizationServer = oauthTypes.parseAuthorizationServerMetadata(asMetadata);
  try { oauthTypes.parseAuthorizationServerMetadata({ issuer: "https://x" }); } catch (error) { out.authorizationServerInvalid = error.message; }
  try {
    oauthTypes.parseAuthorizationServerMetadata({
      issuer: "https://x", authorization_endpoint: "javascript:alert(1)", token_endpoint: "https://x/token",
      response_types_supported: ["code"],
    });
  } catch (error) { out.authorizationServerUnsafe = error.message; }
  out.tokens = oauthTypes.parseOAuthTokens({ access_token: "at", token_type: "Bearer", expires_in: "3600", scope: "a b", refresh_token: "rt", id_token: "it", unknown: "dropped" });
  try { oauthTypes.parseOAuthTokens({ access_token: "at" }); } catch (error) { out.tokensInvalid = error.message; }
  try { oauthTypes.parseOAuthTokens({ access_token: "at", token_type: "B", expires_in: "soon" }); } catch (error) { out.tokensBadExpires = error.message; }
  out.clientInformation = oauthTypes.parseClientInformation({
    client_id: "cid", client_secret: "sec", client_id_issued_at: 5, client_secret_expires_at: 10,
    redirect_uris: ["https://cb"], client_name: "pi", application_type: "web",
  });
  out.clientInformationNoSecret = oauthTypes.parseClientInformation({ client_id: "cid" });
  out.discoveryUrls = [
    "https://as.example",
    "https://as.example/",
    "https://as.example/tenant1",
    "https://as.example/tenant1/",
  ].map((value) => oauth.buildAuthorizationServerDiscoveryUrls(value).map((entry) => ({ url: entry.url.href, type: entry.type })));
  return out;
});

await scenario("oauth_discovery", async () => {
  const out = {};
  const resourceMetadata = { resource: "https://rs.example/mcp", authorization_servers: ["https://as.example"] };
  const asMetadata = {
    issuer: "https://as.example",
    authorization_endpoint: "https://as.example/authorize",
    token_endpoint: "https://as.example/token",
    response_types_supported: ["code"],
  };
  // Protected resource discovery: pathed first, fallback to root.
  {
    let calls = 0;
    const { fetch, requests } = recorderFetch((url) => {
      calls++;
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return { status: 404, body: "" };
      if (url.pathname === "/.well-known/oauth-protected-resource") return { status: 200, headers: { "content-type": "application/json" }, body: str(resourceMetadata) };
      if (url.pathname === "/.well-known/oauth-authorization-server") return { status: 200, headers: { "content-type": "application/json" }, body: str(asMetadata) };
      return { status: 404, body: "" };
    });
    const meta = await oauth.discoverProtectedResourceMetadata("https://rs.example/mcp", { fetch });
    out.protectedResourceFallback = { meta, requestUrls: requests.map((r) => r.url), requestHeaders: requests.map((r) => r.headers) };
  }
  // Authorization server metadata: oauth then oidc candidates, issuer check.
  {
    const { fetch, requests } = recorderFetch((url) => {
      if (url.pathname === "/.well-known/oauth-authorization-server") return { status: 200, headers: { "content-type": "application/json" }, body: str(asMetadata) };
      return { status: 404, body: "" };
    });
    const meta = await oauth.discoverAuthorizationServerMetadata("https://as.example", { fetch });
    out.authorizationServerDiscovery = { meta, requestUrls: requests.map((r) => r.url) };
  }
  {
    const { fetch } = recorderFetch(() => ({ status: 200, headers: { "content-type": "application/json" }, body: str({ ...asMetadata, issuer: "https://other.example" }) }));
    try { await oauth.discoverAuthorizationServerMetadata("https://as.example", { fetch }); } catch (error) {
      out.issuerMismatch = { name: error.name, message: error.message, expected: error.expected, received: error.received };
    }
  }
  {
    const { fetch } = recorderFetch(() => ({ status: 503, body: "busy" }));
    try { await oauth.discoverAuthorizationServerMetadata("https://as.example", { fetch }); } catch (error) {
      out.metadataHttpError = error.message;
    }
  }
  // skipIssuerValidation.
  {
    const { fetch } = recorderFetch(() => ({ status: 200, headers: { "content-type": "application/json" }, body: str({ ...asMetadata, issuer: "https://other.example" }) }));
    const meta = await oauth.discoverAuthorizationServerMetadata("https://as.example", { fetch, skipIssuerValidation: true });
    out.skipIssuerValidation = meta ? meta.issuer : undefined;
  }
  // discoverOAuthServerInfo: no resource metadata -> origin fallback.
  {
    const { fetch, requests } = recorderFetch((url) => {
      if (url.host === "as.example" && url.pathname === "/.well-known/oauth-authorization-server") {
        return { status: 200, headers: { "content-type": "application/json" }, body: str(asMetadata) };
      }
      return { status: 404, body: "" };
    });
    const info = await oauth.discoverOAuthServerInfo("https://rs.example/mcp", { fetch });
    out.serverInfo = {
      authorizationServerUrl: info.authorizationServerUrl,
      hasResourceMetadata: info.resourceMetadata !== undefined,
      hasAuthorizationServerMetadata: info.authorizationServerMetadata !== undefined,
      requestUrls: requests.map((r) => r.url),
    };
  }
  // selectResource.
  out.selectResource = [
    ["https://rs.example/mcp", { resource: "https://rs.example/mcp" }, "ok"],
    ["https://rs.example/mcp/sub/path", { resource: "https://rs.example/mcp" }, "ok"],
    ["https://rs.example/mcp#frag", { resource: "https://rs.example/mcp" }, "ok"],
    ["https://rs.example/other", { resource: "https://rs.example/mcp" }, "origin mismatch"],
    ["https://rs.example/mopot", { resource: "https://rs.example/mcp" }, "path mismatch"],
    ["https://RS.example/mcp", { resource: "https://rs.example/mcp" }, "case host"],
  ].map(([serverUrl, metadata, label]) => {
    try {
      const resource = oauth.selectResource(serverUrl, metadata);
      return { label, resource };
    } catch (error) { return { label, error: error.message }; }
  });
  out.selectResourceUndefined = oauth.selectResource("https://x", undefined);
  return out;
});

await scenario("oauth_start_authorization", async () => {
  const out = {};
  const clientInformation = { client_id: "client-123" };
  // No metadata -> /authorize under the server; full parameter order pinned.
  {
    const { authorizationUrl, codeVerifier } = await oauth.startAuthorization("https://as.example", {
      clientInformation, redirectUrl: "http://127.0.0.1:9911/callback",
      state: "st4te", scope: "read write", resource: "https://rs.example/mcp",
    });
    out.noMetadata = { url: authorizationUrl.href, verifier: codeVerifier };
  }
  // offline_access adds prompt=consent after scope.
  {
    const { authorizationUrl, codeVerifier } = await oauth.startAuthorization("https://as.example", {
      clientInformation, redirectUrl: "http://localhost:9911/callback",
      scope: "offline_access read",
    });
    out.offlineAccess = { url: authorizationUrl.href, verifier: codeVerifier };
  }
  // Metadata endpoints win; metadata without code response types errors.
  {
    const metadata = {
      issuer: "https://as.example", authorization_endpoint: "https://as.example/authz",
      token_endpoint: "https://as.example/token", response_types_supported: ["code", "code id_token"],
      code_challenge_methods_supported: ["S256", "plain"],
    };
    const { authorizationUrl, codeVerifier } = await oauth.startAuthorization("https://as.example", {
      metadata, clientInformation, redirectUrl: "http://127.0.0.1:9911/callback",
    });
    out.withMetadata = { url: authorizationUrl.href, verifier: codeVerifier };
    try {
      await oauth.startAuthorization("https://as.example", {
        metadata: { ...metadata, response_types_supported: ["implicit"] }, clientInformation, redirectUrl: "http://127.0.0.1:9911/callback",
      });
    } catch (error) { out.noCodeResponseTypes = error.message; }
    try {
      await oauth.startAuthorization("https://as.example", {
        metadata: { ...metadata, code_challenge_methods_supported: ["plain"] }, clientInformation, redirectUrl: "http://127.0.0.1:9911/callback",
      });
    } catch (error) { out.noS256 = error.message; }
  }
  return out;
});

await scenario("oauth_token_requests", async () => {
  const out = {};
  const metadata = {
    issuer: "https://as.example", authorization_endpoint: "https://as.example/authorize",
    token_endpoint: "https://as.example/token", response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["none"],
  };
  const clientInformation = { client_id: "cid-1" };
  // Authorization code exchange, no secret, with resource.
  {
    const { fetch, requests } = recorderFetch(() => ({ status: 200, headers: { "content-type": "application/json" }, body: str({ access_token: "at", token_type: "Bearer", expires_in: 3600, refresh_token: "rt" }) }));
    const tokens = await oauth.exchangeAuthorizationCode("https://as.example", {
      metadata, clientInformation, resource: "https://rs.example/mcp", fetch,
      code: "abc", codeVerifier: "ver-123", redirectUrl: "http://127.0.0.1:9911/callback",
    });
    out.exchange = { tokens: json(tokens), request: requests[0] };
  }
  // Refresh: result merges old refresh_token when absent in the response.
  {
    const { fetch, requests } = recorderFetch(() => ({ status: 200, headers: { "content-type": "application/json" }, body: str({ access_token: "at2", token_type: "Bearer" }) }));
    const tokens = await oauth.refreshAuthorization("https://as.example", {
      metadata, clientInformation, fetch, refreshToken: "old-rt",
    });
    out.refreshKeep = { tokens: json(tokens), request: requests[0] };
  }
  {
    const { fetch, requests } = recorderFetch(() => ({ status: 200, headers: { "content-type": "application/json" }, body: str({ access_token: "at3", token_type: "Bearer", refresh_token: "new-rt" }) }));
    const tokens = await oauth.refreshAuthorization("https://as.example", {
      metadata, clientInformation, fetch, refreshToken: "old-rt",
    });
    out.refreshReplace = { tokens: json(tokens), request: requests[0] };
  }
  // OAuth error body wins over status.
  {
    const { fetch } = recorderFetch(() => ({ status: 400, headers: { "content-type": "application/json" }, body: str({ error: "invalid_grant", error_description: "code expired", error_uri: "https://as.example/err" }) }));
    try {
      await oauth.exchangeAuthorizationCode("https://as.example", { metadata, clientInformation, fetch, code: "x", codeVerifier: "v", redirectUrl: "http://cb" });
    } catch (error) { out.oauthError = { name: error.name, code: error.code, message: error.message, errorUri: error.errorUri }; }
  }
  // Non-JSON body with 500 -> server_error with the HTTP text.
  {
    const { fetch } = recorderFetch(() => ({ status: 500, body: "<html>oops</html>" }));
    try {
      await oauth.exchangeAuthorizationCode("https://as.example", { metadata, clientInformation, fetch, code: "x", codeVerifier: "v", redirectUrl: "http://cb" });
    } catch (error) { out.serverError = { name: error.name, code: error.code, message: error.message }; }
  }
  // Insecure endpoint refused.
  {
    const { fetch } = recorderFetch(() => ({ status: 200, body: str({ access_token: "a", token_type: "b" }) }));
    try {
      await oauth.exchangeAuthorizationCode("http://as.example", { metadata: { ...metadata, token_endpoint: undefined }, clientInformation, fetch, code: "x", codeVerifier: "v", redirectUrl: "http://cb" });
    } catch (error) { out.insecure = { name: error.name, message: error.message, endpoint: error.endpoint }; }
  }
  // Loopback http is allowed.
  {
    const { fetch, requests } = recorderFetch(() => ({ status: 200, headers: { "content-type": "application/json" }, body: str({ access_token: "a", token_type: "b" }) }));
    await oauth.exchangeAuthorizationCode("http://127.0.0.1:8080", { clientInformation, fetch, code: "x", codeVerifier: "v", redirectUrl: "http://127.0.0.1:9911/callback" });
    out.loopbackTokenUrl = requests[0].url;
  }
  out.loopbackHostnames = ["localhost", "127.0.0.1", "[::1]", "::1", "example.com"].map((host) => ({ host }));
  return out;
});

await scenario("oauth_client_auth", async () => {
  const out = {};
  const tokenEndpoint = "https://as.example/token";
  const metadata = {
    issuer: "https://as.example", authorization_endpoint: "https://as.example/authorize",
    token_endpoint: tokenEndpoint, response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  };
  // client_secret_basic preferred when supported.
  {
    const { fetch, requests } = recorderFetch(() => ({ status: 200, body: str({ access_token: "a", token_type: "b" }) }));
    await oauth.refreshAuthorization("https://as.example", {
      metadata: { ...metadata, token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"] },
      clientInformation: { client_id: "my-id", client_secret: "my-secret" }, fetch, refreshToken: "r",
    });
    out.basic = { authorization: requests[0].headers.authorization, body: requests[0].body };
  }
  // client_secret_post.
  {
    const { fetch, requests } = recorderFetch(() => ({ status: 200, body: str({ access_token: "a", token_type: "b" }) }));
    await oauth.refreshAuthorization("https://as.example", {
      metadata, clientInformation: { client_id: "my-id", client_secret: "my-secret" }, fetch, refreshToken: "r",
    });
    out.post = { authorization: requests[0].headers.authorization, body: requests[0].body };
  }
  // none with secret still available: hinted method wins.
  {
    const { fetch, requests } = recorderFetch(() => ({ status: 200, body: str({ access_token: "a", token_type: "b" }) }));
    await oauth.refreshAuthorization("https://as.example", {
      metadata, clientInformation: { client_id: "my-id", client_secret: "my-secret", token_endpoint_auth_method: "none" }, fetch, refreshToken: "r",
    });
    out.hintedNone = { authorization: requests[0].headers.authorization, body: requests[0].body };
  }
  // No supported list, no secret -> none (client_id in body only).
  {
    const { fetch, requests } = recorderFetch(() => ({ status: 200, body: str({ access_token: "a", token_type: "b" }) }));
    await oauth.refreshAuthorization("https://as.example", {
      metadata: { ...metadata, token_endpoint_auth_methods_supported: undefined }, clientInformation: { client_id: "my-id" }, fetch, refreshToken: "r",
    });
    out.noSecretNone = { authorization: requests[0].headers.authorization, body: requests[0].body };
  }
  // client_secret_basic requested but no secret -> error.
  {
    const { fetch } = recorderFetch(() => ({ status: 200, body: str({ access_token: "a", token_type: "b" }) }));
    try {
      await oauth.refreshAuthorization("https://as.example", {
        metadata: { ...metadata, token_endpoint_auth_methods_supported: ["client_secret_basic"] },
        clientInformation: { client_id: "my-id" }, fetch, refreshToken: "r",
      });
    } catch (error) { out.basicMissingSecret = error.message; }
  }
  // addClientAuthentication override.
  {
    const { fetch, requests } = recorderFetch(() => ({ status: 200, body: str({ access_token: "a", token_type: "b" }) }));
    await oauth.refreshAuthorization("https://as.example", {
      metadata, clientInformation: { client_id: "my-id" }, fetch, refreshToken: "r",
      addClientAuthentication: async (headers, params, url, meta) => {
        headers.set("X-Custom", "yes");
        params.set("client_id", "override-id");
        params.set("extra", url.href + (meta ? " meta" : ""));
      },
    });
    out.customAuth = { headers: requests[0].headers, body: requests[0].body };
  }
  return out;
});

await scenario("oauth_register_client", async () => {
  const out = {};
  const metadata = {
    issuer: "https://as.example", authorization_endpoint: "https://as.example/authorize",
    token_endpoint: "https://as.example/token", registration_endpoint: "https://as.example/register",
    response_types_supported: ["code"],
  };
  const clientMetadata = {
    client_name: "pi",
    redirect_uris: ["http://127.0.0.1:9911/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: undefined,
  };
  {
    const { fetch, requests } = recorderFetch(() => ({ status: 200, headers: { "content-type": "application/json" }, body: str({ client_id: "reg-1", client_secret: "s3cret", client_id_issued_at: 1, redirect_uris: ["http://127.0.0.1:9911/callback"], client_name: "pi" }) }));
    const info = await oauth.registerClient("https://as.example", { metadata, clientMetadata, scope: "read write", fetch });
    out.registered = { info: json(info), request: requests[0] };
  }
  // No metadata -> /register under the server.
  {
    const { fetch, requests } = recorderFetch(() => ({ status: 200, headers: { "content-type": "application/json" }, body: str({ client_id: "reg-2" }) }));
    await oauth.registerClient("https://as.example", { clientMetadata, fetch });
    out.noMetadataUrl = requests[0].url;
  }
  // Metadata without a registration endpoint errors.
  {
    const { fetch } = recorderFetch(() => ({ status: 200, body: str({ client_id: "x" }) }));
    try {
      await oauth.registerClient("https://as.example", { metadata: { ...metadata, registration_endpoint: undefined }, clientMetadata, fetch });
    } catch (error) { out.noRegistrationEndpoint = error.message; }
  }
  // HTTP failure -> OAuthRegistrationError with body.
  {
    const { fetch } = recorderFetch(() => ({ status: 400, body: '{"error":"invalid_redirect_uri"}' }));
    try {
      await oauth.registerClient("https://as.example", { metadata, clientMetadata, fetch });
    } catch (error) { out.registrationError = { name: error.name, status: error.status, message: error.message, body: error.body }; }
  }
  return out;
});

// The full authorizeMcp state machine over a stub provider (mirrors the
// upstream test provider shape).
class StubProvider {
  constructor() {
    this.redirectUrl = "http://localhost:9911/callback";
    this.clientMetadata = {
      client_name: "pi-mcp-test",
      redirect_uris: ["http://localhost:9911/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    this.client = undefined;
    this.tokenSet = undefined;
    this.verifier = undefined;
    this.discovery = undefined;
    this.stateValue = "expected-state";
    this.authorizationUrl = undefined;
    this.invalidations = [];
  }
  state() { return this.stateValue; }
  clientInformation() { return this.client; }
  saveClientInformation(information) { this.client = information; }
  tokens() { return this.tokenSet; }
  saveTokens(tokens) { this.tokenSet = tokens; }
  redirectToAuthorization(url) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier) { this.verifier = verifier; }
  codeVerifier() {
    if (!this.verifier) throw new Error("Missing code verifier");
    return this.verifier;
  }
  invalidateCredentials(kind) {
    this.invalidations.push(kind);
    if (kind === "all" || kind === "client") this.client = undefined;
    if (kind === "all" || kind === "tokens") this.tokenSet = undefined;
    if (kind === "all" || kind === "verifier") this.verifier = undefined;
    if (kind === "all" || kind === "discovery") this.discovery = undefined;
  }
  saveDiscoveryState(state) { this.discovery = state; }
  discoveryState() { return this.discovery; }
}

await scenario("oauth_flow", async () => {
  const out = {};
  const asMetadata = {
    issuer: "https://as.example",
    authorization_endpoint: "https://as.example/authorize",
    token_endpoint: "https://as.example/token",
    registration_endpoint: "https://as.example/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
  const flowFetch = recorderFetch((url, record) => {
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return { status: 200, headers: { "content-type": "application/json" }, body: str({ resource: "https://rs.example/mcp", authorization_servers: ["https://as.example"], scopes_supported: ["org:read"] }) };
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return { status: 200, headers: { "content-type": "application/json" }, body: str(asMetadata) };
    }
    if (url.pathname === "/register") {
      return { status: 200, headers: { "content-type": "application/json" }, body: str({ client_id: "dynamic-client", client_secret: "dynamic-secret", client_id_issued_at: 1, redirect_uris: ["http://localhost:9911/callback"], client_name: "pi-mcp-test", scope: "org:read" }) };
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(record.body);
      if (params.get("grant_type") === "authorization_code" && params.get("code") === "good-code") {
        return { status: 200, headers: { "content-type": "application/json" }, body: str({ access_token: "access-1", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1", scope: "org:read" }) };
      }
      if (params.get("grant_type") === "refresh_token" && params.get("refresh_token") === "refresh-1") {
        return { status: 200, headers: { "content-type": "application/json" }, body: str({ access_token: "access-2", token_type: "Bearer", expires_in: 3600 }) };
      }
      if (params.get("grant_type") === "refresh_token" && params.get("refresh_token") === "expired-rt") {
        return { status: 400, headers: { "content-type": "application/json" }, body: str({ error: "invalid_client", error_description: "client revoked" }) };
      }
      return { status: 400, headers: { "content-type": "application/json" }, body: str({ error: "invalid_grant", error_description: "code expired" }) };
    }
    return { status: 404, body: "" };
  });
  const options = { serverUrl: "https://rs.example/mcp", fetch: flowFetch.fetch };
  // (1) Fresh provider: discovery + registration + REDIRECT.
  const provider = new StubProvider();
  out.first = await oauth.authorizeMcp(provider, options);
  out.firstAuthorizationUrl = provider.authorizationUrl?.href;
  out.firstVerifier = provider.verifier;
  out.firstDiscovery = provider.discovery === undefined ? undefined : {
    authorizationServerUrl: provider.discovery.authorizationServerUrl,
    resourceMetadata: provider.discovery.resourceMetadata,
  };
  out.firstSavedClient = json(provider.client);
  out.registerRequest = flowFetch.requests.find((r) => r.url.endsWith("/register"));
  // (2) Authorization code exchange.
  delete provider.authorizationUrl;
  out.second = await oauth.authorizeMcp(provider, { ...options, authorizationCode: "good-code" });
  out.tokensAfterCode = json(provider.tokenSet);
  out.codeExchangeRequest = flowFetch.requests.find((r) => r.url.endsWith("/token") && (r.body ?? "").includes("authorization_code"));
  // (3) Stored refresh token: silent refresh -> AUTHORIZED, no redirect.
  delete provider.authorizationUrl;
  out.third = await oauth.authorizeMcp(provider, options);
  out.tokensAfterRefresh = json(provider.tokenSet);
  out.refreshRequest = flowFetch.requests.find((r) => (r.body ?? "").startsWith("grant_type=refresh_token"));
  out.redirectedOnRefresh = provider.authorizationUrl === undefined;
  // (4) invalid_client on refresh invalidates everything and re-runs.
  provider.tokenSet = { access_token: "a", token_type: "Bearer", refresh_token: "expired-rt" };
  out.invalidationsBefore = provider.invalidations.slice();
  out.fourth = await oauth.authorizeMcp(provider, options);
  out.invalidationsAfterInvalidClient = provider.invalidations.slice();
  out.redirectedAfterInvalidClient = provider.authorizationUrl?.href !== undefined;
  // (5) invalid_grant invalidates tokens only, then re-runs (redirect).
  provider.invalidations.length = 0;
  provider.tokenSet = { access_token: "a", token_type: "Bearer", refresh_token: "stale-rt" };
  provider.client = { client_id: "dynamic-client", client_secret: "dynamic-secret" };
  provider.discovery = { authorizationServerUrl: "https://as.example" };
  const flowFetch2 = recorderFetch((url) => {
    if (url.pathname === "/token") {
      return { status: 400, headers: { "content-type": "application/json" }, body: str({ error: "invalid_grant", error_description: "rotated" }) };
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return { status: 200, headers: { "content-type": "application/json" }, body: str({
        issuer: "https://as.example", authorization_endpoint: "https://as.example/authorize",
        token_endpoint: "https://as.example/token", response_types_supported: ["code"],
      }) };
    }
    return { status: 404, body: "" };
  });
  out.fifth = await oauth.authorizeMcp(provider, { ...options, fetch: flowFetch2.fetch });
  out.invalidationsAfterInvalidGrant = provider.invalidations.slice();
  out.fifthRequests = flowFetch2.requests.map((r) => ({ url: r.url, body: r.body }));
  // (6) Missing client info during code exchange.
  const freshProvider = new StubProvider();
  try {
    await oauth.authorizeMcp(freshProvider, { serverUrl: "https://rs.example/mcp", authorizationCode: "c", fetch: flowFetch.fetch });
  } catch (error) { out.missingClientDuringExchange = error.message; }
  return out;
});

await scenario("oauth_provider", async () => {
  const out = {};
  const store = new oauth.MemoryOAuthStateStore();
  const redirects = [];
  const provider = new oauth.McpOAuthProvider({
    serverUrl: "https://rs.example/mcp/",
    redirectUrl: "http://localhost:9911/callback",
    clientMetadata: { client_name: "pi" },
    store,
    onRedirect: (url) => redirects.push(url.href),
  });
  out.clientMetadataDefaults = provider.clientMetadata;
  out.redirectUrl = provider.redirectUrl;
  // state() generates a deterministic hex string from the stubbed RNG.
  out.state = await provider.state();
  out.stateReused = await provider.state();
  // code verifier round trip; missing verifier errors.
  try { await provider.codeVerifier(); } catch (error) { out.noVerifier = error.message; }
  await provider.saveCodeVerifier("v-123");
  out.verifier = await provider.codeVerifier();
  // tokens with expiry pinned against FIXED_NOW.
  await provider.saveTokens({ access_token: "a", token_type: "Bearer", expires_in: 60 });
  out.tokens = await provider.tokens();
  const raw = await store.load();
  out.rawState = json(raw);
  // tokens without expiry clears tokensExpireAt.
  await provider.saveTokens({ access_token: "b", token_type: "Bearer" });
  out.rawStateNoExpiry = json(await store.load());
  // discovery state + client information.
  await provider.saveClientInformation({ client_id: "c1", client_secret: "s1" });
  out.clientInformation = await provider.clientInformation();
  await provider.saveDiscoveryState({ authorizationServerUrl: "https://as.example" });
  out.discovery = await provider.discoveryState();
  // invalidateCredentials kinds.
  await provider.invalidateCredentials("tokens");
  out.afterTokensInvalidation = json(await store.load());
  await provider.invalidateCredentials("verifier");
  out.afterVerifierInvalidation = json(await store.load());
  await provider.invalidateCredentials("client");
  out.afterClientInvalidation = json(await store.load());
  await provider.invalidateCredentials("discovery");
  out.afterDiscoveryInvalidation = json(await store.load());
  // Server-URL isolation: state saved under another URL is ignored.
  const otherStore = new oauth.MemoryOAuthStateStore();
  await otherStore.save({ serverUrl: "https://other.example", tokens: { access_token: "leak", token_type: "Bearer" }, codeVerifier: "leak-v" });
  const isolated = new oauth.McpOAuthProvider({
    serverUrl: "https://rs.example/mcp", redirectUrl: "http://localhost:9911/callback",
    clientMetadata: { client_name: "pi" }, store: otherStore, onRedirect: () => {},
  });
  out.isolatedTokens = await isolated.tokens();
  out.isolatedVerifier = await isolated.codeVerifier().catch((error) => error.message);
  // Configured client id/secret bypasses registration.
  const configured = new oauth.McpOAuthProvider({
    serverUrl: "https://rs.example/mcp", redirectUrl: "http://localhost:9911/callback",
    clientMetadata: { client_name: "pi" }, clientId: "fixed-id", clientSecret: "fixed-secret",
    onRedirect: () => {},
  });
  out.configuredClient = await configured.clientInformation();
  out.configuredMetadata = configured.clientMetadata;
  // Explicit client metadata keys are kept in place.
  const explicit = new oauth.McpOAuthProvider({
    serverUrl: "https://rs.example/mcp", redirectUrl: "http://localhost:9911/callback",
    clientMetadata: { client_name: "pi", grant_types: ["authorization_code"], token_endpoint_auth_method: "client_secret_basic", redirect_uris: ["http://cb/1"] },
    onRedirect: () => {},
  });
  out.explicitMetadata = explicit.clientMetadata;
  return out;
});

await scenario("oauth_adapt_provider", async () => {
  const out = {};
  const provider = new StubProvider();
  provider.tokenSet = { access_token: "tok-1", token_type: "Bearer" };
  provider.client = { client_id: "c-1" };
  provider.discovery = { authorizationServerUrl: "https://as.example" };
  const adapted = oauth.adaptOAuthProvider(provider);
  out.token = await adapted.token();
  let authorizeCalls = 0;
  // REDIRECT result -> McpOAuthAuthorizationRequiredError.
  try {
    await adapted.onUnauthorized({
      response: new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } }),
      serverUrl: new URL("https://rs.example/mcp"),
      fetch: async (input, init) => {
        authorizeCalls++;
        return new Response(str({
          issuer: "https://as.example", authorization_endpoint: "https://as.example/authorize",
          token_endpoint: "https://as.example/token", response_types_supported: ["code"],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      token: "tok-1",
    });
  } catch (error) { out.authorizationRequired = { name: error.name, message: error.message }; }
  out.authorizeCalls = authorizeCalls;
  // Stale token: another request already refreshed -> no authorize call.
  provider.tokenSet = { access_token: "tok-2", token_type: "Bearer" };
  let authorizeCalls2 = 0;
  await adapted.onUnauthorized({
    response: new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } }),
    serverUrl: new URL("https://rs.example/mcp"),
    fetch: async () => { authorizeCalls2++; return new Response("{}", { status: 200 }); },
    token: "tok-1",
  });
  out.staleTokenAuthorizeCalls = authorizeCalls2;
  // insufficient_scope skips refresh and goes straight to the redirect.
  provider.tokenSet = { access_token: "tok-3", token_type: "Bearer", refresh_token: "r-3" };
  try {
    await adapted.onUnauthorized({
      response: new Response(null, { status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="more"' } }),
      serverUrl: new URL("https://rs.example/mcp"),
      fetch: async () => new Response(str({
        issuer: "https://as.example", authorization_endpoint: "https://as.example/authorize",
        token_endpoint: "https://as.example/token", response_types_supported: ["code"],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      token: "tok-3",
    });
  } catch (error) { out.insufficientScope = { name: error.name, message: error.message }; }
  out.insufficientScopeRedirect = provider.authorizationUrl?.href;
  // With no stored token at all the challenge path still authorizes once.
  const fresh = new StubProvider();
  fresh.discovery = { authorizationServerUrl: "https://as.example" };
  const adaptedFresh = oauth.adaptOAuthProvider(fresh);
  let freshCalls = 0;
  try {
    await adaptedFresh.onUnauthorized({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL("https://rs.example/mcp"),
      fetch: async () => { freshCalls++; return new Response(str({
        issuer: "https://as.example", authorization_endpoint: "https://as.example/authorize",
        token_endpoint: "https://as.example/token", response_types_supported: ["code"],
      }), { status: 200 }); },
    });
  } catch (error) { out.freshAuthorizationRequired = error.name; }
  out.freshAuthorizeCalls = freshCalls;
  return out;
});

// ---------------------------------------------------------------------------
// 10. oauth/callback.ts over a real loopback listener
// ---------------------------------------------------------------------------
function rawGet(port, pathAndQuery) {
  return new Promise((resolve, reject) => {
    // agent:false -> Connection: close, so server.close() is not blocked by
    // the global agent's keep-alive sockets.
    const request = http.request({ host: "127.0.0.1", port, path: pathAndQuery, method: "GET", agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([key]) => key !== "date")),
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

await scenario("oauth_callback_server", async () => {
  const out = {};
  const server = await oauth.OAuthCallbackServer.listen({ port: 0 });
  out.redirectUrl = server.redirectUrl.replace(/:\d+/, ":PORT");
  const port = Number(/:(\d+)/.exec(server.redirectUrl)[1]);
  const pending = server.waitForCallback("state-1");
  const pagePromise = rawGet(port, "/callback?code=xyz&state=state-1&iss=https://as.example");
  const callback = await pending;
  out.callback = json(callback);
  out.okPage = await pagePromise;
  // Error callback.
  const pending2 = server.waitForCallback("state-2");
  const pagePromise2 = rawGet(port, "/callback?state=state-2&error=access_denied&error_description=User%20said%20no");
  try { await pending2; } catch (error) { out.errorCallback = error.message; }
  out.errorPage = await pagePromise2;
  // Unknown state -> 400 page.
  out.unknownState = await rawGet(port, "/callback?code=1&state=nope");
  out.missingState = await rawGet(port, "/callback?code=1");
  // Wrong path -> 404.
  out.wrongPath = await rawGet(port, "/other?state=state-1");
  // Missing code -> 400 and rejection.
  const pending3 = server.waitForCallback("state-3");
  const pagePromise3 = rawGet(port, "/callback?state=state-3");
  try { await pending3; } catch (error) { out.missingCodeCallback = error.message; }
  out.missingCodePage = await pagePromise3;
  // Duplicate pending state: registration throws synchronously. The state-4
  // waiter itself stays pending until server.close() rejects it below.
  server.waitForCallback("state-4");
  try { server.waitForCallback("state-4"); } catch (error) { out.duplicateState = error.message; }
  // renderPage HTML rendering with status passthrough.
  const server2 = await oauth.OAuthCallbackServer.listen({
    port: 0, path: "/cb", host: "127.0.0.1", redirectHost: "localhost",
    renderPage: (page) => `<html>${page.ok ? "OK" : `NO: ${page.message}`}</html>`,
  });
  out.customRedirectUrl = server2.redirectUrl.replace(/:\d+/, ":PORT");
  const port2 = Number(/:(\d+)/.exec(server2.redirectUrl)[1]);
  const pending5 = server2.waitForCallback("s");
  const pagePromise5 = rawGet(port2, "/cb?code=1&state=s");
  out.customCallback = json(await pending5);
  out.customOkPage = await pagePromise5;
  const pending6 = server2.waitForCallback("s2");
  const pagePromise6 = rawGet(port2, "/cb?state=s2&error=nope");
  try { await pending6; } catch { /* recorded by page */ }
  out.customErrorPage = await pagePromise6;
  // close() rejects pending waiters.
  const pending7 = server2.waitForCallback("s3");
  const closePromise = server2.close();
  try { await pending7; } catch (error) { out.closedPending = error.message; }
  await closePromise;
  await server.close();
  return out;
});

// ---------------------------------------------------------------------------

const manifest = {
  upstream: "2bbfcca43",
  package: "@earendil-works/pi-mcp 0.99.1",
  fixedNow: FIXED_NOW,
  rngStream: "draw k fills byte[i] = (k*32 + i) & 0xFF; the counter resets to 0 at the start of every scenario and draws are sequential within it",
  cryptoSubtle: "real WebCrypto SHA-256 (captured PKCE challenges are true S256 of the deterministic verifiers)",
  network: "all HTTP scenarios use an injected recorder fetch through the package's fetch options; the OAuth callback scenario listens on 127.0.0.1 loopback with raw sockets only",
  stagedSubstitutions: [
    {
      file: "packages/mcp/src/transports/stdio.ts",
      original: 'import crossSpawn from "cross-spawn";',
      replacement: 'import { spawn as crossSpawn } from "node:child_process";',
      reason: "ESM bare specifiers cannot resolve without node_modules; scenarios spawn a direct executable where cross-spawn delegates to node's spawn with identical options",
    },
  ],
  sourceHashes: hashes,
};
fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, "\t"));

const outDir = fileURLToPath(new URL(".", import.meta.url));
fs.writeFileSync(path.join(outDir, "mcp_oracle.json"), JSON.stringify(scenarios, null, "\t"));
fs.writeFileSync(path.join(outDir, "mcp_oracle.manifest.json"), JSON.stringify(manifest, null, "\t"));
console.log("scenarios:", Object.keys(scenarios).join(", "));
for (const [name, value] of Object.entries(scenarios)) {
  if (value && typeof value === "object" && "__captureError" in value) console.log(`ERROR in ${name}:\n${value.__captureError}`);
}
console.log("fixture written to", path.join(outDir, "mcp_oracle.json"));
// Some scenarios intentionally leave pending handles (never-closing SSE GET
// streams); exit explicitly once the fixture is on disk.
process.exit(Object.values(scenarios).some((value) => value && typeof value === "object" && "__captureError" in value) ? 1 : 0);
