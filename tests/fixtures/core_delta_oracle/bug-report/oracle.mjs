// Oracle driver: upstream coding-agent src/core/bug-report.ts (HEAD
// 2bbfcca43, v0.99.1) under `node --experimental-strip-types`. The module
// graph is verbatim upstream copies (see ./src, SHA-pinned in manifest.json)
// with three disclosed stubs:
// - src/config.ts exports VERSION = "ORACLE-VERSION" (the port substitutes
//   its crate version before comparison),
// - src/core/session-manager.ts stubs the two compaction-only value imports,
// - @earendil-works/pi-ai/compat stubs completeSimple (scenarios always pass
//   a stub streamFn).
//
// Pins:
// - redactUrl / redactJsonValue / redactSettings grids,
// - collectBugReportMetadata over fixed inputs with a stubbed process.env,
//   fixed id, and placeholder createdAt / node-version (host-dependent),
// - collectBugReportDiagnostics over a fixed entry list + crash records,
// - bugReportFiles text/JSON assembly, archive file name, and the zip
//   structure (entry names, flags, method, CRCs, inflated payloads),
// - generateBugReportSummary prompt/options assembly and response handling
//   through the real compaction pipeline with a stub streamFn.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const {
  BUG_REPORT_CUSTOM_ENTRY_TYPE,
  redactUrl,
  redactJsonValue,
  collectBugReportMetadata,
  collectBugReportDiagnostics,
  bugReportFiles,
  writeBugReportArchive,
  bugReportArchiveFileName,
  generateBugReportSummary,
} = await import(new URL("./src/core/bug-report.ts", import.meta.url).href);

const out = { scenarios: [] };
const add = (name, observed) => out.scenarios.push({ name, observed });
const json = (v) =>
  JSON.parse(
    JSON.stringify(v, (_key, value) => (typeof value === "function" ? "<fn>" : value === undefined ? "<undefined>" : value)),
  );
const catchMessage = async (run) => {
  try {
    return await run();
  } catch (error) {
    return error.message;
  }
};

// ---------------------------------------------------------------------------
// Environment control: the metadata scenarios see exactly these variables.
// ---------------------------------------------------------------------------
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_")) delete process.env[key];
}
process.env.SHELL = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
process.env.TERM = "xterm-256color";
process.env.TERM_PROGRAM = "vscode";
process.env.TERM_PROGRAM_VERSION = "1.2.3";
process.env.COLORTERM = "truecolor";
process.env.TMUX = "";
process.env.SSH_TTY = "/dev/pts/3";
delete process.env.SSH_CONNECTION;
delete process.env.SSH_CLIENT;
process.env.CI = "1";
process.env.PI_ZED = "last";
process.env.PI_ALPHA = "first";
process.env.PI_MIDDY = "middle";
process.env.PI_EMPTY = "";

// ---------------------------------------------------------------------------
// redactUrl grid
// ---------------------------------------------------------------------------
{
  const cases = {
    credentials_and_params: "https://user:pass@api.example.com/v1/x?api_key=abc&token=XYZ&q=hello&Password=pw&token=dup#frag",
    unchanged: "https://example.com/path",
    not_a_url: "not a url",
    mailto: "mailto:user@host",
    userinfo_only: "https://token@host.com/",
    hyphen_keys: "http://h.com/?authorization=Bearer%20x&a=1&api-key=k",
    camel_key: "https://h.com/?apiKey=v",
    upper_key: "https://h.com/?API_KEY=v",
    encoded_value: "https://h.com/?x=a%20b&token=s",
    nested_scheme: "socks5:https://u:p@h.com/?token=t",
    uppercase_url: "HTTPS://U:P@H.COM/?TOKEN=x",
    boundary_miss: "https://h.com/?refresh_token=a&sessionid=b&secret-key=c",
    empty_value: "https://h.com/?token=",
    no_query_with_creds: "https://u:p@h.com/x",
    plus_value: "https://h.com/?q=a+b&access_token=z",
    trailing_query: "https://h.com/x?",
    keys_only: "https://h.com/?token",
    credential_subpath: "https://h.com/?credential=abc&other=keep",
    oauth_cookie: "https://h.com/?OAUTH=1&cookie=2&session=3",
    multiple_sensitive: "https://h.com/?b=2&api_key=x&c=3&api_key=y",
  };
  add("redact_url_grid", Object.fromEntries(Object.entries(cases).map(([name, value]) => [name, redactUrl(value)])));
}

