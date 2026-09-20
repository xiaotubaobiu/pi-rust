use serde::{Deserialize, Serialize};

use crate::ai::types::{Model, ModelCost, ModelInput};

/// Upstream `KnownProvider` ids (packages/ai/src/types.ts:35-75) that the
/// port wires. Ambient-auth flows (google-vertex ADC, bedrock AWS profiles,
/// codex OAuth) land in M2d; those providers work with an explicit key now.
pub const PROVIDERS: &[&str] = &[
    "anthropic",
    "openai-compat",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex",
    "google",
    "google-vertex",
    "mistral",
    "amazon-bedrock",
    "pi-messages",
];

/// Default context window for hand-declared models (no catalog lookup yet).
pub const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// One of [`PROVIDERS`], e.g. "anthropic" or "openai-compat".
    pub provider: String,
    /// Model id sent to the provider, e.g. "claude-sonnet-4-5" or "glm-4.6".
    pub model: String,
    /// API base URL. Required for openai-compat/openai-responses/pi-messages;
    /// other providers default per [`resolve_base_url`].
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u64,
    /// Context window for the hand-declared model, in tokens. Optional;
    /// defaults to [`DEFAULT_CONTEXT_WINDOW`]. Catalog-based models with
    /// real per-model metadata arrive in M2e.
    #[serde(default = "default_context_window")]
    pub context_window: u64,
}

fn default_max_tokens() -> u64 {
    8192
}

fn default_context_window() -> u64 {
    DEFAULT_CONTEXT_WINDOW
}

impl Default for Config {
    fn default() -> Self {
        Config {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-5".into(),
            base_url: None,
            max_tokens: default_max_tokens(),
            context_window: default_context_window(),
        }
    }
}

/// The wire-protocol API id a configured provider id speaks (fills
/// `Model.api`). Ids are the upstream `KnownApi` strings
/// (packages/ai/src/types.ts:17-27).
pub fn api_for_provider(provider: &str) -> anyhow::Result<&'static str> {
    match provider {
        "anthropic" => Ok("anthropic-messages"),
        "openai-compat" => Ok("openai-completions"),
        "openai-responses" => Ok("openai-responses"),
        "azure-openai-responses" => Ok("azure-openai-responses"),
        "openai-codex" => Ok("openai-codex-responses"),
        "google" => Ok("google-generative-ai"),
        "google-vertex" => Ok("google-vertex"),
        "mistral" => Ok("mistral-conversations"),
        "amazon-bedrock" => Ok("bedrock-converse-stream"),
        "pi-messages" => Ok("pi-messages"),
        other => anyhow::bail!("unknown provider: {other}"),
    }
}

/// Base URL for the model/endpoint: the configured value, or the provider's
/// upstream default. Defaults mirror the upstream provider registry
/// (`packages/ai/src/providers/*.ts`); an empty default means the API
/// implementation resolves the endpoint itself (azure: the
/// `AZURE_OPENAI_BASE_URL`/`AZURE_OPENAI_RESOURCE_NAME` env chain; vertex:
/// the express/global default base). `openai-compat`/`openai-responses`/
/// `pi-messages` callers must have validated a base URL exists (main does,
/// after CLI overrides are merged).
pub fn resolve_base_url(cfg: &Config) -> anyhow::Result<String> {
    match &cfg.base_url {
        Some(url) => Ok(url.clone()),
        None => match cfg.provider.as_str() {
            "anthropic" => Ok("https://api.anthropic.com".to_string()),
            // providers/google.ts:10
            "google" => Ok("https://generativelanguage.googleapis.com/v1beta".to_string()),
            // providers/openai-codex.ts:11; the API impl falls back to the
            // same default, so this only makes Model.base_url self-describing.
            "openai-codex" => Ok("https://chatgpt.com/backend-api".to_string()),
            // providers/mistral.ts:10
            "mistral" => Ok("https://api.mistral.ai".to_string()),
            // Upstream bedrock has no provider base URL (the SDK resolves the
            // regional endpoint) and defaults the region to us-east-1
            // (bedrock-converse-stream.ts:202); a standard endpoint base
            // reproduces both in the port's endpoint resolution matrix.
            "amazon-bedrock" => Ok("https://bedrock-runtime.us-east-1.amazonaws.com".to_string()),
            // Azure resolves from its env chain inside the API impl (erroring
            // with the upstream message when unset); vertex falls back to the
            // express/global default base.
            "azure-openai-responses" | "google-vertex" => Ok(String::new()),
            _ => anyhow::bail!(
                "provider '{}' requires --base-url or base_url in config",
                cfg.provider
            ),
        },
    }
}

