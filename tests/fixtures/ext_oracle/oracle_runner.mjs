// Oracle capture: upstream coding-agent extension runner under node
// (type stripping). Captured sources are verbatim copies (sha256 in port
// report); surrounding module graph is stubbed — see ./src file headers
// (seams O-1..O-4). Every captured string has the fixture root replaced by
// "<root>".
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const { createExtensionRuntime, loadExtensionFromFactory } = await import(
  new URL("./src/core/extensions/loader.ts", import.meta.url)
);
const { ExtensionRunner, emitProjectTrustEvent, emitSessionShutdownEvent } = await import(
  new URL("./src/core/extensions/runner.ts", import.meta.url)
);
const { createEventBus } = await import(new URL("./src/core/event-bus.ts", import.meta.url));
const { normalizeBuildSystemPromptOptions, buildSystemPrompt } = await import(
  new URL("./src/core/system-prompt.ts", import.meta.url)
);

const rootReal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-oracle-"));
const rootFwd = rootReal.replaceAll("\\", "/");
const deepRel = (v) => {
  if (typeof v === "string")
    return v.split(rootReal).join("<root>").split(rootFwd).join("<root>");
  if (Array.isArray(v)) return v.map(deepRel);
  if (v instanceof Map) return deepRel(Object.fromEntries(v));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [
        k,
        // JS `error.stack` embeds script-file paths/line numbers of the oracle
        // harness itself; the capture pins presence, not the machine text.
        k === "stack" && typeof val === "string" ? `<js-stack:${val.length > 0}>` : deepRel(val),
      ]),
    );
  }
  return v;
};
const out = { scenarios: [] };
const add = (name, observed) => out.scenarios.push({ name, observed: deepRel(observed) });

