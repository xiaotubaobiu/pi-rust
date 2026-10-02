// Oracle driver: upstream coding-agent src/core/virtual-models.ts (HEAD
// 2bbfcca43, v0.99.1) under `node --experimental-strip-types`. Sources are
// verbatim upstream copies (see ./src, SHA-pinned in manifest.json); the
// `@earendil-works/pi-ai` import resolves to the stub package re-exporting
// the verbatim isModelType/lazyStream sources.
//
// Pins:
// - createVirtualModel catalog entries over the definition grid (canonical
//   JSON: thinkingLevelMap keys are SORTED on capture because the Rust
//   ThinkingLevelMap is a BTreeMap — the entry set is identical, only object
//   key order is canonicalized),
// - isVirtualModel over models and assistant messages,
// - findLatestResponse over mixed branches,
// - getBranchSelection per the model_change/assistant grid (including the
//   unregistered-virtual fallback),
// - getVirtualModelState over pi.virtual-model-state custom entries,
// - the pi.virtual-model-state custom-entry JSON schema (key order),
// - withVirtualModels: keyless provider (auth literal, catalog, unrouted
//   stream error) and the wrapped-provider grid (id hiding, filterModels/
//   filterAllModels composition, stream interception).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { createVirtualModel, isVirtualModel, findLatestResponse, getBranchSelection, getVirtualModelState, withVirtualModels } =
  await import(new URL("./src/core/virtual-models.ts", import.meta.url).href);

const out = { scenarios: [] };
const json = (v) => JSON.parse(JSON.stringify(v));

// Canonicalize only `thinkingLevelMap` object keys (the Rust ThinkingLevelMap
// is a BTreeMap: identical entry set, sorted key order). Every other object
// keeps its insertion order — the pin.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out2 = {};
    for (const key of Object.keys(v)) {
      const value = v[key];
      out2[key] =
        key === "thinkingLevelMap" && value && typeof value === "object"
          ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]))
          : canonical(value);
    }
    return out2;
  }
  return v;
}
const add = (name, observed) => out.scenarios.push({ name, observed: canonical(json(observed)) });

// A physically-complete chat model fixture.
const physicalModel = (provider, id, extra = {}) => ({
  id,
  name: `Name ${id}`,
  api: "openai-completions",
  provider,
  baseUrl: "https://api.example.com/v1",
  reasoning: false,
  thinkingLevelMap: { off: null },
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  contextWindow: 8192,
  maxTokens: 1024,
  ...extra,
});
const virtualModel = (provider, id, extra = {}) => ({
  ...createVirtualModel({ provider, id, name: `Virtual ${id}`, ...extra }),
});

// ---------------------------------------------------------------------------
// createVirtualModel grid
// ---------------------------------------------------------------------------
{
  const cases = {
    defaults: { provider: "llama.cpp", id: "auto", name: "Auto" },
    thinkingLevels_subset: { provider: "p", id: "m", name: "M", thinkingLevels: ["off", "medium", "max"] },
    thinkingLevels_all: {
      provider: "p",
      id: "m",
      name: "M",
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    },
    thinkingLevels_unknown: { provider: "p", id: "m", name: "M", thinkingLevels: ["medium"] },
    limits: { provider: "p", id: "m", name: "M", contextWindow: 1000, maxTokens: 100 },
    input_text_only: { provider: "p", id: "m", name: "M", input: ["text"] },
  };
  add("create_virtual_model_grid", Object.fromEntries(Object.entries(cases).map(([name, def]) => [name, createVirtualModel(def)])));
}

// ---------------------------------------------------------------------------
// isVirtualModel
// ---------------------------------------------------------------------------
{
  add("is_virtual_model", {
    virtualModel: isVirtualModel(virtualModel("p", "v")),
    physicalModel: isVirtualModel(physicalModel("p", "gpt")),
    assistantVirtual: isVirtualModel({
      role: "assistant",
      content: [],
      api: "pi-virtual",
      provider: "p",
      model: "v",
      usage: {},
      stopReason: "stop",
      timestamp: 1,
    }),
    assistantPhysical: isVirtualModel({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude",
      usage: {},
      stopReason: "stop",
      timestamp: 1,
    }),
  });
}

