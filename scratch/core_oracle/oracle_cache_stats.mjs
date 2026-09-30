// Oracle capture: upstream coding-agent src/core/cache-stats.ts under node.
// SessionEntry comes from session-manager.ts (type-only upstream), so plain
// object literals matching the runtime shape are used.
const mod = await import(new URL("./src/core/cache-stats.ts", import.meta.url));
const { computeCacheWaste, collectCacheMisses, detectCacheMiss, CACHE_TTL_MS } = mod;

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const models = { getModel: () => ({ cost: { cacheRead: 0.3 } }) };

function assistant(options = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "test",
    model: options.model ?? "test-model",
    usage: {
      input: options.input ?? 0,
      output: 10,
      cacheRead: options.cacheRead ?? 0,
      cacheWrite: options.cacheWrite ?? 0,
      totalTokens: 0,
      cost: { ...zeroCost, ...options.cost },
    },
    stopReason: "stop",
    timestamp: options.timestamp ?? 0,
  };
}
function entry(message) {
  return { type: "message", id: "x", parentId: null, timestamp: "", message };
}
const reset = { type: "compaction", id: "c", parentId: null, timestamp: "" };
const branchReset = { type: "branch_summary", id: "b", parentId: null, timestamp: "" };

// Turn 1: fresh 100k cache write at $3.75/M; Turn 2: healthy read-back.
const turn1 = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, timestamp: 0 });
const turn2 = assistant({
  cacheRead: 100_000,
  cacheWrite: 5_000,
  cost: { cacheRead: 0.03, cacheWrite: 0.019 },
  timestamp: 60_000,
});

const computeCases = [
  {
    name: "accumulates_missed_tokens_and_cost",
    entries: [
      entry(turn1),
      entry(turn2),
      entry(assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 })),
    ],
  },
  { name: "healthy_session", entries: [entry(turn1), entry(turn2)] },
  { name: "skips_turn_after_compaction", entries: [entry(turn1), reset, entry(assistant({ cacheWrite: 20_000, cost: { cacheWrite: 0.075 } }))] },
  { name: "skips_turn_after_branch_summary", entries: [entry(turn1), branchReset, entry(assistant({ cacheWrite: 20_000, cost: { cacheWrite: 0.075 } }))] },
  {
    name: "counts_model_switch_misses",
    entries: [entry(turn1), entry(assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, model: "other-model" }))],
  },
  {
    name: "skips_providers_without_cache_activity",
    entries: [entry(assistant({ input: 100_000 })), entry(assistant({ input: 110_000 }))],
  },
  {
    name: "noise_floor_exact_1024_not_counted",
    entries: [entry(assistant({ input: 10, cacheWrite: 105_000, cost: { cacheWrite: 0.39 } })), entry(assistant({ input: 10, cacheRead: 103_986, cacheWrite: 2_000, cost: { cacheRead: 0.31, cacheWrite: 0.0074 } }))],
  },
  {
    name: "noise_floor_1025_counted",
    entries: [entry(assistant({ input: 10, cacheWrite: 105_000, cost: { cacheWrite: 0.39 } })), entry(assistant({ input: 10, cacheRead: 103_985, cacheWrite: 2_000, cost: { cacheRead: 0.31, cacheWrite: 0.0074 } }))],
  },
  {
    name: "first_turn_only",
    entries: [entry(turn1)],
  },
  {
    name: "zero_prompt_tokens",
    entries: [entry(turn1), entry(assistant({}))],
  },
  {
    name: "total_miss_on_reporting_provider_uses_model_price",
    entries: [entry(turn1), entry(turn2), entry(assistant({ input: 105_000, cost: { input: 0.39375 }, timestamp: 120_000 }))],
  },
];

const compute = computeCases.map(({ name, entries }) => {
  const totals = computeCacheWaste(entries, models);
  return { name, entries, totals };
});

const collectCases = [
  {
    name: "maps_misses_by_reference",
    entries: [
      entry(turn1),
      entry(turn2),
      entry(assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 })),
    ],
  },
  { name: "empty", entries: [] },
];
const collect = collectCases.map(({ name, entries }) => {
  const misses = collectCacheMisses(entries, models);
  return { name, entries, size: misses.size, missedTokens: [...misses.values()].map((m) => m.missedTokens) };
});

const detectCases = [
  {
    name: "miss_with_idle_time",
    entries: [entry(turn1), entry(turn2)],
    message: assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 600_000 }),
  },
  {
    name: "flags_model_switch",
    entries: [entry(turn1), entry(turn2)],
    message: assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, model: "other-model", timestamp: 120_000 }),
  },
  {
    name: "healthy_turn_undefined",
    entries: [entry(turn1), entry(turn2)],
    message: assistant({
      cacheRead: 105_000,
      cacheWrite: 2_000,
      cost: { cacheRead: 0.0315, cacheWrite: 0.0075 },
      timestamp: 120_000,
    }),
  },
  { name: "first_turn_undefined", entries: [], message: turn1 },
  {
    name: "negative_idle_clamped_to_zero",
    entries: [entry(turn1), entry(turn2)],
    message: assistant({
      cacheRead: 90_000,
      cacheWrite: 2_000,
      cost: { cacheRead: 0.027, cacheWrite: 0.005 },
      timestamp: 30_000,
    }),
  },
];
const detect = detectCases.map(({ name, entries, message }) => {
  const miss = detectCacheMiss(entries, message, models);
  return { name, entries, message, miss: miss ?? null };
});

const out = { cache_ttl_ms: CACHE_TTL_MS, compute, collect, detect };
const target = new URL("./cache_stats.oracle.json", import.meta.url);
const { writeFileSync } = await import("node:fs");
writeFileSync(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
console.log("wrote", target, "compute cases:", compute.length);
