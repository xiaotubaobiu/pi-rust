//! Auth type system ported from upstream `packages/ai/src/auth/types.ts`:
//! the type-tagged [`Credential`] wire format (the shape of today's
//! `auth.json`), the [`CredentialStore`] operation options, and the
//! interaction/data shapes shared by the api-key and OAuth auth surfaces.
//!
//! Wire format (serde JSON) matches upstream byte-for-byte: tags
//! (`"api_key"`/`"oauth"`) and field names (`key`, `env`, `refresh`,
//! `access`, `expires`) round-trip a file written by upstream pi, and
//! unknown `OAuthCredential` fields are preserved like the upstream index
//! signature. The async provider-auth trait methods (`login`/`refresh`/
//! `toAuth`/`resolve`) land with the resolve port (M2d Task 2); the data
//! shapes those signatures need are fixed here.

use std::collections::BTreeMap;
use std::fmt;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::ai::types::{ProviderEnv, ProviderHeaders};

/// Upstream `ModelAuth` (types.ts:7-12): request auth for a single model
/// request. Anything not expressible as these three fields is provider
/// config, not auth.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelAuth {
    pub api_key: Option<String>,
    pub headers: Option<ProviderHeaders>,
    pub base_url: Option<String>,
}

/// Upstream `AuthType` (types.ts:117): the credential discriminator, with the
/// literal upstream union values as the serde wire format (`snake_case`
/// alone would mangle `OAuth` to `"o_auth"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AuthType {
    #[serde(rename = "api_key")]
    ApiKey,
    #[serde(rename = "oauth")]
    OAuth,
}

/// Upstream `ApiKeyCredential` (types.ts:17-21): stored api-key credential.
/// `env` holds provider-scoped environment/config values such as Cloudflare
/// account/gateway ids. The `"type": "api_key"` tag is applied by [`Credential`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ApiKeyCredential {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<ProviderEnv>,
}

/// Upstream `OAuthCredential` (types.ts:24-36): stored canonical OAuth
/// credential. `expires` is upstream `number` (epoch milliseconds).
/// Upstream's `[key: string]: unknown` index signature becomes `extra`:
/// extension fields are preserved verbatim on the auth.json round trip.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OAuthCredential {
    pub refresh: String,
    pub access: String,
    pub expires: i64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Upstream `Credential` (types.ts:37): one type-tagged credential per
/// provider — the shape of today's auth.json. Internally tagged by `type`
/// with the upstream tag values (`snake_case` alone would mangle `OAuth` to
/// `"o_auth"`); auth.json wire-compat is a hard goal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Credential {
    #[serde(rename = "api_key")]
    ApiKey(ApiKeyCredential),
    #[serde(rename = "oauth")]
    OAuth(OAuthCredential),
}

impl Credential {
    /// The credential discriminator (upstream `credential.type`).
    pub fn auth_type(&self) -> AuthType {
        match self {
            Credential::ApiKey(_) => AuthType::ApiKey,
            Credential::OAuth(_) => AuthType::OAuth,
        }
    }
}

/// Upstream `CredentialInfo` (types.ts:40-43): non-secret credential metadata
/// for account/status enumeration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialInfo {
    pub provider_id: String,
    pub r#type: AuthType,
}

/// Port invention (upstream `AuthOperationOptions` wraps an `AbortSignal`):
/// errors surfaced by auth and credential operations. Upstream rejects with
/// JS exceptions; `Models` wraps storage failures in `ModelsError` with code
/// `"auth"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// The operation's cancellation token fired (upstream `AbortError`).
    Cancelled,
    /// Storage failure inside a credential store implementation.
    Storage(String),
    /// Failure propagated from a `modify` callback or auth flow (upstream
    /// rejections propagate unchanged).
    Operation(String),
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthError::Cancelled => write!(f, "auth operation cancelled"),
            AuthError::Storage(message) => write!(f, "credential storage failure: {message}"),
            AuthError::Operation(message) => write!(f, "auth operation failed: {message}"),
        }
    }
}

impl std::error::Error for AuthError {}

/// Upstream `AuthOperationOptions` (types.ts:46-48): optional cancellation
/// for public auth and credential operations. `CancellationToken` replaces
/// the `AbortSignal`.
#[derive(Debug, Clone, Default)]
pub struct AuthOperationOptions {
    pub signal: Option<CancellationToken>,
}

