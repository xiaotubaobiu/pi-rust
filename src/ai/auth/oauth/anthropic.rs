//! Anthropic OAuth flow (Claude Pro/Max) ported from upstream
//! `packages/ai/src/auth/oauth/anthropic.ts`: the PKCE authorization-URL
//! build, the local redirect-capture server, the manual-code fallback, the
//! token exchange/refresh requests, and the [`AnthropicOAuth`] [`OAuthAuth`]
//! implementation.
//!
//! Interactive surface: the browser is pointed at the authorize URL through
//! the [`AuthEvent::AuthUrl`] event and the user's pasted redirect URL /
//! authorization code arrives through a `manual_code` prompt (M2d ruling) —
//! the flow never touches stdio. The local callback server is flow-owned
//! infrastructure, like upstream's `http.createServer`.
//!
//! Port notes (disclosed divergences):
//! - The token endpoint URL and callback port are fields on
//!   [`AnthropicOAuth`] (upstream: module constants) so tests can point the
//!   flow at a wiremock server and free ports. The production constructor
//!   pins the upstream values.
//! - Token request JSON bodies serialize with serde_json's map ordering
//!   (alphabetical) instead of upstream's `JSON.stringify` insertion order;
//!   OAuth token endpoints parse JSON, so the wire semantics are unchanged.
//! - `formatErrorDetails` (upstream lines 82-97) cannot see Node-only error
//!   fields (`code`/`errno`/`stack`); the port formats `Error: <display>`
//!   plus the `cause=<display>` chain of [`std::error::Error::source`].
//! - The upstream request-handler catch-all (500 "Internal error") covers
//!   throwing `URL` parses; the Rust router has no fallible step after the
//!   request target is read, so a malformed request line maps to the same
//!   500 response (disclosed: Node answers 400 before the handler there).
//! - A failed callback-server bind wraps the OS error in "Failed to start
//!   the OAuth callback server on host:port: …" instead of surfacing the raw
//!   Node `EADDRINUSE` error text.
//! - The token response parse is stricter than upstream: a 200 response
//!   missing `access_token`/`refresh_token`/`expires_in` errors as invalid
//!   JSON, where upstream would silently build a credential with `undefined`
//!   fields. (Deliberate: the port never stores a corrupt credential.)

use std::sync::Arc;

use futures::future::BoxFuture;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::ai::api::azure_openai_responses::get_provider_env_value;
use crate::ai::api::http_client;
use crate::ai::auth::types::{
    AuthError, AuthEvent, AuthInteraction, AuthPrompt, AuthPromptKind, ModelAuth, OAuthAuth,
    OAuthCredential, ProviderAuthInteraction,
};
use crate::ai::now_ms;

use super::oauth_page::{oauth_error_html, oauth_success_html};
use super::pkce::{generate_pkce, Pkce};

/// Upstream `CLIENT_ID` (anthropic.ts:29): upstream decodes
/// `atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")` at module load;
/// the port stores the decoded value (pinned by a test).
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/// Upstream `AUTHORIZE_URL` (anthropic.ts:30).
const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";

/// Upstream `TOKEN_URL` (anthropic.ts:31); the production default for
/// [`AnthropicOAuth::new`].
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";

/// Upstream `getProviderEnvValue("PI_OAUTH_CALLBACK_HOST")` (anthropic.ts:32).
const CALLBACK_HOST_ENV: &str = "PI_OAUTH_CALLBACK_HOST";

/// Upstream `|| "127.0.0.1"` fallback for the callback host.
const DEFAULT_CALLBACK_HOST: &str = "127.0.0.1";

/// Upstream `CALLBACK_PORT` (anthropic.ts:33).
const CALLBACK_PORT: u16 = 53692;

/// Upstream `CALLBACK_PATH` (anthropic.ts:34).
const CALLBACK_PATH: &str = "/callback";

/// Upstream `SCOPES` (anthropic.ts:36-37).
const SCOPES: &str =
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/// Upstream `AbortSignal.timeout(30_000)` composed into every token request
/// (anthropic.ts:178).
const POST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Upstream `REDIRECT_URI` (anthropic.ts:35): the redirect host is always
/// `localhost`; the server binds `CALLBACK_HOST` separately.
fn redirect_uri(callback_port: u16) -> String {
    format!("http://localhost:{callback_port}{CALLBACK_PATH}")
}

/// The Anthropic OAuth auth surface (upstream `anthropicOAuth`, lines
/// 355-364). [`AnthropicOAuth::new`] pins the upstream endpoints; tests
/// inject a wiremock token URL and a free callback port.
pub struct AnthropicOAuth {
    token_url: String,
    callback_host: String,
    callback_port: u16,
}

impl Default for AnthropicOAuth {
    fn default() -> Self {
        Self::new()
    }
}

impl AnthropicOAuth {
    /// Upstream module constants, with the callback host resolved from
    /// `PI_OAUTH_CALLBACK_HOST` (default `127.0.0.1`), like the upstream
    /// module-load read.
    pub fn new() -> Self {
        let callback_host = get_provider_env_value(CALLBACK_HOST_ENV, None)
            .unwrap_or_else(|| DEFAULT_CALLBACK_HOST.to_string());
        AnthropicOAuth {
            token_url: TOKEN_URL.to_string(),
            callback_host,
            callback_port: CALLBACK_PORT,
        }
    }

    /// Test constructor: point the token endpoint at a stub server and use a
    /// port that does not collide with other tests (upstream tests stub the
    /// global `fetch` and keep port 53692 because they run sequentially).
    #[cfg(test)]
    fn with_endpoints(token_url: String, callback_host: String, callback_port: u16) -> Self {
        AnthropicOAuth {
            token_url,
            callback_host,
            callback_port,
        }
    }
}

/// Upstream `parseAuthorizationInput` (anthropic.ts:52-80): a pasted redirect
/// URL, a `code#state` pair, a bare query string, or a bare code.
fn parse_authorization_input(input: &str) -> ParsedAuthorizationInput {
    let value = input.trim();
    if value.is_empty() {
        return ParsedAuthorizationInput {
            code: None,
            state: None,
        };
    }

    // WHATWG `new URL(value)` — absolute URLs only; anything else falls
    // through like the upstream catch. A parsed URL returns immediately, even
    // when it carries no code/state at all.
    if let Ok(url) = Url::parse(value) {
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        return ParsedAuthorizationInput {
            code: first_pair(&pairs, "code"),
            state: first_pair(&pairs, "state"),
        };
    }

    if value.contains('#') {
        // JS `value.split("#", 2)`: at most two elements, the rest dropped.
        let mut parts = value.split('#');
        let code = parts.next().map(str::to_string);
        let state = parts.next().map(str::to_string);
        return ParsedAuthorizationInput { code, state };
    }

    if value.contains("code=") {
        // `new URLSearchParams` strips a single leading `?`, so a pasted
        // `?code=…&state=…` (browser URL bar) parses like upstream. Only this
        // branch: the callback router splits the target off the request line
        // first and never sees a leading `?` on its query.
        let query = value.strip_prefix('?').unwrap_or(value);
        let pairs = parse_urlencoded_pairs(query);
        return ParsedAuthorizationInput {
            code: first_pair(&pairs, "code"),
            state: first_pair(&pairs, "state"),
        };
    }

    ParsedAuthorizationInput {
        code: Some(value.to_string()),
        state: None,
    }
}

