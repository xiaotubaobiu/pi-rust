// Byte-oracle capture for the OAuth/auth-delta slice (upstream 2bbfcca43,
// baseline 590144609): copies the UNMODIFIED upstream TypeScript dependency
// closures into a temp directory (hashing every file for the provenance
// manifest) and executes them under Node's --experimental-strip-types with
// deterministic stubs:
//   - Date.now -> 1758240000000
//   - globalThis.crypto -> fake with a deterministic getRandomValues byte
//     stream (draw k fills byte[i] = (k*32 + i) & 0xFF), the real
//     webcrypto.subtle, and the fixed UUID
//     11223344-5566-4888-99aa-bbccddeeff00 for randomUUID().
//   - globalThis.fetch -> per-scenario recorder (records url/method/headers/
//     body, returns canned responses). The Rust port injects the same byte
//     stream through its test_entropy seam and replays the same fixtures.
//   - Two DOCUMENTED textual substitutions in the STAGED copies only (the
//     manifest hashes the ORIGINAL files): the `node:crypto` randomBytes
//     import in openai-chatgpt.ts and the lazy `import("node:crypto")`
//     loader in openai-codex.ts are replaced by the same deterministic
//     generator (ESM builtin bindings cannot be monkey-patched).
// Scenarios: the shared callback server (callback-server.ts, NEW), the two
// NEW flows (openai-chatgpt.ts, meta.ts), and the four refactored flows
// (anthropic.ts, openai-codex.ts, openrouter.ts, radius.ts) — page bytes,
// request shapes, error strings and events, with NO real network (loopback
// listeners only).
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { createHash } from "node:crypto";
import { webcrypto } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const upstreamRoot = fileURLToPath(new URL("../../../../pi/", import.meta.url));
const aiSrc = path.join(upstreamRoot, "packages", "ai", "src");

const CLOSURES = {
  callbackServer: ["auth/oauth/callback-server.ts"],
  openaiChatgpt: ["auth/oauth/openai-chatgpt.ts"],
  meta: ["auth/oauth/meta.ts"],
  anthropic: ["auth/oauth/anthropic.ts"],
  openaiCodex: ["auth/oauth/openai-codex.ts"],
  openrouter: ["auth/oauth/openrouter.ts"],
  radius: ["auth/oauth/radius.ts", "providers/radius-config.ts"],
};

const hashes = {};
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ai-oauth-oracle-"));
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

for (const entries of Object.values(CLOSURES)) {
  for (const entry of entries) copyClosure(entry);
}

// Deterministic RNG (shared with the Rust oracle tests through the entropy
// queue): draw k fills byte[i] = (k*32 + i) & 0xFF.
globalThis.__oracleRngCall = 0;
const draw32 = () => {
  const k = globalThis.__oracleRngCall++;
  return Buffer.from({ length: 32 }, (_, i) => (k * 32 + i) & 0xFF);
};

// openai-chatgpt.ts substitution: the module-level randomBytes import.
{
  const rel = "auth/oauth/openai-chatgpt.ts";
  const target = path.join(stagedRoot, ...rel.split("/"));
  let source = fs.readFileSync(target, "utf8");
  const original = 'import { randomBytes } from "node:crypto";';
  const replacement = `const randomBytes = (n) => {
	const bytes = Buffer.alloc(n);
	const drawn = draw32();
	for (let i = 0; i < n; i++) bytes[i] = drawn[i % 32];
	return bytes;
};
function draw32() {
	const k = globalThis.__oracleRngCall++;
	const bytes = Buffer.alloc(32);
	for (let i = 0; i < 32; i++) bytes[i] = (k * 32 + i) & 0xFF;
	return bytes;
}`;
  if (!source.includes(original)) throw new Error(`openai-chatgpt substitution anchor missing`);
  source = source.replace(original, replacement);
  fs.writeFileSync(target, source);
}

// openai-codex.ts substitution: the lazy node:crypto loader block.
{
  const rel = "auth/oauth/openai-codex.ts";
  const target = path.join(stagedRoot, ...rel.split("/"));
  let source = fs.readFileSync(target, "utf8");
  const original = `let _randomBytes: typeof import("node:crypto").randomBytes | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:crypto").then((m) => {
		_randomBytes = m.randomBytes;
	});
}`;
  const replacement = `let _randomBytes: ((n: number) => Buffer) | null = (n) => {
	const bytes = Buffer.alloc(n);
	const k = globalThis.__oracleRngCall++;
	for (let i = 0; i < n; i++) bytes[i] = (k * 32 + i) & 0xFF;
	return bytes;
};`;
  if (!source.includes(original)) throw new Error(`openai-codex substitution anchor missing`);
  source = source.replace(original, replacement);
  fs.writeFileSync(target, source);
}

// Determinism stubs (the staged modules run in this process).
const FIXED_NOW = 1758240000000;
const FIXED_UUID = "11223344-5566-4888-99aa-bbccddeeff00";
Date.now = () => FIXED_NOW;
const fakeCrypto = {
  getRandomValues(array) {
    const k = globalThis.__oracleRngCall++;
    for (let i = 0; i < array.length; i++) array[i] = (k * 32 + i) & 0xFF;
    return array;
  },
  subtle: webcrypto.subtle,
  randomUUID: () => FIXED_UUID,
};
Object.defineProperty(globalThis, "crypto", { value: fakeCrypto, configurable: true });

const stagedUrl = (rel) => pathToFileURL(path.join(stagedRoot, ...rel.split("/"))).href;

// One raw loopback GET returning status + interesting headers + exact body.
function rawGet(port, target, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: target, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          contentType: res.headers["content-type"] ?? null,
          cacheControl: res.headers["cache-control"] ?? null,
          body,
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

// A local http server for stubbed token/gateway endpoints (radius).
function localServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const record = { method: request.method, url: request.url, headers: { ...request.headers }, body };
        const reply = handler(record);
        response.writeHead(reply.status ?? 200, reply.headers ?? { "content-type": "application/json" });
        response.end(reply.body ?? "");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ port, close: () => server.close() });
    });
  });
}

const nativeFetch = globalThis.fetch;

const STATUS_TEXT = {
  200: "OK", 201: "Created", 400: "Bad Request", 401: "Unauthorized",
  403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway",
};

function stubResponse(body, status = 200, contentType = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: STATUS_TEXT[status] ?? "",
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

// Installs a recording fetch handler; returns the captured request list.
function installFetch(handler) {
  const captured = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let body = init?.body ?? null;
    if (body instanceof URLSearchParams) body = body.toString();
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers ?? {}) },
      body: typeof body === "string" ? body : body == null ? null : String(body),
    });
    return handler(captured[captured.length - 1]);
  };
  return captured;
}

function cloneEvent(event) {
  return JSON.parse(JSON.stringify(event));
}