impl AuthOperationOptions {
    /// No cancellation, the common case for internal callers.
    pub const NONE: Self = Self { signal: None };

    pub fn new(signal: CancellationToken) -> Self {
        Self {
            signal: Some(signal),
        }
    }

    /// Upstream `signal.throwIfAborted()`: `Err` once the token has fired.
    pub fn check(&self) -> Result<(), AuthError> {
        if self
            .signal
            .as_ref()
            .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
        {
            Err(AuthError::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Future resolving when the token fires. Resolves immediately when
    /// already cancelled, and never without a token.
    pub(crate) fn cancelled(&self) -> BoxFuture<'_, ()> {
        match &self.signal {
            Some(signal) => Box::pin(async move { signal.cancelled().await }),
            None => Box::pin(std::future::pending()),
        }
    }
}

/// Upstream `AuthContext` (types.ts:97-101): environment access for auth
/// resolution. Injectable for tests; the default implementation (upstream
/// `auth/context.ts`) lands with the resolve port.
pub trait AuthContext: Send + Sync {
    /// Value of an environment variable, `None` when unset.
    fn env<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Option<String>>;

    /// Whether a file exists. Supports a leading `~`.
    fn file_exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, bool>;
}

/// Upstream `AuthResult` (types.ts:104-110): result of resolving auth for a
/// model.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AuthResult {
    pub auth: ModelAuth,
    /// Provider-scoped environment/config values resolved from credentials
    /// and ambient context.
    pub env: Option<ProviderEnv>,
    /// Human-readable label for status UI: "ANTHROPIC_API_KEY", "OAuth",
    /// "~/.aws/credentials".
    pub source: Option<String>,
}

/// Upstream `AuthCheck` (types.ts:112-115): side-effect-free availability
/// result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthCheck {
    pub source: Option<String>,
    pub r#type: AuthType,
}

/// One selectable option of an upstream `AuthPrompt` of type `"select"`
/// (types.ts:128).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthPromptOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

/// Upstream `AuthPrompt` (types.ts:125-130): prompt shown to the user during
/// login. Upstream forms it as `{ signal?: AbortSignal } & (<variant union>)`;
/// the variant union is [`AuthPromptKind`] and the per-prompt `signal` (which
/// lets a flow cancel a pending prompt when an out-of-band event resolves the
/// step) rides next to it.
#[derive(Debug, Clone)]
pub struct AuthPrompt {
    /// Per-prompt cancellation, independent of the interaction-level signal.
    pub signal: Option<CancellationToken>,
    pub kind: AuthPromptKind,
}

/// The variant union of upstream `AuthPrompt` (types.ts:125-130).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthPromptKind {
    Text {
        message: String,
        placeholder: Option<String>,
    },
    Secret {
        message: String,
        placeholder: Option<String>,
    },
    Select {
        message: String,
        options: Vec<AuthPromptOption>,
    },
    ManualCode {
        message: String,
        placeholder: Option<String>,
    },
}

/// Upstream `AuthInfoLink` (types.ts:132-135).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthInfoLink {
    pub url: String,
    pub label: Option<String>,
}

/// Upstream `AuthEvent` (types.ts:137-147): progress events emitted during a
/// login flow.
#[derive(Debug, Clone, PartialEq)]
pub enum AuthEvent {
    Info {
        message: String,
        links: Option<Vec<AuthInfoLink>>,
    },
    AuthUrl {
        url: String,
        instructions: Option<String>,
    },
    DeviceCode {
        user_code: String,
        verification_uri: String,
        interval_seconds: Option<u64>,
        expires_in_seconds: Option<u64>,
    },
    Progress {
        message: String,
    },
}

/// Upstream `AuthInteraction` (types.ts:156-161): login interaction callbacks
/// serving both api-key and OAuth flows. `prompt` resolves with the entered
/// text (or the selected option id for `select`) and errors with
/// [`AuthError::Cancelled`] on cancel/abort; `signal` aborts the whole login
/// flow while per-prompt cancellation uses [`AuthPrompt::signal`].
///
/// Interactive surfaces go through this trait: auth flows never touch stdio
/// or a browser directly (M2d controller ruling).
pub trait AuthInteraction: Send + Sync {
    /// Interaction-level cancellation (upstream `signal?: AbortSignal`).
    fn signal(&self) -> Option<CancellationToken>;

