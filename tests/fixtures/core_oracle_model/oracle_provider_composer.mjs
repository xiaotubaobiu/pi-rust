// Oracle capture: upstream coding-agent src/core/provider-composer.ts under
// node (--experimental-strip-types). The captured sources are verbatim copies
// (provider-composer.ts, model-config.ts, resolve-config-value.ts).
// `@earendil-works/pi-ai` re-exports the real upstream modelsAreEqual (see
// node_modules/@earendil-works/pi-ai/); lazyStream/getApiProvider are only
// reachable at stream-dispatch time (never in these scenarios) and throw.
//
// Base providers are plain duck-typed Provider objects (getModels/name/auth),
// exactly what composeModelProvider reads. ModelConfig instances come from the
// real typebox-validated ModelConfig.load over temp models.json files.
//
// Structured values are captured as canonical JSON (recursively key-sorted) so
// the Rust port can compare byte-for-byte against serde_json sorted-key output.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelConfig } from "./src/core/model-config.ts";
import {
  composeModelProvider,
  configuredRequestAuthStatus,
  resolveCompatibilityRequestConfig,
  resolveConfiguredModelHeaders,
  validateExtensionProvider,
} from "./src/core/provider-composer.ts";

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

// --- fixtures ----------------------------------------------------------------
function baseModel(provider, id, extra = {}) {
  return {
    id,
    name: extra.name ?? id,
    api: extra.api ?? "openai-completions",
    provider,
    baseUrl: extra.baseUrl ?? "https://base.example.com/v1",
    reasoning: extra.reasoning ?? false,
    ...(extra.thinkingLevelMap ? { thinkingLevelMap: extra.thinkingLevelMap } : {}),
    input: extra.input ?? ["text"],
    cost: extra.cost ?? { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: extra.contextWindow ?? 128000,
    maxTokens: extra.maxTokens ?? 8192,
    ...(extra.samplingParams ? { samplingParams: extra.samplingParams } : {}),
    ...(extra.headers ? { headers: extra.headers } : {}),
    ...(extra.compat ? { compat: extra.compat } : {}),
  };
}

function stubProvider(id, models, extra = {}) {
  return {
    id,
    name: extra.name ?? id,
    // Real upstream providers always carry `auth` (the composer reads
    // `base?.auth.apiKey` unguarded — a base without `auth` throws).
    auth: extra.auth ?? {},
    ...(extra.baseUrl ? { baseUrl: extra.baseUrl } : {}),
    ...(extra.headers ? { headers: extra.headers } : {}),
    ...(extra.auth ? { auth: extra.auth } : {}),
    getModels: () => models,
    stream: () => { throw new Error("oracle: base stream must not be called"); },
    streamSimple: () => { throw new Error("oracle: base streamSimple must not be called"); },
  };
}

const openrouterBase = stubProvider("openrouter", [
  baseModel("openrouter", "anthropic/claude-sonnet-4", {
    name: "Claude Sonnet 4",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    compat: { supportsUsageInStreaming: true, thinkingFormat: "openai", openRouterRouting: { allow_fallbacks: true, order: ["anthropic"] } },
    samplingParams: { temperature: 0.5, top_p: 0.9 },
  }),
  baseModel("openrouter", "anthropic/claude-opus-4", {
    name: "Claude Opus 4",
    reasoning: true,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    compat: { supportsUsageInStreaming: true },
  }),
  baseModel("openrouter", "openai/gpt-4o", { name: "GPT-4o" }),
]);

const results = {};

// --- scenario: baseUrl override only ---------------------------------------
async function scenario(name, providersJson, providerId, base, extension, run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-oracle-pc-"));
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify(providersJson ?? { providers: {} }));
  const config = await ModelConfig.load(modelsPath);
  let outcome;
  try {
    if (run) {
      outcome = { ok: true, value: run(config) };
    } else {
      const provider = composeModelProvider(providerId, base, config, extension);
      outcome = { ok: true, models: provider.getModels(), name: provider.name, baseUrl: provider.baseUrl ?? null };
    }
  } catch (error) {
    outcome = { ok: false, error: error.message };
  }
  results[name] = outcome;
  return outcome;
}