// A flow interaction recording events and answering prompts through the
// driver closure.
// v1.0.0: the Anthropic login prompts the method select first; this wrapper
// always answers it with the browser flow and hands later prompts to `impl`.
// Other flows never emit a select, so wrapping is a no-op there.
const selectAware = (impl) => async (prompt) => {
  if (prompt && prompt.type === "select") return "browser";
  return impl(prompt);
};
function makeInteraction({ promptImpl, deviceId } = {}) {
  const events = [];
  const controller = new AbortController();
  const interaction = {
    signal: controller.signal,
    notify: (event) => events.push(cloneEvent(event)),
    prompt: (prompt) => promptImpl(prompt),
  };
  if (deviceId !== undefined) interaction.options = { getDeviceId: () => deviceId };
  return { interaction, events, controller };
}

const DEVICE_ID = "e61bbe28-07ef-466d-8e5d-a344f94ab305";

// Progress logging to stderr so a hang identifies its scenario.
let __currentScenario = "init";
const __log = (label) => {
  __currentScenario = label;
  console.error(`[capture] ${label}`);
};
// Hard stop so a stuck scenario fails loudly instead of hanging forever.
setTimeout(() => {
  console.error(`[capture] TIMEOUT in scenario: ${__currentScenario}`);
  process.exit(97);
}, 120000).unref();