    fn prompt(&self, prompt: AuthPrompt) -> BoxFuture<'_, Result<String, AuthError>>;

    fn notify(&self, event: AuthEvent);
}

/// Upstream `ProviderAuthInteraction` (types.ts:164): normalized interaction
/// passed to provider login implementations — an [`AuthInteraction`] whose
/// `signal` is always present.
#[derive(Clone)]
pub struct ProviderAuthInteraction {
    pub signal: CancellationToken,
    interaction: std::sync::Arc<dyn AuthInteraction>,
}

impl ProviderAuthInteraction {
    pub fn new(
        interaction: std::sync::Arc<dyn AuthInteraction>,
        signal: CancellationToken,
    ) -> Self {
        Self {
            signal,
            interaction,
        }
    }
}

impl AuthInteraction for ProviderAuthInteraction {
    fn signal(&self) -> Option<CancellationToken> {
        Some(self.signal.clone())
    }

    fn prompt(&self, prompt: AuthPrompt) -> BoxFuture<'_, Result<String, AuthError>> {
        Box::pin(self.interaction.prompt(prompt))
    }

    fn notify(&self, event: AuthEvent) {
        self.interaction.notify(event)
    }
}

/// Upstream `ApiKeyAuth` (types.ts:170-199): api-key auth — stored key or
/// provider env plus ambient sources (env vars, AWS profiles, ADC files).
/// Ambient-only providers omit `login`.
///
/// Data shape only in M2d Task 1; the async `login`/`check`/`resolve` methods
/// land with the resolve port (Task 2) without changing this shape.
pub trait ApiKeyAuth: Send + Sync {
    /// Display name, e.g. "Anthropic API key".
    fn name(&self) -> &str;
}

/// Upstream `OAuthAuth` (types.ts:206-230): OAuth auth. The `refresh`/`toAuth`
/// split (Task 2) lets `Models` own the locked refresh pattern.
///
/// Data shape only in M2d Task 1; the async `login`/`refresh`/`toAuth`
/// methods land with the resolve port (Task 2) without changing this shape.
pub trait OAuthAuth: Send + Sync {
    /// Display name, e.g. "Anthropic (Claude Pro/Max)".
    fn name(&self) -> &str;

    /// Whether access through this auth method is backed by a provider
    /// subscription (upstream optional, defaults to false).
    fn is_subscription(&self) -> bool {
        false
    }

    /// Selector label for the OAuth login option, e.g. "Sign in with
    /// SuperGrok or X Premium".
    fn login_label(&self) -> Option<&str> {
        None
    }
}

/// Upstream `ProviderAuth` (types.ts:237-240): provider auth. At least one of
/// `api_key`/`oauth` must be present: even ambient-credential providers and
/// keyless local servers provide api-key auth whose resolve reports whether
/// the provider is configured (invariant, not enforced by the type).
#[derive(Clone, Default)]
pub struct ProviderAuth {
    pub api_key: Option<std::sync::Arc<dyn ApiKeyAuth>>,
    pub oauth: Option<std::sync::Arc<dyn OAuthAuth>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_type_wire_values_match_upstream() {
        assert_eq!(
            serde_json::to_string(&AuthType::ApiKey).unwrap(),
            "\"api_key\""
        );
        assert_eq!(
            serde_json::to_string(&AuthType::OAuth).unwrap(),
            "\"oauth\""
        );
        let back: AuthType = serde_json::from_str("\"api_key\"").unwrap();
        assert_eq!(back, AuthType::ApiKey);
    }