await scenario("baseUrl_override", {
  providers: { openrouter: { baseUrl: "https://proxy.example.com/v1" } },
}, "openrouter", openrouterBase);

await scenario("headers_only_override", {
  providers: { openrouter: { headers: { "x-custom": "custom-value", "x-env": "$VAR_X" } } },
}, "openrouter", openrouterBase, undefined, (config) => {
  const provider = composeModelProvider("openrouter", openrouterBase, config, undefined);
  const model = provider.getModels()[0];
  process.env.VAR_X = "env-x";
  try {
    return {
      headers: resolveConfiguredModelHeaders(model, config.getProvider("openrouter"), undefined, {}),
      compatConfig: resolveCompatibilityRequestConfig(model, config.getProvider("openrouter"), undefined),
    };
  } finally {
    delete process.env.VAR_X;
  }
});

// --- scenario: models merge / replace --------------------------------------
await scenario("models_merge_replace", {
  providers: {
    openrouter: {
      baseUrl: "https://merged.example.com/v1",
      models: [
        { id: "anthropic/claude-sonnet-4", name: "Replaced Sonnet", reasoning: false, input: ["text"], cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 },
        { id: "brand-new-model", reasoning: true, input: ["text"], thinkingLevelMap: { high: "high" }, cost: { input: 1, output: 2, cacheRead: 0.3, cacheWrite: 0.4 }, contextWindow: 200000, maxTokens: 64000, headers: { "x-model": "m" }, compat: { supportsStrictMode: true } },
      ],
    },
  },
}, "openrouter", openrouterBase);

await scenario("custom_model_inherits_provider_defaults", {
  providers: {
    openrouter: {
      models: [{ id: "inherit-model", reasoning: false, input: ["text"] }],
    },
  },
}, "openrouter", openrouterBase);

await scenario("provider_compat_applies_to_models", {
  providers: {
    openrouter: {
      compat: { supportsUsageInStreaming: false, openRouterRouting: { allow_fallbacks: false } },
    },
  },
}, "openrouter", openrouterBase);

// --- scenario: modelOverrides ----------------------------------------------
await scenario("model_overrides", {
  providers: {
    openrouter: {
      modelOverrides: {
        "anthropic/claude-sonnet-4": {
          name: "Overridden Sonnet",
          reasoning: false,
          thinkingLevelMap: { high: "xhigh", off: null },
          input: ["text"],
          cost: { input: 99 },
          contextWindow: 555000,
          maxTokens: 1234,
          samplingParams: { top_p: 0.7 },
          compat: { supportsUsageInStreaming: false, openRouterRouting: { order: ["together"] } },
        },
      },
    },
  },
}, "openrouter", openrouterBase);

await scenario("override_unknown_model_ignored", {
  providers: { openrouter: { modelOverrides: { "no/such-model": { name: "x" } } } },
}, "openrouter", openrouterBase);

// --- scenario: extension layer ---------------------------------------------
await scenario("extension_models_replace", undefined, "ext-provider", openrouterBase, {
  name: "Ext Provider",
  baseUrl: "https://ext.example.com/v1",
  apiKey: "ext-key",
  api: "openai-completions",
  models: [
    { id: "ext-model", name: "Ext Model", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512, headers: { "x-ext": "dropped" } },
  ],
});

await scenario("extension_base_url_only", undefined, "openrouter", openrouterBase, {
  baseUrl: "https://ext-overlay.example.com/v1",
});

