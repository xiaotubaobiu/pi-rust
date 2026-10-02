// Oracle driver: upstream coding-agent src/core/cache-warmer.ts (HEAD
// 2bbfcca43, v0.99.1) under `node --experimental-strip-types`. Sources are
// verbatim upstream copies (see ./src, SHA-pinned in manifest.json);
// `calculateCost` is a verbatim text extraction from pi-ai models.ts
// (see ./src/ai/cost-stub/models-cost.ts), `getProviderEnvValue` the verbatim
// pi-ai util.
//
// Pins:
// - getCacheWarmingDelayMs / getPromptCacheTtlMs / isReplayable decision
//   grids (time-independent by construction),
// - CacheWarmer.evaluate economics over stubbed session/model inputs
//   (decision objects only: warmCost/missCost/continuationProbability/
//   expectedSavings/economicsAvailable/action — never the wall-clock
//   nextWarmAt),
// - refresh outcomes: appendUsage payloads, extension-override notes,
//   decide-hook fallback on rejection, stop reasons,
// - the /session formatters over constructed statuses (format strings are
//   functions of (nextWarmAt - now) only, so fixed offsets pin them
//   host-independently),
// - formatCacheWarmingUsage fixed-point rendering.
//
// The warm request scenario uses a 10.001s TTL so the armed timer fires in
// 1ms; every assertion waits for the refresh to settle.
import * as fs from "node:fs";

const {
  getCacheWarmingDelayMs,
  getPromptCacheTtlMs,
  isReplayable,
  CacheWarmer,
  formatCacheWarmingStatus,
  formatCacheWarmingUsage,
} = await import(new URL("./src/core/cache-warmer.ts", import.meta.url).href);

const out = { scenarios: [] };
const json = (v) =>
  JSON.parse(
    JSON.stringify(v, (_key, value) => (typeof value === "function" ? "<fn>" : value)),
  );
