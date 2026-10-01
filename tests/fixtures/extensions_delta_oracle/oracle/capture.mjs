// Extensions-delta oracle driver. Executes the VERBATIM upstream HEAD
// (`pi@2bbfcca43`, v0.99.1) sources copied under ../src with
// `node --experimental-strip-types`:
//
//   src/core/extensions/{types,runner,loader}.ts   (HEAD, verbatim)
//   src/core/{mcp-servers,source-info}.ts          (HEAD, verbatim)
//   src/extensions/tool-search/{index,tool}.ts     (HEAD, verbatim)
//   src/ai/{transcript,text}.ts                    (HEAD pi-ai utils, verbatim)
//
// The surrounding module graph (config/exec/event-bus/pi-manifest/system-prompt/
// timings/theme/paths) reuses the established ext_oracle seams; `typebox` is
// the REAL pinned npm package (1.3.27, lockfile sha512 in manifest.json)
// because the tool-search scenarios exercise Type.* output. The
// `@earendil-works/pi-ai` import resolves to a stub package re-exporting the
// verbatim transcript utils (node refuses type-stripped .ts under
// node_modules).
//
// Every captured string has the fixture tmp root replaced by "<root>";
// function-valued fields are pinned as presence markers. Output:
// extensions_delta_oracle.json — every entry is a byte-exact expectation.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } = await import(
  new URL("../src/core/extensions/loader.ts", import.meta.url).href
);
const { ExtensionRunner } = await import(new URL("../src/core/extensions/runner.ts", import.meta.url).href);
const { createEventBus } = await import(new URL("../src/core/event-bus.ts", import.meta.url).href);
const {
  TOOL_SEARCH_TOOL_NAME,
  DEFAULT_TOOL_SEARCH_LIMIT,
  tokenize,
  createToolSearchDocument,
  Bm25Ranker,
  toolSearchSchema,
  isToolSearchTool,
  createToolSearchDescription,
  createToolSearchToolDefinition,
} = await import(new URL("../src/extensions/tool-search/tool.ts", import.meta.url).href);
const { createToolSearchExtension } = await import(
  new URL("../src/extensions/tool-search/index.ts", import.meta.url).href
);

const rootReal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-delta-oracle-"));
const rootFwd = rootReal.replaceAll("\\", "/");
const deepRel = (v) => {
  if (typeof v === "string")
    return v
      .split(rootReal)
      .join("<root>")
      .split(rootFwd)
      .join("<root>")
      .replaceAll("\\", "/");
  // Normalize win32 separators so the oracle replays on every host.
  if (Array.isArray(v)) return v.map(deepRel);
  if (v instanceof Map) return deepRel(Object.fromEntries(v));
  if (typeof v === "function") return "<fn>";
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [
        k,
        // JS error stacks embed harness paths/line numbers; pin presence only.
        k === "stack" && typeof val === "string" ? `<js-stack:${val.length > 0}>` : deepRel(val),
      ]),
    );
  }
  return v;
};
const out = { scenarios: [] };
const add = (name, observed) => out.scenarios.push({ name, observed: deepRel(observed) });
const tick = () => new Promise((r) => setTimeout(r, 20));
const json = (v) => JSON.parse(JSON.stringify(v, (_k, val) => (val instanceof Map ? Object.fromEntries(val) : val)));
const catchMessage = (run) => {
  try {
    const value = run();
    return value instanceof Promise ? value.then(() => "ok", (err) => err.message) : value ?? "ok";
  } catch (err) {
    return err.message;
  }
};