/// Build the hand-declared [`Model`] for one config. Catalog-based models
/// with real names, pricing, and capability metadata arrive in M2e; until
/// then every field is the conservative default (no reasoning, text-only,
/// zero cost) and `context_window`/`max_tokens` come from the config.
pub fn build_model(cfg: &Config) -> anyhow::Result<Model> {
    Ok(Model {
        id: cfg.model.clone(),
        name: cfg.model.clone(),
        api: api_for_provider(&cfg.provider)?.to_string(),
        provider: cfg.provider.clone(),
        base_url: resolve_base_url(cfg)?,
        reasoning: false,
        thinking_level_map: None,
        input: vec![ModelInput::Text],
        cost: ModelCost::default(),
        context_window: cfg.context_window,
        max_tokens: cfg.max_tokens,
        sampling_params: None,
        headers: None,
        compat: None,
    })
}

pub fn parse_config(toml_str: &str) -> anyhow::Result<Config> {
    let cfg: Config = toml::from_str(toml_str)?;
    if !PROVIDERS.contains(&cfg.provider.as_str()) {
        anyhow::bail!(
            "unknown provider '{}'; expected one of {:?}",
            cfg.provider,
            PROVIDERS
        );
    }
    // Note: the openai-compat/openai-responses base_url requirement is
    // enforced in main, after CLI overrides are merged, so `--base-url` can
    // satisfy it.
    Ok(cfg)
}

/// Path of the user config file: <config_dir>/pi-rust/config.toml
pub fn config_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("pi-rust").join("config.toml"))
}

pub fn load_config() -> anyhow::Result<Config> {
    match config_path().filter(|p| p.exists()) {
        Some(path) => parse_config(&std::fs::read_to_string(path)?),
        None => Ok(Config::default()),
    }
}

/// Env var candidates consulted (in order) when no explicit key is given.
/// `openai-responses` accepts the same keys as `openai-compat`: both speak
/// the OpenAI family of APIs. New-provider entries mirror upstream
/// `getApiKeyEnvVars` (packages/ai/src/env-api-keys.ts:68-120).
/// `openai-codex` (OAuth), `amazon-bedrock` (ambient AWS credential chain),
/// and `pi-messages` (no upstream env var) have no candidates: they take an
/// explicit `--api-key` only until M2d adds the ambient flows.
pub fn api_key_env_candidates(provider: &str) -> &'static [&'static str] {
    match provider {
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "openai-compat" | "openai-responses" => &[
            "GLM_API_KEY",
            "OPENAI_API_KEY",
            "DEEPSEEK_API_KEY",
            "MOONSHOT_API_KEY",
        ],
        "azure-openai-responses" => &["AZURE_OPENAI_API_KEY"],
        "google" => &["GEMINI_API_KEY"],
        "google-vertex" => &["GOOGLE_CLOUD_API_KEY"],
        "mistral" => &["MISTRAL_API_KEY"],
        _ => &[],
    }
}

/// Key resolution: explicit CLI flag wins, then the provider's env vars.
/// openai-compat/openai-responses accept keys for common compatible vendors
/// (GLM, OpenAI, DeepSeek, Moonshot).
pub fn resolve_api_key(provider: &str, cli_key: Option<&str>) -> Option<String> {
    if let Some(k) = cli_key {
        if !k.is_empty() {
            return Some(k.to_string());
        }
    }
    api_key_env_candidates(provider)
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
}