// ---------------------------------------------------------------------------
// findLatestResponse
// ---------------------------------------------------------------------------
{
  // Full wire-shape messages so the Rust side reconstructs byte-identical
  // inputs through serde.
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (stopReason, extra = {}) => ({
    role: "assistant",
    content: [],
    api: "api",
    provider: "p",
    model: "m",
    usage,
    stopReason,
    timestamp: 1,
    ...extra,
  });
  const user = { role: "user", content: "hi", timestamp: 1 };
  const toolResult = {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text: "x" }],
    details: {},
    isError: false,
    timestamp: 2,
  };
  const branch = [
    user,
    assistant("error", { errorMessage: "boom" }),
    assistant("aborted"),
    toolResult,
    assistant("toolUse"),
    assistant("stop", { model: "final" }),
  ];
  add("find_latest_response", {
    mixed: findLatestResponse(branch),
    empty: findLatestResponse([]),
    onlyFailures: findLatestResponse([assistant("error"), assistant("aborted")]),
    firstWins: findLatestResponse([assistant("stop", { model: "first" }), user]),
  });
}

// ---------------------------------------------------------------------------
// Session entry builders (JSONL-shaped; types only matter where read)
// ---------------------------------------------------------------------------
const entry = (type, fields) => ({ type, ...fields });
const messageEntry = (id, message) => entry("message", { id, parentId: null, timestamp: `t-${id}`, message });
const modelChangeEntry = (id, provider, modelId) =>
  entry("model_change", { id, parentId: null, timestamp: `t-${id}`, provider, modelId });
const stateEntry = (id, provider, modelId, state) =>
  entry("custom", {
    customType: "pi.virtual-model-state",
    data: { provider, modelId, state },
    id,
    parentId: null,
    timestamp: `t-${id}`,
  });