let scenarioIndex = 0;
const extensionActions = {
  sendMessage: () => {},
  sendUserMessage: () => {},
  appendEntry: () => {},
  setSessionName: () => {},
  getSessionName: () => undefined,
  setLabel: () => {},
  getActiveTools: () => [],
  getAllTools: () => [],
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
  const extension = await loadExtensionFromFactory(factory, rootReal, bus, runtime, opts.extensionPath ?? "<inline>");
  const runner = new ExtensionRunner(
    opts.extensions ?? [extension],
    runtime,
    rootReal,
    /* sessionManager stub */ {},
    /* modelRegistry stub */ {},
  );
  if (!opts.skipBind) runner.bindCore(extensionActions, extensionContextActions);
  return { extension, runtime, runner };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

// ---- 1. event subscription semantics (upstream #8967 battery) ---------------
{
  // 1a. self-removal does not skip neighboring handlers
  const calls = [];
  const { runner } = await loadRunner((pi) => {
    const unsubscribe = pi.on("agent_end", () => {
      calls.push("A");
      unsubscribe();
    });
    pi.on("agent_end", () => {
      calls.push("B");
    });
  });
  await runner.emit({ type: "agent_end", messages: [] });
  const afterFirst = [...calls];
  await runner.emit({ type: "agent_end", messages: [] });
  add("subscription_self_removal", { afterFirst, afterSecond: calls });

  // 1b. duplicate registrations removed independently; cleanup of last handler
  const calls2 = [];
  const unsubscribers = [];
  const { extension, runner: runner2 } = await loadRunner((pi) => {
    const shared = () => {
      calls2.push("shared");
    };
    unsubscribers.push(pi.on("agent_end", shared));
    unsubscribers.push(
      pi.on("agent_end", () => {
        calls2.push("B");
      }),
    );
    unsubscribers.push(pi.on("agent_end", shared));
  });
  const [stopFirst, stopB, stopSecond] = unsubscribers;
  stopSecond();
  stopSecond();
  await runner2.emit({ type: "agent_end", messages: [] });
  const s1 = [...calls2];
  stopFirst();
  await runner2.emit({ type: "agent_end", messages: [] });
  const s2 = [...calls2];
  stopB();
  add("subscription_duplicate_removal", { s1, s2, handlersMapCleared: !extension.handlers.has("agent_end") });

  // 1c. removal of a pending handler keeps it in the current dispatch
  const calls3 = [];
  const { runner: runner3 } = await loadRunner((pi) => {
    pi.on("agent_end", () => {
      calls3.push("A");
      stopB3();
    });
    const stopB3 = pi.on("agent_end", () => {
      calls3.push("B");
    });
    pi.on("agent_end", () => {
      calls3.push("C");
    });
  });
  await runner3.emit({ type: "agent_end", messages: [] });
  const first3 = [...calls3];
  await runner3.emit({ type: "agent_end", messages: [] });
  add("subscription_removed_pending", { first3, second: calls3 });

  // 1d. registrations during dispatch defer to next dispatch
  const calls4 = [];
  const { runner: runner4 } = await loadRunner((pi) => {
    pi.on("agent_end", () => {
      calls4.push("A");
      pi.on("agent_end", () => {
        calls4.push("C");
      });
    });
    pi.on("agent_end", () => {
      calls4.push("B");
    });
  });
  await runner4.emit({ type: "agent_end", messages: [] });
  const first4 = [...calls4];
  await runner4.emit({ type: "agent_end", messages: [] });
  add("subscription_deferred_registration", { first4, second: calls4 });

  // 1e. nested dispatch uses a fresh handler list
  const calls5 = [];
  const { runner: runner5 } = await loadRunner((pi) => {
    const stopA = pi.on("agent_end", async () => {
      calls5.push("A");
      stopA();
      stopB5();
      pi.on("agent_end", () => {
        calls5.push("C");
      });
      await runner5.emit({ type: "agent_end", messages: [] });
    });
    const stopB5 = pi.on("agent_end", () => {
      calls5.push("B");
    });
  });
  await runner5.emit({ type: "agent_end", messages: [] });
  add("subscription_nested_dispatch", { calls: calls5 });
}

// ---- 2. hasHandlers ----------------------------------------------------------
{
  const empty = await loadRunner(() => {});
  const withHandler = await loadRunner((pi) => pi.on("tool_call", async () => undefined));
  add("has_handlers", {
    empty: empty.runner.hasHandlers("tool_call"),
    withHandler: withHandler.runner.hasHandlers("tool_call"),
    otherEvent: withHandler.runner.hasHandlers("agent_end"),
  });
}

// ---- 3. tool collection -------------------------------------------------------
{
  const mkTool = (name, description) => (pi) =>
    pi.registerTool({
      name,
      label: name,
      description,
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
  const a = await loadRunner(mkTool("tool_a", "a"));
  const b = await loadRunner(mkTool("tool_b", "b"));
  const shared1 = await loadRunner(mkTool("shared", "first"), { extensionPath: "<a-first>" });
  const shared2 = await loadRunner(mkTool("shared", "second"), { extensionPath: "<b-second>" });
  const combined = new ExtensionRunner(
    [...shared1.extension ? [shared1.extension] : [], shared2.extension],
    shared2.runtime,
    rootReal,
    {},
    {},
  );
  const tools = combined.getAllRegisteredTools();
  const noParams = (t) => ({ name: t.definition.name, description: t.definition.description });
  add("tool_collection", {
    two_tools: [a.runner.getAllRegisteredTools(), b.runner.getAllRegisteredTools()].map((l) => l.map(noParams)),
    first_wins: tools.map(noParams),
    by_name: (() => {
      const d = combined.getToolDefinition("shared");
      return { name: d?.name, description: d?.description };
    })(),
    missing: combined.getToolDefinition("nope"),
  });
}

// ---- 4. command collection ----------------------------------------------------
{
  const mkCmd = (name, description) => (pi) => pi.registerCommand(name, { description, handler: async () => {} });
  const unique = await loadRunner(mkCmd("unique", "Only one"));
  // duplicates across extensions, in insertion order
  const a = await loadRunner(mkCmd("shared-cmd", "First command"), { extensionPath: "<cmd-a>" });
  const b = await loadRunner(mkCmd("shared-cmd", "Second command"), { extensionPath: "<cmd-b>" });
  const c = await loadRunner(mkCmd("shared-cmd", "Third command"), { extensionPath: "<cmd-c>" });
  // a duplicate whose natural suffix is already taken by another command name
  const x = await loadRunner(mkCmd("collide", "A"), { extensionPath: "<collide-a>" });
  const y = await loadRunner(mkCmd("collide:2", "fake"), { extensionPath: "<collide-fake>" });
  const z = await loadRunner(mkCmd("collide", "B"), { extensionPath: "<collide-b>" });
  const runner = new ExtensionRunner(
    [unique.extension, a.extension, b.extension, c.extension, x.extension, y.extension, z.extension],
    unique.runtime,
    rootReal,
    {},
    {},
  );
  const commands = runner.getRegisteredCommands();
  add("command_invocation_names", {
    resolved: commands.map((cmd) => ({ name: cmd.name, invocationName: cmd.invocationName, description: cmd.description })),
    diagnostics: runner.getCommandDiagnostics(),
    lookup1: runner.getCommand("shared-cmd:1")?.description,
    lookup2: runner.getCommand("shared-cmd:2")?.description,
    lookup3: runner.getCommand("shared-cmd:3")?.description,
    lookupCollide: runner.getCommand("collide")?.description,
    lookupCollide2: runner.getCommand("collide:2")?.description,
    lookupCollide3: runner.getCommand("collide:3")?.description,
    lookupMissing: runner.getCommand("shared-cmd") ?? "<undefined>",
  });
}

// ---- 5. shortcut conflicts -----------------------------------------------------
{
  const defaultKeybindings = [
    ["app.clipboard.pasteImage", "ctrl+v"],
    ["app.model.cycleForward", "ctrl+p"],
    ["app.interrupt", "ctrl+c"],
    ["app.clear", "ctrl+l"],
  ];
  const baseConfig = Object.fromEntries(defaultKeybindings);
  const mk = (key) => (pi) => pi.registerShortcut(key, { description: "ext shortcut", handler: async () => {} });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  const keyOf = (m) => [...m.keys()];
  const describe = async (factories, config) => {
    warns.length = 0;
    const loaded = [];
    for (const factory of factories) {
      loaded.push((await loadRunner(factory)).extension);
    }
    const runtime = createExtensionRuntime();
    const runner = new ExtensionRunner(loaded, runtime, rootReal, {}, {});
    runner.bindCore(extensionActions, extensionContextActions);
    const shortcuts = runner.getShortcuts(config);
    return {
      keys: keyOf(shortcuts),
      descriptions: [...shortcuts.values()].map((s) => s.description),
      warns: [...warns],
      diagnostics: runner.getShortcutDiagnostics().map((d) => ({ type: d.type, message: d.message, path: d.path })),
    };
  };

  const reserved = await describe([mk("ctrl+x")], { "app.interrupt": "ctrl+x" });
  const nonReserved = await describe([mk("ctrl+v")], baseConfig);
  const rebound = await describe([mk("ctrl+p")], { ...baseConfig, "app.model.cycleForward": "ctrl+n" });
  const reboundReserved = await describe([mk("ctrl+x")], { ...baseConfig, "app.interrupt": "ctrl+x" });
  const sharedReserved = await describe([mk("ctrl+p")], baseConfig);
  const multiReserved = await describe([mk("ctrl+y")], { ...baseConfig, "app.clear": ["ctrl+x", "ctrl+y"] });
  const multiNonReserved = await describe([mk("ctrl+y")], {
    ...baseConfig,
    "app.clipboard.pasteImage": ["ctrl+x", "ctrl+y"],
  });
  const dupe = await describe(
    [
      (pi) => pi.registerShortcut("ctrl+shift+x", { description: "First extension", handler: async () => {} }),
      (pi) => pi.registerShortcut("ctrl+shift+x", { description: "Second extension", handler: async () => {} }),
    ],
    baseConfig,
  );
  console.warn = origWarn;
  add("shortcut_conflicts", { reserved, nonReserved, rebound, reboundReserved, sharedReserved, multiReserved, multiNonReserved, dupe });
}

// ---- 6. user_bash routing -------------------------------------------------------
{
  const throwsErrs = [];
  const { runner } = await loadRunner((pi) =>
    pi.on("user_bash", async () => {
      throw new Error("Routing failed");
    }),
  );
  runner.onError((e) => throwsErrs.push({ event: e.event, error: e.error }));
  let threw = "no-throw";
  try {
    await runner.emitUserBash({ type: "user_bash", command: "pwd", excludeFromContext: false, cwd: rootReal });
  } catch (e) {
    threw = e.message;
  }
  add("user_bash_throws", { threw, errors: throwsErrs });

  const invalidCases = {
    empty_object: {},
    null_operations: { operations: null },
    operations_without_exec: { operations: {} },
    null_result: { result: null },
    incomplete_result: { result: { output: "handled" } },
    operations_and_result: {
      operations: { exec: async () => ({ exitCode: 0 }) },
      result: { output: "handled", exitCode: 0, cancelled: false, truncated: false },
    },
  };
  const observed = [];
  for (const [label, result] of Object.entries(invalidCases)) {
    const errs = [];
    const r = await loadRunner((pi) => pi.on("user_bash", async () => result));
    r.runner.onError((e) => errs.push(e.error));
    let thrown = "no-throw";
    try {
      await r.runner.emitUserBash({ type: "user_bash", command: "pwd", excludeFromContext: false, cwd: rootReal });
    } catch (e) {
      thrown = e.message;
    }
    observed.push({ label, thrown, errorPrefix: errs[0]?.slice(0, 40) });
  }
  add("user_bash_invalid_results", observed);

  const valid = await loadRunner((pi) =>
    pi.on("user_bash", async (event) => {
      if (event.command === "operations") return { operations: { exec: async () => ({ exitCode: 0 }) } };
      return { result: { output: "handled", exitCode: 0, cancelled: false, truncated: false } };
    }),
  );
  const operations = await valid.runner.emitUserBash({ type: "user_bash", command: "operations", excludeFromContext: false, cwd: rootReal });
  const resultOverride = await valid.runner.emitUserBash({ type: "user_bash", command: "result", excludeFromContext: false, cwd: rootReal });
  const noHandlers = await loadRunner(() => {});
  const none = await noHandlers.runner.emitUserBash({ type: "user_bash", command: "x", excludeFromContext: false, cwd: rootReal });
  add("user_bash_valid_results", {
    operationsHasExec: typeof operations?.operations?.exec === "function",
    operationsKeys: Object.keys(operations ?? {}),
    resultOverride,
    none,
  });
}

// ---- 7. input event chaining -----------------------------------------------------
{
  const noHandler = await loadRunner(() => {});
  const a1 = await noHandler.runner.emitInput("x", undefined, "interactive");
  const undef = await loadRunner((pi) => pi.on("input", async () => {}));
  const a2 = await undef.runner.emitInput("x", undefined, "interactive");
  const cont = await loadRunner((pi) => pi.on("input", async () => ({ action: "continue" })));
  const a3 = await cont.runner.emitInput("x", undefined, "interactive");
  add("input_continue", [a1, a2, a3]);

  const images = [{ type: "image", data: "orig", mimeType: "image/png" }];
  const transformer = await loadRunner((pi) => pi.on("input", async (e) => ({ action: "transform", text: "T:" + e.text })));
  add("input_transform_preserves_images", { result: await transformer.runner.emitInput("hi", images, "interactive") });

  const replacer = await loadRunner((pi) =>
    pi.on("input", async () => ({ action: "transform", text: "X", images: [{ type: "image", data: "new", mimeType: "image/jpeg" }] })),
  );
  add("input_transform_replaces_images", { result: await replacer.runner.emitInput("hi", images, "interactive") });

  const chain = await loadRunner((pi) => {
    pi.on("input", async (e) => ({ action: "transform", text: e.text + "[1]" }));
    pi.on("input", async (e) => ({ action: "transform", text: e.text + "[2]" }));
  });
  add("input_chain", { result: await chain.runner.emitInput("X", undefined, "interactive") });

  globalThis.testVar = false;
  const handled = await loadRunner((pi) => {
    pi.on("input", async () => ({ action: "handled" }));
    pi.on("input", async () => {
      globalThis.testVar = true;
    });
  });
  const handledResult = await handled.runner.emitInput("X", undefined, "interactive");
  add("input_handled_short_circuit", { result: handledResult, secondRan: globalThis.testVar });

  const sources = await loadRunner((pi) =>
    pi.on("input", async (e) => {
      globalThis.testVar = e.source;
      return { action: "continue" };
    }),
  );
  const sourceObserved = [];
  for (const source of ["interactive", "rpc", "extension"]) {
    await sources.runner.emitInput("x", undefined, source);
    sourceObserved.push(globalThis.testVar);
  }
  const behaviors = await loadRunner((pi) =>
    pi.on("input", async (e) => {
      globalThis.testVar = e.streamingBehavior;
      return { action: "continue" };
    }),
  );
  await behaviors.runner.emitInput("x", undefined, "interactive", "steer");
  const behaviorObserved = [globalThis.testVar];
  await behaviors.runner.emitInput("x", undefined, "interactive", "followUp");
  behaviorObserved.push(globalThis.testVar);
  await behaviors.runner.emitInput("x", undefined, "interactive");
  behaviorObserved.push(globalThis.testVar);
  add("input_source_and_behavior", { sources: sourceObserved, behaviors: behaviorObserved });

  const boom = await loadRunner((pi) =>
    pi.on("input", async () => {
      throw new Error("boom");
    }),
  );
  const errs = [];
  boom.runner.onError((e) => errs.push(e.error));
  const boomResult = await boom.runner.emitInput("x", undefined, "interactive");
  add("input_error_isolation", { result: boomResult, errors: errs });
}

// ---- 8. tool_result chaining ------------------------------------------------------
{
  const { runner } = await loadRunner((pi) => {
    pi.on("tool_result", async (event) => ({ content: [...event.content, { type: "text", text: "ext1" }] }));
    pi.on("tool_result", async (event) => ({ content: [...event.content, { type: "text", text: "ext2" }] }));
  });
  const chained = await runner.emitToolResult({
    type: "tool_result",
    toolName: "my_tool",
    toolCallId: "call-1",
    input: {},
    content: [{ type: "text", text: "base" }],
    details: { initial: true },
    isError: false,
  });
  add("tool_result_chain_content", chained);

  const partial = await loadRunner((pi) => {
    pi.on("tool_result", async () => ({ content: [{ type: "text", text: "first" }], details: { source: "ext1" } }));
    pi.on("tool_result", async () => ({ isError: true }));
  });
  const patched = await partial.runner.emitToolResult({
    type: "tool_result",
    toolName: "my_tool",
    toolCallId: "call-2",
    input: {},
    content: [{ type: "text", text: "base" }],
    details: { initial: true },
    isError: false,
  });
  const untouched = await loadRunner(() => {});
  add("tool_result_partial_patch", {
    patched,
    noHandlers: await untouched.runner.emitToolResult({
      type: "tool_result",
      toolName: "t",
      toolCallId: "c",
      input: {},
      content: [{ type: "text", text: "x" }],
      details: undefined,
      isError: false,
    }),
  });
}

// ---- 9. context / provider payload / headers --------------------------------------
{
  const { runner } = await loadRunner((pi) => {
    pi.on("context", async (event) => ({ messages: [...event.messages, { role: "user", content: "injected" }] }));
    pi.on("context", async (event) => {
      if (event.messages.length > 1) throw new Error("ctx boom");
    });
  });
  const errs = [];
  runner.onError((e) => errs.push(e.error));
  const messages = await runner.emitContext([{ role: "user", content: "hi" }]);
  add("emit_context", { messages, errors: errs });

  const payload = await loadRunner((pi) => {
    pi.on("before_provider_request", async () => "first");
    pi.on("before_provider_request", async () => "second");
    pi.on("before_provider_request", async () => undefined);
  });
  add("emit_before_provider_request", { payload: await payload.runner.emitBeforeProviderRequest("start") });

  const headers = await loadRunner((pi) => {
    pi.on("before_provider_headers", (event) => {
      event.headers["X-Turn-Index"] = "3";
    });
  });
  add("emit_before_provider_headers", {
    headers: await headers.runner.emitBeforeProviderHeaders({ "User-Agent": "kimchi/1.0" }),
  });

  const mixed = await loadRunner((pi) => {
    pi.on("before_provider_headers", () => {
      throw new Error("header handler boom");
    });
    pi.on("before_provider_headers", (event) => {
      event.headers["X-Good"] = "yes";
    });
  });
  const headerErrs = [];
  mixed.runner.onError((e) => headerErrs.push({ event: e.event, error: e.error }));
  add("emit_before_provider_headers_mixed", {
    headers: await mixed.runner.emitBeforeProviderHeaders({ "User-Agent": "x" }),
    errors: headerErrs,
  });
}

// ---- 10. before_agent_start chaining ------------------------------------------------
{
  const { runner } = await loadRunner((pi) => {
    pi.on("before_agent_start", async (_event, ctx) => ({ systemPrompt: ctx.getSystemPrompt() + "\nfirst" }));
    pi.on("before_agent_start", async (_event, ctx) => ({ systemPrompt: ctx.getSystemPrompt() + "\nsecond" }));
  });
  const errs = [];
  runner.onError((e) => errs.push(e.error));
  const chained = await runner.emitBeforeAgentStart("hello", undefined, { cwd: rootReal, customPrompt: "base" });
  add("before_agent_start_chain", {
    messages: chained.messages,
    systemPrompt: buildSystemPrompt(chained.systemPromptOptions),
    forceSystemPrompt: chained.systemPromptOptions.forceSystemPrompt,
    selectedTools: chained.systemPromptOptions.selectedTools,
    errors: errs,
  });

  const withMessage = await loadRunner((pi) => {
    pi.on("before_agent_start", async () => ({ message: { customType: "note", content: "m", display: true, details: null } }));
  });
  const chained2 = await withMessage.runner.emitBeforeAgentStart("p", undefined, { cwd: rootReal });
  add("before_agent_start_message", { messages: chained2.messages });
}

// ---- 11. resources_discover ----------------------------------------------------------
{
  const { runner } = await loadRunner((pi) => {
    pi.on("resources_discover", async () => ({ skillPaths: ["s1", "s2"], promptPaths: ["p1"] }));
    pi.on("resources_discover", async () => ({ themePaths: ["t1"] }));
    pi.on("resources_discover", async () => {
      throw new Error("discover boom");
    });
  });
  const errs = [];
  runner.onError((e) => errs.push(e.error));
  const discovered = await runner.emitResourcesDiscover(rootReal, "startup");
  add("emit_resources_discover", {
    discovered: {
      skillPaths: discovered.skillPaths,
      promptPaths: discovered.promptPaths,
      themePaths: discovered.themePaths,
    },
    errors: errs,
  });
}

// ---- 12. session_before_switch / generic emit ----------------------------------------
{
  const cancel = await loadRunner((pi) => {
    pi.on("session_before_switch", async () => ({ cancel: true }));
    pi.on("session_before_switch", async () => ({ cancel: false }));
  });
  const cancelled = await cancel.runner.emit({ type: "session_before_switch", reason: "new" });
  const none = await loadRunner(() => {});
  add("emit_session_before_switch", {
    cancelled,
    none: await none.runner.emit({ type: "session_before_switch", reason: "resume", targetSessionFile: "x" }),
  });

  const tree = await loadRunner((pi) => {
    pi.on("session_before_tree", async () => ({ summary: { summary: "s", details: null, usage: undefined }, customInstructions: "ci" }));
  });
  add("emit_session_before_tree", {
    result: await tree.runner.emit({ type: "session_before_tree", preparation: { targetId: "t", oldLeafId: null, commonAncestorId: null, entriesToSummarize: [], userWantsSummary: true }, signal: undefined }),
  });
}

// ---- 13. message_end -------------------------------------------------------------------
{
  const good = await loadRunner((pi) => {
    pi.on("message_end", async (event) => ({ message: { ...event.message, content: "replaced" } }));
  });
  add("emit_message_end_replace", {
    result: await good.runner.emitMessageEnd({ type: "message_end", message: { role: "assistant", content: "orig" } }),
  });

  const roleMismatch = await loadRunner((pi) => {
    pi.on("message_end", async () => ({ message: { role: "user", content: "bad" } }));
    pi.on("message_end", async (event) => ({ message: { ...event.message, content: "ok" } }));
  });
  const errs = [];
  roleMismatch.runner.onError((e) => errs.push({ event: e.event, error: e.error }));
  add("emit_message_end_role_mismatch", {
    result: await roleMismatch.runner.emitMessageEnd({ type: "message_end", message: { role: "assistant", content: "orig" } }),
    errors: errs,
  });
}

// ---- 14. tool_call blocking --------------------------------------------------------------
{
  const { runner } = await loadRunner((pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName === "bash") event.input.command = "patched";
    });
    pi.on("tool_call", async () => undefined);
    pi.on("tool_call", async () => ({ block: true, reason: "nope", terminate: true }));
    pi.on("tool_call", async () => ({ block: false }));
  });
  const event = { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "orig" } };
  add("emit_tool_call_block", { result: await runner.emitToolCall(event), mutatedInput: event.input });

  const soft = await loadRunner((pi) => {
    pi.on("tool_call", async () => ({ block: false, reason: "soft" }));
  });
  add("emit_tool_call_soft", { result: await soft.runner.emitToolCall({ type: "tool_call", toolCallId: "c2", toolName: "read", input: {} }) });
}

