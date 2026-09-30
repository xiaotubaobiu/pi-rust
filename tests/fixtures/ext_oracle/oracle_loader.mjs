// Oracle capture: upstream coding-agent extension loader under node
// (type stripping). The captured sources are verbatim copies (sha256 in port
// report); only the module graph around them is stubbed — see the file
// headers in ./src for seams O-1..O-3. Every captured string has the fixture
// root replaced by "<root>" so the capture is machine-independent.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const { createExtensionRuntime, loadExtensionFromFactory, loadExtensions, discoverAndLoadExtensions } = await import(
  new URL("./src/core/extensions/loader.ts", import.meta.url)
);
const { readPiManifest } = await import(new URL("./src/core/pi-manifest.ts", import.meta.url));
const { createEventBus } = await import(new URL("./src/core/event-bus.ts", import.meta.url));

const rootReal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-oracle-"));
const rootFwd = rootReal.replaceAll("\\", "/");
const deepRel = (v) => {
  if (typeof v === "string") return v.split(rootReal).join("<root>").split(rootFwd).join("<root>");
  if (Array.isArray(v)) return v.map(deepRel);
  if (v instanceof Map) return deepRel(Object.fromEntries(v));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, deepRel(val)]));
  return v;
};
const out = { scenarios: [] };
const add = (name, observed) => out.scenarios.push({ name, observed: deepRel(observed) });
const json = (v) => JSON.parse(JSON.stringify(v, (_k, val) => (val instanceof Map ? Object.fromEntries(val) : val)));
const rel = (p) => p.replaceAll("\\", "/").replace(rootFwd + "/", "");
process.env.PI_CODING_AGENT_DIR = path.join(rootReal, "agent");
globalThis.__extFactoryRegistry = {};

// ---- 1. createExtensionRuntime stubs ---------------------------------------
{
  const runtime = createExtensionRuntime();
  const throws = [];
  for (const [name, fn] of Object.entries({
    sendMessage: runtime.sendMessage,
    appendEntry: runtime.appendEntry,
    setSessionName: runtime.setSessionName,
    getSessionName: runtime.getSessionName,
    setLabel: runtime.setLabel,
    getActiveTools: runtime.getActiveTools,
    getAllTools: runtime.getAllTools,
    setActiveTools: runtime.setActiveTools,
    getCommands: runtime.getCommands,
    getThinkingLevel: runtime.getThinkingLevel,
    setThinkingLevel: runtime.setThinkingLevel,
  })) {
    try {
      fn();
      throws.push(`${name}: no-throw`);
    } catch (e) {
      throws.push(`${name}: ${e.message}`);
    }
  }
  const setModelRejection = await runtime.setModel({ id: "m" }).then(
    () => "resolved",
    (e) => `rejected: ${e.message}`,
  );
  runtime.refreshTools();
  throws.push(`refreshTools: ok`, `setModel: ${setModelRejection}`);
  throws.push(`flagValues: ${JSON.stringify(Object.fromEntries(runtime.flagValues))}`);
  add("runtime_stubs_throw", throws);

  const r2 = createExtensionRuntime();
  r2.invalidate();
  const first = (() => {
    try {
      r2.assertActive();
      return "no-throw";
    } catch (e) {
      return e.message;
    }
  })();
  r2.invalidate("second message");
  const second = (() => {
    try {
      r2.assertActive();
      return "no-throw";
    } catch (e) {
      return e.message;
    }
  })();
  add("runtime_invalidate_default_message", { first, second, first_is_default: first.length > 100 });

  const r3 = createExtensionRuntime();
  const calls = [];
  const bus = createEventBus();
  const tracked = r3.trackEventBusSubscription(bus.on("ch", () => calls.push("tracked")));
  const direct = r3.trackEventBusSubscription(bus.on("ch", () => calls.push("direct")));
  r3.invalidate("stale");
  tracked();
  direct();
  tracked();
  add("runtime_track_event_bus", { callsAfterInvalidateAndUnsub: calls });
}

