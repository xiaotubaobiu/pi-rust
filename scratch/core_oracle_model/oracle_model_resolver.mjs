// Oracle capture: upstream coding-agent src/core/model-resolver.ts under node
// (--experimental-strip-types). The captured source is a verbatim copy.
// `@earendil-works/pi-ai` re-exports the real upstream modelsAreEqual;
// `chalk` is an identity stub (upstream chalk auto-disables color on
// non-TTY, so chalk.X(text) === text); `minimatch` is the real package
// (npm-bundled 10.2.4; upstream pins 10.2.6 — patch-level drift, disclosed).
// The ModelRuntime is a structural stub (getModels/getAvailable/
// getAvailableSnapshot/getModel/hasConfiguredAuth), exactly the surface the
// resolver reads; the async entry points run over Promise.resolve values.
//
// Structured values are captured as canonical JSON (recursively key-sorted,
// with arrays in order) so the Rust port can compare byte-for-byte against
// serde_json's sorted-key output.
import { writeFileSync } from "node:fs";
import * as mod from "./src/core/model-resolver.ts";

const canonical = (value) => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

function model(provider, id, extra = {}) {
  return {
    id,
    name: extra.name ?? id,
    api: extra.api ?? "anthropic-messages",
    provider,
    baseUrl: extra.baseUrl ?? "https://example.invalid",
    reasoning: extra.reasoning ?? false,
    input: extra.input ?? ["text"],
    cost: extra.cost ?? { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
    contextWindow: extra.contextWindow ?? 128000,
    maxTokens: 8192,
  };
}

const allModels = [
  model("anthropic", "claude-sonnet-4-5", { name: "Claude Sonnet 4.5", reasoning: true, input: ["text", "image"] }),
  model("openai", "gpt-4o", { name: "GPT-4o", reasoning: false, input: ["text", "image"] }),
  model("openrouter", "qwen/qwen3-coder:exacto", { name: "Qwen3 Coder Exacto", reasoning: true }),
  model("openrouter", "openai/gpt-4o:extended", { name: "GPT-4o Extended" }),
  model("openrouter", "openai/gpt-4o-20250101", { name: "GPT-4o Dated" }),
  model("custom", "bracketed-model[1m]", { name: "Bracketed Model", reasoning: true }),
];

const results = {};

// --- defaultModelPerProvider table -----------------------------------------
results.defaultModelPerProvider = mod.defaultModelPerProvider;

// --- parseModelPattern -------------------------------------------------------
const patterns = [
  "claude-sonnet-4-5",
  "sonnet",
  "nonexistent",
  "sonnet:high",
  "gpt-4o:medium",
  ...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => `sonnet:${level}`),
  "sonnet:random",
  "gpt-4o:invalid",
  "qwen/qwen3-coder:exacto",
  "openrouter/qwen/qwen3-coder:exacto",
  "qwen/qwen3-coder:exacto:high",
  "openrouter/qwen/qwen3-coder:exacto:high",
  "openai/gpt-4o:extended",
  "qwen/qwen3-coder:exacto:random",
  "qwen/qwen3-coder:exacto:high:random",
  "",
  "sonnet:",
  "custom/bracketed-model[1m]",
  "custom/bracketed-model[1m]:high",
  "gpt-4o-2025",
];
results.parseModelPattern = patterns.map((pattern) => ({
  pattern,
  ...(result => result)((() => {
    const r = mod.parseModelPattern(pattern, allModels);
    return { model: r.model ? `${r.model.provider}/${r.model.id}` : null, thinkingLevel: r.thinkingLevel ?? null, warning: r.warning ?? null };
  })()),
}));
// strict mode (CLI parsing)
results.parseModelPatternStrict = [
  "sonnet:random",
  "gpt-4o:extended",
  "nonexistent:xhigh",
].map((pattern) => {
  const r = mod.parseModelPattern(pattern, allModels, { allowInvalidThinkingLevelFallback: false });
  return { pattern, model: r.model ? `${r.model.provider}/${r.model.id}` : null, thinkingLevel: r.thinkingLevel ?? null, warning: r.warning ?? null };
});

// --- resolveModelScopeFromModels ---------------------------------------------
function scope(patternsList, models = allModels) {
  const r = mod.resolveModelScopeFromModels(patternsList, models);
  return {
    scopedModels: r.scopedModels.map((sm) => ({
      model: `${sm.model.provider}/${sm.model.id}`,
      thinkingLevel: sm.thinkingLevel ?? null,
    })),
    diagnostics: r.diagnostics.map((d) => ({ type: d.type, code: d.code, message: d.message, pattern: d.pattern })),
  };
}
results.resolveModelScope = [
  scope(["sonnet:high", "gpt-4o:invalid", "missing"]),
  scope(["anthropic/*"]),
  scope(["*sonnet*"]),
  scope(["custom/bracketed-model[1m]"]),
  scope(["custom/bracketed-model[1m]:high"]),
  scope(["claude-sonnet-4-5", "sonnet:low"]),
  scope(["*/gpt-4o*", "openai/gpt-4o"]),
  scope(["?pt-4o"]),
  scope(["openrouter/qwen/qwen3-coder:exacto:high"]),
  scope(["claude-sonnet-4-5:high", "claude-sonnet-4-5"]),
];

