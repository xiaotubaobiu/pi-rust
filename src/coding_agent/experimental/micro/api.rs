//! Port of upstream `micro/api.ts` (view + controller data model).

use serde_json::Value;

/// Upstream `MicroNotice`.
#[derive(Debug, Clone, PartialEq)]
pub struct MicroNotice {
    pub id: u64,
    pub level: NoticeLevel,
    pub message: String,
}

/// Upstream notice levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

impl NoticeLevel {
    /// Upstream `#syncNotices` color mapping.
    pub fn color(self) -> &'static str {
        match self {
            NoticeLevel::Error => "error",
            NoticeLevel::Warning => "warning",
            _ => "muted",
        }
    }
}

/// Upstream `MicroModelSummary`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicroModelSummary {
    pub provider: String,
    pub model_id: String,
    pub name: String,
    pub context_window: u64,
    pub max_tokens: u64,
}

/// Upstream `MicroProviderAccount`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MicroProviderAccount {
    pub id: String,
    pub name: String,
    pub auth_type: AuthType,
    pub configured: bool,
    pub source: Option<String>,
    pub interactive: bool,
    pub method_name: Option<String>,
}

/// Upstream `"oauth" | "api_key"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AuthType {
    #[default]
    Oauth,
    ApiKey,
}

impl AuthType {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthType::Oauth => "oauth",
            AuthType::ApiKey => "api_key",
        }
    }
}

/// Upstream `MicroModelsView`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MicroModelsView {
    pub models: Vec<MicroModelSummary>,
    pub accounts: Vec<MicroProviderAccount>,
    pub refreshing: bool,
}

/// Upstream `MicroUsageView`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MicroUsageView {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub total_cost: f64,
    pub last_cache_hit_rate: Option<f64>,
    pub context_tokens: Option<f64>,
    pub context_window: u64,
    pub context_percent: Option<f64>,
}

/// Upstream `MicroView` face (the conversation is carried as the JSON value
/// the harness replicates; only the config fields the port reads are
/// structured).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MicroView {
    pub session: SessionRef,
    pub model_ref: Option<ModelRef>,
    pub thinking_level: Option<String>,
    pub threshold: Option<f64>,
    pub compaction: Option<CompactionState>,
    pub generation: Option<GenerationState>,
    pub running_tool: Option<RunningToolView>,
    pub turn_active: bool,
    pub inbox: Vec<InboxItem>,
    pub models: MicroModelsView,
    pub usage: MicroUsageView,
    pub notices: Vec<MicroNotice>,
    pub fatal: Option<String>,
}

/// Upstream `session: { id, path, cwd }`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionRef {
    pub id: String,
    pub path: String,
    pub cwd: String,
}

/// Upstream pico3 `ModelRef`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRef {
    pub provider: String,
    pub model_id: String,
}

/// Upstream compaction state face.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionState {
    pub reason: String,
    pub stage: Option<String>,
    pub attempt: u64,
    pub task_id: Option<String>,
}

/// Upstream generation state face.
#[derive(Debug, Clone, PartialEq)]
pub struct GenerationState {
    pub stage: String,
    pub attempt: u64,
}

/// Upstream running tool face.
#[derive(Debug, Clone, PartialEq)]
pub struct RunningToolView {
    pub name: String,
}

/// Upstream inbox item face (`queued.mode` + input).
#[derive(Debug, Clone, PartialEq)]
pub enum InboxItem {
    Message { mode: String, text: String },
    Write { mode: String, entry_kind: String },
}

/// Upstream `MicroAuthView` face (notices carried as opaque JSON events).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MicroAuthView {
    pub provider_id: String,
    pub provider_name: String,
    pub auth_type: AuthType,
    pub notices: Vec<Value>,
    pub prompt: Option<AuthPromptRequestView>,
}

/// Upstream `AuthPromptRequest` face.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthPromptRequestView {
    pub id: String,
    pub kind: String,
    pub message: String,
    pub options: Vec<(String, String)>,
}

/// Upstream `MicroViewSource`: `current()` + subscribe.
pub trait MicroViewSource {
    fn current(&self) -> MicroView;
}

/// Upstream `#syncStatus` decision chain (`micro/tui.ts`), exported here for
/// reuse by the notice fold: the exact status text for a view.
pub fn status_text(view: &MicroView) -> String {
    if let Some(fatal) = &view.fatal {
        return format!("Fatal: {fatal}");
    }
    if let Some(compaction) = &view.compaction {
        let reason = if compaction.reason == "threshold" {
            "automatic".to_string()
        } else {
            compaction.reason.clone()
        };
        return if compaction.stage.as_deref() == Some("retrying") {
            format!(
                "Retrying {reason} compaction (attempt {})...",
                compaction.attempt
            )
        } else {
            format!("Running {reason} compaction...")
        };
    }
    if let Some(generation) = &view.generation {
        return match generation.stage.as_str() {
            "retrying" => format!("Retrying generation (attempt {})...", generation.attempt),
            "deferred" => "Waiting for deferred response...".to_string(),
            "waiting" => "Waiting for compaction...".to_string(),
            "streaming" => "Working... (esc to abort)".to_string(),
            _ => "Preparing response...".to_string(),
        };
    }
    if let Some(running_tool) = &view.running_tool {
        return format!("Running {}... (esc to abort)", running_tool.name);
    }
    String::new()
}