// ---------------------------------------------------------------------------
// getBranchSelection grid
// ---------------------------------------------------------------------------
{
  const catalog = {
    getModel: (provider, modelId) => {
      if (provider === "p" && modelId === "virtual") return virtualModel(provider, modelId);
      if (provider === "p" && modelId === "physical") return physicalModel(provider, modelId);
      return undefined;
    },
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (provider, model) => ({
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider,
    model,
    usage,
    stopReason: "stop",
    timestamp: 1,
  });
  const cases = {
    empty_branch: [],
    only_user: [messageEntry("u1", { role: "user", content: "hi", timestamp: 1 })],
    physical_response: [
      messageEntry("m1", assistant("p", "physical")),
      messageEntry("m2", assistant("other", "model")),
    ],
    model_change_last: [messageEntry("m1", assistant("p", "physical")), modelChangeEntry("c1", "p", "physical")],
    virtual_model_change_holds: [
      messageEntry("m1", assistant("p", "physical")),
      modelChangeEntry("c1", "p", "virtual"),
      messageEntry("m2", assistant("p", "physical")),
    ],
    virtual_model_change_unregistered: [
      messageEntry("m1", assistant("p", "physical")),
      modelChangeEntry("c1", "p", "gone"),
      messageEntry("m2", assistant("p", "physical")),
    ],
    virtual_assistant_skipped: [
      modelChangeEntry("c1", "p", "virtual"),
      messageEntry("m1", assistant("p", "virtual")),
      messageEntry("m2", assistant("p", "physical")),
    ],
    earliest_model_change_wins_over_later_virtual_change: [
      modelChangeEntry("c1", "p", "virtual"),
      messageEntry("m1", assistant("p", "physical")),
      modelChangeEntry("c2", "other", "physical"),
      messageEntry("m2", assistant("p", "physical")),
    ],
  };
  add("get_branch_selection_grid", Object.fromEntries(Object.entries(cases).map(([name, branch]) => [name, getBranchSelection(branch, catalog.getModel)])));
}

// ---------------------------------------------------------------------------
// getVirtualModelState grid
// ---------------------------------------------------------------------------
{
  const branch = [
    stateEntry("s1", "p", "virtual", { tier: "fast" }),
    stateEntry("s2", "p", "other", { tier: "nope" }),
    entry("custom", { customType: "pi.other", data: { provider: "p", modelId: "virtual", state: "x" }, id: "s3", parentId: null, timestamp: "t" }),
    entry("custom", { customType: "pi.virtual-model-state", id: "s4", parentId: null, timestamp: "t" }),
    entry("custom", { customType: "pi.virtual-model-state", data: { provider: 42, modelId: "virtual", state: "bad" }, id: "s5", parentId: null, timestamp: "t" }),
    stateEntry("s6", "p", "virtual", { tier: "newest" }),
  ];
  add("get_virtual_model_state_grid", {
    match: getVirtualModelState(branch, "p", "virtual"),
    other_model: getVirtualModelState(branch, "p", "other"),
    unknown: getVirtualModelState(branch, "p", "gone"),
    empty_branch: getVirtualModelState([], "p", "virtual"),
  });
}

// ---------------------------------------------------------------------------
// pi.virtual-model-state custom entry JSON schema (key order)
// ---------------------------------------------------------------------------
{
  const customEntry = stateEntry("s1", "p", "virtual", { tier: "fast", note: null });
  add("state_entry_json_schema", {
    entryKeyOrder: Object.keys(customEntry),
    dataKeyOrder: Object.keys(customEntry.data),
    serialized: JSON.stringify(customEntry),
  });
}

// ---------------------------------------------------------------------------
// withVirtualModels — keyless provider
// ---------------------------------------------------------------------------
{
  const provider = withVirtualModels("llama.cpp", undefined, [
    virtualModel("llama.cpp", "auto", { thinkingLevels: ["off", "medium"], contextWindow: 8192 }),
    virtualModel("llama.cpp", "eco"),
  ]);
  const unrouted = provider.stream(virtualModel("llama.cpp", "auto"), { messages: [] }, {});
  const unroutedMessage = await unrouted.result();
  unroutedMessage.timestamp = "<timestamp>";
  add("with_virtual_models_keyless", {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: provider.getModels(),
    getAllModelsUndefined: provider.getAllModels == null,
    auth: {
      hasApiKey: Boolean(provider.auth?.apiKey),
      apiKeyName: provider.auth?.apiKey?.name,
      resolve: json(await provider.auth.apiKey.resolve({})),
    },
    filterModelsUndefined: provider.filterModels == null,
    filterAllModelsUndefined: provider.filterAllModels == null,
    unroutedMessage,
  });
}

// ---------------------------------------------------------------------------
// withVirtualModels — wrapped provider grid
// ---------------------------------------------------------------------------
{
  const makeProvider = (overrides = {}) => ({
    id: "p",
    name: "Provider P",
    baseUrl: "https://p.example.com",
    headers: { "x-provider": "1" },
    auth: { apiKey: { name: "P key", resolve: async () => ({ auth: { apiKey: "pk" }, source: "stored" }) } },
    getModels: () => [physicalModel("p", "shared"), physicalModel("p", "other")],
    getAllModels: () => [
      physicalModel("p", "shared"),
      physicalModel("p", "other"),
      // Wire-shape image model (the port's ImageModel is typed; chat-only
      // fields would be lossy).
      {
        id: "img",
        name: "Name img",
        api: "openai-completions",
        provider: "p",
        baseUrl: "https://api.example.com/v1",
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
        type: "image",
        output: ["image"],
      },
    ],
    stream: (model) => ({ physical: model.id }),
    streamSimple: (model) => ({ simple: model.id }),
    ...overrides,
  });

  // Without filterModels/filterAllModels: passthrough keeps the real list,
  // virtual models appended; a virtual model hides the shared-id physical.
  const plain = withVirtualModels("p", makeProvider(), [virtualModel("p", "shared"), virtualModel("p", "extra")]);
  add("with_virtual_models_wrapped_plain", {
    name: plain.name,
    baseUrl: plain.baseUrl,
    models: plain.getModels(),
    allModels: plain.getAllModels(),
    filterModels: plain.filterModels([...plain.getModels(), virtualModel("p", "injected")], undefined),
    filterModelsOfFullList: plain.filterModels(plain.getModels(), undefined),
    hasFilterAllModels: plain.filterAllModels == null,
    streamVirtual: await plain.stream(virtualModel("p", "extra"), {}, {}).result().then(
      (message) => ({ errorMessage: message.errorMessage }),
      (error) => error.message,
    ),
    streamPhysical: plain.stream(physicalModel("p", "other"), {}, {}),
    catalogRefreshAddsVirtualThenPhysicalSameId: plain.getModels(),
  });

  // With provider filters: virtual models always pass the provider filter.
  const filtered = withVirtualModels(
    "p",
    makeProvider({
      filterModels: (models) => models.filter((model) => model.id !== "other"),
      filterAllModels: (models) => models.filter((model) => model.id !== "other"),
    }),
    [virtualModel("p", "shared"), virtualModel("p", "extra")],
  );
  add("with_virtual_models_wrapped_filtered", {
    filterModels: filtered.filterModels(filtered.getModels(), undefined),
    filterAllModels: filtered.filterAllModels(filtered.getAllModels(), undefined),
  });

  // A catalog refresh adding a physical chat model with a virtual id: the
  // virtual model still hides it (getModels order: physical minus hidden,
  // then the registered virtual list).
  const refreshed = makeProvider();
  refreshed.getModels = () => [physicalModel("p", "shared"), physicalModel("p", "extra"), physicalModel("p", "other")];
  const wrapper = withVirtualModels("p", refreshed, [virtualModel("p", "extra")]);
  add("with_virtual_models_catalog_refresh", { models: wrapper.getModels() });
}

fs.writeFileSync(new URL("./virtual_models.oracle.json", import.meta.url), JSON.stringify(out, null, "\t") + "\n");
console.log(`captured ${out.scenarios.length} scenarios -> virtual_models.oracle.json`);