// ---------------------------------------------------------------------------
// redactJsonValue grid
// ---------------------------------------------------------------------------
{
  add("redact_json_value_grid", {
    nested: redactJsonValue({
      apiKey: "sk-123",
      nested: { token: "t", keep: "yes", deeper: { SECRET_KEY: "s", arr: ["plain", "https://u:p@h.com/?x=1&password=y"] } },
    }),
    null_child_kept: redactJsonValue({ token: null, keep: null }),
    url_strings: redactJsonValue(["https://u:p@h.com/", "not a url", 42, true, null]),
    camel_boundaries: redactJsonValue({ secretToken: "s", authToken: "a", refreshToken: "r", sessionid: "ok", myKey: "ok" }),
    passthrough: redactJsonValue({ a: 1, b: [1, 2, { c: 3 }] }),
    empty: redactJsonValue({}),
  });
}

// ---------------------------------------------------------------------------
// redactSettings
// ---------------------------------------------------------------------------
{
  const settings = {
    trackingId: "track-me",
    deviceId: "device-me",
    theme: "dark",
    defaultProvider: "anthropic",
    providerAuth: { anthropic: { apiKey: "sk", token: "t", expiresIn: 3600 } },
    nested: { apiKeyEnv: "ANTHROPIC_API_KEY", callbackUrl: "https://u:p@h.com/cb?secret=s" },
  };
  const stubSettings = (value) => value; // upstream redactSettings takes the settings object
  const { default: stubOnly } = await import(new URL("./src/config.ts", import.meta.url).href);
  // Reimplement redactSettings inline over the real redactJsonValue: the
  // function itself is module-private; the port pins its composition.
  const redactSettings = (value) => {
    const { trackingId: _t, deviceId: _d, ...rest } = value;
    return redactJsonValue(rest);
  };
  add("redact_settings", {
    stubVersion: stubOnly,
    redacted: redactSettings(settings),
    keepsUnknownTopLevel: Object.keys(redactSettings({ trackingId: "t", other: 1 })),
  });
}

// ---------------------------------------------------------------------------
// collectBugReportMetadata
// ---------------------------------------------------------------------------
const settingsValue = {
  trackingId: "track-me",
  deviceId: "device-me",
  theme: "dark",
  apiKeyEnv: "sk-live",
  nested: { token: "t" },
};
const projectSettingsValue = { theme: "solarized", authorization: "Bearer" };

const stubModelRuntime = {
  getProvider: (providerId) =>
    providerId === "stub"
      ? {
          id: "stub",
          name: "Stub Provider",
          baseUrl: "https://stub.example.com/v1?api_key=x",
          headers: { "x-stub": "1", "z-last": "2" },
          auth: { apiKey: { name: "Stub key" }, oauth: { name: "Stub oauth" } },
        }
      : undefined,
  getProviderAuthStatus: (providerId) =>
    providerId === "stub" ? { configured: true, source: "runtime", label: "STUB_KEY" } : { configured: false },
  isUsingOAuth: (providerId) => providerId === "stub",
  getRegisteredProviderIds: () => ["stub", "other"],
};

