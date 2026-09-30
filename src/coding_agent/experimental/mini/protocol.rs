//! Port of upstream `mini/shared/protocol.ts`: service contracts and wire
//! payloads. `Remote<T>`/`ServiceToken<TApi, TEvent>` typing is type-level
//! and maps to the name constants plus payload structs.

use serde::{Deserialize, Serialize};

/// Upstream `CommandResult` — `{ ok: true } | { ok: false; error: string }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CommandResult {
    /// Upstream `{ ok: true }`.
    pub fn ok() -> Self {
        CommandResult {
            ok: true,
            error: None,
        }
    }

    /// Upstream `{ ok: false, error }`.
    pub fn error(message: impl Into<String>) -> Self {
        CommandResult {
            ok: false,
            error: Some(message.into()),
        }
    }
}

/// Upstream `ModelRef`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    pub provider: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
}

/// Upstream `ModelSummary`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSummary {
    pub provider: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub name: String,
}

/// Upstream `ProviderAccount`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderAccount {
    pub id: String,
    pub name: String,
    #[serde(rename = "authType")]
    pub auth_type: String,
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub interactive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method_name: Option<String>,
}

/// Upstream `ModelsState`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ModelsState {
    pub models: Vec<ModelSummary>,
    pub accounts: Vec<ProviderAccount>,
    pub refreshing: bool,
}

/// Upstream `SessionSummary`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: String,
    pub path: String,
    pub cwd: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

/// Upstream `ModelsEvent`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ModelsEvent {
    /// `{ type: "state", state }`.
    State { state: ModelsState },
    /// `{ type: "prompt", requestId, request }`.
    Prompt {
        #[serde(rename = "requestId")]
        request_id: String,
        request: serde_json::Value,
    },
    /// `{ type: "notice", notice }`.
    Notice { notice: serde_json::Value },
}

/// Upstream `LaneSubscription` face (the lane snapshot is the harness's
/// replicated value, carried as JSON here).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LaneSubscription {
    #[serde(rename = "subscriptionId")]
    pub subscription_id: String,
    pub snapshot: serde_json::Value,
}

/// Upstream `LaneEvent`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LaneEvent {
    #[serde(rename = "subscriptionId")]
    pub subscription_id: String,
    pub event: serde_json::Value,
}

/// Upstream `defineService` names (`Lane`/`Models`/`Worker`/`Sessions`).
pub mod service_names {
    /// Upstream `defineService<LaneServiceApi, LaneEvent>("lane")`.
    pub const LANE: &str = "lane";
    /// Upstream `defineService<ModelsServiceApi, ModelsEvent>("models")`.
    pub const MODELS: &str = "models";
    /// Upstream `defineService<WorkerServiceApi>("worker")`.
    pub const WORKER: &str = "worker";
    /// Upstream `defineService<SessionsServiceApi>("sessions")`.
    pub const SESSIONS: &str = "sessions";
}

/// Upstream login labels (`tui/view.ts`).
pub const SUBSCRIPTION_LOGIN_LABEL: &str = "Sign in with an account";
/// Upstream API key login label.
pub const API_KEY_LOGIN_LABEL: &str = "Sign in with an API key";

/// Upstream timing constants.
pub const DEFAULT_DEAD_MS: u64 = 15_000;
/// Upstream `tui/session.ts` `ATTACH_TIMEOUT_MS`.
pub const ATTACH_TIMEOUT_MS: u64 = 60_000;
/// Upstream `server/run.ts` `WORKER_START_TIMEOUT_MS`.
pub const WORKER_START_TIMEOUT_MS: u64 = 30_000;
/// Upstream `server/run.ts` `IDLE_SHUTDOWN_MS`.
pub const IDLE_SHUTDOWN_MS: u64 = 10_000;
/// Upstream `models-service.ts` `CATALOG_REFRESH_TIMEOUT_MS`.
pub const CATALOG_REFRESH_TIMEOUT_MS: u64 = 15_000;
/// Upstream `tui/run.ts` `SERVER_START_TIMEOUT_MS`.
pub const SERVER_START_TIMEOUT_MS: u64 = 10_000;
