/**
 * Oracle harness for the deterministic data transforms of the transcript
 * view faces: `client-tui-chat.ts`, `micro/tui.ts`, `micro/runtime.ts`,
 * `micro/models.ts`, and the plugins data surfaces. VERBATIM blocks are
 * copied unmodified from the upstream files named in each comment; draw
 * components are stubbed with recording fakes.
 *   node --experimental-strip-types oracle_view.ts
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve, dirname as pathDirname } from "node:path";

const out = {};

function tryFn(fn) {
  try {
    const value = fn();
    return value === undefined ? "ok" : value;
  } catch (error) {
    return error.message;
  }
}

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/client-tui-chat.ts (userMessageText,
// #syncQueues text transform, #syncTranscript divergence, #addEntry branches)
// ---------------------------------------------------------------------------
function userMessageText(message) {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter((content) => content.type === "text").map((content) => content.text).join("");
}

function queueText(item) {
  const text = item.type === "message" ? userMessageText(item.message).replace(/\s+/g, " ") : `<${item.customType}>`;
  return `[${item.kind}] ${text}`;
}

function syncTranscript(prevIds, transcript) {
  const diverged = prevIds.some((id, index) => transcript[index]?.id !== id);
  let rendered = diverged ? [] : [...prevIds];
  const appended = [];
  for (const entry of transcript.slice(rendered.length)) {
    appended.push(entry.id);
    rendered.push(entry.id);
  }
  return { diverged, appended, rendered };
}

function addEntry(entry, sink) {
  if (entry.type === "compaction") {
    sink.push(`[compaction] compacted from ${entry.tokensBefore} tokens`);
    for (const retained of entry.retainedTail) addMessage(retained, sink);
    return;
  }
  if (entry.type === "branch_summary") {
    sink.push("[branch summary]");
    sink.push(entry.summary);
    return;
  }
  if (entry.type === "custom") {
    sink.push(`[${entry.customType}]`);
    return;
  }
  addMessage(entry.message, sink);
}

function addMessage(message, sink) {
  if (message.role === "user") {
    sink.push(`user:${userMessageText(message)}`);
    return;
  }
  if (message.role === "assistant") {
    sink.push(`assistant:${messageText(message)}`);
    for (const content of message.content) {
      if (content.type === "toolCall") sink.push(`toolCall:${content.name}:${content.id}`);
    }
    return;
  }
  if (message.role === "toolResult") sink.push(`toolResult:${message.toolName}:${message.toolCallId}`);
}

function messageText(message) {
  return message.content.filter((content) => content.type === "text").map((content) => content.text).join("");
}

out.chatView = {
  queueText: [
    queueText({ kind: "steer", type: "message", message: { role: "user", content: [{ type: "text", text: "a\n b\t c" }] } }),
    queueText({ kind: "followUp", type: "message", message: { role: "user", content: "plain" } }),
    queueText({ kind: "custom", type: "custom", customType: "memory.write" }),
    queueText({ kind: "write", type: "message", message: { role: "assistant", content: [{ type: "text", text: "ignored" }] } }),
  ],
  sync: [
    syncTranscript([], [{ id: "e1" }, { id: "e2" }]),
    syncTranscript(["e1"], [{ id: "e1" }, { id: "e2" }]),
    syncTranscript(["e0"], [{ id: "e1" }, { id: "e2" }]),
    syncTranscript(["e1", "e2"], [{ id: "e1" }]),
  ],
  entries: (() => {
    const sink = [];
    addEntry(
      { type: "compaction", tokensBefore: 4321, retainedTail: [{ role: "user", content: [{ type: "text", text: "kept" }] }] },
      sink,
    );
    addEntry({ type: "branch_summary", summary: "the branch did things" }, sink);
    addEntry({ type: "custom", customType: "pi.notice" }, sink);
    addEntry({ type: "message", message: { role: "user", content: "hi" } }, sink);
    addEntry(
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hey" },
            { type: "toolCall", name: "read", id: "call-1", arguments: {} },
          ],
        },
      },
      sink,
    );
    addEntry({ type: "message", message: { role: "toolResult", toolName: "read", toolCallId: "call-1" } }, sink);
    return sink;
  })(),
};

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/micro/tui.ts (modelRef, userContent,
// #syncStatus decision chain, footer stats, #syncQueue, #syncNotices,
// authProviders, selectModel ordering)
// ---------------------------------------------------------------------------
function modelRef(value) {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value;
  return typeof candidate.provider === "string" && typeof candidate.modelId === "string"
    ? { provider: candidate.provider, modelId: candidate.modelId }
    : undefined;
}

function userContent(content) {
  if (typeof content === "string") return content;
  return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

// VERBATIM formatTokens (upstream modes/interactive/components/footer.ts)
function formatTokens(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function footerStats(view) {
  const usage = view.usage;
  const stats = [];
  if (usage.input) stats.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) stats.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) stats.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) stats.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.lastCacheHitRate !== undefined && (usage.cacheRead > 0 || usage.cacheWrite > 0)) {
    stats.push(`CH${usage.lastCacheHitRate.toFixed(1)}%`);
  }
  stats.push(`$${usage.totalCost.toFixed(3)}`);
  if (usage.contextWindow > 0) {
    const automatic = Number(view.conversation.config.threshold ?? 0) > 0 ? " (auto)" : "";
    const context =
      usage.contextPercent === null
        ? `?/${formatTokens(usage.contextWindow)}${automatic}`
        : `${usage.contextPercent.toFixed(1)}%/${formatTokens(usage.contextWindow)}${automatic}`;
    stats.push(
      usage.contextPercent !== null && usage.contextPercent > 90
        ? `error(${context})`
        : usage.contextPercent !== null && usage.contextPercent > 70
          ? `warning(${context})`
          : context,
    );
  }
  return stats.join(" ");
}

function footerHints(view) {
  const model = modelRef(view.conversation.config.model);
  const thinking = String(view.conversation.config.thinkingLevel ?? "off");
  return `${model ? `${model.provider}/${model.modelId}` : "no model"} · thinking:${thinking} (alt+t) · (ctrl+p) or /model · /login · /compact · (alt+enter) follow-up · (ctrl+c) exit`;
}

function statusText(view) {
  let text = "";
  const compaction = view.conversation.compaction;
  const generation = view.conversation.turn?.generation;
  const runningTool = view.conversation.turn?.tools.find((tool) => tool.status === "running");
  if (view.fatal) text = `Fatal: ${view.fatal}`;
  else if (compaction) {
    const reason = compaction.reason === "threshold" ? "automatic" : compaction.reason;
    text =
      compaction.stage === "retrying"
        ? `Retrying ${reason} compaction (attempt ${compaction.attempt})...`
        : `Running ${reason} compaction...`;
  } else if (generation) {
    if (generation.stage === "retrying") text = `Retrying generation (attempt ${generation.attempt})...`;
    else if (generation.stage === "deferred") text = "Waiting for deferred response...";
    else if (generation.stage === "waiting") text = "Waiting for compaction...";
    else text = generation.stage === "streaming" ? "Working... (esc to abort)" : "Preparing response...";
  } else if (runningTool) text = `Running ${runningTool.name}... (esc to abort)`;
  return text;
}

function queueLine(queued) {
  const text = queued.mode === "write" ? `<${queued.entry.kind}>` : userContent(queued.input);
  return `[${queued.mode}] ${text}`;
}

function authProviders(accounts) {
  return accounts.map((account) => ({
    id: account.id,
    name: account.name,
    authType: account.authType,
    ...(account.configured ? { status: { type: account.authType, source: account.source ?? "configured" } } : {}),
  }));
}

out.microTui = {
  status: [
    statusText({ fatal: "disk full", conversation: {} }),
    statusText({ conversation: { compaction: { reason: "threshold", stage: "running", attempt: 1 } } }),
    statusText({ conversation: { compaction: { reason: "manual", stage: "retrying", attempt: 3 } } }),
    statusText({ conversation: { turn: { generation: { stage: "retrying", attempt: 2 }, tools: [] } } }),
    statusText({ conversation: { turn: { generation: { stage: "deferred" }, tools: [] } } }),
    statusText({ conversation: { turn: { generation: { stage: "waiting" }, tools: [] } } }),
    statusText({ conversation: { turn: { generation: { stage: "streaming" }, tools: [] } } }),
    statusText({ conversation: { turn: { generation: { stage: "preparing" }, tools: [] } } }),
    statusText({ conversation: { turn: { tools: [{ status: "running", name: "bash" }, { status: "done", name: "read" }] } } }),
    statusText({ fatal: undefined, conversation: {} }),
  ],
  footer: [
    footerStats({
      usage: {
        input: 1234, output: 567, cacheRead: 89000, cacheWrite: 0,
        totalCost: 1.23456, lastCacheHitRate: 66.66, contextTokens: 90000, contextWindow: 200000,
        contextPercent: 45.0,
      },
      conversation: { config: { threshold: 0 } },
    }),
    footerStats({
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0,
        lastCacheHitRate: undefined, contextTokens: null, contextWindow: 100000, contextPercent: null,
      },
      conversation: { config: { threshold: 5000 } },
    }),
    footerStats({
      usage: {
        input: 10, output: 10, cacheRead: 95000, cacheWrite: 1000, totalCost: 0.5,
        lastCacheHitRate: 92.5, contextTokens: 180000, contextWindow: 200000, contextPercent: 90.5,
      },
      conversation: { config: { threshold: 5000 } },
    }),
    footerStats({
      usage: {
        input: 10, output: 10, cacheRead: 75000, cacheWrite: 1000, totalCost: 0.5,
        lastCacheHitRate: 75.0, contextTokens: 150000, contextWindow: 200000, contextPercent: 75.5,
      },
      conversation: { config: {} },
    }),
    footerHints({ conversation: { config: { model: { provider: "p", modelId: "m" }, thinkingLevel: "high" } } }),
    footerHints({ conversation: { config: { thinkingLevel: null } } }),
  ],
  queue: [
    queueLine({ mode: "steer", input: "hello" }),
    queueLine({ mode: "followUp", input: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    queueLine({ mode: "write", entry: { kind: "memory.append" } }),
  ],
  notices: [
    [{ id: 1, level: "info", message: "a" }, { id: 2, level: "warning", message: "b" }, { id: 3, level: "error", message: "c" }, { id: 4, level: "info", message: "d" }, { id: 5, level: "error", message: "e" }].slice(-4).map(
      (item) => `${item.level}:${item.message}`,
    ),
  ],
  authProviders: authProviders([
    { id: "anthropic", name: "Anthropic", authType: "oauth", configured: true, source: "stored", interactive: true, methodName: "Claude account" },
    { id: "openai", name: "OpenAI", authType: "api_key", configured: false, interactive: true, methodName: "API key" },
    { id: "bedrock", name: "Bedrock", authType: "api_key", configured: true, interactive: false },
  ]),
  selectModelOrder: (() => {
    const current = { provider: "p2", modelId: "m1" };
    const models = [
      { provider: "p1", modelId: "m1" },
      { provider: "p2", modelId: "m1" },
      { provider: "p2", modelId: "m2" },
      { provider: "p1", modelId: "m3" },
    ];
    return [...models]
      .sort((left, right) => {
        const leftCurrent = left.provider === current?.provider && left.modelId === current.modelId;
        const rightCurrent = right.provider === current?.provider && right.modelId === current.modelId;
        return leftCurrent === rightCurrent ? 0 : leftCurrent ? -1 : 1;
      })
      .map((model) => `${model.provider}/${model.modelId}`);
  })(),
  valueSplit: (() => {
    const value = "provider.name/model-id";
    const separator = value.indexOf("/");
    return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
  })(),
};

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/micro/runtime.ts (usage accumulation and
// usage view math; foldEvent notice mapping)
// ---------------------------------------------------------------------------
function accumulateUsage(accumulator, entry) {
  if (accumulator.seen.has(entry.id)) return;
  accumulator.seen.add(entry.id);
  const assistant = assistantMessage(entry);
  const usage = assistant?.usage ?? usageRecord(entry);
  if (usage) {
    accumulator.input += usage.input;
    accumulator.output += usage.output;
    accumulator.cacheRead += usage.cacheRead;
    accumulator.cacheWrite += usage.cacheWrite;
    accumulator.totalCost += usage.cost.total;
  }
  if (assistant && assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && entry.id > accumulator.lastAssistantId) {
    accumulator.lastAssistantId = entry.id;
    const promptTokens = assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite;
    accumulator.lastCacheHitRate = promptTokens > 0 ? (assistant.usage.cacheRead / promptTokens) * 100 : undefined;
  }
}

function assistantMessage(entry) {
  const message = entry.model?.find((candidate) => candidate.role === "assistant");
  return message ?? undefined;
}

function usageRecord(entry) {
  return entry.data?.usage ?? undefined;
}

function contextTokenCount(usage) {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function usageView(cumulative, conversation, contextWindowById) {
  const ref = modelRef(conversation.config.model);
  const contextWindow = ref ? (contextWindowById[`${ref.provider}/${ref.modelId}`] ?? 0) : 0;
  const newestSummary = conversation.entries.filter((entry) => entry.kind === "pi.summary").map((entry) => entry.id).at(-1);
  const contextAssistant = [...conversation.entries].reverse().find((entry) => {
    const assistant = assistantMessage(entry);
    return (
      assistant !== undefined &&
      assistant.stopReason !== "aborted" &&
      assistant.stopReason !== "error" &&
      (newestSummary === undefined || entry.id > newestSummary)
    );
  });
  const contextUsage = contextAssistant ? assistantMessage(contextAssistant)?.usage : undefined;
  const contextTokens = contextUsage ? contextTokenCount(contextUsage) : null;
  const contextPercent = contextTokens === null || contextWindow <= 0 ? null : (contextTokens / contextWindow) * 100;
  return {
    input: cumulative.input,
    output: cumulative.output,
    cacheRead: cumulative.cacheRead,
    cacheWrite: cumulative.cacheWrite,
    totalCost: cumulative.totalCost,
    ...(cumulative.lastCacheHitRate === undefined ? {} : { lastCacheHitRate: cumulative.lastCacheHitRate }),
    contextTokens,
    contextWindow,
    contextPercent,
  };
}

function foldEvent(notices, event, previousCompaction) {
  if (event.type === "entry.added") return "accumulate";
  else if (event.type === "warning") notices.push(["warning", event.message]);
  else if (event.type === "generation.failed") {
    notices.push([event.reason === "overflow" ? "info" : "error", event.detail]);
  } else if (event.type === "compaction.failed") notices.push(["error", `Compaction failed: ${event.detail}`]);
  else if (event.type === "compaction.finished" && previousCompaction?.reason === "threshold") {
    notices.push(["info", "Automatic compaction completed."]);
  }
  return "folded";
}

out.microUsage = (() => {
  const assistant = (id, usage, stopReason = "stop") => ({
    id,
    model: [{ role: "assistant", stopReason, usage }],
  });
  const accumulator = { seen: new Set(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0, lastAssistantId: 0 };
  accumulateUsage(accumulator, assistant(1, { input: 10, output: 5, cacheRead: 70, cacheWrite: 20, totalTokens: 105, cost: { total: 0.1 } }));
  accumulateUsage(accumulator, assistant(2, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.2 } }, "aborted"));
  accumulateUsage(accumulator, { id: 3, data: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0.3 } } } });
  accumulateUsage(accumulator, assistant(2, { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, cost: { total: 9 } }));
  const conversation = {
    config: { model: { provider: "p", modelId: "m" } },
    entries: [
      { id: 1, kind: "pi.user" },
      { id: 2, kind: "pi.summary" },
      { id: 3, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", usage: { input: 7, output: 3, cacheRead: 40, cacheWrite: 10, totalTokens: 0 } }] },
      { id: 4, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "aborted", usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }] },
      { id: 5, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "error", usage: { input: 888, output: 888, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }] },
    ],
  };
  const notices = [];
  const folds = [
    foldEvent(notices, { type: "entry.added", entry: {} }, undefined),
    foldEvent(notices, { type: "warning", message: "watch out" }, undefined),
    foldEvent(notices, { type: "generation.failed", reason: "overflow", detail: "context full" }, undefined),
    foldEvent(notices, { type: "generation.failed", reason: "error", detail: "boom" }, undefined),
    foldEvent(notices, { type: "compaction.failed", detail: "no space" }, undefined),
    foldEvent(notices, { type: "compaction.finished" }, { reason: "threshold" }),
    foldEvent(notices, { type: "compaction.finished" }, { reason: "manual" }),
  ];
  return {
    accumulator: {
      input: accumulator.input,
      output: accumulator.output,
      cacheRead: accumulator.cacheRead,
      cacheWrite: accumulator.cacheWrite,
      totalCost: accumulator.totalCost,
      lastAssistantId: accumulator.lastAssistantId,
      lastCacheHitRate: accumulator.lastCacheHitRate,
    },
    view: usageView(accumulator, conversation, { "p/m": 1000 }),
    viewNoWindow: usageView(accumulator, { ...conversation, config: { model: { provider: "x", modelId: "y" } } }, {}),
    folds,
    notices,
  };
})();

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/micro/models.ts (toAiContext grouping,
// readModelsView account construction and ordering)
// ---------------------------------------------------------------------------
function toAiContext(request, toolMetadata) {
  const systemPrompt = [];
  const messages = [];
  const tools = new Map();
  for (const message of request.messages) {
    if (message.role !== "system") {
      messages.push(message);
      continue;
    }
    const system = message;
    if (system.content) systemPrompt.push(system.content);
    for (const removed of system.toolsRemoved ?? []) tools.delete(removed.name);
    for (const added of system.toolsAdded ?? []) {
      const metadata = toolMetadata.get(added.name);
      tools.set(added.name, {
        name: added.name,
        description: added.description,
        parameters: added.parameters,
        ...(metadata?.constrainedSampling === undefined ? {} : { constrainedSampling: metadata.constrainedSampling }),
      });
    }
  }
  return {
    messages,
    ...(systemPrompt.length === 0 ? {} : { systemPrompt: systemPrompt.join("\n\n") }),
    ...(tools.size === 0 ? {} : { tools: [...tools.values()] }),
  };
}

function readModelsView(runtime, refreshing) {
  const models = runtime.getAvailableSnapshot().map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
  const accounts = [];
  for (const provider of runtime.getProviders()) {
    const status = runtime.getProviderAuthStatus(provider.id);
    const shared = {
      id: provider.id,
      name: provider.name,
      configured: status.configured,
      ...((status.label ?? status.source) === undefined ? {} : { source: status.label ?? status.source }),
    };
    if (provider.auth.oauth) {
      accounts.push({ ...shared, authType: "oauth", interactive: true, methodName: provider.auth.oauth.name });
    }
    if (provider.auth.apiKey) {
      accounts.push({
        ...shared,
        authType: "api_key",
        interactive: provider.auth.apiKey.login !== undefined,
        methodName: provider.auth.apiKey.name,
      });
    }
  }
  accounts.sort((left, right) => left.name.localeCompare(right.name));
  return { models, accounts, refreshing };
}

out.microModels = {
  aiContext: toAiContext(
    {
      messages: [
        { role: "system", content: "one", toolsAdded: [{ name: "read", description: "Read.", parameters: { t: 1 } }] },
        { role: "user", content: "hi" },
        { role: "system", content: "two", toolsRemoved: [{ name: "read" }], toolsAdded: [{ name: "bash", description: "Bash.", parameters: { t: 2 } }] },
        { role: "assistant", content: "hello" },
      ],
    },
    new Map([["bash", { constrainedSampling: false }]]),
  ),
  modelsView: readModelsView(
    {
      getAvailableSnapshot: () => [
        { provider: "b", id: "m2", name: "Zeta", contextWindow: 200, maxTokens: 8192 },
        { provider: "a", id: "m1", name: "Alpha", contextWindow: 100, maxTokens: 4096 },
      ],
      getProviders: () => [
        { id: "p2", name: "Zeta", auth: { oauth: { name: "ZLogin" }, apiKey: undefined } },
        { id: "p1", name: "Anthropic", auth: { oauth: undefined, apiKey: { name: "KeyLogin", login: () => {} } } },
        { id: "p3", name: "Bedrock", auth: { oauth: undefined, apiKey: { name: "Ambient", login: undefined } } },
      ],
      getProviderAuthStatus: (id) =>
        id === "p1"
          ? { configured: true, label: "stored" }
          : id === "p2"
            ? { configured: false, label: undefined, source: "environment" }
            : { configured: true, label: undefined, source: undefined },
    },
    false,
  ),
};

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/plugins/package.ts pure surfaces + upstream
// experimental/plugins/bundled.ts createPresentationFacetData
// ---------------------------------------------------------------------------
const PLUGIN_PACKAGE_PROFILE_VERSION = 1;
const FACET_BUNDLE_MANIFEST_FILE = "chord-facets.json";

function normalizePluginPackagePaths(packagePaths) {
  const normalized = packagePaths.map((packagePath) => {
    if (packagePath.length === 0) throw new Error("Plugin package path must not be empty");
    return resolve(packagePath);
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Plugin package paths must be unique");
  }
  return normalized;
}

function sessionPluginProfilePath(directory, serverId, sessionPath) {
  const hash = createHash("sha256").update(sessionPath).digest("hex").slice(0, 24);
  return join(directory, `session-plugin-packages-${serverId}-${hash}.json`);
}

function pluginBuildDirectoryName(packagePath) {
  const packageDirectory = basename(packagePath) === "package.json" ? dirname(packagePath) : packagePath;
  const base = basename(packageDirectory).replaceAll(/[^a-zA-Z0-9._-]/gu, "-") || "plugin";
  const label = base.endsWith("-plugin") ? base : `${base}-plugin`;
  const hash = createHash("sha256").update(packagePath).digest("hex").slice(0, 12);
  return `${label}-${hash}`;
}

function dirname(path) {
  return pathDirname(path);
}

const PROFILE = {
  read: (text, allowEmpty, sessionPath) => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw new Error(`Could not read experimental plugin package profile <path>`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some(
        (key) => key !== "version" && key !== "packagePaths" && !(key === "sessionPath" && sessionPath !== undefined),
      ) ||
      !("version" in parsed) ||
      parsed.version !== PLUGIN_PACKAGE_PROFILE_VERSION ||
      (sessionPath === undefined
        ? "sessionPath" in parsed
        : !("sessionPath" in parsed) || parsed.sessionPath !== sessionPath) ||
      !("packagePaths" in parsed) ||
      !Array.isArray(parsed.packagePaths) ||
      (!allowEmpty && parsed.packagePaths.length === 0) ||
      parsed.packagePaths.some((packagePath) => typeof packagePath !== "string" || packagePath.length === 0)
    ) {
      throw new Error("Invalid experimental plugin package profile <path>");
    }
    return normalizePluginPackagePaths(parsed.packagePaths);
  },
  write: (packagePaths, sessionPath) =>
    `${JSON.stringify(
      {
        version: PLUGIN_PACKAGE_PROFILE_VERSION,
        ...(sessionPath === undefined ? {} : { sessionPath }),
        packagePaths,
      },
      null,
      2,
    )}\n`,
};

const PRESENTATION_FACET_BUNDLES_KEY = "presentationFacetBundles";

function createPresentationFacetData(artifacts) {
  return { [PRESENTATION_FACET_BUNDLES_KEY]: artifacts.map((artifact) => artifact) };
}

function createPresentationFacetLoadersValidate(data) {
  if (data === null || Array.isArray(data) || typeof data !== "object") {
    throw new Error("Invalid presentation plugin data");
  }
  const artifacts = data[PRESENTATION_FACET_BUNDLES_KEY];
  if (artifacts === undefined) return [];
  if (!Array.isArray(artifacts)) throw new Error("Invalid presentation plugin bundle list");
  return artifacts.map(() => "loader");
}

out.plugins = {
  normalize: [
    tryFn(() => normalizePluginPackagePaths(["a/b", "./c"]).length),
    tryFn(() => normalizePluginPackagePaths([""])),
    tryFn(() => normalizePluginPackagePaths(["a", "b", "a"])),
  ],
  profilePath: sessionPluginProfilePath("<dir>", "00000000-0000-4000-8000-000000000001", "/sessions/abc.json"),
  buildDirs: [
    pluginBuildDirectoryName("/plugins/my-plugin/package.json"),
    pluginBuildDirectoryName("/plugins/cool/package.json"),
    pluginBuildDirectoryName("/plugins/Weird Name!"),
    pluginBuildDirectoryName("/plugins/-plugin"),
  ],
  profile: [
    tryFn(() => PROFILE.read('{"version":1,"packagePaths":["/a"]}', false)?.length),
    tryFn(() => PROFILE.read('{"version":1,"packagePaths":["/a","/b"]}', true, "/s/1")?.length),
    tryFn(() => PROFILE.read('{"version":1,"sessionPath":"/s/1","packagePaths":["/a"]}', true, "/s/1")?.length),
    tryFn(() => PROFILE.read('{"version":1,"sessionPath":"/s/2","packagePaths":["/a"]}', true, "/s/1")),
    tryFn(() => PROFILE.read('{"version":2,"packagePaths":["/a"]}', false)),
    tryFn(() => PROFILE.read('{"version":1,"packagePaths":[]}', false)),
    tryFn(() => PROFILE.read('{"version":1,"packagePaths":[]}', true)),
    tryFn(() => PROFILE.read('{"version":1,"packagePaths":[""]}', false)),
    tryFn(() => PROFILE.read('{"version":1,"packagePaths":"nope"}', false)),
    tryFn(() => PROFILE.read('{"version":1,"extra":1,"packagePaths":["/a"]}', false)),
    tryFn(() => PROFILE.read('{"version":1,"sessionPath":"/s/1","packagePaths":["/a"]}', false)),
    tryFn(() => PROFILE.read('{"version":1,"sessionPath":"/s/1","packagePaths":["/a"]}', true, "/s/1")?.length),
    tryFn(() => PROFILE.read("not json", false)),
  ],
  written: [
    PROFILE.write(["/a", "/b"]),
    PROFILE.write(["/a"], "/sessions/s1"),
  ],
  facetData: createPresentationFacetData([
    { format: "chord-facet-bundle", formatVersion: 1, plugin: { id: "p" }, entryName: "tui", entry: { file: "tui.cjs", integrity: "sha256-x", externalImports: [] }, source: "" },
  ]),
  facetLoaders: [
    tryFn(() => createPresentationFacetLoadersValidate({}).length),
    tryFn(() => createPresentationFacetLoadersValidate({ [PRESENTATION_FACET_BUNDLES_KEY]: [1, 2] }).length),
    tryFn(() => createPresentationFacetLoadersValidate({ [PRESENTATION_FACET_BUNDLES_KEY]: "nope" })),
    tryFn(() => createPresentationFacetLoadersValidate(null)),
    tryFn(() => createPresentationFacetLoadersValidate([1])),
  ],
};

console.log(JSON.stringify(out, null, 2));