struct ParsedAuthorizationInput {
    code: Option<String>,
    state: Option<String>,
}

/// First `URLSearchParams.get` match for a name.
fn first_pair(pairs: &[(String, String)], name: &str) -> Option<String> {
    pairs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
}

/// `application/x-www-form-urlencoded` pair parsing (`new URLSearchParams`):
/// split on `&`, name/value split at the first `=`, `+` reads as space and
/// `%XX` sequences decode.
fn parse_urlencoded_pairs(input: &str) -> Vec<(String, String)> {
    input
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((name, value)) => (decode_urlencoded(name), decode_urlencoded(value)),
            None => (decode_urlencoded(pair), String::new()),
        })
        .collect()
}

fn decode_urlencoded(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let high = (bytes[index + 1] as char).to_digit(16);
                let low = (bytes[index + 2] as char).to_digit(16);
                match (high, low) {
                    (Some(high), Some(low)) => {
                        decoded.push((high * 16 + low) as u8);
                        index += 3;
                    }
                    _ => {
                        decoded.push(b'%');
                        index += 1;
                    }
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// Failures of [`post_json`]. `Cancelled` never reaches the upstream-style
/// wrappers: the port surfaces cancellation as [`AuthError::Cancelled`].
enum PostJsonError {
    Cancelled,
    /// `fetch` rejection: transport or timeout.
    Transport(reqwest::Error),
    /// Non-2xx response: upstream
    /// `HTTP request failed. status=…; url=…; body=…`.
    Status(String),
}

impl PostJsonError {
    /// Upstream `formatErrorDetails(error)` of the thrown error: an `Error`
    /// renders as `Error: <message>`.
    fn details(&self) -> String {
        match self {
            PostJsonError::Transport(error) => format_error_details(error),
            PostJsonError::Status(message) => format!("Error: {message}"),
            PostJsonError::Cancelled => String::new(),
        }
    }
}

/// Upstream `formatErrorDetails` (anthropic.ts:82-97) over a Rust error
/// chain: `Error: <display>` plus `cause=<display>` per source. Node-only
/// fields (`code`, `errno`, `stack`) have no Rust counterpart.
fn format_error_details(error: &(dyn std::error::Error + 'static)) -> String {
    let mut details = vec![format!("Error: {error}")];
    let mut source = error.source();
    while let Some(cause) = source {
        details.push(format!("cause={cause}"));
        source = cause.source();
    }
    details.join("; ")
}

/// Upstream `postJson` (anthropic.ts:170-188): POST the JSON body with
/// `Content-Type`/`Accept: application/json` and a 30s budget, returning the
/// raw response text (status errors carry the body in the message).
async fn post_json(
    token_url: &str,
    body: serde_json::Value,
    signal: &CancellationToken,
) -> Result<String, PostJsonError> {
    let body = serde_json::to_string(&body).expect("token request body must serialize");
    let request = http_client()
        .post(token_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(body)
        .timeout(POST_TIMEOUT);

    let response = tokio::select! {
        biased;
        _ = signal.cancelled() => return Err(PostJsonError::Cancelled),
        response = request.send() => match response {
            Ok(response) => response,
            Err(error) => return Err(PostJsonError::Transport(error)),
        },
    };
    let status = response.status();
    let response_body = tokio::select! {
        biased;
        _ = signal.cancelled() => return Err(PostJsonError::Cancelled),
        body = response.text() => match body {
            Ok(body) => body,
            Err(error) => return Err(PostJsonError::Transport(error)),
        },
    };

    // `if (!response.ok)`: `as_u16()` matches the upstream
    // `status=${response.status}` interpolation (a bare number).
    if !status.is_success() {
        return Err(PostJsonError::Status(format!(
            "HTTP request failed. status={}; url={token_url}; body={response_body}",
            status.as_u16()
        )));
    }
    Ok(response_body)
}

/// The token endpoint response fields (upstream exchange/refresh parse).
#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
}

/// Upstream `expires: Date.now() + expires_in * 1000 - 5 * 60 * 1000`
/// (anthropic.ts:230, 351): shave five minutes for clock skew.
fn credential_from_tokens(tokens: TokenResponse) -> OAuthCredential {
    OAuthCredential {
        refresh: tokens.refresh_token,
        access: tokens.access_token,
        expires: now_ms() + tokens.expires_in * 1000 - 5 * 60 * 1000,
        extra: Default::default(),
    }
}

/// Upstream `exchangeAuthorizationCode` (anthropic.ts:190-232).
async fn exchange_authorization_code(
    token_url: &str,
    code: &str,
    state: &str,
    verifier: &str,
    redirect_uri: &str,
    signal: &CancellationToken,
) -> Result<OAuthCredential, AuthError> {
    let body = serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "code": code,
        "state": state,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    });

    let response_body = match post_json(token_url, body, signal).await {
        Ok(response_body) => response_body,
        Err(PostJsonError::Cancelled) => return Err(AuthError::Cancelled),
        Err(error) => {
            return Err(AuthError::Operation(format!(
                "Token exchange request failed. url={token_url}; redirect_uri={redirect_uri}; \
                 response_type=authorization_code; details={}",
                error.details()
            )));
        }
    };

    match serde_json::from_str::<TokenResponse>(&response_body) {
        Ok(tokens) => Ok(credential_from_tokens(tokens)),
        Err(error) => Err(AuthError::Operation(format!(
            "Token exchange returned invalid JSON. url={token_url}; body={response_body}; \
             details=Error: {error}"
        ))),
    }
}

/// Upstream `refreshAnthropicToken` (anthropic.ts:317-353): the refresh
/// request carries no scope (pinned by the oracle).
async fn refresh_anthropic_token(
    token_url: &str,
    refresh_token: &str,
    signal: &CancellationToken,
) -> Result<OAuthCredential, AuthError> {
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "client_id": CLIENT_ID,
        "refresh_token": refresh_token,
    });

    let response_body = match post_json(token_url, body, signal).await {
        Ok(response_body) => response_body,
        Err(PostJsonError::Cancelled) => return Err(AuthError::Cancelled),
        Err(error) => {
            return Err(AuthError::Operation(format!(
                "Anthropic token refresh request failed. url={token_url}; details={}",
                error.details()
            )));
        }
    };

    match serde_json::from_str::<TokenResponse>(&response_body) {
        Ok(tokens) => Ok(credential_from_tokens(tokens)),
        Err(error) => Err(AuthError::Operation(format!(
            "Anthropic token refresh returned invalid JSON. url={token_url}; body={response_body}; \
             details=Error: {error}"
        ))),
    }
}