// ---- 2. loader lifecycle ----------------------------------------------------
// 2a. flag default type mismatch fails the load with wrapped error text.
{
  const runtime = createExtensionRuntime();
  const p = path.join(rootReal, "bad-flag-default.ts");
  globalThis.__extFactoryRegistry[p] = (pi) => pi.registerFlag("safe-mode", { type: "boolean", default: "false" });
  const result = await loadExtensions([p], rootReal);
  add("flag_default_mismatch", { errors: result.errors });
  add("flag_default_mismatch_flagvalues", { flagValues: Object.fromEntries(result.runtime.flagValues) });
}

// 2b. registerTool parameter schema validation.
{
  const mk = (params) => (pi) =>
    pi.registerTool({ name: "noop", label: "No-op", description: "Do nothing", parameters: params, execute: async () => ({}) });
  const cases = [["undefined", undefined], ["array", []], ["null", null], ["string", "nope"]];
  const observed = [];
  for (const [label, params] of cases) {
    const p = path.join(rootReal, `missing-params-${label}.ts`);
    globalThis.__extFactoryRegistry[p] = mk(params);
    const result = await loadExtensions([p], rootReal);
    observed.push({ label, errors: result.errors });
  }
  add("tool_parameter_schema_validation", observed);
}

// 2c. getFlag during load sees pending defaults; commit applies them.
{
  const bus = makeBus();
  const runtime = createExtensionRuntime();
  const seen = {};
  const p = path.join(rootReal, "flags.ts");
  globalThis.__extFactoryRegistry[p] = (pi) => {
    pi.registerFlag("with-default", { type: "boolean", default: true });
    pi.registerFlag("string-default", { type: "string", default: "dflt" });
    pi.registerFlag("no-default", { type: "boolean" });
    seen.duringLoad = {
      withDefault: pi.getFlag("with-default"),
      noDefault: pi.getFlag("no-default"),
      unknown: pi.getFlag("unknown"),
    };
    seen.flagValuesDuringLoad = Object.fromEntries(runtime.flagValues);
  };
  await loadExtensionFromFactory(globalThis.__extFactoryRegistry[p], rootReal, bus, runtime);
  seen.afterCommit = {
    withDefault: runtime.flagValues.get("with-default"),
    stringDefault: runtime.flagValues.get("string-default"),
    noDefault: runtime.flagValues.has("no-default"),
  };
  add("flag_lifecycle", seen);
}

// 2d. factory throwing fails the load.
{
  const p = path.join(rootReal, "throws.ts");
  globalThis.__extFactoryRegistry[p] = () => {
    throw new Error("Initialization failed!");
  };
  const result = await loadExtensions([p], rootReal);
  add("factory_throws", { errors: result.errors });
}

// 2e. non-factory export.
{
  const p = path.join(rootReal, "no-default.ts");
  globalThis.__extFactoryRegistry[p] = 42;
  const result = await loadExtensions([p], rootReal);
  add("non_factory_export", { errors: result.errors });
}

// 2f. provider queueing during load, unregister filtering, discard rollback.
{
  const bus = makeBus();
  const runtime = createExtensionRuntime();
  const busCalls = [];
  const queued = {};
  const okPath = path.join(rootReal, "providers-ok.ts");
  const failPath = path.join(rootReal, "providers-fail.ts");
  globalThis.__extFactoryRegistry[okPath] = (pi) => {
    pi.registerProvider("queued-provider", { baseUrl: "https://x.test" });
    pi.registerProvider({ id: "native-provider" });
    pi.unregisterProvider("queued-provider");
    pi.registerProvider("kept-provider", { baseUrl: "https://y.test" });
    pi.events.on("bus-chan", () => busCalls.push("ok"));
  };
  globalThis.__extFactoryRegistry[failPath] = (pi) => {
    pi.registerProvider("doomed-provider", { baseUrl: "https://z.test" });
    pi.events.on("bus-chan", () => busCalls.push("doomed"));
    throw new Error("discard me");
  };
  await loadExtensionFromFactory(globalThis.__extFactoryRegistry[okPath], rootReal, bus, runtime);
  queued.committed = runtime.pendingProviderRegistrations.map((r) => ({ name: r.name, extensionPath: r.extensionPath }));
  queued.committedNative = runtime.pendingNativeProviderRegistrations.map((r) => ({ id: r.provider.id, extensionPath: r.extensionPath }));
  bus.emit("bus-chan", null);
  try {
    await loadExtensionFromFactory(globalThis.__extFactoryRegistry[failPath], rootReal, bus, createExtensionRuntime());
  } catch (e) {
    queued.discardRethrows = e.message;
  }
  bus.emit("bus-chan", null);
  add("provider_queueing", { ...queued, busCalls });
}