await scenario("extension_models_merge_with_models_json", {
  providers: {
    openrouter: {
      baseUrl: "https://json.example.com/v1",
      models: [{ id: "json-model", reasoning: false, input: ["text"] }],
    },
  },
}, "openrouter", openrouterBase, {
  baseUrl: "https://ext.example.com/v1",
  api: "openai-completions",
  models: [{ id: "ext-model", name: "Ext Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512 }],
});

// --- scenario: error texts ---------------------------------------------------
await scenario("error_missing_api", {
  providers: { "no-api": { baseUrl: "https://x.example.com", models: [{ id: "m1", reasoning: false, input: ["text"] }] } },
}, "no-api", undefined);
await scenario("error_missing_base_url", {
  providers: { "no-url": { api: "openai-completions", models: [{ id: "m1", reasoning: false, input: ["text"] }] } },
}, "no-url", undefined);
await scenario("error_invalid_context_window", {
  providers: { "bad-cw": { baseUrl: "https://x.example.com", api: "openai-completions", models: [{ id: "m1", reasoning: false, input: ["text"], contextWindow: 0 }] } },
}, "bad-cw", undefined);
await scenario("error_invalid_max_tokens", {
  providers: { "bad-mt": { baseUrl: "https://x.example.com", api: "openai-completions", models: [{ id: "m1", reasoning: false, input: ["text"], maxTokens: -5 }] } },
}, "bad-mt", undefined);
await scenario("error_must_specify_something", {
  providers: { empty: { } },
}, "empty", undefined);
await scenario("error_oauth_requires_base_url", {
  providers: { rad: { oauth: "radius" } },
}, "rad", undefined);
// Upstream's `no authentication method configured` guard is unreachable in
// the current tree: composeApiKeyAuth only returns undefined when an oauth
// method exists (the OAuth-only guard), in which case composeOAuthAuth also
// returns it. Documented here; the port keeps the guard (dead) verbatim.
await scenario("no_auth_method_guard_unreachable", {
  providers: { openrouter: { baseUrl: "https://x.example.com/v1" } },
}, "openrouter", undefined);
await scenario("error_streamsimple_requires_api", undefined, "broken-ext", openrouterBase, {
  baseUrl: "https://x.example.com",
  streamSimple: () => { throw new Error("never"); },
}, (config) => {
  validateExtensionProvider("broken-ext", openrouterBase, config.getProvider("broken-ext"), {
    baseUrl: "https://x.example.com",
    streamSimple: () => { throw new Error("never"); },
  });
  return "validated";
});

// --- scenario: auth status table --------------------------------------------
results.authStatus = [
  { label: "extension_key", value: configuredRequestAuthStatus(undefined, { apiKey: "literal-key" }) },
  { label: "models_json_key", value: configuredRequestAuthStatus({ apiKey: "json-key" }, undefined) },
  { label: "extension_wins", value: configuredRequestAuthStatus({ apiKey: "json-key" }, { apiKey: "ext-key" }) },
  { label: "env_configured", value: configuredRequestAuthStatus({ apiKey: "$ORACLE_SET_VAR" }, undefined) },
  { label: "env_missing", value: configuredRequestAuthStatus({ apiKey: "$ORACLE_MISSING_VAR" }, undefined) },
  { label: "command", value: configuredRequestAuthStatus({ apiKey: "!run" }, undefined) },
  { label: "template_configured", value: configuredRequestAuthStatus({ apiKey: "pre-$ORACLE_SET_VAR" }, undefined) },
  { label: "none", value: configuredRequestAuthStatus(undefined, undefined) },
];
process.env.ORACLE_SET_VAR = "1";
results.authStatus.push(
  { label: "env_configured_live", value: configuredRequestAuthStatus({ apiKey: "$ORACLE_SET_VAR" }, undefined) },
  { label: "template_configured_live", value: configuredRequestAuthStatus({ apiKey: "pre-$ORACLE_SET_VAR" }, undefined) },
);
delete process.env.ORACLE_SET_VAR;

// --- scenario: composed api-key auth resolve --------------------------------
const dir = mkdtempSync(join(tmpdir(), "pi-oracle-pc-auth-"));
const authModelsPath = join(dir, "models.json");
writeFileSync(authModelsPath, JSON.stringify({
  providers: {
    p: {
      baseUrl: "https://p.example.com/v1",
      apiKey: "json-$ORACLE_AUTH_VAR",
      headers: { "x-json": "$ORACLE_AUTH_VAR", "x-lit": "v" },
      authHeader: true,
    },
  },
}));
const authConfig = await ModelConfig.load(authModelsPath);
const composed = composeModelProvider("p", undefined, authConfig, undefined);
async function driveResolve() {
  const ctx = { env: async (name) => (name === "ORACLE_AUTH_VAR" ? "secret-var" : process.env[name]) };
  const check = await composed.auth.apiKey.check({ ctx, credential: undefined });
  const resolved = await composed.auth.apiKey.resolve({ ctx, credential: undefined });
  const withCredential = await composed.auth.apiKey.resolve({ ctx, credential: { type: "api_key", key: "stored-key" } });
  const withEnvCredential = await composed.auth.apiKey.resolve({ ctx, credential: { type: "api_key", key: "stored-key", env: { ORACLE_AUTH_VAR: "cred-env" } } });
  const oauthlessCheck = composed.auth.oauth;
  return {
    name: composed.auth.apiKey.name,
    check: check ?? null,
    resolved: resolved ? { auth: resolved.auth, env: resolved.env ?? null, source: resolved.source ?? null } : null,
    withCredential: withCredential ? { auth: withCredential.auth, env: withCredential.env ?? null, source: withCredential.source ?? null } : null,
    withEnvCredential: withEnvCredential ? { auth: withEnvCredential.auth, env: withEnvCredential.env ?? null, source: withEnvCredential.source ?? null } : null,
    oauthPresent: oauthlessCheck !== undefined,
  };
}
results.composedAuth = await driveResolve();

// inherited base auth propagation + credential passthrough
const inheritedBase = stubProvider("inh", [baseModel("inh", "m1")], {
  auth: {
    apiKey: {
      name: "Inherited Key",
      check: async () => ({ type: "api_key", source: "inherited check" }),
      resolve: async (input) => {
        if (input.credential?.key === "cred-key") return { auth: { apiKey: "cred-key" }, source: "from credential" };
        return undefined;
      },
    },
  },
});
const inheritedDir = mkdtempSync(join(tmpdir(), "pi-oracle-pc-inh-"));
const inheritedPath = join(inheritedDir, "models.json");
writeFileSync(inheritedPath, JSON.stringify({ providers: {} }));
const inheritedConfig = await ModelConfig.load(inheritedPath);
const inheritedComposed = composeModelProvider("inh", inheritedBase, inheritedConfig, undefined);
const inheritedCtx = { env: async () => undefined };
results.inheritedAuth = {
  name: inheritedComposed.auth.apiKey.name,
  checkNoCredential: (await inheritedComposed.auth.apiKey.check({ ctx: inheritedCtx, credential: undefined })) ?? null,
  checkWithCredential: (await inheritedComposed.auth.apiKey.check({ ctx: inheritedCtx, credential: { type: "api_key", key: "cred-key" } })) ?? null,
  resolveNoCredential: (await inheritedComposed.auth.apiKey.resolve({ ctx: inheritedCtx, credential: undefined })) ?? null,
  resolveWithCredential: await inheritedComposed.auth.apiKey.resolve({ ctx: inheritedCtx, credential: { type: "api_key", key: "cred-key" } }),
};

// oauth-only provider gets no fabricated api-key method
const oauthExtension = {
  baseUrl: "https://oauth.example.com/v1",
  api: "openai-completions",
  oauth: {
    name: "Ext OAuth",
    login: async () => ({ access: "a", refresh: "r", expires: 1 }),
    refreshToken: async (c) => c,
    getApiKey: (c) => c.access,
  },
  models: [{ id: "oauth-model", name: "OAuth Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512 }],
};
const oauthComposed = composeModelProvider("oauth-p", undefined, await ModelConfig.load(mkdtempSync(join(tmpdir(), "pi-oracle-pc-oauth-")) + "/models.json"), oauthExtension);
results.oauthOnly = {
  apiKeyPresent: composed2HasKey(oauthComposed),
  oauthName: oauthComposed.auth.oauth?.name ?? null,
  models: oauthComposed.getModels(),
};
function composed2HasKey(provider) {
  return provider.auth.apiKey !== undefined;
}

writeFileSync(new URL("./provider_composer.oracle.json", import.meta.url), canonical(results) + "\n");
console.log("provider_composer oracle written:", Object.keys(results).join(","));