/// Upstream `loginAnthropic` (anthropic.ts:234-312): open the callback
/// server, publish the authorize URL, race the manual prompt against the
/// callback (and the interaction signal), then exchange the code.
async fn login_anthropic(
    token_url: &str,
    callback_host: &str,
    callback_port: u16,
    interaction: ProviderAuthInteraction,
) -> Result<OAuthCredential, AuthError> {
    if interaction.signal.is_cancelled() {
        return Err(AuthError::Cancelled);
    }
    let redirect_uri = redirect_uri(callback_port);
    let Pkce {
        verifier,
        challenge,
    } = generate_pkce();
    let server = CallbackServer::start(verifier.clone(), callback_host, callback_port).await?;

    // Upstream's `manualAbort` controller: aborts the pending prompt in the
    // finally block so UIs can dismiss it once login settles.
    let manual_token = CancellationToken::new();
    let result = async {
        // `new URLSearchParams({...}).toString()` — insertion order preserved,
        // form-urlencoded serialization (spaces become `+`). Built (and the
        // serializer dropped) before any await: the serializer is not `Send`
        // and the login future must be.
        let auth_url = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("code", "true");
            query.append_pair("client_id", CLIENT_ID);
            query.append_pair("response_type", "code");
            query.append_pair("redirect_uri", &redirect_uri);
            query.append_pair("scope", SCOPES);
            query.append_pair("code_challenge", &challenge);
            query.append_pair("code_challenge_method", "S256");
            query.append_pair("state", &verifier);
            format!("{AUTHORIZE_URL}?{}", query.finish())
        };
        interaction.notify(AuthEvent::AuthUrl {
            url: auth_url,
            instructions: Some(
                "Complete login in your browser. If the browser is on another machine, paste the \
                 final redirect URL here."
                    .to_string(),
            ),
        });

        let prompt = interaction.prompt(AuthPrompt {
            signal: Some(manual_token.clone()),
            kind: AuthPromptKind::ManualCode {
                message: "Complete login in your browser, or paste the authorization code / \
                          redirect URL here:"
                    .to_string(),
                placeholder: Some(redirect_uri.clone()),
            },
        });
        tokio::pin!(prompt);

        let mut manual: Option<Result<String, AuthError>> = None;
        // Upstream races the manual prompt against `server.waitForCode()` —
        // the prompt's then/catch cancels the wait, and the abort listener
        // cancels the wait when the interaction signal fires. `biased` makes
        // the port deterministic: cancellation, then the prompt, then the
        // delivered callback. The guard disables the prompt arm once settled
        // so the loop can keep polling the wait without re-polling a
        // completed future.
        let delivered = loop {
            tokio::select! {
                biased;
                _ = interaction.signal.cancelled() => return Err(AuthError::Cancelled),
                settled = &mut prompt, if manual.is_none() => {
                    manual = Some(settled);
                    server.cancel_wait();
                }
                value = server.wait() => break value,
            }
        };

        // Upstream throws the manual rejection before looking at any result.
        if let Some(Err(error)) = &manual {
            return Err(error.clone());
        }

        let code;
        let state;
        if let Some((delivered_code, delivered_state)) = delivered {
            code = delivered_code;
            state = delivered_state;
        } else if let Some(Ok(input)) = &manual {
            let parsed = parse_authorization_input(input);
            if let Some(parsed_state) = parsed.state.as_deref().filter(|state| !state.is_empty()) {
                if parsed_state != verifier {
                    return Err(AuthError::Operation("OAuth state mismatch".to_string()));
                }
            }
            code = parsed.code.unwrap_or_default();
            state = parsed.state.unwrap_or_else(|| verifier.clone());
        } else {
            // The wait can only return empty through a cancelled prompt or a
            // cancelled signal, both handled above.
            code = String::new();
            state = String::new();
        }

        // Upstream truthiness checks (`if (!code)`, `if (!state)`).
        let code = if code.is_empty() {
            return Err(AuthError::Operation(
                "Missing authorization code".to_string(),
            ));
        } else {
            code
        };
        let state = if state.is_empty() {
            return Err(AuthError::Operation("Missing OAuth state".to_string()));
        } else {
            state
        };

        interaction.notify(AuthEvent::Progress {
            message: "Exchanging authorization code for tokens...".to_string(),
        });
        exchange_authorization_code(
            token_url,
            &code,
            &state,
            &verifier,
            &redirect_uri,
            &interaction.signal,
        )
        .await
    }
    .await;

    // Upstream `finally`: abort the manual prompt and close the server.
    manual_token.cancel();
    server.close().await;
    result
}

/// The code/state pair a successful callback delivers.
type DeliveredCode = (String, String);

/// The local redirect-capture server (upstream `startCallbackServer`,
/// anthropic.ts:99-168, plus the `server.server.close()` teardown): a minimal
/// HTTP/1.1 responder that settles exactly once with `{ code, state }` — or
/// with `None` when cancelled.
struct CallbackServer {
    waiter: CallbackWaiter,
    shutdown: CancellationToken,
    accept_loop: Option<tokio::task::JoinHandle<()>>,
}

impl CallbackServer {
    async fn start(
        expected_state: String,
        callback_host: &str,
        callback_port: u16,
    ) -> Result<Self, AuthError> {
        let listener = tokio::net::TcpListener::bind((callback_host, callback_port))
            .await
            .map_err(|error| {
                AuthError::Operation(format!(
                    "Failed to start the OAuth callback server on \
                     {callback_host}:{callback_port}: {error}"
                ))
            })?;
        let waiter = CallbackWaiter::new();
        let shutdown = CancellationToken::new();
        let task_shutdown = shutdown.clone();
        let loop_waiter = waiter.clone();
        let loop_state = expected_state;
        let accept_loop = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = task_shutdown.cancelled() => break,
                    // Transient accept errors must not kill the capture;
                    // upstream's server keeps listening too.
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _)) => {
                            let waiter = loop_waiter.clone();
                            let expected_state = loop_state.clone();
                            tokio::spawn(handle_connection(stream, expected_state, waiter));
                        }
                        Err(_) => continue,
                    },
                }
            }
        });
        Ok(CallbackServer {
            waiter,
            shutdown,
            accept_loop: Some(accept_loop),
        })
    }

    /// Upstream `waitForCode()`: resolves with the first settle.
    async fn wait(&self) -> Option<DeliveredCode> {
        self.waiter.wait().await
    }

    /// Upstream `cancelWait()`: settles with `None` unless a code landed.
    fn cancel_wait(&self) {
        self.waiter.settle(None);
    }

    /// Upstream `server.close()`: stop accepting and wait for the listener
    /// to drop (frees the port for the next login).
    async fn close(mut self) {
        self.shutdown.cancel();
        if let Some(accept_loop) = self.accept_loop.take() {
            let _ = accept_loop.await;
        }
    }
}