// Shared action stubs. bindCore copies these into the runtime; scenarios
// override individual fields.
const extensionActions = {
  sendMessage: () => {},
  sendUserMessage: () => {},
  appendEntry: () => {},
  setSessionName: () => {},
  getSessionName: () => undefined,
  setLabel: () => {},
  getActiveTools: () => [],
  getAllTools: () => [],
  getSettings: () => ({}),
  setActiveTools: () => {},
  refreshTools: () => {},
  getCommands: () => [],
  setModel: async () => false,
  getThinkingLevel: () => "off",
  setThinkingLevel: () => {},
};
const extensionContextActions = {
  getModel: () => undefined,
  getScopedModels: () => [],
  isIdle: () => true,
  isProjectTrusted: () => true,
  getSignal: () => undefined,
  abort: () => {},
  hasPendingMessages: () => false,
  shutdown: () => {},
  getContextUsage: () => undefined,
  compact: () => {},
  getSystemPrompt: () => "",
};

async function loadRunner(factory, opts = {}) {
  const runtime = opts.runtime ?? createExtensionRuntime();
  const bus = opts.bus ?? createEventBus();
  const extensions = [...(opts.extensions ?? [])];
  if (factory) {
    const extension = await loadExtensionFromFactory(factory, rootReal, bus, runtime, opts.extensionPath ?? "<inline>");
    extensions.push(extension);
  }
  const runner = new ExtensionRunner(extensions, runtime, rootReal, {}, opts.modelRegistry ?? {});
  if (!opts.skipBind) {
    runner.bindCore(
      { ...extensionActions, ...(opts.actions ?? {}) },
      { ...extensionContextActions, ...(opts.contextActions ?? {}) },
      opts.providerActions,
    );
  }
  return { runtime, runner };
}

const toolJson = (definition) =>
  json({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    promptSnippet: definition.promptSnippet,
    parameters: definition.parameters,
    exposure: definition.exposure,
    hasExecute: typeof definition.execute === "function",
    hasPrepareLoadout: typeof definition.prepareLoadout === "function",
  });

// ============================================================================
// Part 1 — tool_search (extensions/tool-search/tool.ts)
// ============================================================================

// 1a. tokenize: camelCase/acronym splitting, stop words, naive stemming.
{
  const cases = [
    "list open GitHub issues",
    "WorldSearch WEB_fetch HTTPServer",
    "the cats are running with boxes",
    "classes buses moss pass quest",
    "machines watches boxes wzes",
    "a-b/c.d_e",
    "truncate_session_tree",
    "",
  ];
  add("tool_search_tokenize", cases.map((text) => ({ text, tokens: tokenize(text) })));
}

// 1b. createToolSearchDocument: name, spaced name, description, schema text, namespace.
{
  const namespace = {
    name: "mcp__docs",
    description: "Documentation server\nsecond line",
    instructions: "Use for doc lookups.",
  };
  add("tool_search_documents", [
    createToolSearchDocument({ name: "issue_list", description: "List repository issues", parameters: toolSearchSchema }),
    createToolSearchDocument({
      name: "deploy",
      description: "Deploy a service",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Deployment target" },
          variants: { anyOf: [{ type: "string", description: "A variant" }] },
          tags: { type: "array", items: { type: "string", description: "Tag names" } },
        },
      },
    }),
    createToolSearchDocument(
      { name: "search_docs", description: "Search documentation", parameters: toolSearchSchema },
      namespace,
    ),
    createToolSearchDocument({ name: "bare", description: "  ", parameters: { type: "object" } }),
  ]);
}

// 1c. Bm25Ranker: fixed corpus, ties keep document order, limits, empty inputs.
{
  const documents = [
    { name: "issue_list", text: "issue_list issue list list repository issues" },
    { name: "issue_close", text: "issue_close issue close repository issue" },
    { name: "deploy_service", text: "deploy_service deploy service deployment target" },
    { name: "search_docs", text: "search_docs search documentation docs" },
  ];
  const rank = (query, limit, docs = documents) => new Bm25Ranker().rank(query, docs, limit);
  add("tool_search_bm25", {
    issue: rank("issue", 10),
    issues_stem: rank("issues", 10),
    limit2: rank("issue repository", 2),
    limit0: rank("issue", 0),
    limitNegative: rank("issue", -3),
    emptyQuery: rank("", 10),
    noMatch: rank("zzzqqq", 10),
    emptyDocs: rank("issue", 10, []),
    singleDoc: rank("deploy service", 10, [documents[2]]),
    tieOrder: rank("shared", 10, [
      { name: "alpha", text: "shared term" },
      { name: "beta", text: "shared term" },
      { name: "gamma", text: "shared term" },
    ]),
    customParams: new Bm25Ranker({ k1: 2.0, b: 0.5 }).rank("issue", documents, 10),
  });
}