// ---- 15. project_trust --------------------------------------------------------------------
{
  const undecidedPath = "<undecided>";
  const decidedPath = "<decided>";
  const undecided = await loadRunner((pi) => pi.on("project_trust", () => ({ trusted: "undecided", remember: true })), { extensionPath: undecidedPath });
  const decided = await loadRunner((pi) => pi.on("project_trust", () => ({ trusted: "no", remember: true })), { extensionPath: decidedPath });
  const both = new ExtensionRunner(
    [undecided.extension, decided.extension],
    decided.runtime,
    rootReal,
    {},
    {},
  );
  const result = await emitProjectTrustEvent(
    { extensions: both.extensions, runtime: both.runtime, errors: [] },
    { type: "project_trust", cwd: rootReal },
    {
      cwd: rootReal,
      mode: "tui",
      hasUI: false,
      ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: () => {} },
    },
  );
  const boomExt = await loadRunner((pi) =>
    pi.on("project_trust", () => {
      throw new Error("trust handler failed");
    }),
    { extensionPath: "<boom>" },
  );
  const errorResult = await emitProjectTrustEvent(
    { extensions: boomExt.extension ? [boomExt.extension] : [], runtime: boomExt.runtime, errors: [] },
    { type: "project_trust", cwd: rootReal },
    { cwd: rootReal, mode: "print", hasUI: false, ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: () => {} } },
  );
  add("project_trust", { result: { result: result.result, errors: result.errors }, errorResult });
}

