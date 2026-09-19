use serde::{Deserialize, Serialize};

pub const PROVIDERS: &[&str] = &["anthropic", "openai-compat"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// "anthropic" or "openai-compat"
    pub provider: String,
    /// Model id sent to the provider, e.g. "claude-sonnet-4-5" or "glm-4.6".
    pub model: String,
    /// API base URL. Required for openai-compat; default https://api.anthropic.com for anthropic.
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u64,
}

fn default_max_tokens() -> u64 {
    8192
}

impl Default for Config {
    fn default() -> Self {
        Config {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-5".into(),
            base_url: None,
            max_tokens: default_max_tokens(),
        }
    }
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
    if cfg.provider == "openai-compat" && cfg.base_url.is_none() {
        anyhow::bail!("openai-compat requires base_url in config or --base-url");
    }
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

/// Key resolution: explicit CLI flag wins, then the provider's env vars.
/// openai-compat accepts keys for common compatible vendors (GLM, OpenAI, DeepSeek, Moonshot).
pub fn resolve_api_key(provider: &str, cli_key: Option<&str>) -> Option<String> {
    if let Some(k) = cli_key {
        if !k.is_empty() {
            return Some(k.to_string());
        }
    }
    let candidates: &[&str] = match provider {
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "openai-compat" => &[
            "GLM_API_KEY",
            "OPENAI_API_KEY",
            "DEEPSEEK_API_KEY",
            "MOONSHOT_API_KEY",
        ],
        _ => &[],
    };
    candidates
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
    }

    #[test]
    fn rejects_unknown_provider_and_missing_base_url() {
        assert!(parse_config("provider = \"nope\"\nmodel = \"m\"").is_err());
        assert!(parse_config("provider = \"openai-compat\"\nmodel = \"m\"").is_err());
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
}