// 1d. createToolSearchDescription: source listing, first-line trimming, CRLF.
{
  add("tool_search_description", [
    createToolSearchDescription(),
    createToolSearchDescription([]),
    createToolSearchDescription([{ name: "mcp__docs", description: "Documentation server\nsecond line" }]),
    createToolSearchDescription([{ name: "mcp__docs", description: "  padded first\r\nsecond  " }]),
    createToolSearchDescription([{ name: "mcp__jira" }, { name: "mcp__ci", description: "\nstarts blank" }]),
  ]);
}

// 1e. schema + identity-based isToolSearchTool.
{
  const clone = JSON.parse(JSON.stringify(toolSearchSchema));
  add("tool_search_schema", {
    schema: toolSearchSchema,
    defaultLimit: DEFAULT_TOOL_SEARCH_LIMIT,
    toolName: TOOL_SEARCH_TOOL_NAME,
    isTool_sameReference: isToolSearchTool({ name: "tool_search", parameters: toolSearchSchema }),
    isTool_structuralClone: isToolSearchTool({ name: "tool_search", parameters: clone }),
    isTool_otherName: isToolSearchTool({ name: "other", parameters: toolSearchSchema }),
  });
}

// 1f. execute semantics against a fixed tool list.
{
  const all = [
    { name: "direct_active", description: "Already declared", parameters: toolSearchSchema, exposure: "direct" },
    { name: "cm_tool", description: "Codemode tool first line\nmore", parameters: toolSearchSchema, exposure: "codemode" },
    { name: "def_tool", description: "Deferred tool", parameters: toolSearchSchema, exposure: "deferred" },
    { name: "cm_active", description: "Codemode but active", parameters: toolSearchSchema, exposure: "codemode" },
    { name: "hidden_tool", description: "Hidden", parameters: toolSearchSchema, exposure: "hidden" },
    { name: "model_only", description: "Model only", parameters: toolSearchSchema, exposure: "model-only" },
  ];
  const mkTools = (initialActive, log) => {
    let active = [...initialActive];
    return {
      getAllTools: () => all,
      getActiveTools: () => [...active],
      setActiveTools: (names) => {
        log.push([...names]);
        active = names;
      },
    };
  };
  const run = async (tools, query, limit) => {
    const definition = createToolSearchToolDefinition(tools === undefined ? {} : { tools });
    const args = { query, ...(limit === undefined ? {} : { limit }) };
    try {
      return json(await definition.execute("call1", args, undefined, undefined, {}));
    } catch (err) {
      return { threw: err.message };
    }
  };

  // Searchable: codemode + deferred, not active. cm_active is codemode but
  // already active; direct/hidden/model-only are never searchable.
  const log1 = [];
  add("tool_search_execute_load", {
    result: await run(mkTools(["direct_active", "cm_active"], log1), "deferred codemode tool", 8),
    setActiveCalls: log1,
  });

  const log2 = [];
  add("tool_search_execute_no_match", {
    result: await run(mkTools(["direct_active"], log2), "zzzqqq nothing", 8),
    setActiveCalls: log2,
  });

  add("tool_search_execute_no_tools_option", {
    result: await run(undefined, "anything", 8),
  });

  add("tool_search_execute_validation", {
    emptyQuery: await run(mkTools([], []), "   "),
    limitZero: await run(mkTools([], []), "query", 0),
    limitFloat: await run(mkTools([], []), "query", 2.5),
    limitNegative: await run(mkTools([], []), "query", -1),
  });

  const log3 = [];
  add("tool_search_execute_limit_one", {
    result: await run(mkTools(["direct_active", "cm_active"], log3), "deferred codemode tool", 1),
    setActiveCalls: log3,
  });
}