const fixtureModel = {
  id: "claude-4",
  name: "Claude 4",
  api: "anthropic-messages",
  provider: "stub",
  baseUrl: "https://stub.example.com?api_key=secret",
  reasoning: true,
  thinkingLevelMap: { off: null, high: "high" },
  input: ["text", "image"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 64000,
  samplingParams: { top_p: 0.9, api_key_hint: "nope" },
  compat: { forceAdaptiveThinking: true, password: "p" },
  headers: { "x-a": "1", "X-B": "2" },
};

const fixtureExtensions = [
  {
    path: "/ext/one.ts",
    sourceInfo: { source: "one.ts", scope: "project", origin: "top-level" },
    hidden: false,
  },
  {
    path: "/ext/pkg/index.ts",
    sourceInfo: { source: "https://registry.example/pkg?token=leak", scope: "user", origin: "package" },
    hidden: true,
  },
];

async function metadataScenario(name, options, postProcess) {
  const observed = await collectBugReportMetadata({
    sessionId: "session-1",
    cwd: "/work/project",
    includeSession: true,
    includeSummary: false,
    messageCount: 3,
    globalSettings: settingsValue,
    projectSettings: projectSettingsValue,
    ...options,
  });
  observed.createdAt = "<createdAt>";
  const prepared = postProcess ? postProcess(observed) : observed;
  add(name, json(prepared));
}

{
  await metadataScenario("metadata_with_model", {
    id: "fixed-id-1",
    hint: "  it crashed  ",
    model: fixtureModel,
    modelRuntime: stubModelRuntime,
    thinkingLevel: "high",
    extensions: fixtureExtensions,
    extensionErrors: [{ path: "/ext/broken.ts", error: "boom" }],
  });

  await metadataScenario("metadata_minimal", {
    id: "fixed-id-2",
    includeSession: false,
    modelRuntime: stubModelRuntime,
    thinkingLevel: "off",
    extensions: [],
    extensionErrors: [],
    hint: "   ",
  });

  // Environment values are captured as-is; the node version string is
  // canonicalized to a placeholder.
  const envScenario = json(await collectBugReportMetadata({
    id: "fixed-id-env",
    sessionId: "s",
    cwd: "/c",
    includeSession: false,
    includeSummary: false,
    messageCount: 0,
    modelRuntime: stubModelRuntime,
    thinkingLevel: "off",
    extensions: [],
    extensionErrors: [],
    globalSettings: {},
    projectSettings: {},
  }));
  envScenario.createdAt = "<createdAt>";
  envScenario.environment.runtime = envScenario.environment.runtime.replace(/^node\/.*$/, "node/<version>");
  envScenario.environment.userAgent = envScenario.environment.userAgent.replace(/node\/[^;)]+/g, "node/<version>");
  envScenario.environment.osRelease = "<osRelease>";
  envScenario.environment.osVersion = "<osVersion>";
  add("metadata_environment", envScenario.environment);
}

// ---------------------------------------------------------------------------
// collectBugReportDiagnostics
// ---------------------------------------------------------------------------
{
  const entries = [
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "t1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage: {},
        stopReason: "stop",
        timestamp: 1,
      },
    },
    { type: "model_change", id: "c1", parentId: "m1", timestamp: "t2", provider: "anthropic", modelId: "claude" },
    {
      type: "message",
      id: "m2",
      parentId: "c1",
      timestamp: "t3",
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage: {},
        stopReason: "error",
        errorMessage: "http 500",
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "m3",
      parentId: "m2",
      timestamp: "t4",
      message: {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "openai",
        model: "gpt",
        usage: {},
        stopReason: "aborted",
        rawStopReason: "cancelled",
        timestamp: 3,
      },
    },
    {
      type: "message",
      id: "m4",
      parentId: "m3",
      timestamp: "t5",
      message: {
        role: "assistant",
        content: [],
        api: "api",
        provider: "p",
        model: "m",
        usage: {},
        stopReason: "stop",
        diagnostics: [{ type: "retry", timestamp: 7, error: { name: "HttpError", message: "429" } }],
        timestamp: 4,
      },
    },
    { type: "custom", customType: "pi.note", data: {}, id: "cu1", parentId: "m4", timestamp: "t6" },
    {
      type: "message",
      id: "m5",
      parentId: "cu1",
      timestamp: "t7",
      message: { role: "user", content: "hi", timestamp: 5 },
    },
    {
      type: "message",
      id: "m6",
      parentId: "m5",
      timestamp: "t8",
      message: {
        role: "assistant",
        content: [],
        api: "api",
        provider: "p",
        model: "m",
        usage: {},
        stopReason: "stop",
        errorMessage: "leftover message",
        timestamp: 6,
      },
    },
  ];
  const sessionManager = {
    getEntries: () => entries,
    getSessionId: () => "session-1",
  };
  const crashes = [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "0.99.1",
      kind: "fatal_error",
      message: "first",
      stack: "Error: first\n    at f (/ext/one.ts:1:1)",
      sessionFile: "/s/session.jsonl",
      cwd: "/work",
      notified: true,
    },
    {
      timestamp: "2026-01-02T00:00:00.000Z",
      version: "0.99.1",
      kind: "uncaught_exception",
      message: "second",
      stack: null,
      sessionFile: null,
      cwd: "/work",
    },
  ];
  add("diagnostics", collectBugReportDiagnostics(sessionManager, crashes));
  add("diagnostics_empty", collectBugReportDiagnostics({ getEntries: () => [], getSessionId: () => "empty" }, []));
  add("bug_report_custom_entry_type", BUG_REPORT_CUSTOM_ENTRY_TYPE);
}