// ---- 16. ui prompt nesting ------------------------------------------------------------------
{
  const uiEvents = [];
  const { runner } = await loadRunner((pi) => {
    pi.on("ui_prompt_start", (e) => uiEvents.push({ type: e.type, kind: e.kind, title: e.title }));
    pi.on("ui_prompt_end", (e) => uiEvents.push({ type: e.type, kind: e.kind, title: e.title }));
  });
  const calls = [];
  runner.setUIContext(
    {
      select: async (title, options) => {
        calls.push(`select:${title}:${options.join("|")}`);
        return options[0];
      },
      confirm: async (title, message) => {
        calls.push(`confirm:${title}:${message}`);
        return true;
      },
      input: async (title) => {
        calls.push(`input:${title}`);
        return "typed";
      },
      editor: async (title, prefill) => {
        calls.push(`editor:${title}:${prefill ?? ""}`);
        return "edited";
      },
      custom: async () => {
        calls.push("custom");
        return "custom-result";
      },
    },
    "tui",
  );
  const ctx = runner.createContext();
  await ctx.ui.select("Pick", ["a", "b"]);
  await ctx.ui.confirm("Sure?", "msg");
  await ctx.ui.input("Name", "ph");
  await ctx.ui.editor("Edit", "prefill");
  await ctx.ui.custom(() => {});
  // nested: prompt started inside another prompt only emits at outer boundary
  await ctx.ui.select("Outer", ["x"], {
    timeout: 0,
  });
  add("ui_prompt_events", { calls, uiEvents, hasUI: runner.hasUI(), mode: ctx.mode });
}

