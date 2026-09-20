use anyhow::{bail, Context as AnyhowContext, Result};
use clap::Parser;
use pi_rust::agent::session::SessionWriter;
use pi_rust::agent::tools::builtin_tools;
use pi_rust::agent::Agent;
use pi_rust::ai::api::anthropic::AnthropicMessages;
use pi_rust::ai::api::openai_completions::OpenAiCompletions;
use pi_rust::ai::api::openai_responses::OpenAiResponses;
use pi_rust::ai::{ApiImpl, ProviderConfig};
use pi_rust::cli::repl;
use pi_rust::config::{
    build_model, load_config, resolve_api_key, resolve_base_url, Config, PROVIDERS,
};
use std::sync::Arc;

#[derive(Parser)]
#[command(
    name = "pirs",
    version,
    about = "Minimal coding agent CLI (Rust rewrite of pi)"
)]
struct Args {
    /// Provider: anthropic | openai-compat | openai-responses
    #[arg(long)]
    provider: Option<String>,
    /// Model id, e.g. claude-sonnet-4-5 or glm-4.6
    #[arg(long)]
    model: Option<String>,
    /// API base URL (required for openai-compat/openai-responses)
    #[arg(long)]
    base_url: Option<String>,
    /// API key (overrides env resolution)
    #[arg(long)]
    api_key: Option<String>,
}

/// One wire protocol per provider id; the API implementations are unit
/// structs, so selection is a plain constructor pick.
fn select_api(provider: &str) -> Result<Arc<dyn ApiImpl>> {
    Ok(match provider {
        "anthropic" => Arc::new(AnthropicMessages),
        "openai-compat" => Arc::new(OpenAiCompletions),
        "openai-responses" => Arc::new(OpenAiResponses),
        other => bail!("unknown provider: {other}"),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut cfg: Config = load_config()?;
    if let Some(p) = args.provider {
        cfg.provider = p;
    }
    if let Some(m) = args.model {
        cfg.model = m;
    }
    if args.base_url.is_some() {
        cfg.base_url = args.base_url.clone();
    }

    // Validate after merging CLI overrides (a config-only check would reject
    // valid `--base-url` overrides), and before resolving the API key so an
    // unknown provider reports a provider error, not a missing-key error.
    if !PROVIDERS.contains(&cfg.provider.as_str()) {
        bail!(
            "unknown provider '{}'; expected one of {:?}",
            cfg.provider,
            PROVIDERS
        );
    }
    if matches!(cfg.provider.as_str(), "openai-compat" | "openai-responses")
        && cfg.base_url.is_none()
    {
        bail!("{} requires --base-url or base_url in config", cfg.provider);
    }

    let key = resolve_api_key(&cfg.provider, args.api_key.as_deref()).context(
        "no API key found: set ANTHROPIC_API_KEY (anthropic) or GLM_API_KEY/OPENAI_API_KEY \
         (openai-compat/openai-responses), or pass --api-key",
    )?;

    let pcfg = ProviderConfig {
        base_url: resolve_base_url(&cfg)?,
        api_key: key,
        max_tokens: cfg.max_tokens,
    };
    let model = build_model(&cfg)?;

    let provider = select_api(&cfg.provider)?;

    let mut agent = Agent::new(
        provider,
        pcfg,
        model,
        builtin_tools(),
        repl::SYSTEM_PROMPT.to_string(),
    );
    let sessions_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("pi-rust")
        .join("sessions");
    let mut session = SessionWriter::create(&sessions_dir)?;
    println!("session: {}", session.path().display());

    repl::run(&mut agent, &mut session, &cfg.model).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_api_maps_each_provider() {
        // The impls are unit structs; pin the selection succeeds for every
        // supported provider (per-protocol behavior is pinned by the
        // api module and agent-on-API integration tests).
        assert!(select_api("anthropic").is_ok());
        assert!(select_api("openai-compat").is_ok());
        assert!(select_api("openai-responses").is_ok());
    }

    #[test]
    fn select_api_rejects_unknown_provider() {
        match select_api("nope") {
            Err(err) => assert!(err.to_string().contains("unknown provider"), "{err}"),
            Ok(_) => panic!("expected unknown provider to be rejected"),
        }
    }
}