/// Test-visible variant of env resolution so tests don't race provider env vars.
#[doc(hidden)]
pub fn resolve_api_key_env(env_name: &str, cli_key: Option<&str>) -> Option<String> {
    if let Some(k) = cli_key {
        if !k.is_empty() {
            return Some(k.to_string());
        }
    }
    std::env::var(env_name).ok().filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_config() {
        let cfg = parse_config(
            r#"
provider = "openai-compat"
model = "glm-4.6"
base_url = "https://open.bigmodel.cn/api/paas/v4"
"#,
        )
        .unwrap();
        assert_eq!(cfg.provider, "openai-compat");
        assert_eq!(cfg.model, "glm-4.6");
        assert_eq!(cfg.max_tokens, 8192);
        assert_eq!(cfg.context_window, DEFAULT_CONTEXT_WINDOW);
    }

    #[test]
    fn rejects_unknown_provider_allows_missing_base_url() {
        assert!(parse_config("provider = \"nope\"\nmodel = \"m\"").is_err());
        // openai-compat without base_url is accepted here; main enforces the
        // base_url requirement after CLI overrides are merged.
        assert!(parse_config("provider = \"openai-compat\"\nmodel = \"m\"").is_ok());
        assert!(parse_config("provider = \"openai-responses\"\nmodel = \"m\"").is_ok());
    }

    #[test]
    fn cli_key_wins_over_env() {
        std::env::set_var("PIRS_TEST_KEY_ENV", "env-key");
        let got = resolve_api_key_env("PIRS_TEST_KEY_ENV", Some("cli-key"));
        assert_eq!(got.unwrap(), "cli-key");

        let from_env = resolve_api_key_env("PIRS_TEST_KEY_ENV", None);
        assert_eq!(from_env.unwrap(), "env-key");

        let missing = resolve_api_key_env("PIRS_TEST_KEY_MISSING", None);
        assert!(missing.is_none());
    }

    // ---- Task 9: hand-declared Model construction (catalog lands in M2e) ----

    fn cfg_with(provider: &str, toml_extra: &str) -> Config {
        let toml = format!("provider = \"{provider}\"\nmodel = \"m-1\"\n{toml_extra}");
        parse_config(&toml).unwrap()
    }

    #[test]
    fn api_maps_per_provider() {
        assert_eq!(api_for_provider("anthropic").unwrap(), "anthropic-messages");
        assert_eq!(
            api_for_provider("openai-compat").unwrap(),
            "openai-completions"
        );
        assert_eq!(
            api_for_provider("openai-responses").unwrap(),
            "openai-responses"
        );
        // Upstream KnownApi wire ids (types.ts:17-27).
        assert_eq!(
            api_for_provider("azure-openai-responses").unwrap(),
            "azure-openai-responses"
        );
        assert_eq!(
            api_for_provider("openai-codex").unwrap(),
            "openai-codex-responses"
        );
        assert_eq!(api_for_provider("google").unwrap(), "google-generative-ai");
        assert_eq!(api_for_provider("google-vertex").unwrap(), "google-vertex");
        assert_eq!(
            api_for_provider("mistral").unwrap(),
            "mistral-conversations"
        );
        assert_eq!(
            api_for_provider("amazon-bedrock").unwrap(),
            "bedrock-converse-stream"
        );
        assert_eq!(api_for_provider("pi-messages").unwrap(), "pi-messages");
        assert!(api_for_provider("nope").is_err());
    }

    #[test]
    fn build_model_fields_come_from_config() {
        let cfg = cfg_with("anthropic", "max_tokens = 4096\ncontext_window = 128000");
        let model = build_model(&cfg).unwrap();
        assert_eq!(model.id, "m-1");
        assert_eq!(model.name, "m-1");
        assert_eq!(model.api, "anthropic-messages");
        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.base_url, "https://api.anthropic.com");
        assert!(!model.reasoning);
        assert_eq!(model.input, vec![ModelInput::Text]);
        assert_eq!(model.cost, ModelCost::default());
        assert_eq!(model.context_window, 128_000);
        assert_eq!(model.max_tokens, 4096);
        assert_eq!(model.thinking_level_map, None);
        assert_eq!(model.sampling_params, None);
        assert_eq!(model.headers, None);
        assert_eq!(model.compat, None);
    }

    #[test]
    fn context_window_defaults_and_overrides_base_url_resolved() {
        // Default context window; openai-compat base_url resolves from config.
        let cfg = cfg_with("openai-compat", "base_url = \"https://example.com/v4\"");
        let model = build_model(&cfg).unwrap();
        assert_eq!(model.context_window, DEFAULT_CONTEXT_WINDOW);
        assert_eq!(model.base_url, "https://example.com/v4");
        assert_eq!(model.api, "openai-completions");

        // openai-compat/openai-responses without a base URL are an error at
        // model-build time too (main rejects them earlier).
        let cfg = cfg_with("openai-responses", "");
        assert!(build_model(&cfg).is_err());
    }

    #[test]
    fn openai_responses_shares_openai_compat_key_envs() {
        assert_eq!(
            api_key_env_candidates("openai-responses"),
            api_key_env_candidates("openai-compat")
        );
        assert_eq!(api_key_env_candidates("anthropic"), &["ANTHROPIC_API_KEY"]);
        assert!(PROVIDERS.contains(&"openai-responses"));
    }

    // ---- Task 9: full provider surface wired ----

    #[test]
    fn new_provider_env_candidates_follow_upstream() {
        // env-api-keys.ts getApiKeyEnvVars entries.
        assert_eq!(
            api_key_env_candidates("azure-openai-responses"),
            &["AZURE_OPENAI_API_KEY"]
        );
        assert_eq!(api_key_env_candidates("google"), &["GEMINI_API_KEY"]);
        assert_eq!(
            api_key_env_candidates("google-vertex"),
            &["GOOGLE_CLOUD_API_KEY"]
        );
        assert_eq!(api_key_env_candidates("mistral"), &["MISTRAL_API_KEY"]);
        // No upstream env vars: codex is OAuth (M2d), bedrock uses the ambient
        // AWS credential chain (M2d), pi-messages defines none.
        assert!(api_key_env_candidates("openai-codex").is_empty());
        assert!(api_key_env_candidates("amazon-bedrock").is_empty());
        assert!(api_key_env_candidates("pi-messages").is_empty());
    }

    #[test]
    fn explicit_only_providers_skip_env_and_honor_cli_key() {
        // Empty candidate lists never consult process env, so these are
        // race-free without the resolve_api_key_env seam.
        assert!(resolve_api_key("openai-codex", None).is_none());
        assert!(resolve_api_key("amazon-bedrock", None).is_none());
        assert!(resolve_api_key("pi-messages", None).is_none());
        // A CLI key wins before any env lookup happens.
        assert_eq!(
            resolve_api_key("amazon-bedrock", Some("bearer-token")).unwrap(),
            "bearer-token"
        );
    }

    #[test]
    fn base_url_defaults_match_upstream_providers() {
        // google (providers/google.ts:10), codex (providers/openai-codex.ts:11),
        // mistral (providers/mistral.ts:10), bedrock (standard us-east-1
        // endpoint, upstream region default).
        let cases = [
            ("google", "https://generativelanguage.googleapis.com/v1beta"),
            ("openai-codex", "https://chatgpt.com/backend-api"),
            ("mistral", "https://api.mistral.ai"),
            (
                "amazon-bedrock",
                "https://bedrock-runtime.us-east-1.amazonaws.com",
            ),
        ];
        for (provider, base_url) in cases {
            let cfg = cfg_with(provider, "");
            assert_eq!(resolve_base_url(&cfg).unwrap(), base_url, "{provider}");
        }

        // azure/vertex stay empty: the API impls resolve their own endpoint
        // (azure env chain; vertex express/global default).
        for provider in ["azure-openai-responses", "google-vertex"] {
            let cfg = cfg_with(provider, "");
            assert_eq!(resolve_base_url(&cfg).unwrap(), "", "{provider}");
        }

        // pi-messages names the pi server endpoint: required, like the
        // openai-* family.
        let cfg = cfg_with("pi-messages", "");
        assert!(resolve_base_url(&cfg).is_err());
        let cfg = cfg_with("pi-messages", "base_url = \"https://pi.example.com\"");
        assert_eq!(resolve_base_url(&cfg).unwrap(), "https://pi.example.com");

        // Every provider in PROVIDERS either resolves or requires a base URL
        // (never panics); build_model consumes the same resolution.
        for provider in PROVIDERS {
            let cfg = cfg_with(provider, "");
            let _ = resolve_base_url(&cfg);
        }
    }
}