// ---- 17. context creation -------------------------------------------------------------------
{
  const { runner } = await loadRunner(() => {});
  const ctx = runner.createContext();
  runner.bindCore(extensionActions, {
    ...extensionContextActions,
    isProjectTrusted: () => false,
    getScopedModels: () => ["scoped"],
  });
  const controller = { aborted: false };
  runner.bindCore(extensionActions, {
    ...extensionContextActions,
    isProjectTrusted: () => false,
    getSignal: () => controller,
    getScopedModels: () => ["scoped"],
  });
  const ctx2 = runner.createContext();
  add("context_defaults", {
    modeBefore: ctx.mode,
    hasUIBefore: ctx.hasUI,
    mode: ctx2.mode,
    hasUI: ctx2.hasUI,
    isProjectTrusted: ctx2.isProjectTrusted(),
    scopedModels: ctx2.scopedModels,
    idle: ctx2.isIdle(),
    pendingMessages: ctx2.hasPendingMessages(),
    systemPromptDefault: ctx2.getSystemPrompt(),
    usage: ctx2.getContextUsage(),
  });
  runner.setUIContext({ select: async () => undefined }, "rpc");
  add("context_rpc_mode", { mode: runner.createContext().mode, hasUI: runner.createContext().hasUI });
  controller.aborted = true;
  add("context_signal_live", { aborted: runner.createContext().signal.aborted });
}