// ---------------------------------------------------------------------------
// bugReportFiles / archive
// ---------------------------------------------------------------------------
{
  const bundle = {
    metadata: { id: "rep-1", z: 1, a: [1, 2] },
    diagnostics: { sessionId: "s", crashes: [] },
    sessionJsonl: "{\"type\":\"session\"}\n",
    summary: "Report body",
  };
  const noSummary = { ...bundle, summary: undefined };
  const noSession = { ...bundle, sessionJsonl: undefined };
  add("bug_report_files", {
    full: bugReportFiles(bundle),
    summary_newline_added: bugReportFiles({ ...bundle, summary: "no trailing" }).find((f) => f.name === "summary.md"),
    without_summary: bugReportFiles(noSummary).map((f) => f.name),
    without_session: bugReportFiles(noSession).map((f) => f.name),
    archive_name: bugReportArchiveFileName("rep-1"),
  });

  // Zip structure: names, method/flags, CRCs, and inflated payloads.
  const rootReal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bug-report-oracle-"));
  const archivePath = path.join(rootReal, "report.zip");
  await writeBugReportArchive(bundle, archivePath);
  const bytes = fs.readFileSync(archivePath);
  const text = (start, length) => bytes.toString("utf8", start, start + length);
  const u16 = (offset) => bytes.readUInt16LE(offset);
  const u32 = (offset) => bytes.readUInt32LE(offset);
  const entries = [];
  let offset = 0;
  while (u32(offset) === 0x04034b50) {
    const flags = u16(offset + 6);
    const method = u16(offset + 8);
    const crc = u32(offset + 14);
    const compressedSize = u32(offset + 18);
    const uncompressedSize = u32(offset + 22);
    const nameLength = u16(offset + 26);
    const name = text(offset + 30, nameLength);
    const compressed = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + compressedSize);
    const inflated = zlib.inflateRawSync(compressed).toString("utf8");
    entries.push({
      name,
      flagsHex: `0x${flags.toString(16)}`,
      method,
      crcMatchesPayload: crc === zlib.crc32(Buffer.from(inflated, "utf8")),
      uncompressedSize,
      inflated,
      decompressesRoundTrip: inflated === (name === "report.json" ? `${JSON.stringify(bundle.metadata, null, 2)}\n` : name === "diagnostics.json" ? `${JSON.stringify(bundle.diagnostics, null, 2)}\n` : name === "session.jsonl" ? bundle.sessionJsonl : "Report body\n"),
    });
    offset += 30 + nameLength + compressedSize;
  }
  add("bug_report_archive", {
    entryCount: entries.length,
    entries,
    endsWithCentralDirectory: u32(offset) === 0x02014b50,
    trailingNewlineEnforced: entries.find((entry) => entry.name === "summary.md")?.inflated,
  });
  fs.rmSync(rootReal, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// generateBugReportSummary (real compaction pipeline, stub streamFn)
// ---------------------------------------------------------------------------
const summaryModel = (overrides = {}) => ({
  id: "claude-4",
  name: "Claude 4",
  api: "anthropic-messages",
  provider: "stub",
  baseUrl: "https://stub.example.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 64000,
  ...overrides,
});

const userMessage = (text, timestamp) => ({ role: "user", content: text, timestamp });
const toolResultMessage = (text, timestamp) => ({
  role: "toolResult",
  toolCallId: "c1",
  toolName: "bash",
  content: [{ type: "text", text }],
  details: {},
  isError: false,
  timestamp,
});

function streamStub(responseMessage) {
  const calls = [];
  const streamFn = async (model, context, options) => {
    calls.push({ model, context, options });
    return {
      async result() {
        return responseMessage;
      },
      async *[Symbol.asyncIterator]() {},
    };
  };
  return { streamFn, calls };
}

const responseMessage = (overrides = {}) => ({
  role: "assistant",
  content: [{ type: "text", text: "  Report body.\n\nSecond line.  " }],
  api: "anthropic-messages",
  provider: "stub",
  model: "claude-4",
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
  ...overrides,
});

async function summaryScenario(name, { messages, model, hint, thinkingLevel, sessionId, response, streamThrows }) {
  const stub = streamStub(response ?? responseMessage());
  if (streamThrows) {
    stub.streamFn = async () => {
      throw new Error("stream setup failed");
    };
  }
  const run = generateBugReportSummary({
    messages,
    hint,
    model: model ?? summaryModel(),
    signal: undefined,
    thinkingLevel,
    sessionId,
    streamFn: stub.streamFn,
  });
  const summary = await catchMessage(async () => (await run) ?? "ok");
  const call = stub.calls[0];
  const options = call ? { ...call.options } : undefined;
  if (options) {
    options.signal = "<signal>";
    // completeSummarization routes through a fresh uuidv7 when the caller
    // passes no sessionId; canonicalize the random value.
    if (
      typeof options.sessionId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.sessionId)
    ) {
      options.sessionId = "<sessionId>";
    }
  }
  add(name, {
    summary,
    callCount: stub.calls.length,
    systemPrompt: call ? (call.context.messages[0].role === "system" ? call.context.messages[0].content : null) : null,
    userTimestampPresence: call ? typeof call.context.messages.at(-1).timestamp === "number" : null,
    prompt: call ? call.context.messages.at(-1).content[0].text : null,
    options,
    streamedModel: call ? call.model : null,
  });
}