// 1g. prepareLoadout: namespaces of searchable tools, description rewrite.
{
  const definition = createToolSearchToolDefinition({});
  const namespace = { name: "mcp__docs", description: "Docs", instructions: "Use me" };
  const loadout = {
    declared: [],
    callable: [],
    registered: [
      { name: "tool_search" },
      { name: "doc_search" },
      { name: "direct_thing" },
      { name: "doc_other" },
      { name: "deferred_plain" },
    ],
    getExposure: (name) =>
      ({ doc_search: "codemode", doc_other: "deferred", deferred_plain: "deferred" })[name] ?? "direct",
    getNamespace: (name) => (name === "doc_search" || name === "doc_other" ? namespace : undefined),
  };
  const changes = definition.prepareLoadout(loadout);
  add("tool_search_prepare_loadout", {
    changes: json(changes),
    descriptionWithoutSources: definition.description,
    rewrittenDescription: changes.descriptions[TOOL_SEARCH_TOOL_NAME],
    changesWhenOnlyDirect: json(
      definition.prepareLoadout({ ...loadout, getExposure: () => "direct", getNamespace: () => namespace }),
    ),
  });
}

// 1h. the extension factory registers the tool inactive (defaultActive: false).
{
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(
    createToolSearchExtension(),
    rootReal,
    createEventBus(),
    runtime,
    "builtin:tool-search",
  );
  const registered = extension.tools.get("tool_search");
  add("tool_search_extension_registration", {
    extensionPath: extension.path,
    sourceInfo: extension.sourceInfo,
    defaultActive: registered.definition.defaultActive,
    definition: toolJson(registered.definition),
  });
}

// ============================================================================
// Part 2 — runner/loader delta
// ============================================================================

// 2a. registerMcpServer surface: validation, ownership, unregister scoping.
{
  const runtime = createExtensionRuntime();
  const one = {};
  const two = {};
  await loadExtensionFromFactory(
    (pi) => {
      one.valid = catchMessage(() => pi.registerMcpServer("jira", { url: "https://mcp.example.com/jira", exposure: "codemode-deferred" }));
      one.invalid = catchMessage(() => pi.registerMcpServer("bad name!", { command: "x" }));
      one.afterRegister = json(pi.getMcpServers());
    },
    rootReal,
    createEventBus(),
    runtime,
    "<inline:one>",
  );
  await loadExtensionFromFactory(
    (pi) => {
      two.conflict = catchMessage(() => pi.registerMcpServer("jira", { command: "y" }));
      two.ownReplace = catchMessage(() => {
        pi.registerMcpServer("own", { command: "a" });
        pi.registerMcpServer("own", { command: "b" });
        return json(pi.getMcpServers().map((server) => server.name));
      });
      two.foreignUnregister = catchMessage(() => pi.unregisterMcpServer("jira"));
      two.afterForeignUnregister = json(pi.getMcpServers().map((server) => server.name));
      two.ownUnregister = catchMessage(() => {
        pi.unregisterMcpServer("own");
        return json(pi.getMcpServers().map((server) => server.name));
      });
    },
    rootReal,
    createEventBus(),
    runtime,
    "<inline:two>",
  );
  add("register_mcp_server_surface", { one, two, finalList: json(runtime.mcpServers.list()) });
}

