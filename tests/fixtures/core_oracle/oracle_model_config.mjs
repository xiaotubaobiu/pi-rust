// Oracle capture: upstream coding-agent src/core/model-config.ts under node.
// typebox is resolved from the locally available copy (1.3.11; upstream pins
// 1.3.27 — patch-level difference, disclosed in the port).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ModelConfig } = await import(new URL("./src/core/model-config.ts", import.meta.url));

const fixtures = {
  valid_minimal: { providers: { openai: { models: [{ id: "gpt" }] } } },
  provider_id_order: {
    providers: {
      zeta: { models: [{ id: "z1" }] },
      alpha: { models: [{ id: "a1" }] },
      middle: { models: [{ id: "m1" }] },
    },
  },
  provider_full: {
    providers: {
      p: {
        name: "Provider",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        api: "openai-completions",
        oauth: "radius",
        headers: { "x-a": "1" },
        models: [
          {
            id: "full-model",
            name: "Full Model",
            api: "openai-completions",
            baseUrl: "https://alt.example.com",
            reasoning: true,
            thinkingLevelMap: { low: null, high: "high" },
            input: ["text", "image"],
            cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 1000, input: 0.5, output: 1, cacheRead: 0.25, cacheWrite: 0.6 }] },
            contextWindow: 128000,
            maxTokens: 8192,
            samplingParams: { temperature: 0.7 },
            headers: { "x-m": "m" },
            compat: { supportsStore: true, thinkingFormat: "openai" },
          },
        ],
        modelOverrides: { "o-model": { reasoning: false, contextWindow: 4096 } },
        authHeader: true,
      },
    },
  },
  anthropic_compat: {
    providers: {
      a: {
        api: "anthropic-messages",
        compat: {
          supportsCacheControlOnTools: true,
          allowedFallbackModels: [{ provider: "p2", model: "m2", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 } }],
        },
      },
    },
  },
  missing_providers: {},
  providers_null: { providers: null },
  model_missing_id: { providers: { p: { models: [{ name: "no-id" }] } } },
  model_bad_id_type: { providers: { p: { models: [{ id: 42 }] } } },
  compat_bad_thinking_format: { providers: { p: { models: [{ id: "m", compat: { thinkingFormat: "bogus" } }] } } },
  fallback_models_too_many: {
    providers: {
      a: {
        compat: {
          allowedFallbackModels: [
            { provider: "p", model: "m", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 } },
            { provider: "p", model: "m", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 } },
            { provider: "p", model: "m", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 } },
            { provider: "p", model: "m", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 } },
          ],
        },
      },
    },
  },
  empty_provider_name: { providers: { p: { name: "" } } },
  bad_input_union: { providers: { p: { models: [{ id: "m", input: ["text", "audio"] }] } } },
  bad_oauth: { providers: { p: { oauth: "google" } } },
  compat_not_object: { providers: { p: { models: [{ id: "m", compat: 42 }] } } },
  cost_bad_input_type: { providers: { p: { models: [{ id: "m", cost: { input: "x", output: 1, cacheRead: 0, cacheWrite: 0 } }] } } },
  context_window_string: { providers: { p: { models: [{ id: "m", contextWindow: "5" }] } } },
  headers_bad_value: { providers: { p: { headers: { a: 1 } } } },
  model_override_bad_reasoning: { providers: { p: { modelOverrides: { "o-model": { reasoning: "yes" } } } } },
  thinking_level_map_bad: { providers: { p: { models: [{ id: "m", thinkingLevelMap: { low: 3 } }] } } },
  tier_missing_all_required: { providers: { p: { models: [{ id: "m", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, tiers: [{}] } }] } } },
  providers_array: { providers: [] },
  provider_not_object: { providers: { p: 42 } },
  models_not_array: { providers: { p: { models: {} } } },
  empty_model_id: { providers: { p: { models: [{ id: "" }] } } },
  multi_error_order: { providers: { p: { apiKey: 42, models: [{ id: "" }, { id: 9 }] } } },
  null_optional_number: { providers: { p: { models: [{ id: "m", contextWindow: null }] } } },
};

const results = {};
for (const [name, config] of Object.entries(fixtures)) {
  const dir = mkdtempSync(join(tmpdir(), `pi-model-config-oracle-${name}-`));
  const path = join(dir, "models.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  const loaded = await ModelConfig.load(path);
  results[name] = {
    input: config,
    error: loaded.getError() ?? null,
    providerIds: loaded.getProviderIds(),
    providerJson: loaded.getProvider("p") ? JSON.stringify(loaded.getProvider("p")) : null,
    providerAJson: loaded.getProvider("a") ? JSON.stringify(loaded.getProvider("a")) : null,
    providerZetaJson: loaded.getProvider("zeta") ? JSON.stringify(loaded.getProvider("zeta")) : null,
  };
}

// JSONC + BOM handling.
{
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-oracle-jsonc-"));
  const path = join(dir, "models.json");
  writeFileSync(path, "\uFEFF{\n // comment\n \"providers\": { \"p\": { \"name\": \"N\", } },\n}", "utf-8");
  const loaded = await ModelConfig.load(path);
  results.jsonc_with_bom = {
    rawInput: "\uFEFF{\n // comment\n \"providers\": { \"p\": { \"name\": \"N\", } },\n}",
    error: loaded.getError() ?? null,
    providerIds: loaded.getProviderIds(),
    providerJson: loaded.getProvider("p") ? JSON.stringify(loaded.getProvider("p")) : null,
  };
}

// Malformed JSON (message text is V8-specific; captured for disclosure).
{
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-oracle-bad-"));
  const path = join(dir, "models.json");
  writeFileSync(path, "{ nope", "utf-8");
  const loaded = await ModelConfig.load(path);
  results.malformed_json = { rawInput: "{ nope", errorPrefix: (loaded.getError() ?? "").split("\n\nFile: ")[0] ?? null };
}

// Missing file.
{
  const loaded = await ModelConfig.load(join(tmpdir(), "pi-model-config-oracle-nonexistent-dir", "models.json"));
  results.missing_file = { error: loaded.getError() ?? null, providerIds: loaded.getProviderIds() };
}

// Undefined path.
{
  const loaded = await ModelConfig.load(undefined);
  results.undefined_path = { error: loaded.getError() ?? null, providerIds: loaded.getProviderIds() };
}

const out = { fixtures: results };
const target = new URL("./model_config.oracle.json", import.meta.url);
const { writeFileSync: writeFile } = await import("node:fs");
writeFile(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
console.log("wrote", target, "fixtures:", Object.keys(results).length);
