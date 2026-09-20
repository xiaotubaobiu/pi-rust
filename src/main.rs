use anyhow::{bail, Context as AnyhowContext, Result};
use clap::Parser;
use pi_rust::agent::session::SessionWriter;
use pi_rust::agent::tools::builtin_tools;
use pi_rust::agent::Agent;
use pi_rust::ai::api::anthropic::AnthropicMessages;
use pi_rust::ai::api::azure_openai_responses::AzureOpenAiResponses;
use pi_rust::ai::api::bedrock::BedrockConverseStream;
use pi_rust::ai::api::google_generative_ai::GoogleGenerativeAi;
use pi_rust::ai::api::google_vertex::GoogleVertex;
use pi_rust::ai::api::mistral::MistralConversations;
use pi_rust::ai::api::openai_codex_responses::OpenAiCodexResponses;
use pi_rust::ai::api::openai_completions::OpenAiCompletions;
use pi_rust::ai::api::openai_responses::OpenAiResponses;
use pi_rust::ai::api::pi_messages::PiMessages;
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
    /// Provider id (see PROVIDERS): anthropic, openai-compat, openai-responses,
    /// azure-openai-responses, openai-codex, google, google-vertex, mistral,
    /// amazon-bedrock, pi-messages
    #[arg(long)]
    provider: Option<String>,
    /// Model id, e.g. claude-sonnet-4-5 or glm-4.6
    #[arg(long)]
    model: Option<String>,
    /// API base URL (required for openai-compat/openai-responses/pi-messages)
    #[arg(long)]
    base_url: Option<String>,
    /// API key (overrides env resolution)
    #[arg(long)]
    api_key: Option<String>,
}

/// One wire protocol per provider id; the API implementations are unit
/// structs, so selection is a plain constructor pick.
///
/// Ambient-auth providers are explicit-key only until M2d:
/// - `google-vertex`: pass an API key (`GOOGLE_CLOUD_API_KEY`/`--api-key`);
///   Application Default Credentials are M2d.
/// - `amazon-bedrock`: pass a bearer token via `--api-key`; AWS profiles and
///   the ambient credential chain are M2d.
/// - `openai-codex`: pass a JWT bearer via `--api-key`; the ChatGPT OAuth
///   flow is M2d.
fn select_api(provider: &str) -> Result<Arc<dyn ApiImpl>> {
    Ok(match provider {
        "anthropic" => Arc::new(AnthropicMessages),
        "openai-compat" => Arc::new(OpenAiCompletions),
        "openai-responses" => Arc::new(OpenAiResponses),
        "azure-openai-responses" => Arc::new(AzureOpenAiResponses),
        "openai-codex" => Arc::new(OpenAiCodexResponses),
        "google" => Arc::new(GoogleGenerativeAi),
        "google-vertex" => Arc::new(GoogleVertex),
        "mistral" => Arc::new(MistralConversations),
        "amazon-bedrock" => Arc::new(BedrockConverseStream),
        "pi-messages" => Arc::new(PiMessages),
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
    // pi-messages posts to `{base_url}/messages` on the pi server; azure
    // resolves its endpoint from env instead, so only these three require it.
    if matches!(
        cfg.provider.as_str(),
        "openai-compat" | "openai-responses" | "pi-messages"
    ) && cfg.base_url.is_none()
    {
        bail!("{} requires --base-url or base_url in config", cfg.provider);
    }

    let key = resolve_api_key(&cfg.provider, args.api_key.as_deref()).context(
        "no API key found: set ANTHROPIC_API_KEY (anthropic), GLM_API_KEY/OPENAI_API_KEY \
         (openai-compat/openai-responses), AZURE_OPENAI_API_KEY (azure-openai-responses), \
         GEMINI_API_KEY (google), GOOGLE_CLOUD_API_KEY (google-vertex), or MISTRAL_API_KEY \
         (mistral); openai-codex/amazon-bedrock/pi-messages need --api-key",
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
        // api module and agent-on-API integration tests). Provider ids are
        // the upstream KnownProvider strings.
        for provider in PROVIDERS {
            assert!(select_api(provider).is_ok(), "{provider} should map");
        }
    }

    #[test]
    fn select_api_covers_all_ten_arms() {
        // Pin each arm explicitly so a PROVIDERS/select_api drift fails here.
        let expected = [
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
        assert_eq!(PROVIDERS, expected);
        for provider in expected {
            assert!(select_api(provider).is_ok());
        }
    }

    #[test]
    fn select_api_rejects_unknown_provider() {
        match select_api("nope") {
            Err(err) => assert!(err.to_string().contains("unknown provider"), "{err}"),
            Ok(_) => panic!("expected unknown provider to be rejected"),
        }
    }
}