// 2b. mcp_servers_change emission + unhandled reporting.
{
  // With a handler: registrations made during load are applied at commit
  // (pre-bind, no listener); post-bind registrations emit the change event.
  const emitted = [];
  const runtime = createExtensionRuntime();
  const handler = await loadExtensionFromFactory(
    (pi) => {
      pi.on("mcp_servers_change", (event) => emitted.push(json(event)));
      pi.registerMcpServer("loaded", { command: "serve" });
    },
    rootReal,
    createEventBus(),
    runtime,
    "<inline:handler>",
  );
  const { runner } = await loadRunner(undefined, { runtime, extensions: [handler] });
  await loadExtensionFromFactory(
    (pi) => {
      pi.registerMcpServer("live", { url: "https://mcp.example.com/live" });
    },
    rootReal,
    createEventBus(),
    runtime,
    "<inline:handler2>",
  );
  await tick();
  add("mcp_servers_change_with_handler", { emitted });

  // Without any handler: each newly registered server is reported once.
  // Re-registering the same name from the same extension replaces it and does
  // not report again (the reported set is keyed by server name).
  const errors = [];
  const runtime2 = createExtensionRuntime();
  const { runner: runner3 } = await loadRunner(undefined, { runtime: runtime2 });
  runner3.onError((error) => errors.push(json(error)));
  await loadExtensionFromFactory(
    (pi) => {
      pi.registerMcpServer("alpha", { command: "a" });
      pi.registerMcpServer("alpha", { command: "a2" });
      pi.registerMcpServer("beta", { command: "b" });
      pi.unregisterMcpServer("alpha");
    },
    rootReal,
    createEventBus(),
    runtime2,
    "<inline:nohandler-same>",
  );
  await tick();
  add("mcp_servers_unhandled_report", { errors });
}

// 2c. getSettings passthrough + pre-bind throw.
{
  const settings = { defaultProvider: "anthropic", compaction: { enabled: true } };
  const preBindMessage = { value: null };
  const preBindRuntime = createExtensionRuntime();
  await loadExtensionFromFactory(
    (pi) => {
      preBindMessage.value = catchMessage(() => pi.getSettings());
    },
    rootReal,
    createEventBus(),
    preBindRuntime,
    "<inline:prebind>",
  );
  // The factory runs pre-bind; stash the api and call post-bind.
  const holder = {};
  const { runner } = await loadRunner(
    (pi) => {
      holder.preBindInFactory = catchMessage(() => pi.getSettings());
      holder.pi = pi;
    },
    { actions: { getSettings: () => settings } },
  );
  add("get_settings", {
    preBind: preBindMessage.value,
    inFactory: holder.preBindInFactory,
    postBind: catchMessage(() => holder.pi.getSettings()),
    runtimeGetSettingsAfterBind: runner.runtime.getSettings?.() ?? null,
  });
}

// 2d. registerCommand validation.
{
  const observed = {};
  await loadRunner((pi) => {
    observed.emptyName = catchMessage(() => pi.registerCommand("", { handler: () => {} }));
    observed.missingHandler = catchMessage(() => pi.registerCommand("nohandler", {}));
    observed.valid = catchMessage(() => pi.registerCommand("ok", { description: "d", handler: () => {} }));
  });
  add("register_command_validation", observed);
}