const add = (name, observed) => out.scenarios.push({ name, observed: json(observed) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ensure the process env does not leak into the retention lookups.
delete process.env.PI_CACHE_RETENTION;

const model = (extra = {}) => ({
  id: "claude",
  name: "Claude",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 64000,
  ...extra,
});

// ---------------------------------------------------------------------------
// getCacheWarmingDelayMs grid
// ---------------------------------------------------------------------------
{
  const ttls = [0, 5000, 9999, 10000, 10001, 10500, 11000, 20000, 30050, 100000, 3600000];
  add("delay_grid", Object.fromEntries(ttls.map((ttl) => [String(ttl), getCacheWarmingDelayMs(ttl)])));
}

// ---------------------------------------------------------------------------
// getPromptCacheTtlMs grid
// ---------------------------------------------------------------------------
{
  const cached = model({ promptCache: { short: 300, long: 3600 } });
  const uncached = model();
  const cases = {
    default_short: { m: cached, options: {} },
    explicit_short: { m: cached, options: { cacheRetention: "short" } },
    explicit_long: { m: cached, options: { cacheRetention: "long" } },
    none: { m: cached, options: { cacheRetention: "none" } },
    env_long: { m: cached, options: { env: { PI_CACHE_RETENTION: "long" } } },
    env_empty: { m: cached, options: { env: { PI_CACHE_RETENTION: "" } } },
    env_other: { m: cached, options: { env: { PI_CACHE_RETENTION: "medium" } } },
    options_missing: { m: cached, options: undefined },
    no_prompt_cache: { m: uncached, options: {} },
    long_tier_missing: { m: model({ promptCache: { short: 300 } }), options: { cacheRetention: "long" } },
    fractional: { m: model({ promptCache: { short: 0.5 } }), options: {} },
  };
  add(
    "ttl_grid",
    Object.fromEntries(
      Object.entries(cases).map(([name, { m, options }]) => [name, getPromptCacheTtlMs(m, options)]),
    ),
  );
}

// ---------------------------------------------------------------------------
// isReplayable grid
// ---------------------------------------------------------------------------
{
  const anthropicAdaptive = model({ compat: { forceAdaptiveThinking: true } });
  const anthropicLegacy = model({ compat: { forceAdaptiveThinking: false } });
  const anthropicNoCompat = model();
  const openai = model({ api: "openai-completions", compat: undefined });
  const cases = {
    anthropic_adaptive_reasoning: { m: anthropicAdaptive, options: { reasoning: "high" } },
    anthropic_adaptive_no_reasoning: { m: anthropicAdaptive, options: {} },
    anthropic_legacy_reasoning: { m: anthropicLegacy, options: { reasoning: "high" } },
    anthropic_nocompat_reasoning: { m: anthropicNoCompat, options: { reasoning: "high" } },
    openai_reasoning: { m: openai, options: { reasoning: "off" } },
    openai_no_reasoning: { m: openai, options: {} },
    options_missing: { m: anthropicLegacy, options: undefined },
  };
  add(
    "replayable_grid",
    Object.fromEntries(Object.entries(cases).map(([name, { m, options }]) => [name, isReplayable(m, options)])),
  );
}

// ---------------------------------------------------------------------------
// CacheWarmer decision economics + refresh outcomes (stubbed seams)
// ---------------------------------------------------------------------------
const assistantMessage = (overrides = {}) => ({
  role: "assistant",
  content: [],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude",
  usage: {
    input: 10,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
  ...overrides,
});

const branchWithPrompt = (input, cacheRead, cacheWrite) => [
  { role: "user", content: "hi", timestamp: 1 },
  {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "t",
    message: assistantMessage({
      usage: {
        input,
        output: 5,
        cacheRead,
        cacheWrite,
        totalTokens: input + 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }),
  },
];

function makeWarmer({ branch = [], mode = "always", decide, streamMessage, streamThrows, modeHolder } = {}) {
  const appendedUsage = [];
  const seenEvents = [];
  const sessionManager = {
    appendUsage: (kind, provider, modelId, usage, note) => {
      const entry = {
        type: "usage",
        id: "usage-1",
        parentId: null,
        timestamp: "t-usage",
        kind,
        provider,
        model: modelId,
        usage,
        ...(note ? { note } : {}),
      };
      appendedUsage.push(entry);
      return entry;
    },
    getBranch: () => branch,
  };
  const models = {
    streamSimple: (m, context, options) => {
      if (streamThrows) throw new Error("stream boom");
      return {
        async *iterate() {},
        async result() {
          return streamMessage ?? assistantMessage();
        },
        [Symbol.asyncIterator]() {
          return (async function* () {})();
        },
      };
    },
  };
  const warmer = new CacheWarmer(
    models,
    sessionManager,
    modeHolder ? () => modeHolder.value : () => mode,
    decide ?? (async (event) => event.action),
  );
  return { warmer, appendedUsage, seenEvents, sessionManager };
}

const warmRequest = (m = model(), options = {}) => ({
  model: m,
  context: { systemPrompt: undefined, messages: [{ role: "user", content: "hi", timestamp: 1 }] },
  options: { maxTokens: 100, ...options },
});

// Short TTL => 1ms timer delay.
const SHORT_TTL_MODEL = () => model({ promptCache: { short: 10.001 } });

async function decisionAfterStart(warmer, request, settleMs = 60) {
  warmer.start(request, () => true);
  await sleep(settleMs);
  return warmer.status;
}

{
  // Economics: streaming phase (probability 1), known prices.
  const warmer = makeWarmer({ branch: branchWithPrompt(1000, 500, 0) });
  const status = await decisionAfterStart(warmer.warmer, warmRequest(SHORT_TTL_MODEL(), {}));
  add("decision_streaming_known_prices", {
    decision: status.decision,
    appendedUsage: warmer.appendedUsage,
    stateAfter: status.state,
    stoppedReason: status.reason ?? null,
  });

  // Warm economics keep the run scheduled across refreshes.
  const warmBranch = branchWithPrompt(100000, 50000, 0);

  // Idle phase: 15% continuation probability after the agent settles.
  const idle = makeWarmer({ branch: warmBranch, mode: "idle" });
  idle.warmer.start(warmRequest(SHORT_TTL_MODEL(), {}), () => true);
  await sleep(20);
  const idleBefore = idle.warmer.status;
  idle.warmer.onAgentSettled();
  await sleep(20);
  add("decision_after_settle", {
    decisionBeforeSettle: { ...idleBefore, nextWarmAt: "<number>" },
    decisionAfterSettle: { ...idle.warmer.status, nextWarmAt: "<number>" },
    appendedUsageCountGte1: idle.appendedUsage.length >= 1,
    firstAppendedUsage: idle.appendedUsage[0] ?? null,
  });

  // Economics unavailable: empty branch (prompt size unknown).
  const noEconomics = makeWarmer({ branch: [] });
  const noEconomicsStatus = await decisionAfterStart(noEconomics.warmer, warmRequest(SHORT_TTL_MODEL(), {}));
  add("decision_no_economics", {
    decision: noEconomicsStatus.decision,
    state: noEconomicsStatus.state,
    reason: noEconomicsStatus.reason ?? null,
  });

  // Miss priced at input when the model has no cacheWrite rate.
  const noCacheWrite = makeWarmer({
    branch: branchWithPrompt(1000, 500, 0),
  });
  const cheapModel = model({ promptCache: { short: 10.001 }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } });
  const noCacheWriteStatus = await decisionAfterStart(noCacheWrite.warmer, warmRequest(cheapModel, {}));
  add("decision_input_miss", { decision: noCacheWriteStatus.decision });

  // Tiered pricing: the >200k tier covers the whole request.
  const tiered = model({
    promptCache: { short: 10.001 },
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      tiers: [{ input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.875, inputTokensAbove: 200000 }],
    },
  });
  const tieredWarmer = makeWarmer({ branch: branchWithPrompt(250000, 0, 0) });
  const tieredStatus = await decisionAfterStart(tieredWarmer.warmer, warmRequest(tiered, {}));
  add("decision_tiered", { decision: tieredStatus.decision });

  // 1h cache writes price at 2x input (usage cacheWrite1h).
  const longWarm = makeWarmer({
    branch: [
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "t",
        message: assistantMessage({
          usage: {
            input: 100,
            output: 5,
            cacheRead: 0,
            cacheWrite: 400,
            cacheWrite1h: 300,
            totalTokens: 505,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      },
    ],
  });
  const longWarmStatus = await decisionAfterStart(longWarm.warmer, warmRequest(SHORT_TTL_MODEL(), {}));
  add("decision_long_write", { decision: longWarmStatus.decision });
}

{
  // Extension decide hook stopping warm economics: "stopped by extension".
  const stopper = makeWarmer({
    branch: branchWithPrompt(100000, 50000, 0),
    decide: async () => "stop",
  });
  const stopStatus = await decisionAfterStart(stopper.warmer, warmRequest(SHORT_TTL_MODEL(), {}));
  add("decide_override_stop", {
    state: stopStatus.state,
    reason: stopStatus.reason,
    decision: stopStatus.decision,
    extensionOverride: stopStatus.extensionOverride,
    appendedUsage: stopper.appendedUsage,
  });

  // Extension decide hook forcing a warm through stop economics.
  const forcer = makeWarmer({
    branch: branchWithPrompt(1000, 500, 0),
    decide: async () => "warm",
  });
  forcer.warmer.start(warmRequest(SHORT_TTL_MODEL(), {}), () => true);
  await sleep(60);
  const forcedStatus = forcer.warmer.status;
  add("decide_override_warm", {
    state: forcedStatus.state,
    decision: forcedStatus.decision,
    extensionOverride: forcedStatus.extensionOverride,
    appendedUsageCountGte1: forcer.appendedUsage.length >= 1,
    firstAppendedUsage: forcer.appendedUsage[0] ?? null,
  });

  // A decide hook echoing pi's decision is not an override.
  const echo = makeWarmer({
    branch: branchWithPrompt(100000, 50000, 0),
    decide: async (event) => event.action,
  });
  const echoRequest = warmRequest(SHORT_TTL_MODEL(), {});
  echo.warmer.start(echoRequest, () => true);
  await sleep(60);
  add("decide_echo_no_override", {
    state: echo.warmer.status.state,
    extensionOverride: echo.warmer.status.extensionOverride,
    firstAppendedUsage: echo.appendedUsage[0] ?? null,
    appendedUsageNoteAbsent: echo.appendedUsage.every((entry) => entry.note === undefined),
  });

  // Rejected decide hook falls back to pi's decision.
  const failing = makeWarmer({
    branch: branchWithPrompt(1000, 500, 0),
    decide: async () => {
      throw new Error("classifier down");
    },
  });
  const failingStatus = await decisionAfterStart(failing.warmer, warmRequest(SHORT_TTL_MODEL(), {}));
  add("decide_reject_fallback", {
    state: failingStatus.state,
    reason: failingStatus.reason ?? null,
    appendedUsage: failing.appendedUsage,
  });
}

{
  // start() stop reasons.
  const cases = {};
  const off = makeWarmer({ mode: "off" });
  off.warmer.start(warmRequest(), () => true);
  cases.mode_off = off.warmer.status;

  const nonReplayable = makeWarmer({});
  nonReplayable.warmer.start(warmRequest(model({ compat: { forceAdaptiveThinking: false } }), { reasoning: "high" }), () => true);
  cases.not_replayable = nonReplayable.warmer.status;

  const retentionNone = makeWarmer({});
  retentionNone.warmer.start(warmRequest(model({ promptCache: { short: 300 } }), { cacheRetention: "none" }), () => true);
  cases.retention_none = retentionNone.warmer.status;

  const noTtl = makeWarmer({});
  noTtl.warmer.start(warmRequest(model()), () => true);
  cases.no_ttl = noTtl.warmer.status;

  const tinyTtl = makeWarmer({});
  tinyTtl.warmer.start(warmRequest(model({ promptCache: { short: 10 } })), () => true);
  cases.tiny_ttl = tinyTtl.warmer.status;

  add("start_stop_reasons", cases);

  // cancel() lands on the inactive reason.
  const cancelled = makeWarmer({ branch: branchWithPrompt(1000, 500, 0) });
  cancelled.warmer.start(warmRequest(SHORT_TTL_MODEL()), () => true);
  cancelled.warmer.cancel();
  add("cancel", cancelled.warmer.status);

  // onModeChanged to off stops with the mode reason. The mode flips through
  // the mutable holder so the stop lands deterministically before the 1ms
  // refresh.
  const modeHolder = { value: "always" };
  const modeChange = makeWarmer({ branch: branchWithPrompt(1000, 500, 0), modeHolder });
  modeChange.warmer.start(warmRequest(SHORT_TTL_MODEL()), () => true);
  modeHolder.value = "off";
  modeChange.warmer.onModeChanged();
  add("on_mode_changed_off", modeChange.warmer.status);

  const settled = makeWarmer({ branch: branchWithPrompt(1000, 500, 0), mode: "streaming" });
  settled.warmer.start(warmRequest(SHORT_TTL_MODEL()), () => true);
  settled.warmer.onAgentSettled();
  add("streaming_settle_stops", settled.warmer.status);

  // isCurrent false -> "conversation context changed".
  const stale = makeWarmer({ branch: branchWithPrompt(1000, 500, 0) });
  let current = false;
  stale.warmer.start(warmRequest(SHORT_TTL_MODEL()), () => current);
  current = false;
  add("stale_context", stale.warmer.status);

  // Waiting-for-first-request initial status.
  const fresh = makeWarmer({});
  add("initial_status", fresh.warmer.status);

  // Mode off shadows everything.
  const offShadow = makeWarmer({ mode: "off" });
  add("status_mode_off", offShadow.warmer.status);

  // Stream failures swallow into rescheduling (best-effort). Warm economics
  // keep the run alive across the failures.
  const failing = makeWarmer({ branch: branchWithPrompt(100000, 50000, 0), streamThrows: true });
  const failingRequest = warmRequest(SHORT_TTL_MODEL(), {});
  failing.warmer.start(failingRequest, () => true);
  await sleep(60);
  add("stream_failure_reschedules", {
    appendedUsage: failing.appendedUsage,
    state: failing.warmer.status.state,
    nextWarmArmed: typeof failing.warmer.status.nextWarmAt === "number",
  });

  // Error/aborted warm responses are not recorded as usage.
  const errored = makeWarmer({
    branch: branchWithPrompt(100000, 50000, 0),
    streamMessage: assistantMessage({ stopReason: "error", errorMessage: "overloaded" }),
  });
  const erroredRequest = warmRequest(SHORT_TTL_MODEL(), {});
  errored.warmer.start(erroredRequest, () => true);
  await sleep(60);
  add("error_response_skips_usage", {
    appendedUsage: errored.appendedUsage,
    state: errored.warmer.status.state,
  });
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
{
  const decision = (overrides = {}) => ({
    phase: "streaming",
    warmCost: 0.001,
    missCost: 0.2,
    continuationProbability: 1,
    expectedSavings: 0.199,
    economicsAvailable: true,
    action: "warm",
    ...overrides,
  });
  const decisionTime = (nextWarmAt, now) => {
    const status = { state: "scheduled", nextWarmAt, decision: decision() };
    return formatCacheWarmingStatus(status, now);
  };
  add("format_decision_time_grid", {
    now: decisionTime(10000, 10000),
    past: decisionTime(5000, 10000),
    undefined: decisionTime(undefined, 10000),
    s59: decisionTime(59000, 10000),
    s60: decisionTime(60000, 10000),
    m1s1: decisionTime(61000, 10000),
    h1: decisionTime(3600000, 10000),
    h1m1s1: decisionTime(3661000, 10000),
    h1s1: decisionTime(3601000, 10000),
    h1m1: decisionTime(3660000, 10000),
    ceiling: decisionTime(10001, 10000),
  });

  const statuses = {
    waiting: { state: "inactive", reason: "waiting for first request" },
    disabled: { state: "inactive", reason: "cache warming disabled" },
    unknownReason: { state: "inactive" },
    economicsUnavailable: {
      state: "inactive",
      reason: "cache economics unavailable",
      decision: decision({ economicsAvailable: false, expectedSavings: -0.001, action: "stop" }),
    },
    economicsUnavailableOverride: {
      state: "inactive",
      reason: "stopped by extension",
      decision: decision({ economicsAvailable: false, expectedSavings: -0.001, action: "stop" }),
      extensionOverride: true,
    },
    stoppedBelowThreshold: {
      state: "inactive",
      reason: "expected savings below threshold",
      decision: decision({ expectedSavings: -0.05, action: "stop" }),
    },
    stoppedNegativeSavings: {
      state: "inactive",
      reason: "expected savings below threshold",
      decision: decision({ expectedSavings: -0.5, action: "stop" }),
    },
    stoppedByExtension: {
      state: "inactive",
      reason: "stopped by extension",
      decision: decision(),
      extensionOverride: true,
    },
    warming: { state: "refreshing", decision: decision() },
    warmingIdle: {
      state: "refreshing",
      decision: decision({ phase: "idle", continuationProbability: 0.15, expectedSavings: -0.07 }),
    },
    scheduled: { state: "scheduled", nextWarmAt: 91000, decision: decision() },
    scheduledIdle: {
      state: "scheduled",
      nextWarmAt: 91000,
      decision: decision({ phase: "idle", continuationProbability: 0.15, expectedSavings: -0.07 }),
    },
  };
  add(
    "format_status_grid",
    Object.fromEntries(Object.entries(statuses).map(([name, status]) => [name, formatCacheWarmingStatus(status, 10000)])),
  );

  const usage = (cost, note) => ({
    type: "usage",
    id: "u",
    parentId: null,
    timestamp: "t",
    kind: "cache_warm",
    provider: "anthropic",
    model: "claude",
    usage: {
      input: 0,
      output: 1,
      cacheRead: 1000,
      cacheWrite: 0,
      totalTokens: 1,
      cost: { input: 0, output: cost, cacheRead: 0.0003, cacheWrite: 0, total: cost },
    },
    ...(note ? { note } : {}),
  });
  add("format_usage_grid", {
    simple: formatCacheWarmingUsage(usage(0.0003)),
    sixDecimals: formatCacheWarmingUsage(usage(0.123456)),
    trailingZeros: formatCacheWarmingUsage(usage(0.1234)),
    wholeDollar: formatCacheWarmingUsage(usage(2)),
    tiny: formatCacheWarmingUsage(usage(0.000001)),
    zero: formatCacheWarmingUsage(usage(0)),
    withNote: formatCacheWarmingUsage(usage(0.0003, "extension override")),
  });
}

fs.writeFileSync(new URL("./cache_warmer.oracle.json", import.meta.url), JSON.stringify(out, null, "\t") + "\n");
console.log(`captured ${out.scenarios.length} scenarios -> cache_warmer.oracle.json`);