// ---- 18. invalidate / assertActive ------------------------------------------------------------
{
  const { runner } = await loadRunner(() => {});
  runner.invalidate("stale-after-replacement");
  let thrown = "no-throw";
  try {
    runner.createContext().ui;
  } catch (e) {
    thrown = e.message;
  }
  let thrownAbort = "no-throw";
  try {
    runner.createContext().abort();
  } catch (e) {
    thrownAbort = e.message;
  }
  const defaulted = await loadRunner(() => {});
  defaulted.runner.invalidate();
  let defaultThrown = "no-throw";
  try {
    defaulted.runner.getActiveTools();
  } catch (e) {
    defaultThrown = e.message.slice(0, 60);
  }
  add("invalidate_stale", { thrown, thrownAbort, defaultThrown, defaultLen: defaultThrown.length });
}

// ---- 19. bindCore provider flush + post-bind immediacy -----------------------------------------
{
  const runtime = createExtensionRuntime();
  runtime.registerProvider("broken-provider", { streamSimple: () => {} }, "/tmp/broken-extension.ts");
  const runner = new ExtensionRunner([], runtime, rootReal, {}, {});
  const errors = [];
  runner.onError((e) => errors.push(`${e.extensionPath}: ${e.error}|event=${e.event}`));
  const registryCalls = [];
  runner.bindCore(extensionActions, extensionContextActions, {
    registerProvider: (name, config) => {
      if (name === "broken-provider") {
        throw new Error(`Provider ${name}: "api" is required when registering streamSimple.`);
      }
      registryCalls.push(`register:${name}`);
    },
    registerNativeProvider: (provider) => registryCalls.push(`native:${provider.id}`),
    unregisterProvider: (name) => registryCalls.push(`unregister:${name}`),
  });
  runtime.registerProvider("instant-provider", { baseUrl: "https://x" });
  runtime.registerNativeProvider({ id: "native-x" });
  runtime.unregisterProvider("instant-provider");
  add("bind_core_provider_flush", { errors, registryCalls, pending: runtime.pendingProviderRegistrations.length });

  const runtime2 = createExtensionRuntime();
  const runner2 = new ExtensionRunner([], runtime2, rootReal, {}, {});
  const fallbackCalls = [];
  runner2.bindCore(extensionActions, extensionContextActions, {
    registerProvider: (name) => fallbackCalls.push(`register:${name}`),
    unregisterProvider: (name) => fallbackCalls.push(`unregister:${name}`),
  });
  runner2.shutdown();
  add("bind_core_fallback", { fallbackCalls });
}