/// Upstream's once-only settle flag (anthropic.ts:103-111) as a
/// first-settle-wins slot: a code wins over a cancel and neither can be
/// overwritten. Three states, because a cancel is observable: unset, then
/// either `Cancelled` or `Delivered`.
#[derive(Clone)]
struct CallbackWaiter {
    settled: Arc<watch::Sender<Option<Settle>>>,
}

enum Settle {
    Cancelled,
    Delivered(DeliveredCode),
}

impl CallbackWaiter {
    fn new() -> Self {
        let (settled, _) = watch::channel(None);
        CallbackWaiter {
            settled: Arc::new(settled),
        }
    }

    fn settle(&self, value: Option<DeliveredCode>) {
        let value = value.map(Settle::Delivered).unwrap_or(Settle::Cancelled);
        self.settled.send_if_modified(|slot| {
            if slot.is_none() {
                *slot = Some(value);
                true
            } else {
                false
            }
        });
    }

    /// Resolves with the first settle: `None` once cancelled, the pair once
    /// delivered, and immediately when the settle already happened.
    async fn wait(&self) -> Option<DeliveredCode> {
        let mut receiver = self.settled.subscribe();
        loop {
            // The borrow is confined to the block so no watch ref is alive
            // across the await (they are not Send).
            let settled = match &*receiver.borrow_and_update() {
                Some(Settle::Delivered((code, state))) => Some(Some((code.clone(), state.clone()))),
                Some(Settle::Cancelled) => Some(None),
                None => None,
            };
            if let Some(delivered) = settled {
                return delivered;
            }
            if receiver.changed().await.is_err() {
                return None;
            }
        }
    }
}

const HTML_CONTENT_TYPE: &str = "text/html; charset=utf-8";
const TEXT_CONTENT_TYPE: &str = "text/plain; charset=utf-8";

/// One handled browser request (upstream request handler, anthropic.ts:113-151
/// plus the catch-all mapping described in the module notes).
async fn handle_connection(mut stream: TcpStream, expected_state: String, waiter: CallbackWaiter) {
    let Some(request_line) = read_request_head(&mut stream).await else {
        // No readable request head: nothing to answer (upstream: an
        // abandoned browser request never completes either).
        return;
    };
    let route = route_callback(&request_line, &expected_state);
    let (status, reason, content_type, body): (u16, &str, &str, &str) = match &route {
        CallbackRoute::Success { body, .. } => (200, "OK", HTML_CONTENT_TYPE, body),
        CallbackRoute::Rejected(status, reason, body) => (*status, reason, HTML_CONTENT_TYPE, body),
        CallbackRoute::Malformed => (
            500,
            "Internal Server Error",
            TEXT_CONTENT_TYPE,
            "Internal error",
        ),
    };
    write_response(&mut stream, status, reason, content_type, body).await;
    if let CallbackRoute::Success { code, state, .. } = route {
        waiter.settle(Some((code, state)));
    }
}

enum CallbackRoute {
    /// 200 + the success page; the waiter settles with the pair afterwards.
    Success {
        body: String,
        code: String,
        state: String,
    },
    /// A rendered error page with status/reason.
    Rejected(u16, &'static str, String),
    /// The upstream catch-all: 500 "Internal error".
    Malformed,
}

/// The upstream router (anthropic.ts:113-151) as a pure mapper: the request
/// line's target picks the response, and a valid `/callback` hit carries the
/// code/state to settle.
fn route_callback(request_line: &str, expected_state: &str) -> CallbackRoute {
    let Some(target) = request_target(request_line) else {
        return CallbackRoute::Malformed;
    };
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };
    if path != CALLBACK_PATH {
        return CallbackRoute::Rejected(
            404,
            "Not Found",
            oauth_error_html("Callback route not found.", None),
        );
    }
    let params = parse_urlencoded_pairs(query);
    let get = |name: &str| first_pair(&params, name).filter(|value| !value.is_empty());
    if let Some(error) = get("error") {
        return CallbackRoute::Rejected(
            400,
            "Bad Request",
            oauth_error_html(
                "Anthropic authentication did not complete.",
                Some(&format!("Error: {error}")),
            ),
        );
    }
    // `if (!code || !state)` truthiness.
    let (Some(code), Some(state)) = (get("code"), get("state")) else {
        return CallbackRoute::Rejected(
            400,
            "Bad Request",
            oauth_error_html("Missing code or state parameter.", None),
        );
    };
    if state != expected_state {
        return CallbackRoute::Rejected(
            400,
            "Bad Request",
            oauth_error_html("State mismatch.", None),
        );
    }
    CallbackRoute::Success {
        body: oauth_success_html("Anthropic authentication completed. You can close this window."),
        code,
        state,
    }
}

/// The raw request target (request line's second token), like
/// `new URL(req.url, "http://localhost")` input. `None` = malformed line.
fn request_target(request_line: &str) -> Option<&str> {
    request_line.split_whitespace().nth(1)
}

