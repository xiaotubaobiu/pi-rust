use anyhow::{bail, Context as AnyhowContext, Result};
use clap::Parser;
use pi_rust::agent::session::SessionWriter;
use pi_rust::agent::tools::builtin_tools;
use pi_rust::agent::Agent;
use pi_rust::ai::anthropic::AnthropicProvider;
use pi_rust::ai::openai_compat::OpenAiCompatProvider;
use pi_rust::ai::{Provider, ProviderConfig};
use pi_rust::cli::repl;
use pi_rust::config::{load_config, resolve_api_key, Config};
use std::sync::Arc;

#[derive(Parser)]
#[command(
    name = "pirs",
    version,
    about = "Minimal coding agent CLI (Rust rewrite of pi)"
)]
struct Args {
    /// Provider: anthropic | openai-compat
    #[arg(long)]
    provider: Option<String>,
    /// Model id, e.g. claude-sonnet-4-5 or glm-4.6
    #[arg(long)]
    model: Option<String>,
    /// API base URL (required for openai-compat)
    #[arg(long)]
    base_url: Option<String>,
    /// API key (overrides env resolution)
    #[arg(long)]
    api_key: Option<String>,
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

    let key = resolve_api_key(&cfg.provider, args.api_key.as_deref())
        .context("no API key found: set ANTHROPIC_API_KEY (anthropic) or GLM_API_KEY/OPENAI_API_KEY (openai-compat), or pass --api-key")?;

    let pcfg = ProviderConfig {
        base_url: match (cfg.provider.as_str(), &cfg.base_url) {
            (_, Some(url)) => url.clone(),
            ("anthropic", None) => "https://api.anthropic.com".into(),
            _ => bail!("openai-compat requires --base-url or base_url in config"),
        },
        api_key: key,
        model: cfg.model.clone(),
        max_tokens: cfg.max_tokens,
    };

    let provider: Arc<dyn Provider> = match cfg.provider.as_str() {
        "anthropic" => Arc::new(AnthropicProvider::new(pcfg)),
        "openai-compat" => Arc::new(OpenAiCompatProvider::new(pcfg)),
        other => bail!("unknown provider: {other}"),
    };

    let mut agent = Agent::new(provider, builtin_tools(), repl::SYSTEM_PROMPT.to_string());
    let sessions_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("pi-rust")
        .join("sessions");
    let mut session = SessionWriter::create(&sessions_dir)?;
    println!("session: {}", session.path().display());

    repl::run(&mut agent, &mut session, &cfg.model).await
}