// Wait for a holder to be populated, failing after 10s instead of hanging.
async function waitFor(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`[capture] timeout waiting: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const REQUIRED_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const TOKEN_BODY = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  id_token: "id-token",
  scope: REQUIRED_SCOPE,
};

// Mask the ephemeral port in a redirect URI (the port differs per run).
const maskPort = (uri) =>
  uri.replace(/(127\.0\.0\.1|localhost):\d+/, "$1:<port>");

function pageOf(response) {
  return { status: response.status, contentType: response.contentType, cacheControl: response.cacheControl, body: response.body };
}

const out = {};
const outFiles = {};

// ---------------------------------------------------------------------------
// 1. Shared callback server (callback-server.ts)
// ---------------------------------------------------------------------------
{
  const ns = await import(stagedUrl("auth/oauth/callback-server.ts"));
  const scenarios = {};
  __log("callbackServer.strayRequests");

  // "ignores stray requests and resolves with the completed code"
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const server = await ns.startOAuthCallbackServer({
      providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
      state: "expected-state",
      complete: async (code) => `completed:${code}`,
    });
    const port = new URL(server.redirectUri).port;
    const wrongPath = pageOf(await rawGet(port, "/other"));
    const wrongState = pageOf(await rawGet(port, "/callback?code=c&state=other"));
    const wrongMethod = await (async () => {
      // node:http POST.
      return new Promise((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port, path: "/callback?code=c&state=expected-state", method: "POST" }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        });
        request.on("error", reject);
        request.end();
      });
    })();
    const missingCode = pageOf(await rawGet(port, "/callback?state=expected-state"));
    const success = pageOf(await rawGet(port, "/callback?code=the-code&state=expected-state"));
    const settled = await server.wait();
    scenarios.strayRequests = {
      redirectUri: maskPort(server.redirectUri),
      wrongPath, wrongState, wrongMethod, missingCode, success,
      wait: settled,
    };
    server.close();
  }

  // "uses the redirect host and skips the state check when none is expected"
  {
    const server = await ns.startOAuthCallbackServer({
      providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
      redirectHost: "localhost",
      complete: async (code) => `completed:${code}`,
    });
    const port = new URL(server.redirectUri).port;
    const success = pageOf(await rawGet(port, "/callback?code=no-state"));
    scenarios.redirectHostNoState = {
      redirectUri: maskPort(server.redirectUri),
      success,
      wait: await server.wait(),
    };
    server.close();
  }

  // "shows completion failures on the page and rejects the wait"
  {
    const server = await ns.startOAuthCallbackServer({
      providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
      state: "expected-state",
      complete: async () => { throw new Error("token exchange failed"); },
    });
    const port = new URL(server.redirectUri).port;
    const failure = pageOf(await rawGet(port, "/callback?code=c&state=expected-state"));
    let waitError = null;
    try { await server.wait(); } catch (error) { waitError = error.message; }
    scenarios.completionFailure = { failure, waitError };
    server.close();
  }

  // "rejects the wait when the provider redirects with an error"
  {
    const server = await ns.startOAuthCallbackServer({
      providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
      state: "expected-state",
      complete: async (code) => code,
    });
    const port = new URL(server.redirectUri).port;
    const failure = pageOf(await rawGet(port, "/callback?error=access_denied&error_description=User%20denied%20access&state=expected-state"));
    let waitError = null;
    try { await server.wait(); } catch (error) { waitError = error.message; }
    scenarios.providerError = { failure, waitError };
    server.close();
  }

  // "completes only the first callback" (409 while the exchange is in flight)
  {
    let finishExchange;
    const server = await ns.startOAuthCallbackServer({
      providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
      state: "expected-state",
      complete: () => new Promise((resolve) => { finishExchange = resolve; }),
    });
    const port = new URL(server.redirectUri).port;
    const firstPromise = rawGet(port, "/callback?code=c&state=expected-state");
    await waitFor(() => finishExchange, "complete started");
    const second = pageOf(await rawGet(port, "/callback?code=c&state=expected-state"));
    server.cancel();
    finishExchange("done");
    const first = pageOf(await firstPromise);
    scenarios.firstCallbackWins = { second, first, wait: await server.wait() };
    server.close();
  }

  // "resolves with undefined after cancel" (late browser request gets 409)
  {
    const server = await ns.startOAuthCallbackServer({
      providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
      state: "expected-state",
      complete: async (code) => code,
    });
    server.cancel();
    const port = new URL(server.redirectUri).port;
    const late = pageOf(await rawGet(port, "/callback?code=c&state=expected-state"));
    scenarios.cancelResolvesUndefined = { wait: await server.wait(), late };
    server.close();
  }

  // "rejects the wait on abort and on timeout" + entry abort
  {
    const controller = new AbortController();
    const server = await ns.startOAuthCallbackServer({
      providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
      state: "expected-state", signal: controller.signal,
      complete: async (code) => code,
    });
    controller.abort();
    let abortError = null;
    try { await server.wait(); } catch (error) { abortError = error.message; }
    server.close();

    const timedOut = await ns.startOAuthCallbackServer({
      providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
      state: "expected-state", timeoutMs: 10,
      complete: async (code) => code,
    });
    let timeoutError = null;
    try { await timedOut.wait(); } catch (error) { timeoutError = error.message; }
    timedOut.close();

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let entryError = null;
    try {
      await ns.startOAuthCallbackServer({
        providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
        signal: alreadyAborted.signal,
        complete: async (code) => code,
      });
    } catch (error) { entryError = error.message; }

    scenarios.abortAndTimeout = { abortError, timeoutError, entryError };
  }

  // waitForCallbackOrManualInput scenarios
  {
    const pendingPrompt = (onPrompt) => (prompt) => {
      onPrompt?.(prompt);
      return new Promise((_, reject) => {
        prompt.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true });
      });
    };
    const baseInteraction = (promptImpl) => ({
      signal: new AbortController().signal,
      notify: () => {},
      prompt: promptImpl,
    });

    // callback wins, manual prompt aborted
    {
      let manualSignal;
      const server = await ns.startOAuthCallbackServer({
        providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
        complete: async (code) => code,
      });
      const port = new URL(server.redirectUri).port;
      const result = ns.waitForCallbackOrManualInput(
        baseInteraction(pendingPrompt((prompt) => { manualSignal = prompt; })),
        server,
        { message: "paste", placeholder: server.redirectUri },
      );
      await rawGet(port, "/callback?code=from-browser");
      const settled = await result;
      scenarios.manualPromptAbortedByCallback = {
        result: { type: settled.type, value: settled.value ?? null },
        manualSignalAborted: manualSignal?.aborted === true,
        prompt: { message: "paste", placeholder: "<redirectUri>" },
      };
      server.close();
    }

    // manual wins
    {
      const server = await ns.startOAuthCallbackServer({
        providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
        complete: async (code) => code,
      });
      const result = await ns.waitForCallbackOrManualInput(
        baseInteraction(async () => "pasted"),
        server,
        { message: "paste", placeholder: server.redirectUri },
      );
      scenarios.manualWins = { result: { type: result.type, input: result.input } };
      server.close();
    }

    // no server: manual only
    {
      const result = await ns.waitForCallbackOrManualInput(
        baseInteraction(async () => "pasted"),
        undefined,
        { message: "paste", placeholder: "http://localhost/callback" },
      );
      scenarios.manualOnlyWithoutServer = { result: { type: result.type, input: result.input } };
    }

    // prompt failure propagates
    {
      const server = await ns.startOAuthCallbackServer({
        providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
        complete: async (code) => code,
      });
      let failure = null;
      try {
        await ns.waitForCallbackOrManualInput(
          baseInteraction(async () => { throw new Error("prompt cancelled"); }),
          server,
          { message: "paste", placeholder: server.redirectUri },
        );
      } catch (error) { failure = error.message; }
      scenarios.promptFailurePropagates = { failure };
      server.close();
    }

    // manual error wins over a delivered callback value
    {
      const server = await ns.startOAuthCallbackServer({
        providerName: "Example", host: "127.0.0.1", port: 0, path: "/callback",
        complete: async (code) => code,
      });
      const port = new URL(server.redirectUri).port;
      let failure = null;
      try {
        const result = ns.waitForCallbackOrManualInput(
          baseInteraction(async () => {
            await rawGet(port, "/callback?code=browser-code");
            throw new Error("manual blew up");
          }),
          server,
          { message: "paste", placeholder: server.redirectUri },
        );
        await result;
      } catch (error) { failure = error.message; }
      scenarios.manualErrorWinsOverCallback = { failure };
      server.close();
    }
  }

  out.callbackServer = scenarios;
  fs.writeFileSync(path.join(import.meta.dirname, "callback_server_oracle.json"), JSON.stringify(scenarios, null, 2));
  outFiles["callback_server_oracle.json"] = true;
}

// ---------------------------------------------------------------------------
// 2. openai-chatgpt (NEW flow)
  __log("openaiChatgpt group");
// ---------------------------------------------------------------------------
{
  const ns = await import(stagedUrl("auth/oauth/openai-chatgpt.ts"));
  const oauth = ns.openaiChatGPTOAuth;
  const scenarios = {};

  const callbackPathOf = (authorizeUrl) => {
    const url = new URL(authorizeUrl);
    return {
      client_id: url.searchParams.get("client_id"),
      agent_name_hint: url.searchParams.get("agent_name_hint"),
      ext_agent_host_id: url.searchParams.get("ext_agent_host_id"),
      response_type: url.searchParams.get("response_type"),
      redirect_uri: url.searchParams.get("redirect_uri"),
      resource: url.searchParams.get("resource"),
      scope: url.searchParams.get("scope"),
      state: url.searchParams.get("state"),
      code_challenge: url.searchParams.get("code_challenge"),
      code_challenge_method: url.searchParams.get("code_challenge_method"),
      nonce: url.searchParams.get("nonce"),
    };
  };

  const pasteAnswer = (authorizeUrl, extra) => {
    const url = new URL(authorizeUrl);
    const callback = new URL(url.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", url.searchParams.get("state"));
    for (const [key, value] of Object.entries(extra)) callback.searchParams.set(key, value);
    return callback.toString();
  };

  // Full login through the real loopback callback with the issued client id.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch(() => stubResponse(TOKEN_BODY));
    const events = [];
    const { interaction } = makeInteraction({
      deviceId: DEVICE_ID,
      promptImpl: async (prompt) => {
        if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
        // Answered but loses the race against the browser callback.
        return new Promise(() => {});
      },
    });
    // Wrap notify to also read the authorize URL for the driver.
    const authorizeHolder = { url: undefined };
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    const login = oauth.login(interaction, interaction.options);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const authorize = callbackPathOf(authorizeHolder.url);
    const callbackResponse = pageOf(await rawGet(1455,
      `/auth/callback?code=authorization-code&state=${authorize.state}&client_id=oaiapp_issued`));
    const credential = await login;
    scenarios.callbackLogin = {
      authorize,
      instructions: "Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.",
      callbackResponse,
      tokenRequest: captured[0],
      credential,
      events: [],
    };
  }

  // Registration callback without the issued client id: page + no exchange.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch(() => stubResponse(TOKEN_BODY));
    const authorizeHolder = { url: undefined };
    const { interaction, controller } = makeInteraction({
      deviceId: DEVICE_ID,
      // A pending UI prompt rejects when its signal aborts.
      promptImpl: (prompt) =>
        new Promise((_, reject) => {
          prompt.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true });
        }),
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    const login = oauth.login(interaction, interaction.options);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const authorize = callbackPathOf(authorizeHolder.url);
    const callbackResponse = pageOf(await rawGet(1455,
      `/auth/callback?code=authorization-code&state=${authorize.state}`));
    // Cancel through the interaction signal: the login is still waiting.
    setTimeout(() => controller.abort(), 50);
    let loginError = null;
    try { await login; } catch (error) { loginError = error.message; }
    scenarios.registrationWithoutClientId = { callbackResponse, loginError, tokenRequestCount: captured.length };
  }

  // Manual paste completes the login (callback server healthy, paste first).
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch(() => stubResponse(TOKEN_BODY));
    const authorizeHolder = { url: undefined };
    const { interaction } = makeInteraction({
      deviceId: DEVICE_ID,
      promptImpl: async (prompt) => {
        if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
        if (!authorizeHolder.url) throw new Error("authorize URL not emitted before the prompt");
        return pasteAnswer(authorizeHolder.url, { client_id: "oaiapp_issued" });
      },
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    const credential = await oauth.login(interaction, interaction.options);
    scenarios.manualPasteLogin = {
      authorize: callbackPathOf(authorizeHolder.url),
      prompt: {
        type: "manual_code",
        message: "Complete login in your browser, or paste the final redirect URL here:",
        placeholder: "http://127.0.0.1:1455/auth/callback",
      },
      tokenRequest: captured[0],
      credential,
      events: [
        { type: "progress", message: "Exchanging authorization code for tokens..." },
      ],
    };
  }

  // Device-ID validation happens before any authorization work.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch(() => stubResponse(TOKEN_BODY));
    let authorizeEmitted = false;
    let prompted = false;
    const { interaction } = makeInteraction({
      promptImpl: async () => { prompted = true; return "x"; },
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeEmitted = true;
      originalNotify(event);
    };
    let error1 = null;
    try { await oauth.login(interaction); } catch (error) { error1 = error.message; }
    let error2 = null;
    try { await oauth.login(interaction, { getDeviceId: () => "not-a-uuid" }); } catch (error) { error2 = error.message; }
    scenarios.deviceIdRequired = {
      error1, error2, authorizeEmitted, prompted, fetchCount: captured.length,
    };
  }

  // Bind failure degrades to manual-only login through the info notice
  // (error text is platform-specific; the prefix is pinned).
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const blocker = http.createServer(() => {});
    await new Promise((resolve) => blocker.listen(1455, "127.0.0.1", resolve));
    const captured = installFetch(() => stubResponse(TOKEN_BODY));
    const authorizeHolder = { url: undefined };
    const events = [];
    const { interaction } = makeInteraction({
      deviceId: DEVICE_ID,
      promptImpl: async () => {
        if (!authorizeHolder.url) throw new Error("authorize URL not emitted before the prompt");
        return pasteAnswer(authorizeHolder.url, { client_id: "oaiapp_issued" });
      },
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    let credential;
    let bindError = null;
    try {
      credential = await oauth.login(interaction, interaction.options);
    } catch (error) {
      bindError = error.message;
    }
    // v1.0.0: a taken callback port fails the login instead of degrading to
    // manual paste (the browser callback would hit whatever else holds the
    // port, which rejects it as a state mismatch). No authorize URL is
    // emitted and no token request happens.
    scenarios.bindFailurePortTaken = {
      error: bindError,
      credential,
    };
    blocker.close();
  }

  // Manual-paste validation errors (pure authorizationResultFromManualInput
  // paths, exercised through the login surface with the callback server
  // healthy; v1.0.0 a blocked port would fail the login before any paste).
  {
    const validationCases = {};
    for (const [name, pasted] of Object.entries({
      not_a_url: "garbage",
      wrong_origin: "http://127.0.0.1:9999/auth/callback?code=c&state=s",
      wrong_path: "http://127.0.0.1:1455/other?code=c&state=s",
      provider_error: "http://127.0.0.1:1455/auth/callback?error=access_denied&error_description=nope",
      missing_client_id: "http://127.0.0.1:1455/auth/callback?code=c&state=s",
    })) {
      globalThis.__oracleRngCall = 0;
    __log("scenario step");
      installFetch(() => stubResponse(TOKEN_BODY));
      const { interaction } = makeInteraction({
        deviceId: DEVICE_ID,
        promptImpl: async () => pasted,
      });
      let failure = null;
      try { await oauth.login(interaction, interaction.options); } catch (error) { failure = error.message; }
      validationCases[name] = failure;
    }
    scenarios.manualValidation = validationCases;
  }

  // Token-response validation through refresh (no loopback needed).
  {
    const connectedCredential = {
      type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0,
      clientId: "oaiapp_existing",
      scopes: REQUIRED_SCOPE.split(" "),
    };
    const cases = {};
    const refreshWith = async (body) => {
      globalThis.__oracleRngCall = 0;
    __log("scenario step");
      const captured = installFetch(() => stubResponse(body));
      const credential = await oauth.refresh(connectedCredential, new AbortController().signal);
      return { tokenRequest: captured[0], credential };
    };
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    installFetch(() => stubResponse({ ...TOKEN_BODY, refresh_token: undefined }));
    let error = null;
    try { await refreshWith({ ...TOKEN_BODY, refresh_token: undefined }); } catch (e) { error = e.message; }
    cases.missingRefresh = { error };
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    installFetch(() => stubResponse({ ...TOKEN_BODY, scope: "openid profile email offline_access resource.invoke" }));
    error = null;
    try { await oauth.refresh(connectedCredential, new AbortController().signal); } catch (e) { error = e.message; }
    cases.narrowScope = { error };
    const refreshed = await refreshWith({ ...TOKEN_BODY, access_token: "new-access", refresh_token: "new-refresh" });
    cases.refreshed = refreshed;
    scenarios.refresh = cases;
  }

  // Token endpoint error shapes through refresh.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch(() => stubResponse("denied", 400));
    let error = null;
    try { await oauth.refresh({ type: "oauth", access: "a", refresh: "r", expires: 0, clientId: "c", scopes: [] }, new AbortController().signal); } catch (e) { error = e.message; }
    scenarios.tokenHttpError = { tokenRequest: captured[0], error };
  }

  out.openaiChatgpt = scenarios;
  fs.writeFileSync(path.join(import.meta.dirname, "openai_chatgpt_oracle.json"), JSON.stringify(scenarios, null, 2));
  outFiles["openai_chatgpt_oracle.json"] = true;
}

// ---------------------------------------------------------------------------
// 3. meta (NEW flow)
  __log("meta group");
// ---------------------------------------------------------------------------
{
  const ns = await import(stagedUrl("auth/oauth/meta.ts"));
  const oauth = ns.metaOAuth;
  const scenarios = {};

  const runLogin = async (fetchHandler) => {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch(fetchHandler);
    const { interaction, events } = makeInteraction({
      promptImpl: async () => { throw new Error("Meta login should not prompt"); },
    });
    const credential = await oauth.login(interaction);
    return { captured, events, credential };
  };

  // Happy path: pending poll, then the identity token, then the mint.
  {
    let pollCount = 0;
    const { captured, events, credential } = await runLogin((record) => {
      if (record.url === "https://auth.meta.com/oidc/device/authorization/") {
        return stubResponse({
          device_code: "device-code-123",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.meta.com/oauth/device/",
          verification_uri_complete: "https://auth.meta.com/oauth/device/?code=ABCD-1234",
          interval: 5,
          expires_in: 600,
        });
      }
      if (record.url === "https://auth.meta.com/oidc/device/token/") {
        pollCount += 1;
        return pollCount === 1
          ? stubResponse({ error: "authorization_pending" }, 400)
          : stubResponse({ access_token: "identity-token", token_type: "Bearer" });
      }
      if (record.url === "https://api.meta.ai/muse-code/key") {
        return stubResponse({ api_key: "LLM|minted-key" });
      }
      throw new Error(`Unexpected fetch URL: ${record.url}`);
    });
    scenarios.login = { requests: captured, events, credential, pollCount };
  }

  // Refresh re-mints from the stored identity token.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch(() => stubResponse({ api_key: "LLM|fresh-key" }));
    const credential = await oauth.refresh(
      { type: "oauth", refresh: "identity-token", access: "LLM|old-key", expires: 1 },
      new AbortController().signal,
    );
    scenarios.refresh = { requests: captured, credential };
  }

  // No key issued: the setup URL surfaces.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    installFetch(() => stubResponse({ require_payment: true, action_url: "https://dev.meta.ai/billing" }));
    let error = null;
    try {
      await oauth.refresh({ type: "oauth", refresh: "identity-token", access: "", expires: 1 }, new AbortController().signal);
    } catch (e) { error = e.message; }
    scenarios.noKeySetupUrl = { error };
  }

  // Mint error shapes (401 session expired with detail precedence; generic).
  {
    const cases = {};
    for (const [name, body, status] of [
      ["sessionExpired", { error: "invalid_token", error_description: "expired" }, 401],
      ["forbiddenDetail", { detail: "no seats" }, 403],
      ["genericFailure", { message: "mint offline" }, 500],
      ["invalidDeviceAuth", null, 503],
    ]) {
      globalThis.__oracleRngCall = 0;
    __log("scenario step");
      installFetch(() => stubResponse(body ?? {}, status));
      let error = null;
      try {
        await oauth.refresh({ type: "oauth", refresh: "identity-token", access: "", expires: 1 }, new AbortController().signal);
      } catch (e) { error = e.message; }
      cases[name] = error;
    }
    // Device-authorization failure shape (non-ok with detail).
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    installFetch(() => stubResponse({ error: "slow_down", error_description: "easy" }, 429));
    let error = null;
    try {
      await oauth.login(makeInteraction({ promptImpl: async () => { throw new Error("no prompt"); } }).interaction);
    } catch (e) { error = e.message; }
    cases.deviceAuthFailed = error;
    scenarios.mintErrors = cases;
  }

  // Trusted-URL validation: a javascript: verification URI is rejected.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    installFetch(() => stubResponse({
      device_code: "d", user_code: "U", verification_uri: "javascript:alert(1)", interval: 5, expires_in: 600,
    }));
    let error = null;
    try {
      await oauth.login(makeInteraction({ promptImpl: async () => { throw new Error("no prompt"); } }).interaction);
    } catch (e) { error = e.message; }
    scenarios.untrustedVerificationUri = { error };
  }

  // Poll terminal errors.
  {
    const cases = {};
    for (const [name, body] of [
      ["accessDenied", { error: "access_denied" }],
      ["expired", { error: "expired_token" }],
      ["unknownError", { error: "weird_thing", message: "boom" }],
    ]) {
      globalThis.__oracleRngCall = 0;
    __log("scenario step");
      installFetch((record) => {
        if (record.url.endsWith("/authorization/")) {
          return stubResponse({ device_code: "d", user_code: "U", verification_uri: "https://meta.example/device", interval: 5, expires_in: 600 });
        }
        return stubResponse(body, 400);
      });
      let error = null;
      try {
        await oauth.login(makeInteraction({ promptImpl: async () => { throw new Error("no prompt"); } }).interaction);
      } catch (e) { error = e.message; }
      cases[name] = error;
    }
    scenarios.pollErrors = cases;
  }

  // toAuth.
  {
    const auth = await oauth.toAuth({ type: "oauth", refresh: "identity-token", access: "LLM|key", expires: 1 });
    scenarios.toAuth = auth;
  }

  out.meta = scenarios;
  fs.writeFileSync(path.join(import.meta.dirname, "meta_oracle.json"), JSON.stringify(scenarios, null, 2));
  outFiles["meta_oracle.json"] = true;
}

// ---------------------------------------------------------------------------
// 4. anthropic (refactored flow)
  __log("anthropic group");
// ---------------------------------------------------------------------------
{
  const ns = await import(stagedUrl("auth/oauth/anthropic.ts"));
  const oauth = ns.anthropicOAuth;
  const scenarios = {};
  const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
  const TOKEN_JSON = { access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 };

  const pasteAnswer = (authorizeUrl, query) => {
    const url = new URL(authorizeUrl);
    return `${url.searchParams.get("redirect_uri")}?${query}`;
  };

  // Full login through the shared callback server with the real state.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch((record) => {
      if (record.url === TOKEN_URL) return stubResponse(TOKEN_JSON);
      throw new Error(`Unexpected fetch: ${record.url}`);
    });
    const authorizeHolder = { url: undefined };
    const events = [];
    const { interaction } = makeInteraction({
      promptImpl: selectAware(async () => new Promise(() => {})),
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      events.push(cloneEvent(event));
      originalNotify(event);
    };
    const login = oauth.login(interaction);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const url = new URL(authorizeHolder.url);
    const authorizeParams = {};
    for (const [key, value] of url.searchParams) authorizeParams[key] = value;
    const state = authorizeParams.state;
    const success = pageOf(await rawGet(53692, `/callback?code=cb-code&state=${state}`));
    const credential = await login;
    scenarios.callbackLogin = {
      authorizeUrl: authorizeHolder.url,
      instructions: "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
      success,
      tokenRequest: captured[0],
      credential,
      progressEvents: events.filter((event) => event.type === "progress"),
    };
  }

  // Provider error redirect fails the login with the shared message.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    installFetch(() => stubResponse(TOKEN_JSON));
    const authorizeHolder = { url: undefined };
    const { interaction, controller } = makeInteraction({
      promptImpl: selectAware(async () => new Promise(() => {})),
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    const login = oauth.login(interaction);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const url = new URL(authorizeHolder.url);
    const failure = pageOf(await rawGet(53692, `/callback?error=access_denied&error_description=User%20said%20no&state=${url.searchParams.get("state")}`));
    let loginError = null;
    try { await login; } catch (error) { loginError = error.message; }
    scenarios.providerError = { failure, loginError };
  }

  // Manual paste (server healthy, paste wins) with a state mismatch.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    installFetch(() => stubResponse(TOKEN_JSON));
    const { interaction } = makeInteraction({
      promptImpl: selectAware(async (prompt) => {
        if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
        return "http://localhost:53692/callback?code=x&state=wrong-state";
      }),
    });
    let loginError = null;
    try { await oauth.login(interaction); } catch (error) { loginError = error.message; }
    scenarios.manualStateMismatch = { loginError, prompt: { type: "manual_code", message: "Complete login in your browser, or paste the authorization code / redirect URL here:", placeholder: "http://localhost:53692/callback" } };
  }

  // Bind failure (53692 taken): manual-only login still completes.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch((record) => {
      if (record.url === TOKEN_URL) return stubResponse(TOKEN_JSON);
      throw new Error(`Unexpected fetch: ${record.url}`);
    });
    const blocker = http.createServer(() => {});
    await new Promise((resolve) => blocker.listen(53692, "127.0.0.1", resolve));
    const authorizeHolder = { url: undefined };
    const { interaction } = makeInteraction({
      promptImpl: selectAware(async (prompt) => {
        if (!authorizeHolder.url) throw new Error("authorize URL not emitted before the prompt");
        return pasteAnswer(authorizeHolder.url, `code=manual-code&state=${new URL(authorizeHolder.url).searchParams.get("state")}`);
      }),
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    const credential = await oauth.login(interaction);
    scenarios.bindFailureManualPaste = { tokenRequest: captured[0], credential };
    blocker.close();
  }

  // Token exchange/refresh error shapes (unchanged request code; pinned for
  // the refactor slice's provenance).
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch(() => stubResponse("denied", 400));
    const authorizeHolder = { url: undefined };
    const { interaction } = makeInteraction({
      promptImpl: selectAware(async () => "the-code"),
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    let loginError = null;
    try { await oauth.login(interaction); } catch (error) { loginError = error.message; }
    scenarios.exchangeHttpError = {
      tokenRequest: captured[0],
      errorPrefix: loginError.slice(0, loginError.indexOf("details=") + "details=".length),
      errorIsPlatformSpecific: true,
    };

    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    installFetch(() => stubResponse("nope", 400));
    let refreshError = null;
    try {
      await oauth.refresh({ type: "oauth", refresh: "r", access: "a", expires: 0 }, new AbortController().signal);
    } catch (error) { refreshError = error.message; }
    scenarios.refreshHttpError = { error: refreshError };
  }

  out.anthropic = scenarios;
  fs.writeFileSync(path.join(import.meta.dirname, "anthropic_oracle.json"), JSON.stringify(scenarios, null, 2));
  outFiles["anthropic_oracle.json"] = true;
}

// ---------------------------------------------------------------------------
// 5. openai-codex (refactored flow)
  __log("openaiCodex group");
// ---------------------------------------------------------------------------
{
  const ns = await import(stagedUrl("auth/oauth/openai-codex.ts"));
  const oauth = ns.openaiCodexOAuth;
  const scenarios = {};
  const JWT_CLAIM = "https://api.openai.com/auth";
  const b64 = (input) => Buffer.from(input).toString("base64");
  const accessTokenFor = (accountId) =>
    `${b64('{"alg":"none"}')}.${b64(`{"${JWT_CLAIM}":{"chatgpt_account_id":"${accountId}"}}`)}.signature`;
  const TOKEN_URL = "https://auth.openai.com/oauth/token";

  const browserInteraction = (onAuthorize) => {
    const authorizeHolder = { url: undefined };
    const { interaction } = makeInteraction({
      promptImpl: async (prompt) => {
        if (prompt.type === "select") return "browser";
        if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
        return new Promise(() => {});
      },
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    return { interaction, authorizeHolder };
  };

  // Browser login through the shared callback server on 1455.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch((record) => {
      if (record.url === TOKEN_URL) {
        return stubResponse({ access_token: accessTokenFor("cb-account"), refresh_token: "cb-refresh", expires_in: 3600 });
      }
      throw new Error(`Unexpected fetch: ${record.url}`);
    });
    const { interaction, authorizeHolder } = browserInteraction();
    const login = oauth.login(interaction);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const url = new URL(authorizeHolder.url);
    const authorizeParams = {};
    for (const [key, value] of url.searchParams) authorizeParams[key] = value;
    const success = pageOf(await rawGet(1455, `/auth/callback?code=cb-code&state=${authorizeParams.state}`));
    const credential = await login;
    scenarios.browserLogin = {
      authorizeUrl: authorizeHolder.url,
      instructions: "A browser window should open. Complete login to finish.",
      success,
      tokenRequest: captured.find((request) => request.url === TOKEN_URL),
      credential,
    };
  }

  // State mismatch + missing code keep the login waiting; provider error
  // fails it (the shared server's error branch).
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    installFetch(() => stubResponse({ access_token: accessTokenFor("a"), refresh_token: "r", expires_in: 3600 }));
    const { interaction, authorizeHolder } = browserInteraction();
    const login = oauth.login(interaction);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const state = new URL(authorizeHolder.url).searchParams.get("state");
    const mismatch = pageOf(await rawGet(1455, `/auth/callback?code=cb&state=wrong`));
    const missingCode = pageOf(await rawGet(1455, `/auth/callback?state=${state}`));
    const failure = pageOf(await rawGet(1455, `/auth/callback?error=access_denied&error_description=nope&state=${state}`));
    let loginError = null;
    try { await login; } catch (error) { loginError = error.message; }
    scenarios.routes = { mismatch, missingCode, failure, loginError };
  }

  // Bind failure (1455 taken): manual-only login completes.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch((record) => {
      if (record.url === TOKEN_URL) {
        return stubResponse({ access_token: accessTokenFor("manual-account"), refresh_token: "manual-refresh", expires_in: 3600 });
      }
      throw new Error(`Unexpected fetch: ${record.url}`);
    });
    const blocker = http.createServer(() => {});
    await new Promise((resolve) => blocker.listen(1455, "127.0.0.1", resolve));
    const { interaction, authorizeHolder } = browserInteraction();
    // Replace the hanging prompt with a paste responder (after select).
    const pasteInteraction = {
      ...interaction,
      prompt: async (prompt) => {
        if (prompt.type === "select") return "browser";
        if (!authorizeHolder.url) throw new Error("authorize URL not emitted before the prompt");
        const url = new URL(authorizeHolder.url);
        const state = url.searchParams.get("state");
        return `${url.searchParams.get("redirect_uri")}?code=manual-code&state=${state}`;
      },
    };
    const credential = await oauth.login(pasteInteraction);
    scenarios.bindFailureManualPaste = {
      tokenRequest: captured.find((request) => request.url === TOKEN_URL),
      credential,
    };
    blocker.close();
  }

  // Manual paste with a wrong state fails with "State mismatch".
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    installFetch(() => stubResponse({ access_token: accessTokenFor("a"), refresh_token: "r", expires_in: 3600 }));
    const { interaction } = makeInteraction({
      promptImpl: async (prompt) => {
        if (prompt.type === "select") return "browser";
        return "http://localhost:1455/auth/callback?code=x&state=wrong-state";
      },
    });
    let loginError = null;
    try { await oauth.login(interaction); } catch (error) { loginError = error.message; }
    scenarios.manualStateMismatch = { loginError };
  }

  // Device-code flow (interval "1" → one second waits, two polls).
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch((record) => {
      if (record.url.endsWith("/deviceauth/usercode")) {
        return stubResponse({ device_auth_id: "device-auth-id", user_code: "ABCD-1234", interval: "1" });
      }
      if (record.url.endsWith("/deviceauth/token")) {
        return stubResponse({ error: { code: "deviceauth_authorization_pending" } }, 403);
      }
      throw new Error(`Unexpected fetch: ${record.url}`);
    });
    const { interaction, events } = makeInteraction({
      promptImpl: async (prompt) => (prompt.type === "select" ? "device_code" : Promise.reject(new Error("no paste"))),
    });
    let deviceCodeEvent = null;
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "device_code") deviceCodeEvent = cloneEvent(event);
      originalNotify(event);
    };
    // First poll pending; flip to success after the event fires.
    const login = oauth.login(interaction);
    login.catch(() => {});
    await waitFor(() => deviceCodeEvent, "device_code event");
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/deviceauth/token")) {
        captured.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers ?? {}) }, body: String(init?.body) });
        return stubResponse({ authorization_code: "oauth-code", code_verifier: "device-code-verifier" });
      }
      if (url === TOKEN_URL) {
        captured.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers ?? {}) }, body: String(init?.body) });
        return stubResponse({ access_token: accessTokenFor("device-account"), refresh_token: "device-refresh", expires_in: 3600 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const credential = await login;
    scenarios.deviceCodeLogin = {
      deviceCodeEvent,
      requests: captured,
      credential,
      verificationUri: "https://auth.openai.com/codex/device",
      expiresInSeconds: 900,
    };
  }

  out.openaiCodex = scenarios;
  fs.writeFileSync(path.join(import.meta.dirname, "openai_codex_oracle.json"), JSON.stringify(scenarios, null, 2));
  outFiles["openai_codex_oracle.json"] = true;
}

// ---------------------------------------------------------------------------
// 6. openrouter (refactored flow)
  __log("openrouter group");
// ---------------------------------------------------------------------------
{
  const ns = await import(stagedUrl("auth/oauth/openrouter.ts"));
  const oauth = ns.openRouterOAuth;
  const scenarios = {};
  const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";

  // Login through the shared callback server (ephemeral port, fixed UUID path).
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    const captured = installFetch((record) => {
      if (record.url === TOKEN_URL) return stubResponse({ key: "sk-or-test" });
      throw new Error(`Unexpected fetch: ${record.url}`);
    });
    const authorizeHolder = { url: undefined };
    const events = [];
    const { interaction } = makeInteraction({
      promptImpl: async () => new Promise(() => {}),
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "progress" || event.type === "auth_url") events.push(cloneEvent(event));
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    const login = oauth.login(interaction);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const callbackUrl = new URL(authorizeHolder.url).searchParams.get("callback_url");
    const parsed = new URL(callbackUrl);
    const success = pageOf(await rawGet(parsed.port, `${parsed.pathname}?code=authorization-code`));
    const credential = await login;
    scenarios.login = {
      authorizeUrl: authorizeHolder.url,
      progressEvents: events.filter((event) => event.type === "progress"),
      callbackPath: parsed.pathname,
      callbackSuccess: success,
      exchangeRequest: captured[0],
      credential,
      instructions: "Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
      prompt: {
        type: "manual_code",
        message: "Complete sign-in in your browser, or paste the authorization code / redirect URL here:",
        placeholder: "<callbackUrl>",
      },
    };
  }

  // Exchange failures: the no-key page through the callback (502 on the
  // page is the exchange failure; a body without `key` errors the login),
  // and the HTTP-error message through the manual paste.
  {
    globalThis.__oracleRngCall = 0;
    installFetch((record) => {
      if (record.url === TOKEN_URL) return stubResponse({ user_id: "user-1" });
      throw new Error(`Unexpected fetch: ${record.url}`);
    });
    const authorizeHolder = { url: undefined };
    const { interaction, controller } = makeInteraction({
      promptImpl: (prompt) =>
        new Promise((_, reject) => {
          prompt.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true });
        }),
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    const login = oauth.login(interaction);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const callbackUrl = new URL(authorizeHolder.url).searchParams.get("callback_url");
    const parsed = new URL(callbackUrl);
    const noKey = pageOf(await rawGet(parsed.port, `${parsed.pathname}?code=code-without-key`));
    let noKeyError = null;
    try { await login; } catch (error) { noKeyError = error.message; }
    void controller;

    globalThis.__oracleRngCall = 0;
    installFetch((record) => {
      if (record.url === TOKEN_URL) return stubResponse({ error: "invalid code" }, 403);
      throw new Error(`Unexpected fetch: ${record.url}`);
    });
    const { interaction: interaction2 } = makeInteraction({
      promptImpl: async () => "http://localhost:9000/oauth/callback/deadbeef?code=the-code",
    });
    let exchangeError = null;
    try { await oauth.login(interaction2); } catch (error) { exchangeError = error.message; }
    scenarios.exchangeErrors = { noKey, noKeyError, httpError: exchangeError };
  }

  // Provider redirect error fails the login through the shared server.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    installFetch(() => stubResponse({ key: "unused" }));
    const authorizeHolder = { url: undefined };
    const { interaction } = makeInteraction({
      promptImpl: selectAware(async () => new Promise(() => {})),
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    const login = oauth.login(interaction);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const callbackUrl = new URL(authorizeHolder.url).searchParams.get("callback_url");
    const parsed = new URL(callbackUrl);
    const failure = pageOf(await rawGet(parsed.port, `${parsed.pathname}?error=access_denied&error_description=User%20denied`));
    let loginError = null;
    try { await login; } catch (error) { loginError = error.message; }
    scenarios.providerError = { failure, loginError };
  }

  out.openrouter = scenarios;
  fs.writeFileSync(path.join(import.meta.dirname, "openrouter_oracle.json"), JSON.stringify(scenarios, null, 2));
  outFiles["openrouter_oracle.json"] = true;
}

// ---------------------------------------------------------------------------
// 7. radius (refactored flow)
  __log("radius group");
  globalThis.fetch = nativeFetch;
// ---------------------------------------------------------------------------
{
  const ns = await import(stagedUrl("auth/oauth/radius.ts"));
  const radius = ns.createRadiusOAuth({ name: "Radius", gateway: "https://gateway.placeholder" });
  // The flow fetches the gateway over the network: point normalizeRadiusGatewayUrl
  // at the local stub by creating the flow AFTER the server is up — instead,
  // capture against the flow with a local gateway by re-creating it.
  const scenarios = {};

  const gateway = await localServer((record) => {
    if (record.url === "/v1/oauth") {
      return { status: 200, body: JSON.stringify({ authorizationEndpoint: "https://radius-ui.example/authorize" }) };
    }
    if (record.url === "/v1/oauth/token") {
      tokenRequests.push(record);
      const response = tokenResponses.shift();
      return response ?? { status: 500, body: "{}" };
    }
    if (record.url === "/v1/oauth/device") {
      deviceRequests.push(record);
      return { status: 200, body: JSON.stringify({ device_code: "device-code", user_code: "ABCD-1234", verification_uri: "https://radius-ui.example/pair", expires_in: 600, interval: 1 }) };
    }
    return { status: 404, body: "{}" };
  });
  const tokenRequests = [];
  const tokenResponses = [];
  const deviceRequests = [];
  const oauth = ns.createRadiusOAuth({ name: "Radius", gateway: `http://127.0.0.1:${gateway.port}` });

  // Browser login with the exchange INSIDE the callback handler.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    tokenRequests.length = 0;
    tokenResponses.push({ status: 200, body: JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600, scope: "gateway offline_access" }) });
    const authorizeHolder = { url: undefined };
    const events = [];
    const { interaction } = makeInteraction({
      promptImpl: async (prompt) => {
        if (prompt.type !== "select") throw new Error(`Unexpected prompt: ${prompt.type}`);
        return prompt.options.find((option) => option.id === "browser").id;
      },
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      events.push(cloneEvent(event));
      originalNotify(event);
    };
    const login = oauth.login(interaction);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const url = new URL(authorizeHolder.url);
    const authorizeParams = {};
    for (const [key, value] of url.searchParams) authorizeParams[key] = value;
    const success = pageOf(await rawGet(1456, `/oauth/callback?code=the-code&state=${authorizeParams.state}`));
    const credential = await login;
    scenarios.browserLogin = {
      authorizeUrl: authorizeHolder.url,
      success,
      tokenRequest: { method: tokenRequests[0].method, url: tokenRequests[0].url, headers: tokenRequests[0].headers, body: tokenRequests[0].body },
      credential,
      progressEvents: events.filter((event) => event.type === "progress"),
      selectPrompt: {
        type: "select",
        message: "Sign in to Radius:",
        options: [
          { id: "browser", label: "Sign in with browser (recommended)" },
          { id: "device-code", label: "Sign in with device code (when signing in from another device)" },
        ],
      },
    };
  }

  // The exchange failing inside the handler renders the 502 page and fails
  // the login with the OAuth error detail.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    tokenRequests.length = 0;
    tokenResponses.push({ status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: "nope" }) });
    const authorizeHolder = { url: undefined };
    const { interaction } = makeInteraction({
      promptImpl: async (prompt) => prompt.options.find((option) => option.id === "browser").id,
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    const login = oauth.login(interaction);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const url = new URL(authorizeHolder.url);
    const failure = pageOf(await rawGet(1456, `/oauth/callback?code=the-code&state=${url.searchParams.get("state")}`));
    let loginError = null;
    try { await login; } catch (error) { loginError = error.message; }
    scenarios.exchangeFailure = { failure, loginError };
  }

  // State mismatch keeps waiting; provider error fails with the shared message.
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    tokenRequests.length = 0;
    const authorizeHolder = { url: undefined };
    const { interaction, controller } = makeInteraction({
      promptImpl: async (prompt) => prompt.options.find((option) => option.id === "browser").id,
    });
    const originalNotify = interaction.notify;
    interaction.notify = (event) => {
      if (event.type === "auth_url") authorizeHolder.url = event.url;
      originalNotify(event);
    };
    const login = oauth.login(interaction);
    login.catch(() => {});
    await waitFor(() => authorizeHolder.url, "authorize url");
    const url = new URL(authorizeHolder.url);
    const mismatch = pageOf(await rawGet(1456, `/oauth/callback?code=the-code&state=wrong`));
    const providerFailure = pageOf(await rawGet(1456, `/oauth/callback?error=access_denied&error_description=nope&state=${url.searchParams.get("state")}`));
    let loginError = null;
    try { await login; } catch (error) { loginError = error.message; }
    scenarios.routes = { mismatch, providerFailure, loginError };
    setTimeout(() => controller.abort(), 10);
    await login.catch(() => {});
  }

  // Device-code login (interval 1 → fast polls).
  {
    globalThis.__oracleRngCall = 0;
    __log("scenario step");
    tokenRequests.length = 0;
    deviceRequests.length = 0;
    tokenResponses.push(
      { status: 400, body: JSON.stringify({ error: "authorization_pending" }) },
      { status: 200, body: JSON.stringify({ access_token: "device-access", refresh_token: "device-refresh", expires_in: 3600 }) },
    );
    const { interaction, events } = makeInteraction({
      promptImpl: async (prompt) => prompt.options.find((option) => option.id === "device-code").id,
    });
    const credential = await oauth.login(interaction);
    scenarios.deviceCodeLogin = {
      deviceRequest: deviceRequests[0],
      tokenRequests: tokenRequests.map((record) => ({ method: record.method, url: record.url, body: record.body })),
      deviceCodeEvents: events.filter((event) => event.type === "device_code"),
      credential,
    };
  }

  gateway.close();
  out.radius = scenarios;
  fs.writeFileSync(path.join(import.meta.dirname, "radius_oracle.json"), JSON.stringify(scenarios, null, 2));
  outFiles["radius_oracle.json"] = true;
}