// ---- 20. command context passthrough ------------------------------------------------------------
{
  const runtime = createExtensionRuntime();
  const runner = new ExtensionRunner([], runtime, rootReal, {}, {});
  const calls = [];
  runner.bindCommandContext({
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async (entryId, options) => {
      calls.push({ entryId, options });
      return { cancelled: false };
    },
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
  });
  const commandContext = runner.createCommandContext();
  await commandContext.fork("entry-1");
  await commandContext.fork("entry-2", { position: "at" });
  await commandContext.waitForIdle();
  // default (unbound) handlers report not-cancelled
  const runner2 = new ExtensionRunner([], createExtensionRuntime(), rootReal, {}, {});
  runner2.bindCommandContext();
  add("command_context_fork", {
    calls,
    defaultFork: await runner2.createCommandContext().fork("e"),
    defaultNewSession: await runner2.createCommandContext().newSession(),
  });
}

// ---- 21. session shutdown emission ---------------------------------------------------------------
{
  const none = await loadRunner(() => {});
  const noHandlers = await emitSessionShutdownEvent(none.runner, { type: "session_shutdown", reason: "quit" });
  const withH = await loadRunner((pi) => pi.on("session_shutdown", () => {}));
  const withHandlers = await emitSessionShutdownEvent(withH.runner, { type: "session_shutdown", reason: "reload", targetSessionFile: "x" });
  add("emit_session_shutdown", { noHandlers, withHandlers });
}