    #[test]
    fn api_key_credential_round_trips_upstream_wire_shape() {
        // With key and provider-scoped env (Cloudflare-style entry).
        let fixture =
            r#"{"type":"api_key","key":"sk-ant-1","env":{"ACCOUNT_ID":"abc","GATEWAY":"gw"}}"#;
        let credential: Credential = serde_json::from_str(fixture).unwrap();
        let Credential::ApiKey(ref api_key) = credential else {
            panic!("expected api_key variant");
        };
        assert_eq!(api_key.key.as_deref(), Some("sk-ant-1"));
        assert_eq!(
            api_key
                .env
                .as_ref()
                .unwrap()
                .get("ACCOUNT_ID")
                .map(String::as_str),
            Some("abc")
        );
        assert_eq!(serde_json::to_string(&credential).unwrap(), fixture);

        // Minimal entry: omitted optional fields stay omitted.
        let minimal: Credential = serde_json::from_str(r#"{"type":"api_key"}"#).unwrap();
        assert_eq!(
            serde_json::to_string(&minimal).unwrap(),
            r#"{"type":"api_key"}"#
        );
        assert_eq!(minimal.auth_type(), AuthType::ApiKey);
    }

    #[test]
    fn oauth_credential_round_trips_upstream_wire_shape_and_preserves_extra_fields() {
        // Extension fields (upstream index signature) must survive a round trip.
        let fixture = r#"{"type":"oauth","refresh":"r","access":"a","expires":1735689600000,"accountId":"acc","scope":"openid"}"#;
        let credential: Credential = serde_json::from_str(fixture).unwrap();
        let Credential::OAuth(oauth) = &credential else {
            panic!("expected oauth variant");
        };
        assert_eq!(oauth.refresh, "r");
        assert_eq!(oauth.access, "a");
        assert_eq!(oauth.expires, 1_735_689_600_000);
        assert_eq!(
            oauth.extra.get("accountId").and_then(|v| v.as_str()),
            Some("acc")
        );
        assert_eq!(serde_json::to_string(&credential).unwrap(), fixture);
        assert_eq!(credential.auth_type(), AuthType::OAuth);
    }

    #[test]
    fn oauth_credential_requires_refresh_access_and_expires() {
        // Upstream auth.json validation requires access/refresh strings and a
        // finite number expires; a credential missing expires is invalid.
        assert!(serde_json::from_str::<Credential>(
            r#"{"type":"oauth","refresh":"r","access":"a"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Credential>(r#"{"type":"oauth"}"#).is_err());
    }

    #[test]
    fn full_auth_json_document_round_trips_upstream_bytes() {
        // `Record<string, Credential>` — the upstream AuthStorageData shape,
        // with key order (sorted provider ids) matching a BTreeMap rewrite.
        let fixture = r#"{"anthropic":{"type":"oauth","refresh":"r","access":"a","expires":10},"openai":{"type":"api_key","key":"sk"}}"#;
        let document: BTreeMap<String, Credential> = serde_json::from_str(fixture).unwrap();
        assert_eq!(document.len(), 2);
        assert_eq!(serde_json::to_string(&document).unwrap(), fixture);
    }

    #[test]
    fn auth_operation_options_reports_cancellation() {
        let options = AuthOperationOptions::default();
        assert_eq!(options.check(), Ok(()));
        let token = CancellationToken::new();
        let options = AuthOperationOptions::new(token.clone());
        assert_eq!(options.check(), Ok(()));
        token.cancel();
        assert_eq!(options.check(), Err(AuthError::Cancelled));
        assert_eq!(AuthError::Cancelled.to_string(), "auth operation cancelled");
    }

    #[test]
    fn provider_auth_interaction_normalizes_the_signal() {
        // Minimal interaction recording the last notify event.
        struct RecordingInteraction {
            events: std::sync::Mutex<Vec<AuthEvent>>,
        }
        impl AuthInteraction for RecordingInteraction {
            fn signal(&self) -> Option<CancellationToken> {
                None
            }
            fn prompt(&self, _prompt: AuthPrompt) -> BoxFuture<'_, Result<String, AuthError>> {
                Box::pin(async { Ok("entered".to_string()) })
            }
            fn notify(&self, event: AuthEvent) {
                self.events.lock().unwrap().push(event);
            }
        }

        let interaction = std::sync::Arc::new(RecordingInteraction {
            events: std::sync::Mutex::new(Vec::new()),
        });
        let token = CancellationToken::new();
        let normalized = ProviderAuthInteraction::new(interaction.clone(), token.clone());
        // The normalized interaction always reports a signal.
        assert_eq!(normalized.signal(), Some(token.clone()));
        let entered = futures::executor::block_on(normalized.prompt(AuthPrompt {
            signal: None,
            kind: AuthPromptKind::Secret {
                message: "Enter key".to_string(),
                placeholder: None,
            },
        }));
        assert_eq!(entered, Ok("entered".to_string()));
        normalized.notify(AuthEvent::Progress {
            message: "refreshing".to_string(),
        });
        assert_eq!(
            interaction.events.lock().unwrap().clone(),
            vec!(AuthEvent::Progress {
                message: "refreshing".to_string()
            })
        );
    }
}