// 2e. emitBoundary (turn_end): chaining, context rebuilds, invalid-entries zeroing.
{
  const preview = (label, entries) => ({
    contextEntries: entries.map((entry) => ({ id: entry.customType ?? null })),
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
    canContinue: true,
    label,
  });
  const baseEvent = {
    type: "turn_end",
    turnIndex: 0,
    message: { role: "assistant", content: "answer", timestamp: 1 },
    toolResults: [],
    messageEntryId: "entry-message",
    toolResultEntryIds: [],
    outcome: "completed",
  };

  const seen = [];
  const { runner } = await loadRunner((pi) => {
    pi.on("turn_end", (event, ctx) => {
      seen.push({
        handler: "A",
        entries: json(event.entries),
        continue: event.continue,
        context: event.context,
        outcome: event.outcome,
        turnIndex: event.turnIndex,
        messageEntryId: event.messageEntryId,
        ctxIsObject: typeof ctx === "object" && ctx !== null,
      });
      return {
        entries: [...event.entries, { type: "custom", customType: "note", data: { from: "A" } }],
        continue: true,
      };
    });
    pi.on("turn_end", (event) => {
      seen.push({ handler: "B", entries: json(event.entries), continue: event.continue, context: event.context });
      return { entries: [...event.entries, { type: "custom_message", customType: "b", content: "hi", display: true }] };
    });
  });
  let buildCalls = 0;
  const result = await runner.emitBoundary(baseEvent, (entries) => {
    buildCalls += 1;
    return preview(`build-${buildCalls}`, entries);
  });
  add("emit_boundary_chain", { seen, result: json(result) });

  const order = [];
  const { runner: runner2 } = await loadRunner((pi) => {
    pi.on("turn_end", (event) => {
      order.push("A");
      return { entries: [...event.entries, { type: "custom", customType: "ok" }] };
    });
    pi.on("turn_end", (event) => {
      order.push("B");
      return { entries: [...event.entries, { type: "bogus" }] };
    });
    pi.on("turn_end", (event) => {
      order.push("C");
      return { continue: true };
    });
  });
  let buildCalls2 = 0;
  const result2 = await runner2.emitBoundary(baseEvent, (entries) => {
    buildCalls2 += 1;
    if (entries.some((entry) => entry.type === "bogus")) throw new Error("unsupported draft type");
    return preview(`build2-${buildCalls2}`, entries);
  });
  add("emit_boundary_invalid", { order, result: json(result2) });

  const order3 = [];
  const { runner: runner3 } = await loadRunner((pi) => {
    pi.on("agent_before_settle", (event) => {
      order3.push({ outcome: event.outcome, type: event.type });
      return { continue: true };
    });
  });
  const result3 = await runner3.emitBoundary({ ...baseEvent, type: "agent_before_settle" }, (entries) =>
    preview("settle", entries),
  );
  add("emit_boundary_agent_before_settle", { order: order3, result: json(result3) });
}

// 2f. emitCacheWarmingDecision: last override wins, errors isolated.
{
  const seen = [];
  const { runner } = await loadRunner((pi) => {
    pi.on("cache_warming_decision", (event) => {
      seen.push(json(event));
      return { action: "stop" };
    });
    pi.on("cache_warming_decision", () => {
      throw new Error("classifier down");
    });
    pi.on("cache_warming_decision", () => ({ action: "warm" }));
  });
  const errors = [];
  runner.onError((error) => errors.push(json(error)));
  const action = await runner.emitCacheWarmingDecision({
    type: "cache_warming_decision",
    warmCost: 0.001,
    missCost: 0.2,
    continuationProbability: 0.5,
    action: "warm",
  });
  add("emit_cache_warming_decision", { seen, action, errors });
}