{
  const small = [userMessage("hello", 1), userMessage("help me debug", 2)];
  await summaryScenario("summary_basic", {
    messages: small,
    hint: "  it hangs  ",
    thinkingLevel: "high",
    sessionId: "session-9",
  });

  await summaryScenario("summary_no_hint", { messages: small });
  await summaryScenario("summary_empty_hint", { messages: small, hint: "   " });

  // Truncation note + newest-first selection.
  const big = [];
  for (let index = 0; index < 6; index++) {
    big.push(userMessage(`u${index} ${"x".repeat(400)}`, index));
    big.push(toolResultMessage(`r${index} ${"y".repeat(400)}`, index));
  }
  await summaryScenario("summary_truncation", { messages: big, model: summaryModel({ contextWindow: 400 }) });

  // maxTokens clamps: 0 -> 4096, large -> 4096, small -> value.
  await summaryScenario("summary_max_tokens_zero", { messages: small, model: summaryModel({ maxTokens: 0 }) });
  await summaryScenario("summary_max_tokens_small", { messages: small, model: summaryModel({ maxTokens: 100 }) });
  await summaryScenario("summary_max_tokens_large", { messages: small, model: summaryModel({ maxTokens: 999999 }) });

  // reasoning option wiring.
  await summaryScenario("summary_reasoning_model_thinking", {
    messages: small,
    model: summaryModel({ reasoning: true }),
    thinkingLevel: "medium",
  });
  await summaryScenario("summary_reasoning_model_off", {
    messages: small,
    model: summaryModel({ reasoning: true }),
    thinkingLevel: "off",
  });
  await summaryScenario("summary_plain_model_thinking", {
    messages: small,
    model: summaryModel(),
    thinkingLevel: "high",
  });

  // Response handling grid.
  await summaryScenario("summary_aborted", {
    messages: small,
    response: responseMessage({ stopReason: "aborted" }),
  });
  await summaryScenario("summary_error_response", {
    messages: small,
    response: responseMessage({ stopReason: "error", errorMessage: "http 500" }),
  });
  await summaryScenario("summary_length_response", {
    messages: small,
    response: responseMessage({ stopReason: "length" }),
  });
  await summaryScenario("summary_tool_call", {
    messages: small,
    response: responseMessage({ content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] }),
  });
  await summaryScenario("summary_empty_text", {
    messages: small,
    response: responseMessage({ content: [{ type: "thinking", thinking: "hmm" }] }),
  });

  // Stream failures surface as errors.
  await summaryScenario("summary_stream_throws", { messages: small, streamThrows: true });
}

// Restore the environment.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, savedEnv);

fs.writeFileSync(new URL("./bug_report.oracle.json", import.meta.url), JSON.stringify(out, null, "\t") + "\n");
console.log(`captured ${out.scenarios.length} scenarios -> bug_report.oracle.json`);