/// Reads the request head and returns the request line. `None` when the peer
/// never completes a head (drop the connection, like an abandoned browser
/// request; the cap and timeout keep stuck sockets from leaking).
async fn read_request_head(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let read = tokio::time::timeout(POST_TIMEOUT, stream.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > 16 * 1024 {
            return None;
        }
        if let Some(head_end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            return Some(String::from_utf8_lossy(&buffer[..head_end]).into_owned());
        }
    }
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &str,
) {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

impl OAuthAuth for AnthropicOAuth {
    /// Upstream `name` (anthropic.ts:356).
    fn name(&self) -> &str {
        "Anthropic (Claude Pro/Max)"
    }

    /// Upstream `isSubscription: true` (anthropic.ts:357).
    fn is_subscription(&self) -> bool {
        true
    }

    /// Upstream `login` (anthropic.ts:358).
    fn login<'a>(
        &'a self,
        interaction: ProviderAuthInteraction,
    ) -> BoxFuture<'a, Result<OAuthCredential, AuthError>> {
        Box::pin(login_anthropic(
            &self.token_url,
            &self.callback_host,
            self.callback_port,
            interaction,
        ))
    }

    /// Upstream `refresh` (anthropic.ts:359).
    fn refresh<'a>(
        &'a self,
        credential: OAuthCredential,
        options: &'a crate::ai::auth::types::AuthOperationOptions,
    ) -> BoxFuture<'a, Result<OAuthCredential, AuthError>> {
        Box::pin(async move {
            let signal = options.signal.clone().unwrap_or_default();
            refresh_anthropic_token(&self.token_url, &credential.refresh, &signal).await
        })
    }

    /// Upstream `toAuth` (anthropic.ts:361-363): `{ apiKey: credential.access }`.
    fn to_auth<'a>(
        &'a self,
        credential: OAuthCredential,
    ) -> BoxFuture<'a, Result<ModelAuth, AuthError>> {
        Box::pin(async move {
            Ok(ModelAuth {
                api_key: Some(credential.access),
                ..ModelAuth::default()
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use futures::future::BoxFuture;
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_util::sync::CancellationToken;
    use url::Url;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::ai::auth::oauth::pkce::base64url_encode;
    use crate::ai::auth::types::{AuthInteraction, AuthOperationOptions};

    type Respond =
        Box<dyn Fn(AuthPrompt) -> BoxFuture<'static, Result<String, AuthError>> + Send + Sync>;

    /// Minimal interaction: records events and prompts, answers prompts
    /// through the injected responder, and mirrors `auth_url` events into a
    /// slot the tests (and responders) can read while login is in flight.
    struct FakeInteraction {
        auth_url: Arc<Mutex<Option<String>>>,
        events: Mutex<Vec<AuthEvent>>,
        prompts: Mutex<Vec<AuthPrompt>>,
        respond: Respond,
    }

    impl AuthInteraction for FakeInteraction {
        fn signal(&self) -> Option<CancellationToken> {
            None
        }

        fn prompt(&self, prompt: AuthPrompt) -> BoxFuture<'_, Result<String, AuthError>> {
            self.prompts.lock().unwrap().push(prompt.clone());
            (self.respond)(prompt)
        }

        fn notify(&self, event: AuthEvent) {
            if let AuthEvent::AuthUrl { url, .. } = &event {
                *self.auth_url.lock().unwrap() = Some(url.clone());
            }
            self.events.lock().unwrap().push(event);
        }
    }

    fn fake_interaction(respond: Respond) -> (Arc<FakeInteraction>, ProviderAuthInteraction) {
        fake_interaction_with_slot(Arc::new(Mutex::new(None)), respond)
    }

    fn fake_interaction_with_slot(
        auth_url: Arc<Mutex<Option<String>>>,
        respond: Respond,
    ) -> (Arc<FakeInteraction>, ProviderAuthInteraction) {
        let fake = Arc::new(FakeInteraction {
            auth_url,
            events: Mutex::new(Vec::new()),
            prompts: Mutex::new(Vec::new()),
            respond,
        });
        let interaction = ProviderAuthInteraction::new(
            Arc::clone(&fake) as Arc<dyn AuthInteraction>,
            CancellationToken::new(),
        );
        (fake, interaction)
    }

    /// Answers immediately with a fixed string (the oracle tests' prompt).
    fn instant_interaction(
        answer: &'static str,
    ) -> (Arc<FakeInteraction>, ProviderAuthInteraction) {
        fake_interaction(Box::new(move |_prompt| {
            Box::pin(async move { Ok(answer.to_string()) })
        }))
    }

    /// Never answers; blocks on its prompt signal like a real pending UI
    /// prompt, so the callback-server path can win the race.
    fn hanging_interaction() -> (Arc<FakeInteraction>, ProviderAuthInteraction) {
        fake_interaction(Box::new(|prompt| {
            Box::pin(async move {
                prompt.signal.unwrap_or_default().cancelled().await;
                Err(AuthError::Cancelled)
            })
        }))
    }

    /// Answers with `{redirect_uri}?{query(state)}`, reading the state and the
    /// redirect URI out of the emitted auth URL like a user pasting the final
    /// redirect. `port` must match the flow's callback port.
    fn redirect_url_interaction(
        port: u16,
        query_for_state: Arc<dyn Fn(&str) -> String + Send + Sync>,
    ) -> (Arc<FakeInteraction>, ProviderAuthInteraction) {
        let slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let respond_slot = Arc::clone(&slot);
        fake_interaction_with_slot(
            slot,
            Box::new(move |_prompt| {
                let slot = Arc::clone(&respond_slot);
                let query_for_state = Arc::clone(&query_for_state);
                Box::pin(async move {
                    let auth_url = slot.lock().unwrap().clone().expect("auth_url emitted");
                    let url = Url::parse(&auth_url).unwrap();
                    let pair = |name: &str| {
                        url.query_pairs()
                            .find(|(key, _)| key == name)
                            .map(|(_, value)| value.into_owned())
                            .expect("missing auth URL parameter")
                    };
                    let state = pair("state");
                    let redirect_uri = pair("redirect_uri");
                    assert_eq!(
                        redirect_uri,
                        format!("http://localhost:{port}/callback"),
                        "the redirect_uri parameter must keep the localhost form"
                    );
                    Ok(format!("{redirect_uri}?{}", query_for_state(&state)))
                })
            }),
        )
    }

    fn free_callback_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn flow_with(server: &MockServer, port: u16) -> AnthropicOAuth {
        AnthropicOAuth::with_endpoints(
            format!("{}/v1/oauth/token", server.uri()),
            "127.0.0.1".to_string(),
            port,
        )
    }

    async fn mount_token_endpoint(server: &MockServer, body: &str, status: u16, expected: u64) {
        Mock::given(method("POST"))
            .and(path("/v1/oauth/token"))
            .and(header("content-type", "application/json"))
            .and(header("accept", "application/json"))
            .respond_with(
                ResponseTemplate::new(status).set_body_raw(body.to_string(), "application/json"),
            )
            .expect(expected)
            .mount(server)
            .await;
    }

    fn auth_url_of(interaction: &FakeInteraction) -> String {
        interaction
            .auth_url
            .lock()
            .unwrap()
            .clone()
            .expect("login must emit an auth_url event")
    }

    fn auth_url_param(auth_url: &str, name: &str) -> String {
        Url::parse(auth_url)
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .expect("missing auth URL parameter")
    }

    async fn http_get(port: u16, target: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        stream
            .write_all(
                format!("GET {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }

    fn token_body(access: &str, refresh: &str) -> String {
        format!(r#"{{"access_token":"{access}","refresh_token":"{refresh}","expires_in":3600}}"#)
    }

    // ---- Oracle ports (packages/ai/test/anthropic-oauth.test.ts) ----

    /// Oracle: "keeps the localhost redirect_uri for manual callback login".
    #[tokio::test]
    async fn login_resolves_through_the_manual_prompt_keeping_the_localhost_redirect_uri() {
        let server = MockServer::start().await;
        mount_token_endpoint(
            &server,
            &token_body("access-token", "refresh-token"),
            200,
            1,
        )
        .await;
        let port = free_callback_port();
        let oauth = flow_with(&server, port);
        let (fake, interaction) = redirect_url_interaction(
            port,
            Arc::new(|state| format!("code=manual-code&state={state}")),
        );

        let credential = oauth.login(interaction).await.unwrap();

        assert_eq!(credential.access, "access-token");
        assert_eq!(credential.refresh, "refresh-token");
        // expires = now + 3600s - 5min (upstream anthropic.ts:230).
        assert!((credential.expires - (now_ms() + 3_300_000)).abs() <= 2_000);

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        let state = auth_url_param(&auth_url_of(&fake), "state");
        assert_eq!(body["grant_type"], "authorization_code");
        assert_eq!(body["code"], "manual-code");
        assert_eq!(
            body["redirect_uri"],
            format!("http://localhost:{port}/callback")
        );
        assert_eq!(body["state"], state);
        // The state is the PKCE verifier; the exchange replays it.
        assert_eq!(body["code_verifier"], state);
        assert_eq!(body["client_id"], CLIENT_ID);
    }

    /// Oracle: "omits scope from refresh token requests".
    #[tokio::test]
    async fn refresh_requests_carry_only_the_refresh_fields_without_scope() {
        let server = MockServer::start().await;
        mount_token_endpoint(
            &server,
            r#"{"access_token":"new-access-token","refresh_token":"new-refresh-token","expires_in":3600,"scope":"user:profile"}"#,
            200,
            1,
        )
        .await;
        let oauth = flow_with(&server, free_callback_port());

        let credential = oauth
            .refresh(
                OAuthCredential {
                    refresh: "refresh-token".to_string(),
                    access: "old-access-token".to_string(),
                    expires: 0,
                    extra: Default::default(),
                },
                &AuthOperationOptions::default(),
            )
            .await
            .unwrap();

        assert_eq!(credential.access, "new-access-token");
        assert_eq!(credential.refresh, "new-refresh-token");
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        let body = body.as_object().unwrap();
        assert_eq!(body.len(), 3);
        assert_eq!(body["grant_type"], "refresh_token");
        assert_eq!(body["client_id"], CLIENT_ID);
        assert_eq!(body["refresh_token"], "refresh-token");
        assert!(body.get("scope").is_none());
    }

    /// Oracle: "anthropicOAuth.login resolves through the manual_code prompt
    /// and aborts it after settling".
    #[tokio::test]
    async fn login_resolves_through_the_manual_code_prompt_and_aborts_it_after_settling() {
        let server = MockServer::start().await;
        mount_token_endpoint(&server, &token_body("access", "refresh"), 200, 1).await;
        let port = free_callback_port();
        let oauth = flow_with(&server, port);
        let (fake, interaction) = instant_interaction("the-code");

        let credential = oauth.login(interaction).await.unwrap();

        assert_eq!(credential.access, "access");
        assert_eq!(credential.refresh, "refresh");
        let events = fake.events.lock().unwrap().clone();
        assert!(
            events
                .iter()
                .any(|event| matches!(event, AuthEvent::AuthUrl { .. })),
            "login must emit an auth_url event: {events:?}"
        );
        assert!(
            events.iter().any(|event| matches!(
                event,
                AuthEvent::Progress { message }
                    if message == "Exchanging authorization code for tokens..."
            )),
            "login must emit the exchange progress event: {events:?}"
        );
        let prompts = fake.prompts.lock().unwrap();
        assert_eq!(prompts.len(), 1);
        let AuthPromptKind::ManualCode {
            message,
            placeholder,
        } = &prompts[0].kind
        else {
            panic!("expected a manual_code prompt, got {:?}", prompts[0].kind);
        };
        assert_eq!(
            message,
            "Complete login in your browser, or paste the authorization code / redirect URL here:"
        );
        assert_eq!(
            placeholder.as_deref(),
            Some(&format!("http://localhost:{port}/callback") as &str)
        );
        // The prompt's signal is aborted once login settles, so UIs can
        // dismiss it.
        assert!(prompts[0].signal.as_ref().unwrap().is_cancelled());
    }

    // ---- Flow details ----

    #[test]
    fn production_endpoints_match_upstream() {
        // atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")
        assert_eq!(CLIENT_ID, "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
        assert_eq!(AUTHORIZE_URL, "https://claude.ai/oauth/authorize");
        assert_eq!(TOKEN_URL, "https://platform.claude.com/v1/oauth/token");
        assert_eq!(DEFAULT_CALLBACK_HOST, "127.0.0.1");
        assert_eq!(CALLBACK_PORT, 53692);
        assert_eq!(CALLBACK_PATH, "/callback");
        assert_eq!(
            redirect_uri(CALLBACK_PORT),
            "http://localhost:53692/callback"
        );
        assert_eq!(
            SCOPES,
            "org:create_api_key user:profile user:inference user:sessions:claude_code \
             user:mcp_servers user:file_upload"
        );
        assert_eq!(POST_TIMEOUT, Duration::from_secs(30));
    }

    #[tokio::test]
    async fn auth_url_carries_the_pkce_parameters_in_upstream_order() {
        let server = MockServer::start().await;
        mount_token_endpoint(&server, &token_body("a", "r"), 200, 1).await;
        let port = free_callback_port();
        let oauth = flow_with(&server, port);
        let (fake, interaction) = instant_interaction("any-code");

        oauth.login(interaction).await.unwrap();

        let (url, instructions) = fake
            .events
            .lock()
            .unwrap()
            .iter()
            .find_map(|event| match event {
                AuthEvent::AuthUrl { url, instructions } => {
                    Some((url.clone(), instructions.clone()))
                }
                _ => None,
            })
            .expect("auth_url event");
        assert_eq!(
            instructions.as_deref(),
            Some(
                "Complete login in your browser. If the browser is on another machine, paste the \
                 final redirect URL here."
            )
        );

        let url = Url::parse(&url).unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("claude.ai"));
        assert_eq!(url.path(), "/oauth/authorize");
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        let state = pairs
            .iter()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.clone())
            .unwrap();
        // S256 of the state (= the verifier), base64url without padding.
        let expected_challenge = base64url_encode(&Sha256::digest(state.as_bytes()));
        assert_eq!(
            pairs,
            vec![
                ("code".to_string(), "true".to_string()),
                ("client_id".to_string(), CLIENT_ID.to_string()),
                ("response_type".to_string(), "code".to_string()),
                (
                    "redirect_uri".to_string(),
                    format!("http://localhost:{port}/callback")
                ),
                ("scope".to_string(), SCOPES.to_string()),
                ("code_challenge".to_string(), expected_challenge),
                ("code_challenge_method".to_string(), "S256".to_string()),
                ("state".to_string(), state),
            ]
        );
    }

    #[tokio::test]
    async fn manual_input_with_a_state_mismatch_is_rejected_without_exchanging() {
        let server = MockServer::start().await;
        mount_token_endpoint(&server, "{}", 200, 0).await;
        let port = free_callback_port();
        let oauth = flow_with(&server, port);
        let (fake, interaction) = redirect_url_interaction(
            port,
            Arc::new(|_state| "code=x&state=wrong-state".to_string()),
        );

        let error = oauth.login(interaction).await.unwrap_err();
        assert_eq!(
            error,
            AuthError::Operation("OAuth state mismatch".to_string())
        );
        assert_eq!(fake.prompts.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn manual_input_state_defaults_to_the_verifier() {
        let server = MockServer::start().await;
        mount_token_endpoint(&server, &token_body("a", "r"), 200, 1).await;
        let oauth = flow_with(&server, free_callback_port());
        let (fake, interaction) = instant_interaction("bare-code");

        let credential = oauth.login(interaction).await.unwrap();
        assert_eq!(credential.access, "a");
        let verifier = auth_url_param(&auth_url_of(&fake), "state");
        let requests = server.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["code"], "bare-code");
        assert_eq!(body["state"], verifier);
    }

    #[tokio::test]
    async fn empty_manual_input_reports_a_missing_authorization_code() {
        let server = MockServer::start().await;
        mount_token_endpoint(&server, "{}", 200, 0).await;
        let oauth = flow_with(&server, free_callback_port());
        let (_fake, interaction) = instant_interaction("   ");

        let error = oauth.login(interaction).await.unwrap_err();
        assert_eq!(
            error,
            AuthError::Operation("Missing authorization code".to_string())
        );
    }

    #[tokio::test]
    async fn login_completes_through_the_local_callback_server() {
        let server = MockServer::start().await;
        mount_token_endpoint(&server, &token_body("cb-access", "cb-refresh"), 200, 1).await;
        let port = free_callback_port();
        let oauth = flow_with(&server, port);
        let (fake, interaction) = hanging_interaction();
        let auth_url_slot = Arc::clone(&fake.auth_url);

        let driver = tokio::spawn(async move {
            let auth_url = loop {
                if let Some(auth_url) = auth_url_slot.lock().unwrap().clone() {
                    break auth_url;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            let state = auth_url_param(&auth_url, "state");
            let response = http_get(port, &format!("/callback?code=cb-code&state={state}")).await;
            response
        });

        let credential = tokio::time::timeout(Duration::from_secs(10), oauth.login(interaction))
            .await
            .unwrap()
            .unwrap();
        let response = driver.await.unwrap();

        assert_eq!(credential.access, "cb-access");
        assert_eq!(credential.refresh, "cb-refresh");
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("Content-Type: text/html; charset=utf-8"));
        assert!(response.contains("<h1>Authentication successful</h1>"));
        assert!(response.contains("Anthropic authentication completed."));
        let requests = server.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["code"], "cb-code");
        // The manual prompt was aborted by the finally block.
        assert!(fake.prompts.lock().unwrap()[0]
            .signal
            .as_ref()
            .unwrap()
            .is_cancelled());
    }

    #[tokio::test]
    async fn cancelled_interaction_signal_aborts_login_before_the_prompt() {
        let oauth = AnthropicOAuth::with_endpoints(
            "http://127.0.0.1:1/v1/oauth/token".to_string(),
            "127.0.0.1".to_string(),
            free_callback_port(),
        );
        let (fake, _) = instant_interaction("unused");
        let token = CancellationToken::new();
        token.cancel();
        let interaction =
            ProviderAuthInteraction::new(Arc::clone(&fake) as Arc<dyn AuthInteraction>, token);

        let result = oauth.login(interaction).await;
        assert_eq!(result, Err(AuthError::Cancelled));
        assert!(fake.prompts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn interaction_signal_cancelled_mid_login_aborts_the_wait() {
        let oauth = AnthropicOAuth::with_endpoints(
            "http://127.0.0.1:1/v1/oauth/token".to_string(),
            "127.0.0.1".to_string(),
            free_callback_port(),
        );
        let (fake, interaction) = hanging_interaction();
        let signal = interaction.signal.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            signal.cancel();
        });

        let result = tokio::time::timeout(Duration::from_secs(5), oauth.login(interaction))
            .await
            .unwrap();
        assert_eq!(result, Err(AuthError::Cancelled));
        assert_eq!(fake.prompts.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn exchange_http_errors_carry_the_upstream_message_shape() {
        let server = MockServer::start().await;
        mount_token_endpoint(&server, "denied", 400, 1).await;
        let port = free_callback_port();
        let token_url = format!("{}/v1/oauth/token", server.uri());
        let oauth = flow_with(&server, port);
        let (_fake, interaction) = instant_interaction("the-code");

        let error = oauth.login(interaction).await.unwrap_err();
        let redirect = format!("http://localhost:{port}/callback");
        assert_eq!(
            error,
            AuthError::Operation(format!(
                "Token exchange request failed. url={token_url}; redirect_uri={redirect}; \
                 response_type=authorization_code; details=Error: HTTP request failed. \
                 status=400; url={token_url}; body=denied"
            ))
        );
    }

    #[tokio::test]
    async fn exchange_invalid_json_errors_carry_the_body() {
        let server = MockServer::start().await;
        mount_token_endpoint(&server, "not json", 200, 1).await;
        let token_url = format!("{}/v1/oauth/token", server.uri());
        let oauth = flow_with(&server, free_callback_port());
        let (_fake, interaction) = instant_interaction("the-code");

        let error = oauth.login(interaction).await.unwrap_err();
        match error {
            AuthError::Operation(message) => assert!(message.starts_with(
                format!(
                    "Token exchange returned invalid JSON. url={token_url}; body=not json; \
                     details=Error: "
                )
                .as_str()
            )),
            other => panic!("expected an operation error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn refresh_http_errors_carry_the_upstream_message_shape() {
        let server = MockServer::start().await;
        mount_token_endpoint(&server, "nope", 400, 1).await;
        let token_url = format!("{}/v1/oauth/token", server.uri());
        let oauth = flow_with(&server, free_callback_port());

        let error = oauth
            .refresh(
                OAuthCredential {
                    refresh: "r".to_string(),
                    access: "a".to_string(),
                    expires: 0,
                    extra: Default::default(),
                },
                &AuthOperationOptions::default(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error,
            AuthError::Operation(format!(
                "Anthropic token refresh request failed. url={token_url}; details=Error: \
                 HTTP request failed. status=400; url={token_url}; body=nope"
            ))
        );
    }

    #[tokio::test]
    async fn refresh_invalid_json_errors_carry_the_body() {
        let server = MockServer::start().await;
        mount_token_endpoint(&server, "not json", 200, 1).await;
        let token_url = format!("{}/v1/oauth/token", server.uri());
        let oauth = flow_with(&server, free_callback_port());

        let error = oauth
            .refresh(
                OAuthCredential {
                    refresh: "r".to_string(),
                    access: "a".to_string(),
                    expires: 0,
                    extra: Default::default(),
                },
                &AuthOperationOptions::default(),
            )
            .await
            .unwrap_err();
        match error {
            AuthError::Operation(message) => assert!(message.starts_with(
                format!(
                    "Anthropic token refresh returned invalid JSON. url={token_url}; \
                     body=not json; details=Error: "
                )
                .as_str()
            )),
            other => panic!("expected an operation error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cancelled_signal_skips_the_refresh_request() {
        let server = MockServer::start().await;
        mount_token_endpoint(&server, "{}", 200, 0).await;
        let oauth = flow_with(&server, free_callback_port());
        let token = CancellationToken::new();
        token.cancel();

        let error = oauth
            .refresh(
                OAuthCredential {
                    refresh: "r".to_string(),
                    access: "a".to_string(),
                    expires: 0,
                    extra: Default::default(),
                },
                &AuthOperationOptions::new(token),
            )
            .await
            .unwrap_err();
        assert_eq!(error, AuthError::Cancelled);
    }

    #[tokio::test]
    async fn to_auth_derives_the_request_api_key_from_the_access_token() {
        let oauth = AnthropicOAuth::new();
        assert_eq!(oauth.name(), "Anthropic (Claude Pro/Max)");
        assert!(oauth.is_subscription());
        assert_eq!(oauth.login_label(), None);
        let auth = oauth
            .to_auth(OAuthCredential {
                refresh: "r".to_string(),
                access: "access-token".to_string(),
                expires: 42,
                extra: Default::default(),
            })
            .await
            .unwrap();
        assert_eq!(
            auth,
            ModelAuth {
                api_key: Some("access-token".to_string()),
                headers: None,
                base_url: None,
            }
        );
    }

    // ---- parse_authorization_input (upstream lines 52-80) ----

    #[test]
    fn parse_authorization_input_follows_the_upstream_branches() {
        let parsed = |input: &str| {
            let parsed = parse_authorization_input(input);
            (parsed.code, parsed.state)
        };

        // Absolute redirect URL: query params win, early return.
        assert_eq!(
            parsed("http://localhost:53692/callback?code=abc&state=xyz"),
            (Some("abc".to_string()), Some("xyz".to_string()))
        );
        // Query values percent-decode (and `+` reads as space).
        assert_eq!(
            parsed("https://claude.ai/test?code=a%20b&state=c+d"),
            (Some("a b".to_string()), Some("c d".to_string()))
        );
        // Fragments do not leak into the query.
        assert_eq!(
            parsed("http://localhost:53692/callback?code=abc#frag"),
            (Some("abc".to_string()), None)
        );
        // A parseable URL without code/state returns empty immediately.
        assert_eq!(parsed("http://localhost:53692/callback"), (None, None));
        // `localhost:53692` parses as scheme + path, like WHATWG `new URL`.
        assert_eq!(parsed("localhost:53692"), (None, None));

        // `code#state` pairs.
        assert_eq!(
            parsed("the-code#the-state"),
            (Some("the-code".to_string()), Some("the-state".to_string()))
        );
        // JS `split("#", 2)` drops everything after the second element.
        assert_eq!(
            parsed("a#b#c"),
            (Some("a".to_string()), Some("b".to_string()))
        );
        assert_eq!(
            parsed("code#"),
            (Some("code".to_string()), Some(String::new()))
        );

        // Bare query strings.
        assert_eq!(
            parsed("code=a&state=b"),
            (Some("a".to_string()), Some("b".to_string()))
        );
        // A URL-bar paste keeps its leading `?`: `new URLSearchParams` strips
        // exactly one, so the input still parses (post-review fix).
        assert_eq!(
            parsed("?code=x&state=y"),
            (Some("x".to_string()), Some("y".to_string()))
        );
        // Only one `?` is stripped: the remainder names a `?code` pair, so
        // `code` is absent (same as upstream).
        assert_eq!(parsed("??code=x"), (None, None));
        // First occurrence wins (`URLSearchParams.get`).
        assert_eq!(parsed("code=a&code=b"), (Some("a".to_string()), None));
        // A name merely containing "code=" matches nothing.
        assert_eq!(parsed("xcode=y"), (None, None));

        // Bare codes, trimmed input, empty input.
        assert_eq!(parsed("the-code"), (Some("the-code".to_string()), None));
        assert_eq!(parsed("  the-code  "), (Some("the-code".to_string()), None));
        assert_eq!(parsed(""), (None, None));
        assert_eq!(parsed("   "), (None, None));
    }

    // ---- Callback server ----

    async fn started_server() -> (CallbackServer, u16) {
        let port = free_callback_port();
        let server = CallbackServer::start("expected-state".to_string(), "127.0.0.1", port)
            .await
            .unwrap();
        (server, port)
    }

    async fn settle_within(server: &CallbackServer) -> Option<DeliveredCode> {
        tokio::time::timeout(Duration::from_secs(5), server.wait())
            .await
            .unwrap()
    }

    async fn stays_pending(server: &CallbackServer) {
        assert!(
            tokio::time::timeout(Duration::from_millis(200), server.wait())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn callback_delivers_the_code_with_the_success_page() {
        let (server, port) = started_server().await;
        let response = http_get(port, "/callback?code=cb&state=expected-state").await;
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("<h1>Authentication successful</h1>"));
        assert_eq!(
            settle_within(&server).await,
            Some(("cb".to_string(), "expected-state".to_string()))
        );
        server.close().await;
    }

    #[tokio::test]
    async fn callback_rejects_unknown_routes_errors_missing_params_and_state_mismatch() {
        let (server, port) = started_server().await;

        // Unknown route.
        let response = http_get(port, "/nope?code=cb&state=expected-state").await;
        assert!(response.starts_with("HTTP/1.1 404 Not Found\r\n"));
        assert!(response.contains("Callback route not found."));
        stays_pending(&server).await;

        // Provider-reported error.
        let response = http_get(port, "/callback?error=access_denied").await;
        assert!(response.starts_with("HTTP/1.1 400 Bad Request\r\n"));
        assert!(response.contains("Anthropic authentication did not complete."));
        assert!(response.contains("Error: access_denied"));
        stays_pending(&server).await;

        // Missing code.
        let response = http_get(port, "/callback?state=expected-state").await;
        assert!(response.starts_with("HTTP/1.1 400 Bad Request\r\n"));
        assert!(response.contains("Missing code or state parameter."));
        stays_pending(&server).await;

        // Missing state.
        let response = http_get(port, "/callback?code=cb").await;
        assert!(response.contains("Missing code or state parameter."));
        stays_pending(&server).await;

        // Empty params count as missing (upstream truthiness).
        let response = http_get(port, "/callback?code=&state=").await;
        assert!(response.contains("Missing code or state parameter."));

        // State mismatch.
        let response = http_get(port, "/callback?code=cb&state=wrong").await;
        assert!(response.starts_with("HTTP/1.1 400 Bad Request\r\n"));
        assert!(response.contains("State mismatch."));
        stays_pending(&server).await;

        server.close().await;
    }

    #[tokio::test]
    async fn callback_malformed_request_line_gets_the_internal_error_page() {
        let (server, port) = started_server().await;
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        stream.write_all(b"NOREQUESTTARGET\r\n\r\n").await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8_lossy(&response);
        assert!(response.starts_with("HTTP/1.1 500 Internal Server Error\r\n"));
        assert!(response.contains("Internal error"));
        stays_pending(&server).await;
        server.close().await;
    }

    #[tokio::test]
    async fn cancel_wait_wins_over_a_later_code() {
        let (server, port) = started_server().await;
        server.cancel_wait();
        assert_eq!(settle_within(&server).await, None);
        // A browser arriving late cannot overwrite the cancel (upstream's
        // `settled` flag).
        let _ = http_get(port, "/callback?code=late&state=expected-state").await;
        assert_eq!(settle_within(&server).await, None);
        server.close().await;
    }

    #[tokio::test]
    async fn close_releases_the_port() {
        let (server, port) = started_server().await;
        server.close().await;
        // The listener is gone: rebinding succeeds.
        let rebound = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(rebound.is_ok(), "port {port} must be released after close");
    }
}
