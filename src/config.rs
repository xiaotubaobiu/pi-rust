use serde::{Deserialize, Serialize};

use crate::ai::types::{Model, ModelCost, ModelInput};

pub const PROVIDERS: &[&str] = &["anthropic", "openai-compat", "openai-responses"];

/// Default context window for hand-declared models (no catalog lookup yet).
pub const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// "anthropic", "openai-compat", or "openai-responses"
    pub provider: String,
    /// Model id sent to the provider, e.g. "claude-sonnet-4-5" or "glm-4.6".
    pub model: String,
    /// API base URL. Required for openai-compat/openai-responses; default
    /// https://api.anthropic.com for anthropic.
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

/// The wire-protocol API id a configured provider speaks (fills
/// `Model.api`). One provider id per supported wire protocol.
pub fn api_for_provider(provider: &str) -> anyhow::Result<&'static str> {
    match provider {
        "anthropic" => Ok("anthropic-messages"),
        "openai-compat" => Ok("openai-completions"),
        "openai-responses" => Ok("openai-responses"),
        other => anyhow::bail!("unknown provider: {other}"),
    }
}

/// Base URL for the model/endpoint: the configured value, or the Anthropic
/// default. `openai-compat`/`openai-responses` callers must have validated a
/// base URL exists (main does, after CLI overrides are merged).
pub fn resolve_base_url(cfg: &Config) -> anyhow::Result<String> {
    match &cfg.base_url {
        Some(url) => Ok(url.clone()),
        None if cfg.provider == "anthropic" => Ok("https://api.anthropic.com".to_string()),
        None => anyhow::bail!(
            "provider '{}' requires --base-url or base_url in config",
            cfg.provider
        ),
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
/// the OpenAI family of APIs.
pub fn api_key_env_candidates(provider: &str) -> &'static [&'static str] {
    match provider {
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "openai-compat" | "openai-responses" => &[
            "GLM_API_KEY",
            "OPENAI_API_KEY",
            "DEEPSEEK_API_KEY",
            "MOONSHOT_API_KEY",
        ],
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
}