// 2g. failed extension API surface becomes inert with exact error text.
{
  const bus = makeBus();
  const runtime = createExtensionRuntime();
  const errs = [];
  const p = path.join(rootReal, "inert.ts");
  let captured;
  globalThis.__extFactoryRegistry[p] = async (pi) => {
    captured = pi;
    throw new Error("boom during load");
  };
  await loadExtensionFromFactory(globalThis.__extFactoryRegistry[p], rootReal, bus, runtime).catch(() => {});
  for (const attempt of [
    () => captured.registerCommand("x", { handler: async () => {} }),
    () => captured.getFlag("x"),
    () => captured.sendMessage({ customType: "t" }),
  ]) {
    try {
      attempt();
      errs.push("no-throw");
    } catch (e) {
      errs.push(e.message);
    }
  }
  add("failed_extension_api_inert", errs);
}

// 2h. stale runtime error text through a captured API.
{
  const bus = makeBus();
  const runtime = createExtensionRuntime();
  const errs = [];
  let captured;
  const p = path.join(rootReal, "stale.ts");
  globalThis.__extFactoryRegistry[p] = (pi) => {
    captured = pi;
  };
  await loadExtensionFromFactory(globalThis.__extFactoryRegistry[p], rootReal, bus, runtime);
  runtime.invalidate("stale-after-replacement");
  try {
    captured.sendMessage({ customType: "t" });
  } catch (e) {
    errs.push(e.message);
  }
  add("stale_extension_api", errs);
}

// ---- 3. createExtension source info synthesis -------------------------------
{
  const bus = makeBus();
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(() => {}, rootReal, bus, runtime);
  const localPath = path.join(rootReal, "sub", "local.ts");
  globalThis.__extFactoryRegistry[localPath] = () => {};
  const viaLoad = await loadExtensions([localPath], rootReal);
  add("source_info", {
    inline: { ...extension.sourceInfo, baseDir: extension.sourceInfo.baseDir === undefined ? "<undefined>" : extension.sourceInfo.baseDir },
    local: viaLoad.extensions[0].sourceInfo,
  });
}

// ---- 4. readPiManifest battery ----------------------------------------------
{
  const cases = {
    pi_extensions: { name: "x", pi: { extensions: ["./a.ts", "b.js"], skills: ["s"], prompts: ["p"], themes: ["t"] } },
    no_pi_field: { name: "x", version: "1.0.0" },
    pi_not_object: { pi: "nope" },
    non_string_entries: { pi: { extensions: ["ok", 42] } },
    empty_entries: { pi: { extensions: [] } },
    non_array_entries: { pi: { extensions: "a.ts" } },
  };
  const observed = {};
  for (const [label, body] of Object.entries(cases)) {
    const p = path.join(rootReal, `manifest-${label}.json`);
    fs.writeFileSync(p, JSON.stringify(body));
    observed[label] = readPiManifest(p);
  }
  const bomPath = path.join(rootReal, "manifest-bom.json");
  fs.writeFileSync(bomPath, "\uFEFF" + JSON.stringify({ pi: { extensions: ["bom.ts"] } }));
  observed.bom = readPiManifest(bomPath);
  observed.missing_file = readPiManifest(path.join(rootReal, "manifest-does-not-exist.json"));
  const badPath = path.join(rootReal, "manifest-bad.json");
  fs.writeFileSync(badPath, "{not json");
  observed.bad_json = readPiManifest(badPath);
  add("read_pi_manifest", observed);
}

