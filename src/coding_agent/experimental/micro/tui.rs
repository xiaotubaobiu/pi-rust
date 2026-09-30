//! Port of upstream `micro/tui.ts` deterministic faces: the footer stats and
//! hints strings, the queue/notice lines, the auth selector providers, the
//! model selector ordering and the submit routing. The draw components are
//! the `crate::tui` face, embedder-owned (D17).

use super::api::{AuthType, InboxItem, MicroProviderAccount, MicroUsageView, MicroView, ModelRef};

/// Upstream `formatTokens` (`modes/interactive/components/footer.ts`).
pub fn format_tokens(tokens: f64) -> String {
    if tokens >= 1_000_000.0 {
        format!("{:.1}M", tokens / 1_000_000.0)
    } else if tokens >= 1000.0 {
        format!("{:.1}k", tokens / 1000.0)
    } else {
        format!("{}", tokens as u64)
    }
}

/// Upstream `#syncFooter` stats line. `theme.fg` coloring is the embedder's;
/// the port emits the plain text plus the color band the embedder applies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FooterStats {
    pub text: String,
    pub color: Option<&'static str>,
}

/// Upstream `#syncFooter` stats construction.
pub fn footer_stats(view: &MicroView) -> FooterStats {
    let usage: &MicroUsageView = &view.usage;
    let mut stats: Vec<String> = Vec::new();
    if usage.input != 0.0 {
        stats.push(format!("↑{}", format_tokens(usage.input)));
    }
    if usage.output != 0.0 {
        stats.push(format!("↓{}", format_tokens(usage.output)));
    }
    if usage.cache_read != 0.0 {
        stats.push(format!("R{}", format_tokens(usage.cache_read)));
    }
    if usage.cache_write != 0.0 {
        stats.push(format!("W{}", format_tokens(usage.cache_write)));
    }
    if let Some(rate) = usage.last_cache_hit_rate {
        if usage.cache_read > 0.0 || usage.cache_write > 0.0 {
            stats.push(format!("CH{rate:.1}%"));
        }
    }
    stats.push(format!("${:.3}", usage.total_cost));
    let mut color = None;
    if usage.context_window > 0 {
        let automatic = if view.threshold.unwrap_or(0.0) > 0.0 {
            " (auto)"
        } else {
            ""
        };
        let context = match usage.context_percent {
            None => format!(
                "?/{}{automatic}",
                format_tokens(usage.context_window as f64)
            ),
            Some(percent) => format!(
                "{:.1}%/{}{automatic}",
                percent,
                format_tokens(usage.context_window as f64)
            ),
        };
        let styled = match usage.context_percent {
            Some(percent) if percent > 90.0 => {
                color = Some("error");
                context
            }
            Some(percent) if percent > 70.0 => {
                color = Some("warning");
                context
            }
            _ => context,
        };
        stats.push(styled);
    }
    FooterStats {
        text: stats.join(" "),
        color,
    }
}

/// Upstream `#syncFooter` hints line (keybinding labels are the embedder's
/// registered bindings; the port takes them as parameters).
pub fn footer_hints(
    model: Option<&ModelRef>,
    thinking_level: Option<&str>,
    cycle_key: &str,
    model_key: &str,
    follow_up_key: &str,
    clear_key: &str,
) -> String {
    let model = match model {
        Some(model) => format!("{}/{}", model.provider, model.model_id),
        None => "no model".to_string(),
    };
    let thinking = thinking_level.unwrap_or("off");
    format!(
        "{model} · thinking:{thinking} ({cycle_key}) · {model_key} or /model · /login · /compact · {follow_up_key} follow-up · {clear_key} exit"
    )
}

/// Upstream `#syncQueue` lines.
pub fn queue_lines(view: &MicroView) -> Vec<String> {
    view.inbox
        .iter()
        .map(|queued| match queued {
            InboxItem::Message { mode, text } => format!("[{mode}] {text}"),
            InboxItem::Write { mode, entry_kind } => format!("[{mode}] <{entry_kind}>"),
        })
        .collect()
}

/// Upstream `#syncNotices`: the last four notices, color-tagged.
pub fn notice_lines(view: &MicroView) -> Vec<(String, &'static str)> {
    view.notices
        .iter()
        .rev()
        .take(4)
        .rev()
        .map(|notice| (notice.message.clone(), notice.level.color()))
        .collect()
}

/// Upstream `authProviders`: map accounts for the OAuth selector.
pub fn auth_selector_providers(accounts: &[MicroProviderAccount]) -> Vec<AuthSelectorProvider> {
    accounts
        .iter()
        .map(|account| AuthSelectorProvider {
            id: account.id.clone(),
            name: account.name.clone(),
            auth_type: account.auth_type,
            status: if account.configured {
                Some(AuthSelectorStatus {
                    source: account
                        .source
                        .clone()
                        .unwrap_or_else(|| "configured".to_string()),
                })
            } else {
                None
            },
        })
        .collect()
}

/// Upstream `AuthSelectorProvider` face.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthSelectorProvider {
    pub id: String,
    pub name: String,
    pub auth_type: AuthType,
    pub status: Option<AuthSelectorStatus>,
}

/// Upstream selector status face.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthSelectorStatus {
    pub source: String,
}

/// Upstream `selectModel`'s ordering: the current model first, others in
/// catalog order.
pub fn order_models_current_first(
    models: &[ModelRef],
    current: Option<&ModelRef>,
) -> Vec<ModelRef> {
    let mut models = models.to_vec();
    models.sort_by(|left, right| {
        let left_current = Some(left) == current;
        let right_current = Some(right) == current;
        match (left_current, right_current) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        }
    });
    models
}

/// Upstream selector value split: `provider/modelId` on the FIRST slash.
pub fn split_model_value(value: &str) -> (String, String) {
    match value.find('/') {
        Some(separator) => (
            value[..separator].to_string(),
            value[separator + 1..].to_string(),
        ),
        None => (value.to_string(), String::new()),
    }
}

/// Upstream submit routing (`submit` handler in `runMicroTui`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitRoute {
    Ignore,
    SelectModel,
    Login,
    Compact,
    Steer,
    Prompt,
}

/// Upstream submit routing decision.
pub fn route_submit(trimmed: &str, turn_active: bool) -> SubmitRoute {
    match trimmed {
        "" => SubmitRoute::Ignore,
        "/model" => SubmitRoute::SelectModel,
        "/login" => SubmitRoute::Login,
        "/compact" => SubmitRoute::Compact,
        _ => {
            if turn_active {
                SubmitRoute::Steer
            } else {
                SubmitRoute::Prompt
            }
        }
    }
}

/// Status text re-export (the port's `#syncStatus`).
pub use super::api::status_text as sync_status;

/// Upstream notice slice bound (`#syncNotices` keeps four).
pub const NOTICE_WINDOW: usize = 4;