// ---------------------------------------------------------------------------
// Manifest: provenance hashes + RNG substitution declaration.
// ---------------------------------------------------------------------------
const manifest = {
  upstream: "2bbfcca43",
  baseline: "590144609",
  fixedNow: FIXED_NOW,
  fixedUuid: FIXED_UUID,
  rngStream: "draw k fills byte[i] = (k*32 + i) & 0xFF; draws are global and sequential per scenario",
  stagedSubstitutions: [
    {
      file: "packages/ai/src/auth/oauth/openai-chatgpt.ts",
      original: 'import { randomBytes } from "node:crypto";',
      reason: "ESM builtin bindings cannot be monkey-patched; the staged copy uses the deterministic generator",
    },
    {
      file: "packages/ai/src/auth/oauth/openai-codex.ts",
      original: 'import("node:crypto").then((m) => { _randomBytes = m.randomBytes; }); block',
      reason: "same as above",
    },
  ],
  sourceHashes: hashes,
  generated: Object.keys(outFiles).sort(),
};
fs.writeFileSync(path.join(import.meta.dirname, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log("captured scenarios:", JSON.stringify(Object.keys(out), null, 2));
console.log("staging:", staging);
// Scenarios leave intentionally-unresolved login promises (pending prompts);
// exit explicitly once the fixtures are written.
process.exit(0);