// 2g. emitContext two-phase: system filtering, in-place edits, restore, with_system.
{
  const transcript = [
    { role: "system", content: "BASE", timestamp: 5, sections: { s1: "v1" }, toolsAdded: [{ name: "read" }] },
    { role: "user", content: "hello", timestamp: 6 },
    { role: "system", content: "extra", timestamp: 7 },
    { role: "assistant", content: "hi", timestamp: 8 },
  ];
  const seen = { context: [], contextWithSystem: [] };
  const { runner } = await loadRunner((pi) => {
    pi.on("context", (event) => {
      seen.context.push(json(event.messages));
      // Replace an element in place: upstream sees a changed conversation and
      // re-attaches the folded leading system message.
      const messages = event.messages;
      messages[0] = { ...messages[0], content: "hello!" };
    });
    pi.on("context", (event) => {
      seen.context.push(json(event.messages));
      return { messages: event.messages.filter((message) => message.role !== "assistant") };
    });
    pi.on("context_with_system", (event) => {
      seen.contextWithSystem.push(json(event.messages));
      return { messages: event.messages.filter((message) => message.role !== "system") };
    });
  });
  const errors = [];
  runner.onError((error) => errors.push(json(error)));
  const result = await runner.emitContext(transcript.map((message) => ({ ...message })));
  add("emit_context_two_phase", { seen, result: json(result), errors });

  const seen2 = { contextHandlers: 0, contextWithSystem: [] };
  const { runner: runner2 } = await loadRunner((pi) => {
    pi.on("context", () => {
      seen2.contextHandlers += 1;
    });
    pi.on("context_with_system", (event) => {
      seen2.contextWithSystem.push(json(event.messages));
    });
  });
  const result2 = await runner2.emitContext([
    { role: "system", content: "only", timestamp: 1 },
    { role: "user", content: "u", timestamp: 2 },
  ]);
  add("emit_context_unchanged", { phases: seen2, result: json(result2) });

  const { runner: runner3 } = await loadRunner((pi) => {
    pi.on("context", (event) => ({ messages: [...event.messages].reverse() }));
  });
  const result3 = await runner3.emitContext([
    { role: "user", content: "a", timestamp: 1 },
    { role: "assistant", content: "b", timestamp: 2 },
  ]);
  add("emit_context_no_system", { result: json(result3) });
}

// 2h. createToolContext: tools getter + executeTool defaulting and fallback.
{
  const forwardCalls = [];
  const markerSignal = { aborted: false };
  const { runner } = await loadRunner(undefined, {
    contextActions: {
      getCallableTools: () => [{ name: "callable_one" }, { name: "callable_two" }],
      executeTool: async (callerId, name, args, options) => {
        forwardCalls.push({
          callerId,
          name,
          args: json(args),
          hasSignal: options.signal !== undefined,
          sameSignal: options.signal === markerSignal,
        });
        return {
          toolCall: { type: "toolCall", id: `${callerId}/0`, name, arguments: args },
          result: { content: [{ type: "text", text: "nested ok" }], details: {} },
          isError: false,
        };
      },
    },
  });
  const ctx = runner.createToolContext("parent1", markerSignal);
  const nested = await ctx.executeTool("mcp__docs__search", { q: "rust" });
  await ctx.executeTool("other", {}, { signal: undefined });
  add("create_tool_context", {
    forwardCalls,
    nested: json(nested),
    tools: json(ctx.tools),
    toolsLiveGetter: ctx.tools.length,
  });

  const { runner: runner2 } = await loadRunner(undefined, {});
  const ctx2 = runner2.createToolContext("parent2", undefined);
  add("create_tool_context_fallback", {
    result: json(await ctx2.executeTool("target", { a: 1 })),
    tools: json(ctx2.tools),
  });
}

