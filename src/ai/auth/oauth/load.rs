//! OAuth flow loader registry ported from upstream
//! `packages/ai/src/auth/oauth/load.ts`: one factory per login flow.
//!
//! Port notes (disclosed divergences):
//! - Upstream loads each flow through a variable dynamic `import()` so
//!   bundlers cannot follow the import into Node-only flow code
//!   (`node:http` callback servers, `node:crypto` PKCE), plus a
//!   `registerBundledOAuthFlowLoaders` registry for standalone Bun binaries.
//!   Rust has no browser bundle target and links everything statically, so
//!   the loader is a plain factory registry: each function constructs the
//!   flow it names and there is no bundled-loader override.

use std::sync::Arc;

use super::anthropic::AnthropicOAuth;
use super::github_copilot::GitHubCopilotOAuth;
use super::kimi_coding::KimiCodingOAuth;
use super::openai_codex::OpenAICodexOAuth;
use super::openrouter::OpenRouterOAuth;
use super::radius::{create_radius_oauth, RadiusOAuthOptions};
use super::xai::XaiOAuth;
use crate::ai::auth::types::OAuthAuth;

/// Upstream `loadAnthropicOAuth` (load.ts:31-34).
pub fn load_anthropic_oauth() -> Arc<dyn OAuthAuth> {
    Arc::new(AnthropicOAuth::new())
}

/// Upstream `loadOpenAICodexOAuth` (load.ts:36-39).
pub fn load_openai_codex_oauth() -> Arc<dyn OAuthAuth> {
    Arc::new(OpenAICodexOAuth::new())
}

/// Upstream `loadGitHubCopilotOAuth` (load.ts:41-44).
pub fn load_github_copilot_oauth() -> Arc<dyn OAuthAuth> {
    Arc::new(GitHubCopilotOAuth::new())
}

/// Upstream `loadOpenRouterOAuth` (load.ts:46-49).
pub fn load_openrouter_oauth() -> Arc<dyn OAuthAuth> {
    Arc::new(OpenRouterOAuth::new())
}

/// Upstream `loadKimiCodingOAuth` (load.ts:51-54).
pub fn load_kimi_coding_oauth() -> Arc<dyn OAuthAuth> {
    Arc::new(KimiCodingOAuth::new())
}

/// Upstream `loadXaiOAuth` (load.ts:56-59).
pub fn load_xai_oauth() -> Arc<dyn OAuthAuth> {
    Arc::new(XaiOAuth::new())
}

/// Upstream `loadRadiusOAuth` (load.ts:61-68): the Radius flow is created
/// per provider from its display name and gateway URL.
pub fn load_radius_oauth(options: RadiusOAuthOptions) -> Arc<dyn OAuthAuth> {
    Arc::new(create_radius_oauth(options))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every loader constructs the flow it names (upstream resolves the
    /// module export by the same name).
    #[test]
    fn loaders_construct_their_flows() {
        assert_eq!(load_anthropic_oauth().name(), "Anthropic (Claude Pro/Max)");
        assert_eq!(
            load_openai_codex_oauth().name(),
            "OpenAI (ChatGPT Plus/Pro)"
        );
        assert_eq!(load_github_copilot_oauth().name(), "GitHub Copilot");
        assert_eq!(load_openrouter_oauth().name(), "OpenRouter OAuth");
        assert_eq!(load_kimi_coding_oauth().name(), "Kimi Code (subscription)");
        assert_eq!(load_xai_oauth().name(), "xAI (Grok/X subscription)");
        assert_eq!(
            load_radius_oauth(RadiusOAuthOptions {
                name: "Radius".to_string(),
                gateway: "https://radius.example".to_string(),
            })
            .name(),
            "Radius"
        );
    }
}