// ---- 5. discovery battery ----------------------------------------------------
{
  const ext = `export default function(pi) { pi.registerCommand("test", { handler: async () => {} }); }`;
  const mk = (dir, files) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const p = path.join(dir, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  };
  const d1 = path.join(rootReal, "fixtures", "mixed", "extensions");
  mk(d1, {
    "direct.ts": ext,
    "foo.ts": ext,
    "bar.ts": ext,
    "with-index/index.ts": ext,
    "with-index/index.js": ext,
    "with-manifest/package.json": JSON.stringify({ pi: { extensions: ["./entry.ts"] } }),
    "with-manifest/entry.ts": ext,
    "not-an-extension/helper.ts": ext,
    "container/nested/index.ts": ext,
  });
  const d2 = path.join(rootReal, "fixtures", "manifests", "extensions");
  mk(d2, {
    "precedence/index.ts": ext,
    "precedence/custom.ts": ext,
    "precedence/package.json": JSON.stringify({ name: "p", pi: { extensions: ["./custom.ts"] } }),
    "multi/package.json": JSON.stringify({ pi: { extensions: ["./ext1.ts", "./ext2.ts"] } }),
    "multi/ext1.ts": ext,
    "multi/ext2.ts": ext,
    "no-pi-field/index.ts": ext,
    "no-pi-field/package.json": JSON.stringify({ version: "1.0.0" }),
    "skip-missing/package.json": JSON.stringify({ pi: { extensions: ["./exists.ts", "./missing.ts"] } }),
    "skip-missing/exists.ts": ext,
    "tilde/package.json": JSON.stringify({ pi: { extensions: ["~entry.ts", "~/entry.ts"] } }),
    "tilde/~entry.ts": ext,
    "tilde/~/entry.ts": ext,
  });
  const observed = {};
  for (const [label, extDir] of [["mixed", d1], ["manifests", d2]]) {
    for (const f of listFiles(extDir)) globalThis.__extFactoryRegistry[f] = () => {};
    // discoverAndLoadExtensions scans `<agentDir>/extensions`, so the agent
    // dir is the fixtures parent, matching the upstream suites' layout.
    const result = await discoverAndLoadExtensions([], path.join(rootReal, "empty-cwd"), path.dirname(extDir));
    observed[label] = {
      // Unsorted: pins the OS readdir discovery order.
      paths: result.extensions.map((e) => rel(e.path)),
      errors: result.errors,
    };
  }
  add("discovery_battery", observed);
}

// ---- 6. discoverAndLoadExtensions pipeline (local + global + configured) ----
{
  const cwd = path.join(rootReal, "project");
  const agentDir = path.join(rootReal, "agent2");
  const ext = `export default function(pi) { pi.registerCommand("test", { handler: async () => {} }); }`;
  fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "extensions", "local.ts"), ext);
  fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "extensions", "global.ts"), ext);
  fs.writeFileSync(path.join(cwd, "explicit.ts"), ext);
  fs.mkdirSync(path.join(cwd, "explicit-dir"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "explicit-dir", "index.ts"), ext);
  for (const f of [
    path.join(cwd, ".pi", "extensions", "local.ts"),
    path.join(agentDir, "extensions", "global.ts"),
    path.join(cwd, "explicit.ts"),
    path.join(cwd, "explicit-dir", "index.ts"),
  ]) {
    globalThis.__extFactoryRegistry[f] = () => {};
  }
  const result = await discoverAndLoadExtensions(
    [path.join(cwd, "explicit.ts"), path.join(cwd, "explicit.ts"), path.join(cwd, "explicit-dir"), "./relative-missing.ts"],
    cwd,
    agentDir,
  );
  add("discover_pipeline", {
    order: result.extensions.map((e) => rel(e.path)),
    errors: result.errors.map((e) => rel(e.path)),
  });
}

function listFiles(dir) {
  const acc = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else acc.push(p);
    }
  };
  walk(dir);
  return acc;
}

function makeBus() {
  return createEventBus();
}

fs.rmSync(rootReal, { recursive: true, force: true });
const target = new URL("./loader.oracle.json", import.meta.url);
fs.writeFileSync(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
console.log("wrote", decodeURIComponent(target.pathname), "scenarios:", out.scenarios.length);