// 2i. virtual models: queueing, unregister filtering, bind flush, routing seam.
{
  const runtime = createExtensionRuntime();
  await loadExtensionFromFactory(
    (pi) => {
      pi.registerVirtualModel({
        provider: "llama.cpp",
        id: "auto",
        name: "Auto",
        thinkingLevels: ["off", "medium"],
        contextWindow: 8192,
        route: async (request, ctx) => ({ model: request.model, thinkingLevel: request.thinkingLevel, ctxOk: ctx !== undefined }),
      });
      pi.registerVirtualModel({ provider: "openai", id: "router", name: "Router", route: async () => ({}) });
      pi.unregisterVirtualModel("openai", "router");
      pi.unregisterVirtualModel("openai", "unknown");
    },
    rootReal,
    createEventBus(),
    runtime,
    "<inline:vm>",
  );
  const pending = runtime.pendingVirtualModelRegistrations.map(({ definition, extensionPath }) => ({
    definition: json({ ...definition, route: "<fn>" }),
    extensionPath,
  }));
  // Pre-bind wrapped route: calling it rejects with the createContext throw.
  const preBindRoute = catchMessage(() =>
    runtime.pendingVirtualModelRegistrations[0].definition.route({ model: { id: "x" } }),
  );
  if (preBindRoute instanceof Promise) {
    add("__internal_unexpected_promise__", {});
  }
  const registered = [];
  const unregistered = [];
  const routedContexts = [];
  await loadRunner(undefined, {
    runtime,
    extensions: [],
    providerActions: {
      registerVirtualModel: (definition) => {
        registered.push(json({ ...definition, route: "<fn>" }));
        Promise.resolve(
          definition.route({ model: { id: "physical" }, thinkingLevel: "off", reason: "direct" }),
        ).then(
          (result) => routedContexts.push({ result: json(result) }),
          (err) => routedContexts.push({ threw: err.message }),
        );
      },
      unregisterVirtualModel: (provider, id) => unregistered.push([provider, id]),
    },
  });
  await tick();
  add("virtual_models_flush", { pending, preBindRoute, registered, unregistered, routedContexts });

  // Error path: provider action throws -> emit_error event register_virtual_model.
  // The listener must be attached before bindCore flushes the queue.
  const errors = [];
  const runtime2 = createExtensionRuntime();
  await loadExtensionFromFactory(
    (pi) => {
      pi.registerVirtualModel({ provider: "p", id: "bad", name: "Bad", route: async () => ({}) });
    },
    rootReal,
    createEventBus(),
    runtime2,
    "<inline:vmbad>",
  );
  const failingRunner = new ExtensionRunner([], runtime2, rootReal, {}, {});
  failingRunner.onError((error) => errors.push(json(error)));
  failingRunner.bindCore(
    { ...extensionActions },
    { ...extensionContextActions },
    {
      registerVirtualModel: () => {
        throw new Error("duplicate virtual model");
      },
    },
  );
  add("virtual_models_flush_error", { errors });

  // Fallback path: no provider actions -> model registry receives registrations.
  const registryCalls = [];
  const runtime4 = createExtensionRuntime();
  await loadExtensionFromFactory(
    (pi) => {
      pi.registerVirtualModel({ provider: "p", id: "m", name: "M", route: async () => ({}) });
    },
    rootReal,
    createEventBus(),
    runtime4,
    "<inline:vmreg>",
  );
  await loadRunner(undefined, {
    runtime: runtime4,
    extensions: [],
    modelRegistry: {
      registerVirtualModel: (definition) => registryCalls.push(json({ ...definition, route: "<fn>" })),
      unregisterVirtualModel: (provider, id) => registryCalls.push(["unregister", provider, id]),
    },
  });
  await loadExtensionFromFactory(
    (pi) => {
      pi.registerVirtualModel({ provider: "q", id: "live", name: "Live", route: async () => ({}) });
      pi.unregisterVirtualModel("q", "live");
    },
    rootReal,
    createEventBus(),
    runtime4,
    "<inline:vmlive>",
  );
  add("virtual_models_registry_fallback", { registryCalls });
}

// 2j. synthetic-path source info (builtin:) + loader warnings field.
{
  const runtime = createExtensionRuntime();
  const builtin = await loadExtensionFromFactory(() => {}, rootReal, createEventBus(), runtime, "builtin:tool-search");
  const inline = await loadExtensionFromFactory(() => {}, rootReal, createEventBus(), runtime, "<inline:named>");
  const filePath = path.join(rootReal, "file-ext.ts");
  fs.writeFileSync(filePath, "export default () => {};");
  const local = await loadExtensionFromFactory(() => {}, rootReal, createEventBus(), runtime, filePath);
  const result = loadExtensions([], rootReal, createEventBus(), runtime);
  add("synthetic_source_info", {
    builtin: builtin.sourceInfo,
    inline: inline.sourceInfo,
    local: local.sourceInfo,
    warnings: result.warnings,
  });
}

fs.writeFileSync(new URL("./extensions_delta_oracle.json", import.meta.url), JSON.stringify(out, null, "\t") + "\n");
console.log(`captured ${out.scenarios.length} scenarios -> extensions_delta_oracle.json`);