// --- resolveCliModel ---------------------------------------------------------
function cli(options) {
  const registry = {
    getModels: () => options.models ?? allModels,
    hasConfiguredAuth: options.auth ?? (() => false),
  };
  const r = mod.resolveCliModel({
    cliProvider: options.provider,
    cliModel: options.model,
    cliThinking: options.thinking,
    modelRuntime: registry,
  });
  return {
    model: r.model ? `${r.model.provider}/${r.model.id}` : null,
    reasoning: r.model?.reasoning ?? null,
    thinkingLevel: r.thinkingLevel ?? null,
    warning: r.warning ?? null,
    error: r.error ?? null,
  };
}
results.resolveCliModel = [
  { case: "provider_id_no_provider", ...cli({ model: "openai/gpt-4o" }) },
  { case: "fuzzy_in_provider", ...cli({ provider: "openai", model: "4o" }) },
  { case: "pattern_with_thinking", ...cli({ model: "sonnet:high" }) },
  { case: "prefers_exact_raw_id", ...cli({ model: "openai/gpt-4o:extended" }) },
  { case: "invalid_suffix_kept_strict", ...cli({ provider: "openai", model: "gpt-4o:extended" }) },
  { case: "double_prefix_custom_id", ...cli({ provider: "openrouter", model: "openrouter/openai/ghost-model" }) },
  { case: "no_models", ...cli({ provider: "openai", model: "gpt-4o", models: [] }) },
  { case: "unknown_provider", ...cli({ provider: "not-a-provider", model: "x" }) },
  { case: "provider_prefixed_fuzzy", ...cli({ model: "openrouter/qwen" }) },
  { case: "prefers_provider_split", ...cli({ model: "zai/glm-5", models: [...allModels, model("zai", "glm-5", { name: "GLM-5", reasoning: true, baseUrl: "https://open.bigmodel.cn/api/paas/v4" }), model("vercel-ai-gateway", "zai/glm-5", { name: "GLM-5", reasoning: true, baseUrl: "https://ai-gateway.vercel.sh" })], auth: () => true }) },
  { case: "ambiguous_bare_id_no_auth", ...cli({ model: "dup-model", models: [model("azure-openai-responses", "dup-model", { name: "Dup" }), model("openai-codex", "dup-model", { name: "Dup" })] }) },
  { case: "ambiguous_bare_id_one_auth", ...cli({ model: "dup-model", models: [model("azure-openai-responses", "dup-model", { name: "Dup" }), model("openai-codex", "dup-model", { name: "Dup" })], auth: (provider) => provider === "openai-codex" }) },
  { case: "authenticated_raw_beats_unauth_inferred", ...cli({ model: "xiaomi/mimo-v2.5-pro", models: [...allModels, model("commandcode", "xiaomi/mimo-v2.5-pro", { name: "Xiaomi MiMo via Commandcode" }), model("xiaomi", "mimo-v2.5-pro", { name: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com" })], auth: (provider) => provider === "commandcode" }) },
  { case: "fallback_strips_thinking", ...cli({ model: "neuralwatt/zai-org/GLM-5.1-FP8:high", models: [...allModels, model("neuralwatt", "some-base-model", { name: "Some Base Model", baseUrl: "https://api.neuralwatt.com" })] }) },
  { case: "fallback_no_suffix", ...cli({ model: "neuralwatt/zai-org/GLM-5.1-FP8", models: [...allModels, model("neuralwatt", "some-base-model", { name: "Some Base Model", baseUrl: "https://api.neuralwatt.com" })] }) },
  { case: "fallback_invalid_suffix", ...cli({ model: "neuralwatt/zai-org/GLM-5.1-FP8:banana", models: [...allModels, model("neuralwatt", "some-base-model", { name: "Some Base Model", baseUrl: "https://api.neuralwatt.com" })] }) },
  { case: "explicit_provider_fallback", ...cli({ provider: "neuralwatt", model: "zai-org/GLM-5.1-FP8:high", models: [...allModels, model("neuralwatt", "some-base-model", { name: "Some Base Model", baseUrl: "https://api.neuralwatt.com" })] }) },
  { case: "explicit_thinking_keeps_suffix", ...cli({ model: "neuralwatt/zai-org/GLM-5.1-FP8:high", thinking: "medium", models: [...allModels, model("neuralwatt", "some-base-model", { name: "Some Base Model", baseUrl: "https://api.neuralwatt.com" })] }) },
  { case: "unknown_model_error", ...cli({ model: "openai/o3-missing" }) },
  { case: "unknown_model_no_provider", ...cli({ model: "o3-missing" }) },
];
// all valid thinking levels through the fallback path
results.fallbackLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => ({
  level,
  ...cli({ model: `neuralwatt/zai-org/GLM-5.1-FP8:${level}`, models: [...allModels, model("neuralwatt", "some-base-model")] }),
}));

// --- findInitialModel --------------------------------------------------------
async function initial(options) {
  const registry = {
    getModels: () => options.models ?? allModels,
    getModel: options.getModel ?? ((provider, id) => (options.models ?? allModels).find((m) => m.provider === provider && m.id === id)),
    hasConfiguredAuth: options.auth ?? (() => false),
    getAvailableSnapshot: () => options.available ?? [],
  };
  const r = await mod.findInitialModel({
    cliProvider: options.provider,
    cliModel: options.model,
    scopedModels: options.scoped ?? [],
    isContinuing: options.continuing ?? false,
    defaultProvider: options.defaultProvider,
    defaultModelId: options.defaultModelId,
    defaultThinkingLevel: options.defaultThinkingLevel,
    modelThinkingLevels: options.modelThinkingLevels,
    modelRuntime: registry,
  });
  return {
    model: r.model ? `${r.model.provider}/${r.model.id}` : null,
    thinkingLevel: r.thinkingLevel ?? null,
    fallbackMessage: r.fallbackMessage ?? null,
  };
}
results.findInitialModel = [
  { case: "cli_provider_model", ...(await initial({ provider: "openrouter", model: "openrouter/openai/ghost-model" })) },
  { case: "scoped_first", ...(await initial({ scoped: [{ model: allModels[0], thinkingLevel: "high" }] })) },
  { case: "scoped_without_level_uses_default", ...(await initial({ scoped: [{ model: allModels[1] }], defaultThinkingLevel: "low" })) },
  { case: "per_model_level", ...(await initial({ scoped: [{ model: allModels[1] }], modelThinkingLevels: { "openai/gpt-4o": "xhigh" } })) },
  { case: "saved_default_authenticated", ...(await initial({ defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5", auth: () => true })) },
  { case: "saved_default_unauthenticated", ...(await initial({ defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5", available: [model("spark-two", "deepseek-v4-flash", { name: "Local" })] })) },
  { case: "available_default_match", ...(await initial({ available: [model("vercel-ai-gateway", "anthropic/claude-opus-4-6", { name: "Claude Opus 4.6", reasoning: true, input: ["text", "image"], baseUrl: "https://ai-gateway.vercel.sh" })] })) },
  { case: "available_fallback_first", ...(await initial({ available: [model("spark-two", "local-1"), model("spark-two", "local-2")] })) },
  { case: "continuing_scoped_skipped", ...(await initial({ scoped: [{ model: allModels[0] }], continuing: true, available: [model("spark-two", "local")] })) },
  { case: "nothing", ...(await initial({})) },
];

// --- restoreModelFromSession -------------------------------------------------
async function restore(options) {
  const registry = {
    getModel: (provider, id) => (options.models ?? allModels).find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: options.auth ?? (() => false),
    getAvailableSnapshot: () => options.available ?? [],
  };
  const r = await mod.restoreModelFromSession(options.savedProvider, options.savedModelId, options.current ?? null, options.print ?? false, registry);
  return {
    model: r.model ? `${r.model.provider}/${r.model.id}` : null,
    fallbackMessage: r.fallbackMessage ?? null,
  };
}
results.restoreModelFromSession = [
  { case: "restored_with_auth", ...(await restore({ savedProvider: "anthropic", savedModelId: "claude-sonnet-4-5", auth: () => true, current: allModels[1] })) },
  { case: "restored_without_auth_falls_back_to_current", ...(await restore({ savedProvider: "anthropic", savedModelId: "claude-sonnet-4-5", current: allModels[1] })) },
  { case: "missing_falls_back_to_default", ...(await restore({ savedProvider: "gone", savedModelId: "nope", available: [model("spark-two", "local")] })) },
  { case: "missing_no_available", ...(await restore({ savedProvider: "gone", savedModelId: "nope" })) },
];

writeFileSync(new URL("./model_resolver.oracle.json", import.meta.url), canonical(results) + "\n");
console.log("model_resolver oracle written:", Object.keys(results).join(","));