// ---- 22. flags / renderers / markdown transformers -------------------------------------------------
{
  const { runner, runtime } = await loadRunner((pi) => {
    pi.registerFlag("my-flag", { description: "My flag", type: "boolean" });
    pi.registerMessageRenderer("my-type", () => null);
    pi.registerEntryRenderer("my-entry", () => null);
    pi.registerMarkdownTransformer((markdown) => markdown);
  });
  runner.setFlagValue("--test-flag", true);
  add("flags_and_renderers", {
    flags: [...runner.getFlags().keys()],
    flagValue: runtime.flagValues.get("--test-flag"),
    flagValuesSnapshot: Object.fromEntries(runner.getFlagValues()),
    messageRenderer: runner.getMessageRenderer("my-type") !== undefined,
    messageRendererMissing: runner.getMessageRenderer("nope") !== undefined,
    entryRenderer: runner.getEntryRenderer("my-entry") !== undefined,
    entryRendererMissing: runner.getEntryRenderer("nope") !== undefined,
    transformers: runner.getMarkdownTransformers().length,
    extensionPaths: runner.getExtensionPaths(),
  });
}

fs.rmSync(rootReal, { recursive: true, force: true });
const target = new URL("./runner.oracle.json", import.meta.url);
fs.writeFileSync(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
console.log("wrote", decodeURIComponent(target.pathname), "scenarios:", out.scenarios.length);
