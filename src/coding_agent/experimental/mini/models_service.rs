//! Port of upstream `mini/worker/models-service.ts`: the worker-side
//! `Models` service's deterministic faces. `ModelRuntime` and the catalog
//! refresh are embedder-owned (D18).

use super::protocol::{CommandResult, ModelsState, ProviderAccount};

/// Upstream `readState`: snapshot models pass through; accounts are built
/// per provider auth and sorted by display name. Note the upstream
/// `status.label ?? status.source === undefined` parenthesization: the
/// source key is present whenever `label` is defined, OR `source` is.
pub fn read_state(
    models: Vec<super::protocol::ModelSummary>,
    providers: &[ProviderRuntimeFace],
    refreshing: bool,
) -> ModelsState {
    let mut accounts: Vec<ProviderAccount> = Vec::new();
    for provider in providers {
        let shared_source = match (&provider.status.label, &provider.status.source) {
            (Some(label), _) => Some(label.clone()),
            (None, Some(source)) => Some(source.clone()),
            (None, None) => None,
        };
        if let Some(oauth_name) = &provider.oauth_name {
            accounts.push(ProviderAccount {
                id: provider.id.clone(),
                name: provider.name.clone(),
                auth_type: "oauth".to_string(),
                configured: provider.status.configured,
                source: shared_source.clone(),
                interactive: true,
                method_name: Some(oauth_name.clone()),
            });
        }
        if let Some(api_key_name) = &provider.api_key_name {
            accounts.push(ProviderAccount {
                id: provider.id.clone(),
                name: provider.name.clone(),
                auth_type: "api_key".to_string(),
                configured: provider.status.configured,
                source: shared_source,
                interactive: provider.api_key_login,
                method_name: Some(api_key_name.clone()),
            });
        }
    }
    accounts.sort_by(|left, right| left.name.cmp(&right.name));
    ModelsState {
        models,
        accounts,
        refreshing,
    }
}

/// Upstream provider record face (`runtime.getProviders()`).
pub struct ProviderRuntimeFace {
    pub id: String,
    pub name: String,
    pub oauth_name: Option<String>,
    pub api_key_name: Option<String>,
    pub api_key_login: bool,
    pub status: ProviderAuthStatusFace,
}

/// Upstream `getProviderAuthStatus` face.
pub struct ProviderAuthStatusFace {
    pub configured: bool,
    pub label: Option<String>,
    pub source: Option<String>,
}

/// Upstream `ModelsService.refresh` outcome: empty error set succeeds,
/// otherwise the exact upstream message.
pub fn refresh_result(errors: &[String]) -> CommandResult {
    if errors.is_empty() {
        CommandResult::ok()
    } else {
        CommandResult::error(format!(
            "Some catalogs could not be refreshed: {}",
            errors.join(", ")
        ))
    }
}

/// Upstream `ModelsService.login`/`logout` error mapping.
pub fn auth_command_result(result: Result<(), String>) -> CommandResult {
    match result {
        Ok(()) => CommandResult::ok(),
        Err(message) => CommandResult::error(message),
    }
}

/// Upstream `authReply`: delete the waiter and settle with the answer.
pub fn auth_reply(
    pending: &mut Vec<(String, Option<String>)>,
    request_id: &str,
    answer: Option<String>,
) -> Option<Option<String>> {
    let index = pending.iter().position(|(id, _)| id == request_id)?;
    let (_, waiter) = pending.remove(index);
    let _ = waiter;
    Some(answer)
}

/// Upstream `#ask` cancellation text.
pub const LOGIN_CANCELLED: &str = "Login cancelled";
