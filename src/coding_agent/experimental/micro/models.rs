//! Port of upstream `micro/models.ts` (request grouping + catalog views).

use super::api::{AuthType, MicroModelSummary, MicroModelsView, MicroProviderAccount, ModelRef};
use serde_json::Value;

/// Upstream `ModelToolMetadata`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ModelToolMetadata {
    pub constrained_sampling: Option<bool>,
}

/// Upstream `toAiContext`: fold system messages into the system prompt and
/// the tool table; non-system messages pass through in order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AiContext {
    pub system_prompt: Option<String>,
    pub tools: Vec<ToolSpec>,
    pub non_system_message_count: usize,
}

/// Upstream tool entry in the folded context.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub constrained_sampling: Option<bool>,
}

/// Upstream system-message face.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SystemMessage {
    pub content: Option<String>,
    pub tools_removed: Vec<String>,
    pub tools_added: Vec<ToolDeclarationInput>,
}

/// Upstream `toolsAdded` entry.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolDeclarationInput {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// Upstream `toAiContext`. Returns the folded context; the caller forwards
/// the non-system messages verbatim.
pub fn to_ai_context(
    system_messages: &[SystemMessage],
    non_system_message_count: usize,
    tool_metadata: &std::collections::HashMap<String, ModelToolMetadata>,
) -> AiContext {
    let mut system_prompt: Vec<String> = Vec::new();
    let mut tools: Vec<ToolSpec> = Vec::new();
    for system in system_messages {
        if let Some(content) = &system.content {
            system_prompt.push(content.clone());
        }
        for removed in &system.tools_removed {
            tools.retain(|tool| &tool.name != removed);
        }
        for added in &system.tools_added {
            let metadata = tool_metadata.get(&added.name);
            tools.retain(|tool| tool.name != added.name);
            tools.push(ToolSpec {
                name: added.name.clone(),
                description: added.description.clone(),
                parameters: added.parameters.clone(),
                constrained_sampling: metadata.and_then(|metadata| metadata.constrained_sampling),
            });
        }
    }
    AiContext {
        system_prompt: if system_prompt.is_empty() {
            None
        } else {
            Some(system_prompt.join("\n\n"))
        },
        tools,
        non_system_message_count,
    }
}

/// Upstream `readModelsView` runtime face (D17 seam).
pub trait ModelRuntimeView {
    /// `getAvailableSnapshot()`.
    fn available_models(&self) -> Vec<MicroModelSummary>;
    /// `getProviders()`: (id, name, oauth name?, api key name?, api key login?).
    fn providers(&self) -> Vec<ProviderFace>;
    /// `getProviderAuthStatus(id)`: (configured, label?, source?).
    fn provider_auth_status(&self, provider_id: &str) -> (bool, Option<String>, Option<String>);
}

/// Upstream provider record face.
pub struct ProviderFace {
    pub id: String,
    pub name: String,
    pub oauth_name: Option<String>,
    pub api_key_name: Option<String>,
    pub api_key_login: bool,
}

/// Upstream `readModelsView`: snapshot + account construction sorted by
/// display name.
pub fn read_models_view(runtime: &dyn ModelRuntimeView, refreshing: bool) -> MicroModelsView {
    let models = runtime.available_models();
    let mut accounts: Vec<MicroProviderAccount> = Vec::new();
    for provider in runtime.providers() {
        let (configured, label, source) = runtime.provider_auth_status(&provider.id);
        let shared_source = label.or(source);
        if let Some(oauth_name) = provider.oauth_name {
            accounts.push(MicroProviderAccount {
                id: provider.id.clone(),
                name: provider.name.clone(),
                auth_type: AuthType::Oauth,
                configured,
                source: shared_source.clone(),
                interactive: true,
                method_name: Some(oauth_name),
            });
        }
        if let Some(api_key_name) = provider.api_key_name {
            accounts.push(MicroProviderAccount {
                id: provider.id.clone(),
                name: provider.name.clone(),
                auth_type: AuthType::ApiKey,
                configured,
                source: shared_source,
                interactive: provider.api_key_login,
                method_name: Some(api_key_name),
            });
        }
    }
    // Upstream: `accounts.sort((left, right) => left.name.localeCompare(right.name))`.
    accounts.sort_by(|left, right| left.name.cmp(&right.name));
    MicroModelsView {
        models,
        accounts,
        refreshing,
    }
}

/// Upstream `modelRef` shape guard.
pub fn model_ref(provider: Option<&str>, model_id: Option<&str>) -> Option<ModelRef> {
    match (provider, model_id) {
        (Some(provider), Some(model_id)) => Some(ModelRef {
            provider: provider.to_string(),
            model_id: model_id.to_string(),
        }),
        _ => None,
    }
}
