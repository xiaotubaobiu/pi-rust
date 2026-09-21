//! The model-catalog layer (upstream `packages/ai/src/model-catalog.ts` plus
//! the generated catalog shards `providers/*.models.ts` and the
//! `data/.manifest.json` manifest) and the `Models` collection (upstream
//! `packages/ai/src/models.ts`): the provider registry, its sync reads, auth
//! resolution ([`Models::get_auth`]/[`Models::get_auth_for_model`]), and
//! stream routing ([`Models::stream`]/[`Models::stream_simple`] with the
//! [`ModelsApiStreamOptions`] transform hooks). The refresh/publication
//! machinery and the models store join in Task 4 (together with
//! `checkAuth`/`getAvailable`/`login`/`logout`, which upstream share the
//! auth-reading surface with), and the built-in provider factories in Task 5.

pub mod catalog;
pub mod provider;

pub use catalog::{
    catalog_provider_ids, embedded_provider_catalog, embedded_provider_groups,
    flatten_model_catalog, model_data_manifest, model_data_structure, model_data_structure_hash,
    validate_embedded_catalog, ModelDataManifest, ModelDataStructure, MODEL_DATA_MANIFEST_FILE,
    MODEL_DATA_SCHEMA_VERSION,
};
pub use provider::{create_provider, ApiImpls, CreateProviderOptions, Provider, StandardProvider};

use std::sync::Arc;

use futures::future::BoxFuture;
use tokio::sync::mpsc;

use crate::ai::auth::context::default_provider_auth_context;
use crate::ai::auth::credential_store::{CredentialStore, InMemoryCredentialStore};
use crate::ai::auth::resolve::{
    resolve_provider_auth, AuthResolutionOverrides, ModelsError, ModelsErrorCode,
};
use crate::ai::auth::types::{AuthContext, AuthError, AuthResult};
use crate::ai::transcript::{normalize_context, TranscriptContext};
use crate::ai::types::events::{AssistantMessageEvent, ErrorReason, PartialAssistant};
use crate::ai::types::message::AssistantMessage;
use crate::ai::types::options::{ProviderEnv, ProviderHeaders, SimpleStreamOptions, StreamOptions};
use crate::ai::types::primitives::{StopReason, Usage};
use crate::ai::types::Model;
use crate::ai::{now_ms, Context, ProviderConfig};

/// Upstream `CreateModelsOptions` (models.ts:244-249). The third upstream
/// field, `modelsStore`, joins with Task 4 together with the `ModelsStore`
/// trait it types (`store.rs`).
#[derive(Default)]
pub struct CreateModelsOptions {
    /// Credential store backing auth resolution (upstream `credentials`).
    /// Default: the in-memory store (upstream `InMemoryCredentialStore`).
    pub credentials: Option<Arc<dyn CredentialStore>>,
    /// Environment access for auth resolution (upstream `authContext`).
    /// Default: the process-env context (upstream `defaultAuthContext`).
    pub auth_context: Option<Arc<dyn AuthContext>>,
}

/// Upstream `ModelsRequestTransforms.transformHeaders` (models.ts:81-83): a
/// Models-only transform over the fully assembled model/auth/request headers,
/// run once before provider dispatch. Async upstream; the port hands the
/// closure a [`BoxFuture`].
pub type TransformHeaders =
    Arc<dyn Fn(ProviderHeaders) -> BoxFuture<'static, ProviderHeaders> + Send + Sync>;

/// Upstream `ModelsApiStreamOptions` (models.ts:85): `ApiStreamOptions` plus
/// the Models-only header transform. The upstream intersection flattens to an
/// embedded base struct here, the same shape [`SimpleStreamOptions`] uses for
/// its upstream base.
#[derive(Clone, Default)]
pub struct ModelsApiStreamOptions {
    /// Base request/stream options.
    pub stream: StreamOptions,
    /// Runs once over the assembled headers (auth + model + explicit)
    /// before dispatch (upstream `transformHeaders`); its result replaces
    /// them and never reaches the provider.
    pub transform_headers: Option<TransformHeaders>,
}

/// Upstream `ModelsSimpleStreamOptions` (models.ts:86): `SimpleStreamOptions`
/// plus the Models-only header transform.
#[derive(Clone, Default)]
pub struct ModelsSimpleStreamOptions {
    /// Base request/stream options plus the simple-request extension fields.
    pub simple: SimpleStreamOptions,
    /// Runs once over the assembled headers before dispatch (upstream
    /// `transformHeaders`).
    pub transform_headers: Option<TransformHeaders>,
}

/// Upstream `Models` + `MutableModels` (models.ts:163-242): runtime collection
/// of providers plus auth application and stream convenience. The upstream
/// `Models`/`MutableModels` interface split (read surface vs registry
/// mutation) is a JS capability boundary; the port is one struct. Providers
/// are held in registration order (upstream `Map` insertion order — an upsert
/// keeps the original position).
pub struct Models {
    providers: Vec<(String, Arc<dyn Provider>)>,
    credentials: Arc<dyn CredentialStore>,
    auth_context: Arc<dyn AuthContext>,
}

/// Upstream `createModels` (models.ts:757-759).
pub fn create_models(options: CreateModelsOptions) -> Models {
    Models {
        providers: Vec::new(),
        credentials: options.credentials.unwrap_or_else(|| {
            Arc::new(InMemoryCredentialStore::default()) as Arc<dyn CredentialStore>
        }),
        auth_context: options
            .auth_context
            .unwrap_or_else(|| Arc::new(default_provider_auth_context()) as Arc<dyn AuthContext>),
    }
}

impl Models {
    /// Upstream `MutableModels.setProvider` (models.ts:239, 281-284): upsert
    /// by provider id — ids are unique and replacement keeps the original
    /// position. Upstream supersedes any in-flight refresh for the id first
    /// (TODO(T4): `supersedeProviderRefresh`, models.ts:332-341).
    pub fn set_provider(&mut self, provider: Arc<dyn Provider>) {
        match self
            .providers
            .iter_mut()
            .find(|(id, _)| *id == provider.id())
        {
            Some((_, existing)) => *existing = provider,
            None => self.providers.push((provider.id().to_string(), provider)),
        }
    }

    /// Upstream `MutableModels.deleteProvider` (models.ts:286-289): no-op for
    /// unknown ids, like `Map.delete` (TODO(T4): refresh supersede).
    pub fn delete_provider(&mut self, id: &str) {
        self.providers.retain(|(existing, _)| existing != id);
    }

    /// Upstream `MutableModels.clearProviders` (models.ts:291-296)
    /// (TODO(T4): refresh supersede).
    pub fn clear_providers(&mut self) {
        self.providers.clear();
    }

    /// Upstream `Models.getProviders` (models.ts:298-300), in provider
    /// registration order.
    pub fn get_providers(&self) -> Vec<Arc<dyn Provider>> {
        self.providers
            .iter()
            .map(|(_, provider)| Arc::clone(provider))
            .collect()
    }

    /// Upstream `Models.getProvider` (models.ts:302-304).
    pub fn get_provider(&self, id: &str) -> Option<Arc<dyn Provider>> {
        self.providers
            .iter()
            .find(|(existing, _)| existing == id)
            .map(|(_, provider)| Arc::clone(provider))
    }

    /// Upstream `Models.getModels` (models.ts:306-326): sync read of
    /// last-known models from one provider or all providers. Best-effort: a
    /// provider whose catalog read fails yields no models — for the
    /// single-provider filter, the all-providers concatenation, and unknown
    /// provider ids alike.
    pub fn get_models(&self, provider: Option<&str>) -> Vec<Model> {
        match provider {
            Some(id) => self
                .get_provider(id)
                .and_then(|entry| entry.get_models().ok())
                .unwrap_or_default(),
            None => self
                .providers
                .iter()
                .filter_map(|(_, entry)| entry.get_models().ok())
                .flatten()
                .collect(),
        }
    }

    /// Upstream `Models.getModel` (models.ts:328-330): sync runtime lookup
    /// against last-known lists. Upstream narrows the result with `hasApi()`;
    /// here [`Model::api`] is compared directly (see `provider.rs` module
    /// docs).
    pub fn get_model(&self, provider: &str, id: &str) -> Option<Model> {
        self.get_models(Some(provider))
            .into_iter()
            .find(|model| model.id == id)
    }

    /// Upstream `Models.getAuth(providerId)` (models.ts:201, 556-575):
    /// provider-scoped auth resolution with a source label for status UI.
    /// Resolves `Ok(None)` when the provider is unknown or unconfigured;
    /// `Err(AuthError::Models(..))` carries the [`ModelsError`] when a token
    /// refresh (code `"oauth"`, credential preserved) or api-key/credential
    /// store resolution (code `"auth"`) fails. Cancellation surfaces as
    /// [`AuthError::Cancelled`].
    pub async fn get_auth(
        &self,
        provider_id: &str,
        overrides: Option<&AuthResolutionOverrides>,
    ) -> Result<Option<AuthResult>, AuthError> {
        let Some(provider) = self.get_provider(provider_id) else {
            return Ok(None);
        };
        resolve_provider_auth(
            provider_id,
            provider.auth(),
            self.credentials.as_ref(),
            self.auth_context.as_ref(),
            overrides,
        )
        .await
    }

    /// Upstream `Models.getAuth(model)` (models.ts:202, 556-575): the
    /// provider-scoped resolution plus the model's static headers, merged
    /// case-insensitively over the auth headers (README "Transforming
    /// Request Headers": provider auth headers -> model.headers).
    pub async fn get_auth_for_model(
        &self,
        model: &Model,
        overrides: Option<&AuthResolutionOverrides>,
    ) -> Result<Option<AuthResult>, AuthError> {
        let Some(result) = self.get_auth(&model.provider, overrides).await? else {
            return Ok(None);
        };
        Ok(Some(merge_model_headers(result, model)))
    }

    /// Upstream `Models.stream` (models.ts:210-214, 679-693): normalize the
    /// context, then lazily resolve auth and dispatch to the owning
    /// provider's API implementation. Setup failures (unknown provider,
    /// unconfigured auth, no API implementation) terminate the stream with an
    /// error event instead of throwing (upstream `lazyStream`).
    pub fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<ModelsApiStreamOptions>,
    ) -> mpsc::Receiver<AssistantMessageEvent> {
        let options = options.unwrap_or_default();
        self.route(
            model,
            context,
            RoutedOptions::Api {
                stream: options.stream,
                transform_headers: options.transform_headers,
            },
        )
    }

    /// Upstream `Models.complete` (models.ts:216-221): the stream's final
    /// message; error streams settle with `stopReason: "error"`.
    pub async fn complete(
        &self,
        model: &Model,
        context: &Context,
        options: Option<ModelsApiStreamOptions>,
    ) -> AssistantMessage {
        reduce_stream(self.stream(model, context, options), model).await
    }

    /// Upstream `Models.streamSimple` (models.ts:222, 703-710): the
    /// simple-request routing over [`Models::stream`]'s path.
    pub fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<ModelsSimpleStreamOptions>,
    ) -> mpsc::Receiver<AssistantMessageEvent> {
        let options = options.unwrap_or_default();
        self.route(
            model,
            context,
            RoutedOptions::Simple {
                simple: options.simple,
                transform_headers: options.transform_headers,
            },
        )
    }

    /// Upstream `Models.completeSimple` (models.ts:223, 712-718).
    pub async fn complete_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<ModelsSimpleStreamOptions>,
    ) -> AssistantMessage {
        reduce_stream(self.stream_simple(model, context, options), model).await
    }

    /// Upstream `lazyStream` (api/lazy.ts:43-60) as a channel: the routing
    /// setup runs in a spawned task behind the returned receiver; setup
    /// failures emit a single error event (upstream `createSetupErrorMessage`)
    /// and close the stream.
    fn route(
        &self,
        model: &Model,
        context: &Context,
        options: RoutedOptions,
    ) -> mpsc::Receiver<AssistantMessageEvent> {
        let transcript = normalize_context(context);
        let model = model.clone();
        let provider = self.get_provider(&model.provider);
        let credentials = Arc::clone(&self.credentials);
        let auth_context = Arc::clone(&self.auth_context);
        let (tx, rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        tokio::spawn(async move {
            match route_stream(
                provider.as_deref(),
                &model,
                transcript,
                credentials.as_ref(),
                auth_context.as_ref(),
                options,
            )
            .await
            {
                Ok(mut inner) => {
                    while let Some(event) = inner.recv().await {
                        if tx.send(event).await.is_err() {
                            break;
                        }
                    }
                }
                Err(message) => {
                    let _ = tx
                        .send(AssistantMessageEvent::Error {
                            reason: ErrorReason::Error,
                            error: setup_error_message(&model, message),
                        })
                        .await;
                }
            }
        });
        rx
    }
}

/// The two option shapes [`Models::route`] accepts, mirroring the upstream
/// `ApiStreamOptions` vs `SimpleStreamOptions` dispatch target.
#[derive(Clone)]
enum RoutedOptions {
    Api {
        stream: StreamOptions,
        transform_headers: Option<TransformHeaders>,
    },
    Simple {
        simple: SimpleStreamOptions,
        transform_headers: Option<TransformHeaders>,
    },
}

/// Event-channel capacity for routed streams; the [`ApiImpl`] implementations
/// use the same bound for their own channels.
const EVENT_CHANNEL_CAPACITY: usize = 64;

/// Upstream `mergeHeaders` (models.ts:250-264): case-insensitive override
/// merge; an override `None` value (upstream `null`) suppresses the base
/// header. `None` only when both sides are absent.
pub(crate) fn merge_headers(
    base: Option<&ProviderHeaders>,
    override_headers: Option<&ProviderHeaders>,
) -> Option<ProviderHeaders> {
    match (base, override_headers) {
        (None, None) => None,
        (base, override_headers) => {
            let mut merged: ProviderHeaders = base.cloned().unwrap_or_default();
            for (name, value) in override_headers.into_iter().flatten() {
                let lowercase = name.to_lowercase();
                let replaced: Vec<String> = merged
                    .keys()
                    .filter(|existing| existing.to_lowercase() == lowercase)
                    .cloned()
                    .collect();
                for existing in replaced {
                    merged.remove(&existing);
                }
                merged.insert(name.clone(), value.clone());
            }
            Some(merged)
        }
    }
}

/// Upstream `getAuth(model)`'s header fold (models.ts:567-574): the model's
/// static headers merge over the resolved auth headers. The port's
/// [`Model::headers`] carries plain string values (M2a type), so they merge
/// as set-operations over the `Option`-valued [`ProviderHeaders`] without
/// the suppression form.
fn merge_model_headers(mut resolution: AuthResult, model: &Model) -> AuthResult {
    if let Some(model_headers) = model.headers.as_ref().filter(|headers| !headers.is_empty()) {
        let overrides: ProviderHeaders = model_headers
            .iter()
            .map(|(name, value)| (name.clone(), Some(value.clone())))
            .collect();
        resolution.auth.headers = merge_headers(resolution.auth.headers.as_ref(), Some(&overrides));
    }
    resolution
}

/// Upstream `createSetupErrorMessage` (api/lazy.ts:8-31): the message a
/// routing failure settles its stream with.
fn setup_error_message(model: &Model, message: impl std::fmt::Display) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        response_model: None,
        response_id: None,
        provider_thinking_level: None,
        diagnostics: None,
        usage: Usage::default(),
        stop_reason: StopReason::Error,
        deferred: None,
        error_message: Some(message.to_string()),
        raw_stop_reason: None,
        end_turn: None,
        timestamp: now_ms(),
    }
}

/// Upstream `.result()` on an event stream (utils/event-stream.ts): reduce the
/// event sequence to its final message. Error events settle the message with
/// `stopReason: "error"` (the [`PartialAssistant`] rules), so failures resolve
/// as values, exactly like upstream.
async fn reduce_stream(
    mut rx: mpsc::Receiver<AssistantMessageEvent>,
    model: &Model,
) -> AssistantMessage {
    let mut partial = PartialAssistant::new();
    while let Some(event) = rx.recv().await {
        if let Err(error) = partial.apply(&event) {
            return setup_error_message(
                model,
                format!("reducer rejected {}: {error}", event.event_type()),
            );
        }
    }
    partial
        .message()
        .cloned()
        .unwrap_or_else(|| setup_error_message(model, "stream ended without events"))
}

/// Upstream `requireProvider` + `applyAuth` + the provider dispatch
/// (models.ts:640-718): resolve auth through the owning provider, assemble
/// the request (config/options), then route to the model's API
/// implementation. Failures return the upstream error message verbatim; the
/// caller settles the stream with it.
async fn route_stream(
    provider: Option<&dyn Provider>,
    model: &Model,
    transcript: TranscriptContext,
    credentials: &dyn CredentialStore,
    auth_context: &dyn AuthContext,
    options: RoutedOptions,
) -> Result<mpsc::Receiver<AssistantMessageEvent>, String> {
    // requireProvider (models.ts:640-646).
    let provider = provider.ok_or_else(|| {
        ModelsError::new(
            ModelsErrorCode::Provider,
            format!("Unknown provider: {}", model.provider),
        )
        .to_string()
    })?;

    // applyAuth (models.ts:648-677) — getAuth(model) with the explicit
    // per-field overrides. The port's request options carry no signal
    // (dropped with the M2b stream signatures).
    let (options_api_key, options_env, options_headers, transform_headers) = match &options {
        RoutedOptions::Api {
            stream,
            transform_headers,
        } => (
            stream.api_key.clone(),
            stream.env.clone(),
            stream.headers.clone(),
            transform_headers.clone(),
        ),
        RoutedOptions::Simple {
            simple,
            transform_headers,
        } => (
            simple.stream.api_key.clone(),
            simple.stream.env.clone(),
            simple.stream.headers.clone(),
            transform_headers.clone(),
        ),
    };
    let overrides = AuthResolutionOverrides {
        api_key: options_api_key.clone(),
        env: options_env.clone(),
        ..AuthResolutionOverrides::default()
    };
    let resolution = resolve_provider_auth(
        &model.provider,
        provider.auth(),
        credentials,
        auth_context,
        Some(&overrides),
    )
    .await
    .map_err(|error| match error {
        AuthError::Models(error) => error.message,
        other => other.to_string(),
    })?;
    let Some(resolution) = resolution else {
        return Err(ModelsError::new(
            ModelsErrorCode::Auth,
            format!("Provider is not configured: {}", model.provider),
        )
        .to_string());
    };
    // applyAuth routes through getAuth(model), so the model's static headers
    // fold in here too (models.ts:656-663).
    let resolution = merge_model_headers(resolution, model);
    let auth = &resolution.auth;

    // Explicit request options win per field; the Models-only transform runs
    // last (models.ts:666-670).
    let api_key = options_api_key.or_else(|| auth.api_key.clone());
    let mut headers = merge_headers(auth.headers.as_ref(), options_headers.as_ref());
    if let Some(transform_headers) = transform_headers {
        headers = Some(transform_headers(headers.unwrap_or_default()).await);
    }
    let env = match (resolution.env.as_ref(), options_env.as_ref()) {
        (None, None) => None,
        (resolved, explicit) => {
            let mut merged: ProviderEnv = resolved.cloned().unwrap_or_default();
            merged.extend(explicit.cloned().unwrap_or_default());
            Some(merged)
        }
    };

    // The routed config is the port's channel for what upstream passes as
    // `requestModel.baseUrl` + `requestOptions.apiKey`: the ApiImpls read
    // both from it.
    let config = ProviderConfig {
        base_url: auth
            .base_url
            .clone()
            .unwrap_or_else(|| model.base_url.clone()),
        api_key: api_key.clone().unwrap_or_default(),
        max_tokens: model.max_tokens,
    };
    // requestModel (models.ts:671): the auth-derived baseUrl overrides the
    // model's; ApiImpls that read `model.base_url` (azure resource urls) see
    // the same override.
    let mut request_model = model.clone();
    if let Some(auth_base_url) = auth.base_url.clone() {
        request_model.base_url = auth_base_url;
    }

    // Provider dispatch (models.ts:691, 708): the api-implementation lookup
    // doubles as the upstream `apiFor` check; `None` produces the
    // "no API implementation" stream error (models.ts:808-811).
    let implementation = provider.api_for(model).ok_or_else(|| {
        ModelsError::new(
            ModelsErrorCode::Stream,
            format!(
                "Provider {} has no API implementation for \"{}\"",
                provider.id(),
                model.api
            ),
        )
        .to_string()
    })?;

    match options {
        RoutedOptions::Api { mut stream, .. } => {
            stream.api_key = api_key;
            stream.headers = headers;
            stream.env = env;
            Ok(implementation.stream(&config, &request_model, &transcript, &stream))
        }
        RoutedOptions::Simple { mut simple, .. } => {
            simple.stream.api_key = api_key;
            simple.stream.headers = headers;
            simple.stream.env = env;
            Ok(implementation.stream_simple(&config, &request_model, &transcript, &simple))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::api::ApiImpl;
    use crate::ai::auth::credential_store::{InMemoryCredentialStore, ModifyCallback};
    use crate::ai::auth::resolve::{AuthResolutionOverrides, ModelsError, ModelsErrorCode};
    use crate::ai::auth::types::{
        ApiKeyAuth, ApiKeyAuthInput, ApiKeyCredential, AuthError, AuthOperationOptions, AuthResult,
        Credential, CredentialInfo, ModelAuth, OAuthAuth, OAuthCredential, ProviderAuth,
        ProviderAuthInteraction,
    };
    use crate::ai::now_ms;
    use crate::ai::transcript::TranscriptContext;
    use crate::ai::types::events::{AssistantMessageEvent, PartialAssistant, SuccessReason};
    use crate::ai::types::message::{AssistantMessage, Message, StringOrBlocks, UserMessage};
    use crate::ai::types::options::{ProviderHeaders, SimpleStreamOptions, StreamOptions};
    use crate::ai::types::primitives::{ModelCost, StopReason, Usage};
    use crate::ai::types::ModelInput;
    use crate::ai::{Context, ProviderConfig};
    use futures::future::BoxFuture;
    use std::collections::BTreeMap;
    use tokio::sync::mpsc;

    /// Upstream `testModel` fixture (models-runtime.test.ts:9-22): api
    /// "test-api".
    fn test_model(provider: &str, id: &str) -> Model {
        Model {
            id: id.to_string(),
            name: id.to_string(),
            api: "test-api".to_string(),
            provider: provider.to_string(),
            base_url: "https://example.test/v1".to_string(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: ModelCost::default(),
            context_window: 10_000,
            max_tokens: 1000,
            sampling_params: None,
            headers: None,
            compat: None,
        }
    }

    /// Upstream `ambientAuth` fixture (models-runtime.test.ts:49-53).
    struct AmbientKeyAuth;

    impl ApiKeyAuth for AmbientKeyAuth {
        fn name(&self) -> &str {
            "Ambient"
        }

        fn resolve<'a>(
            &'a self,
            _input: ApiKeyAuthInput<'a>,
        ) -> BoxFuture<'a, Result<Option<AuthResult>, AuthError>> {
            Box::pin(async { Ok(Some(AuthResult::default())) })
        }
    }

    fn ambient_auth() -> ProviderAuth {
        ProviderAuth {
            api_key: Some(Arc::new(AmbientKeyAuth)),
            oauth: None,
        }
    }

    struct StubApi;

    impl ApiImpl for StubApi {
        fn stream(
            &self,
            _cfg: &crate::ai::ProviderConfig,
            _model: &Model,
            _ctx: &TranscriptContext,
            _options: &StreamOptions,
        ) -> mpsc::Receiver<AssistantMessageEvent> {
            let (tx, rx) = mpsc::channel(1);
            drop(tx);
            rx
        }

        fn stream_simple(
            &self,
            _cfg: &crate::ai::ProviderConfig,
            _model: &Model,
            _ctx: &TranscriptContext,
            _options: &SimpleStreamOptions,
        ) -> mpsc::Receiver<AssistantMessageEvent> {
            let (tx, rx) = mpsc::channel(1);
            drop(tx);
            rx
        }
    }

    fn test_provider(id: &str, models: Vec<Model>) -> Arc<dyn Provider> {
        test_provider_with_auth_and_api(
            id,
            models,
            ambient_auth(),
            ApiImpls::Single(Arc::new(StubApi)),
        )
    }

    fn test_provider_with_auth(
        id: &str,
        models: Vec<Model>,
        auth: ProviderAuth,
    ) -> Arc<dyn Provider> {
        test_provider_with_auth_and_api(id, models, auth, ApiImpls::Single(Arc::new(StubApi)))
    }

    fn test_provider_with_auth_and_api(
        id: &str,
        models: Vec<Model>,
        auth: ProviderAuth,
        api: ApiImpls,
    ) -> Arc<dyn Provider> {
        create_provider(CreateProviderOptions {
            id: id.to_string(),
            name: None,
            base_url: None,
            headers: None,
            auth,
            models,
            api,
        })
    }

    fn provider_ids(models: &Models) -> Vec<String> {
        models
            .get_providers()
            .iter()
            .map(|p| p.id().to_string())
            .collect()
    }

    fn model_ids(models: &[Model]) -> Vec<&str> {
        models.iter().map(|model| model.id.as_str()).collect()
    }

    /// Upstream models-runtime.test.ts "registers, replaces, and deletes
    /// providers".
    #[test]
    fn registers_replaces_and_deletes_providers() {
        let mut models = create_models(CreateModelsOptions::default());
        models.set_provider(test_provider("p1", vec![]));
        models.set_provider(test_provider("p2", vec![]));
        assert_eq!(provider_ids(&models), ["p1", "p2"]);

        let replacement = test_provider("p1", vec![]);
        models.set_provider(Arc::clone(&replacement));
        // The registry hands back the replacement itself.
        assert!(Arc::ptr_eq(
            &replacement,
            &models.get_provider("p1").unwrap()
        ));
        assert_eq!(models.get_providers().len(), 2);
        // Replacement keeps the original position (JS Map semantics).
        assert_eq!(provider_ids(&models), ["p1", "p2"]);

        models.delete_provider("p1");
        assert!(models.get_provider("p1").is_none());
        assert_eq!(provider_ids(&models), ["p2"]);

        models.clear_providers();
        assert!(models.get_providers().is_empty());
    }

    /// Upstream "lists and finds models per provider".
    #[test]
    fn lists_and_finds_models_per_provider() {
        let mut models = create_models(CreateModelsOptions::default());
        models.set_provider(test_provider(
            "p1",
            vec![test_model("p1", "m1"), test_model("p1", "m2")],
        ));
        models.set_provider(test_provider("p2", vec![test_model("p2", "m3")]));

        assert_eq!(model_ids(&models.get_models(None)), ["m1", "m2", "m3"]);
        assert_eq!(model_ids(&models.get_models(Some("p1"))), ["m1", "m2"]);
        assert!(models.get_models(Some("nope")).is_empty());
        assert_eq!(models.get_model("p2", "m3").unwrap().id, "m3");
        assert!(models.get_model("p2", "missing").is_none());

        // Upstream narrows dynamically looked-up models with hasApi(); the
        // port compares `model.api` directly.
        let found = models.get_model("p2", "m3").unwrap();
        assert_ne!(found.api, "openai-completions");
        assert_eq!(found.api, "test-api");
    }

    /// Upstream "swallows provider source failures for both all-provider and
    /// single-provider listing".
    #[test]
    fn swallows_provider_source_failures() {
        let mut models = create_models(CreateModelsOptions::default());
        models.set_provider(Arc::new(BrokenProvider {
            id: "broken".to_string(),
            auth: ambient_auth(),
        }));
        models.set_provider(test_provider("ok", vec![test_model("ok", "m1")]));

        assert_eq!(model_ids(&models.get_models(None)), ["m1"]);
        assert!(models.get_models(Some("broken")).is_empty());
        // Precise failures come from the provider directly (upstream: the
        // provider's own getModels() throws "boom").
        let error = models
            .get_provider("broken")
            .unwrap()
            .get_models()
            .unwrap_err();
        assert_eq!(error.message, "boom");
    }

    /// Upstream testProvider fixture with a throwing `getModels`
    /// (models-runtime.test.ts:201-217).
    struct BrokenProvider {
        id: String,
        auth: ProviderAuth,
    }

    impl Provider for BrokenProvider {
        fn id(&self) -> &str {
            &self.id
        }

        fn name(&self) -> &str {
            &self.id
        }

        fn auth(&self) -> &ProviderAuth {
            &self.auth
        }

        fn get_models(&self) -> Result<Vec<Model>, ModelsError> {
            Err(ModelsError::new(ModelsErrorCode::ModelSource, "boom"))
        }
    }

    /// Upstream `createModels` defaults (models.ts:275-279): no options means
    /// an empty in-memory credential store behind the collection.
    #[test]
    fn create_models_starts_empty_and_registers_providers() {
        let mut models = create_models(CreateModelsOptions::default());
        assert!(models.get_models(None).is_empty());
        assert!(models.get_provider("p1").is_none());
        models.set_provider(test_provider(
            "p1",
            vec![test_model("p1", "m1"), test_model("p1", "m2")],
        ));
        assert_eq!(model_ids(&models.get_models(None)), ["m1", "m2"]);
    }

    // ===================================================================
    // Task 3: Models.getAuth + stream routing (upstream models.ts:556-575,
    // 640-718; oracle models-runtime.test.ts getAuth/stream halves).
    // ===================================================================

    /// Oracle `doneMessage` (models-runtime.test.ts:24-42): the scripted
    /// final message for fixture streams.
    fn done_message(model: &Model) -> AssistantMessage {
        AssistantMessage {
            content: Vec::new(),
            api: model.api.clone(),
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            provider_thinking_level: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            deferred: None,
            error_message: None,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: now_ms(),
        }
    }

    /// Oracle `context` (models-runtime.test.ts:84).
    fn user_context() -> Context {
        Context {
            system_prompt: None,
            messages: vec![Message::User(UserMessage {
                content: StringOrBlocks::Text("hi".to_string()),
                timestamp: now_ms(),
            })],
            tools: None,
        }
    }

    fn header_map(pairs: &[(&str, &str)]) -> ProviderHeaders {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), Some((*value).to_string())))
            .collect()
    }

    /// Plain-string header map for [`Model::headers`] (the M2a model-level
    /// type carries no suppression form).
    fn string_header_map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect()
    }

    /// Oracle `envKeyAuth` (models-runtime.test.ts:86-95): the stored
    /// credential's key wins, otherwise the fixture key; source labels
    /// "stored" vs "env".
    struct EnvKeyAuthFixture {
        name: &'static str,
        key: Option<String>,
    }

    impl EnvKeyAuthFixture {
        fn env(key: &str) -> Arc<Self> {
            Arc::new(EnvKeyAuthFixture {
                name: "Test API key",
                key: Some(key.to_string()),
            })
        }

        fn missing() -> Arc<Self> {
            Arc::new(EnvKeyAuthFixture {
                name: "Test API key",
                key: None,
            })
        }
    }

    impl ApiKeyAuth for EnvKeyAuthFixture {
        fn name(&self) -> &str {
            self.name
        }

        fn resolve<'a>(
            &'a self,
            input: ApiKeyAuthInput<'a>,
        ) -> BoxFuture<'a, Result<Option<AuthResult>, AuthError>> {
            Box::pin(async move {
                let resolved = input
                    .credential
                    .and_then(|credential| credential.key.clone())
                    .or_else(|| self.key.clone());
                Ok(resolved.map(|key| AuthResult {
                    auth: ModelAuth {
                        api_key: Some(key),
                        ..ModelAuth::default()
                    },
                    env: None,
                    source: Some(
                        if input.credential.is_some() {
                            "stored"
                        } else {
                            "env"
                        }
                        .to_string(),
                    ),
                }))
            })
        }
    }

    /// Oracle `testOAuth` (models-runtime.test.ts:97-106): `to_auth` derives
    /// the api key from the access token; refresh passes the credential
    /// through unless configured to fail.
    struct TestOAuth {
        refresh_error: Option<&'static str>,
    }

    impl TestOAuth {
        fn no_refresh() -> Arc<Self> {
            Arc::new(TestOAuth {
                refresh_error: None,
            })
        }

        fn failing(message: &'static str) -> Arc<Self> {
            Arc::new(TestOAuth {
                refresh_error: Some(message),
            })
        }
    }

    impl OAuthAuth for TestOAuth {
        fn name(&self) -> &str {
            "Test OAuth"
        }

        fn login<'a>(
            &'a self,
            _interaction: ProviderAuthInteraction,
        ) -> BoxFuture<'a, Result<OAuthCredential, AuthError>> {
            Box::pin(async { Err(AuthError::Operation("not used".to_string())) })
        }

        fn refresh<'a>(
            &'a self,
            credential: OAuthCredential,
            _options: &'a AuthOperationOptions,
        ) -> BoxFuture<'a, Result<OAuthCredential, AuthError>> {
            Box::pin(async move {
                match self.refresh_error {
                    Some(message) => Err(AuthError::Operation(message.to_string())),
                    None => Ok(credential),
                }
            })
        }

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

    /// Oracle "Test" auth in "merges resolved auth into stream options"
    /// (models-runtime.test.ts:1078-1087): resolves fixed auth values.
    struct ResolvingKeyAuth {
        result: AuthResult,
    }

    impl ApiKeyAuth for ResolvingKeyAuth {
        fn name(&self) -> &str {
            "Test"
        }

        fn resolve<'a>(
            &'a self,
            _input: ApiKeyAuthInput<'a>,
        ) -> BoxFuture<'a, Result<Option<AuthResult>, AuthError>> {
            Box::pin(async { Ok(Some(self.result.clone())) })
        }
    }

    /// Oracle failing resolver (models-runtime.test.ts:1041-1046).
    struct FailingKeyAuth;

    impl ApiKeyAuth for FailingKeyAuth {
        fn name(&self) -> &str {
            "Failing"
        }

        fn resolve<'a>(
            &'a self,
            _input: ApiKeyAuthInput<'a>,
        ) -> BoxFuture<'a, Result<Option<AuthResult>, AuthError>> {
            Box::pin(async { Err(AuthError::Operation("nope".to_string())) })
        }
    }

    /// Oracle read-failing credential store (models-runtime.test.ts:992-999).
    struct ReadFailingStore;

    impl CredentialStore for ReadFailingStore {
        fn read<'a>(
            &'a self,
            _provider_id: &'a str,
            _options: &'a AuthOperationOptions,
        ) -> BoxFuture<'a, Result<Option<Credential>, AuthError>> {
            Box::pin(async { Err(AuthError::Storage("disk on fire".to_string())) })
        }

        fn list<'a>(
            &'a self,
            _options: &'a AuthOperationOptions,
        ) -> BoxFuture<'a, Result<Vec<CredentialInfo>, AuthError>> {
            Box::pin(async { Ok(Vec::new()) })
        }

        fn modify<'a>(
            &'a self,
            _provider_id: &'a str,
            _f: ModifyCallback,
            _options: &'a AuthOperationOptions,
        ) -> BoxFuture<'a, Result<Option<Credential>, AuthError>> {
            Box::pin(async { Ok(None) })
        }

        fn delete<'a>(
            &'a self,
            _provider_id: &'a str,
            _options: &'a AuthOperationOptions,
        ) -> BoxFuture<'a, Result<(), AuthError>> {
            Box::pin(async { Ok(()) })
        }
    }

    async fn store_credential(
        store: &InMemoryCredentialStore,
        provider: &str,
        credential: Credential,
    ) {
        let slot = std::sync::Mutex::new(Some(credential));
        let callback: ModifyCallback = Box::new(move |_| {
            let next = slot.lock().unwrap().take();
            Box::pin(async move { Ok(next) })
        });
        store
            .modify(provider, callback, &AuthOperationOptions::NONE)
            .await
            .unwrap();
    }

    fn api_key_credential(key: &str) -> Credential {
        Credential::ApiKey(ApiKeyCredential {
            key: Some(key.to_string()),
            env: None,
            extra: Default::default(),
        })
    }

    fn oauth_credential(access: &str, expires_in_ms: i64) -> Credential {
        Credential::OAuth(OAuthCredential {
            refresh: "r".to_string(),
            access: access.to_string(),
            expires: now_ms() + expires_in_ms,
            extra: Default::default(),
        })
    }

    /// A `RecordedCall` per ApiImpl invocation (upstream `ProviderCall`,
    /// models-runtime.test.ts:44-47): the routed config/model plus the
    /// request options as the ApiImpl received them.
    #[derive(Clone)]
    struct RecordedCall {
        config: ProviderConfig,
        model: Model,
        stream: Option<StreamOptions>,
        simple: Option<SimpleStreamOptions>,
    }

    /// Oracle `testProvider.respond` (models-runtime.test.ts:64-72) as an
    /// ApiImpl: records the call, then streams a scripted `start`+`done`.
    struct RecordingApi {
        calls: std::sync::Mutex<Vec<RecordedCall>>,
    }

    impl RecordingApi {
        fn new() -> Arc<Self> {
            Arc::new(RecordingApi {
                calls: std::sync::Mutex::new(Vec::new()),
            })
        }

        fn recorded(&self) -> Vec<RecordedCall> {
            self.calls.lock().unwrap().clone()
        }
    }

    fn scripted_stream(model: &Model) -> mpsc::Receiver<AssistantMessageEvent> {
        let (tx, rx) = mpsc::channel(4);
        let message = done_message(model);
        tokio::spawn(async move {
            let _ = tx
                .send(AssistantMessageEvent::Start {
                    message: message.clone(),
                })
                .await;
            let _ = tx
                .send(AssistantMessageEvent::Done {
                    reason: SuccessReason::Stop,
                    message,
                })
                .await;
        });
        rx
    }

    impl ApiImpl for RecordingApi {
        fn stream(
            &self,
            config: &ProviderConfig,
            model: &Model,
            _ctx: &TranscriptContext,
            options: &StreamOptions,
        ) -> mpsc::Receiver<AssistantMessageEvent> {
            self.calls.lock().unwrap().push(RecordedCall {
                config: config.clone(),
                model: model.clone(),
                stream: Some(options.clone()),
                simple: None,
            });
            scripted_stream(model)
        }

        fn stream_simple(
            &self,
            config: &ProviderConfig,
            model: &Model,
            _ctx: &TranscriptContext,
            options: &SimpleStreamOptions,
        ) -> mpsc::Receiver<AssistantMessageEvent> {
            self.calls.lock().unwrap().push(RecordedCall {
                config: config.clone(),
                model: model.clone(),
                stream: None,
                simple: Some(options.clone()),
            });
            scripted_stream(model)
        }
    }

    fn auth_with(api_key: Arc<dyn ApiKeyAuth>) -> ProviderAuth {
        ProviderAuth {
            api_key: Some(api_key),
            oauth: None,
        }
    }

    async fn collect_message(rx: mpsc::Receiver<AssistantMessageEvent>) -> AssistantMessage {
        let mut partial = PartialAssistant::new();
        let mut rx = rx;
        while let Some(event) = rx.recv().await {
            let outcome = partial.apply(&event);
            if let Err(error) = outcome {
                panic!("reducer rejected {}: {error}", event.event_type());
            }
        }
        partial.message().cloned().unwrap()
    }

    /// Oracle "resolves auth: stored credential owns the provider, ambient
    /// only when nothing stored" (models-runtime.test.ts:777-804).
    #[tokio::test]
    async fn get_auth_resolves_through_the_owning_provider() {
        let credentials = Arc::new(InMemoryCredentialStore::default());
        let mut models = create_models(CreateModelsOptions {
            credentials: Some(Arc::clone(&credentials) as Arc<dyn CredentialStore>),
            auth_context: None,
        });
        models.set_provider(test_provider_with_auth(
            "p1",
            vec![test_model("p1", "model-a")],
            ProviderAuth {
                api_key: Some(EnvKeyAuthFixture::env("env-key")),
                oauth: Some(TestOAuth::no_refresh()),
            },
        ));
        let model = test_model("p1", "model-a");

        // model and provider-id forms resolve the same provider-scoped auth
        let model_auth = models
            .get_auth_for_model(&model, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(model_auth.auth.api_key.as_deref(), Some("env-key"));
        let provider_auth = models.get_auth("p1", None).await.unwrap().unwrap();
        assert_eq!(provider_auth.auth.api_key.as_deref(), Some("env-key"));
        let overrides = AuthResolutionOverrides {
            api_key: Some("explicit-key".to_string()),
            ..AuthResolutionOverrides::default()
        };
        let explicit = models
            .get_auth_for_model(&model, Some(&overrides))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(explicit.auth.api_key.as_deref(), Some("explicit-key"));

        // stored oauth credential (persisted via the single write path):
        // beats ambient env
        store_credential(
            &credentials,
            "p1",
            oauth_credential("oauth-token", 10 * 60_000),
        )
        .await;
        let resolution = models.get_auth("p1", None).await.unwrap().unwrap();
        assert_eq!(resolution.auth.api_key.as_deref(), Some("oauth-token"));
        assert_eq!(resolution.source.as_deref(), Some("OAuth"));

        // stored api-key credential resolves through apiKey auth, beats env
        store_credential(&credentials, "p1", api_key_credential("stored-key")).await;
        let resolution = models.get_auth("p1", None).await.unwrap().unwrap();
        assert_eq!(resolution.auth.api_key.as_deref(), Some("stored-key"));
        assert_eq!(resolution.source.as_deref(), Some("stored"));
    }

    /// Oracle "adds model headers only for model auth" first half
    /// (models-runtime.test.ts:1108-1116).
    #[tokio::test]
    async fn get_auth_merges_model_headers_only_for_the_model_form() {
        let mut models = create_models(CreateModelsOptions::default());
        models.set_provider(test_provider_with_auth(
            "p1",
            vec![test_model("p1", "model-a")],
            ambient_auth(),
        ));
        let mut model = test_model("p1", "model-a");
        model.headers = Some(string_header_map(&[
            ("x-model", "model"),
            ("x-shared", "model"),
        ]));

        let provider_auth = models.get_auth("p1", None).await.unwrap().unwrap();
        assert!(provider_auth.auth.headers.is_none());
        let model_auth = models
            .get_auth_for_model(&model, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            model_auth.auth.headers.as_ref(),
            Some(&header_map(&[("x-model", "model"), ("x-shared", "model")]))
        );
    }

    /// Oracle "a stored credential without a matching handler blocks ambient
    /// fallback" (models-runtime.test.ts:858-866) plus the unknown-provider
    /// shape of `getAuth`.
    #[tokio::test]
    async fn get_auth_stays_undefined_for_unknown_providers_and_unhandled_credentials() {
        let credentials = Arc::new(InMemoryCredentialStore::default());
        let mut models = create_models(CreateModelsOptions {
            credentials: Some(Arc::clone(&credentials) as Arc<dyn CredentialStore>),
            auth_context: None,
        });
        models.set_provider(test_provider_with_auth(
            "p1",
            vec![test_model("p1", "model-a")],
            auth_with(EnvKeyAuthFixture::env("env-key")),
        ));
        // stale oauth credential on an api-key-only provider
        store_credential(&credentials, "p1", oauth_credential("a", 0)).await;

        assert!(models.get_auth("nope", None).await.unwrap().is_none());
        assert!(models.get_auth("p1", None).await.unwrap().is_none());
    }

    /// Oracle "wraps credential store failures" read half + "wraps api-key
    /// auth failures" + "rejects with code oauth when refresh fails"
    /// (models-runtime.test.ts:990-1050) — through the `Models.getAuth`
    /// caller.
    #[tokio::test]
    async fn get_auth_wraps_store_resolver_and_refresh_failures() {
        // read failure -> code "auth"
        let mut models = create_models(CreateModelsOptions {
            credentials: Some(Arc::new(ReadFailingStore)),
            auth_context: None,
        });
        models.set_provider(test_provider_with_auth(
            "p1",
            vec![test_model("p1", "model-a")],
            auth_with(EnvKeyAuthFixture::env("env-key")),
        ));
        let error = models.get_auth("p1", None).await.unwrap_err();
        let ModelsError { code, .. } = match error {
            AuthError::Models(error) => error,
            other => panic!("expected ModelsError, got {other:?}"),
        };
        assert_eq!(code, ModelsErrorCode::Auth);

        // failing resolver -> code "auth"
        let mut models = create_models(CreateModelsOptions::default());
        models.set_provider(test_provider_with_auth(
            "p1",
            vec![test_model("p1", "model-a")],
            auth_with(Arc::new(FailingKeyAuth)),
        ));
        let error = models.get_auth("p1", None).await.unwrap_err();
        match error {
            AuthError::Models(error) => assert_eq!(error.code, ModelsErrorCode::Auth),
            other => panic!("expected ModelsError, got {other:?}"),
        }

        // failed oauth refresh -> code "oauth"
        let credentials = Arc::new(InMemoryCredentialStore::default());
        let mut oauth_models = create_models(CreateModelsOptions {
            credentials: Some(Arc::clone(&credentials) as Arc<dyn CredentialStore>),
            auth_context: None,
        });
        oauth_models.set_provider(test_provider_with_auth(
            "p1",
            vec![test_model("p1", "model-a")],
            ProviderAuth {
                api_key: None,
                oauth: Some(TestOAuth::failing("invalid_grant")),
            },
        ));
        store_credential(&credentials, "p1", oauth_credential("old", 0)).await;
        let error = oauth_models.get_auth("p1", None).await.unwrap_err();
        match error {
            AuthError::Models(error) => assert_eq!(error.code, ModelsErrorCode::OAuth),
            other => panic!("expected ModelsError, got {other:?}"),
        }
        // the credential is preserved for retry / re-login
        let stored = credentials
            .read("p1", &AuthOperationOptions::NONE)
            .await
            .unwrap()
            .unwrap();
        match stored {
            Credential::OAuth(stored) => assert_eq!(stored.access, "old"),
            other => panic!("expected oauth credential, got {other:?}"),
        }
    }

    /// Oracle "streams through the provider" (models-runtime.test.ts:1145-1158)
    /// plus routing to the owning provider's ApiImpl with the resolved key.
    #[tokio::test]
    async fn stream_and_complete_route_through_the_owning_provider() {
        let api = RecordingApi::new();
        let mut models = create_models(CreateModelsOptions::default());
        models.set_provider(test_provider_with_auth_and_api(
            "p1",
            vec![test_model("p1", "model-a")],
            auth_with(EnvKeyAuthFixture::env("env-key")),
            ApiImpls::Single(Arc::clone(&api) as Arc<dyn ApiImpl>),
        ));
        let model = test_model("p1", "model-a");
        let context = user_context();

        // stream_simple forwards the scripted start/done pair and reduces to
        // the final message through complete_simple.
        let message = collect_message(models.stream_simple(&model, &context, None)).await;
        assert_eq!(message.stop_reason, StopReason::Stop);
        let message = models.complete_simple(&model, &context, None).await;
        assert_eq!(message.stop_reason, StopReason::Stop);

        let recorded = api.recorded();
        assert_eq!(recorded.len(), 2);
        // stream_simple dispatches through the simple entry point with the
        // resolved key riding both the routed config and the options.
        assert!(recorded[0].stream.is_none());
        assert!(recorded[0].simple.is_some());
        assert_eq!(recorded[0].config.api_key, "env-key");
        assert_eq!(
            recorded[0]
                .simple
                .as_ref()
                .unwrap()
                .stream
                .api_key
                .as_deref(),
            Some("env-key")
        );
    }

    /// Oracle "merges resolved auth into stream options; explicit options win
    /// per field" (models-runtime.test.ts:1076-1106). The port asserts on the
    /// routed `ProviderConfig` (the ApiImpls' base_url/api_key channel).
    #[tokio::test]
    async fn stream_merges_resolved_auth_and_explicit_options_win() {
        let api = RecordingApi::new();
        let mut models = create_models(CreateModelsOptions::default());
        models.set_provider(test_provider_with_auth_and_api(
            "p1",
            vec![test_model("p1", "model-a")],
            auth_with(Arc::new(ResolvingKeyAuth {
                result: AuthResult {
                    auth: ModelAuth {
                        api_key: Some("resolved-key".to_string()),
                        headers: Some(header_map(&[
                            ("Authorization", "Bearer resolved-key"),
                            ("x-a", "auth"),
                            ("x-b", "auth"),
                        ])),
                        base_url: Some("https://auth.test/v1".to_string()),
                    },
                    env: None,
                    source: None,
                },
            })),
            ApiImpls::Single(Arc::clone(&api) as Arc<dyn ApiImpl>),
        ));
        let model = test_model("p1", "model-a");
        let context = user_context();

        let options = ModelsSimpleStreamOptions {
            simple: SimpleStreamOptions {
                stream: StreamOptions {
                    api_key: Some("explicit-key".to_string()),
                    headers: Some(header_map(&[
                        ("authorization", "Explicit token"),
                        ("x-b", "explicit"),
                    ])),
                    ..StreamOptions::default()
                },
                ..SimpleStreamOptions::default()
            },
            transform_headers: None,
        };
        let message = models
            .complete_simple(&model, &context, Some(options))
            .await;
        assert_eq!(message.stop_reason, StopReason::Stop);

        let recorded = api.recorded();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].config.api_key, "explicit-key");
        assert_eq!(recorded[0].config.base_url, "https://auth.test/v1");
        // upstream `calls[0].model.baseUrl`: the request model carries the
        // auth-derived base URL for ApiImpls that read it.
        assert_eq!(recorded[0].model.base_url, "https://auth.test/v1");
        let simple = recorded[0].simple.as_ref().unwrap();
        assert_eq!(simple.stream.api_key.as_deref(), Some("explicit-key"));
        let headers = simple.stream.headers.as_ref().unwrap();
        assert_eq!(
            headers.get("authorization").unwrap(),
            &Some("Explicit token".to_string())
        );
        assert_eq!(headers.get("x-a").unwrap(), &Some("auth".to_string()));
        assert_eq!(headers.get("x-b").unwrap(), &Some("explicit".to_string()));

        // without explicit options, resolved auth applies
        models.complete_simple(&model, &context, None).await;
        let recorded = api.recorded();
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[1].config.api_key, "resolved-key");
        assert_eq!(
            recorded[1]
                .simple
                .as_ref()
                .unwrap()
                .stream
                .api_key
                .as_deref(),
            Some("resolved-key")
        );
    }

    /// Oracle "adds model headers only for model auth and transforms
    /// assembled headers once" second half (models-runtime.test.ts:1118-1135).
    #[tokio::test]
    async fn stream_transforms_assembled_headers_once() {
        let api = RecordingApi::new();
        let mut models = create_models(CreateModelsOptions::default());
        models.set_provider(test_provider_with_auth_and_api(
            "p1",
            vec![test_model("p1", "model-a")],
            auth_with(EnvKeyAuthFixture::env("key")),
            ApiImpls::Single(Arc::clone(&api) as Arc<dyn ApiImpl>),
        ));
        let mut model = test_model("p1", "model-a");
        model.headers = Some(string_header_map(&[
            ("x-model", "model"),
            ("x-shared", "model"),
        ]));

        let transforms = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let transform_counter = Arc::clone(&transforms);
        let transform_headers: TransformHeaders = Arc::new(move |headers: ProviderHeaders| {
            let counter = Arc::clone(&transform_counter);
            Box::pin(async move {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // The transform sees auth/model/explicit headers merged,
                // with the explicit case-different name having replaced
                // the model's.
                assert_eq!(headers.get("x-model").unwrap(), &Some("model".to_string()));
                assert_eq!(
                    headers.get("x-explicit").unwrap(),
                    &Some("explicit".to_string())
                );
                assert_eq!(
                    headers.get("X-Shared").unwrap(),
                    &Some("explicit".to_string())
                );
                let mut transformed = headers;
                transformed.insert("x-transformed".to_string(), Some("yes".to_string()));
                transformed
            }) as BoxFuture<'static, ProviderHeaders>
        });

        let options = ModelsSimpleStreamOptions {
            simple: SimpleStreamOptions {
                stream: StreamOptions {
                    headers: Some(header_map(&[
                        ("x-explicit", "explicit"),
                        ("X-Shared", "explicit"),
                    ])),
                    ..StreamOptions::default()
                },
                ..SimpleStreamOptions::default()
            },
            transform_headers: Some(transform_headers),
        };
        let message = models
            .complete_simple(&model, &user_context(), Some(options))
            .await;
        assert_eq!(message.stop_reason, StopReason::Stop);
        assert_eq!(
            transforms.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "transform runs exactly once per request"
        );

        let recorded = api.recorded();
        assert_eq!(recorded.len(), 1);
        let headers = recorded[0]
            .simple
            .as_ref()
            .unwrap()
            .stream
            .headers
            .as_ref()
            .unwrap();
        assert_eq!(headers.get("x-model").unwrap(), &Some("model".to_string()));
        assert_eq!(
            headers.get("x-explicit").unwrap(),
            &Some("explicit".to_string())
        );
        assert_eq!(
            headers.get("X-Shared").unwrap(),
            &Some("explicit".to_string())
        );
        assert_eq!(
            headers.get("x-transformed").unwrap(),
            &Some("yes".to_string())
        );
    }

    /// Oracle "produces an error stream for unknown providers instead of
    /// throwing" (models-runtime.test.ts:1138-1143), plus the unconfigured
    /// and no-API-implementation routing errors (models.ts:643, 662, 810).
    #[tokio::test]
    async fn stream_produces_error_events_for_routing_failures() {
        let mut models = create_models(CreateModelsOptions::default());
        models.set_provider(test_provider_with_auth_and_api(
            "p1",
            vec![test_model("p1", "model-a")],
            auth_with(EnvKeyAuthFixture::missing()),
            ApiImpls::PerApi(BTreeMap::new()),
        ));
        let context = user_context();

        // unknown provider
        let ghost = test_model("ghost", "model-a");
        let message = models.complete_simple(&ghost, &context, None).await;
        assert_eq!(message.stop_reason, StopReason::Error);
        assert!(
            message
                .error_message
                .as_deref()
                .unwrap_or_default()
                .contains("Unknown provider: ghost"),
            "unexpected error message: {:?}",
            message.error_message
        );

        // unconfigured provider (resolution resolves to nothing)
        let message = models
            .complete_simple(&test_model("p1", "model-a"), &context, None)
            .await;
        assert_eq!(message.stop_reason, StopReason::Error);
        assert_eq!(
            message.error_message.as_deref(),
            Some("Provider is not configured: p1")
        );

        // no API implementation for the model's api (auth resolves first)
        let mut configured = create_models(CreateModelsOptions::default());
        configured.set_provider(test_provider_with_auth_and_api(
            "p1",
            vec![test_model("p1", "model-a")],
            auth_with(EnvKeyAuthFixture::env("key")),
            ApiImpls::PerApi(BTreeMap::new()),
        ));
        let message = configured
            .complete_simple(&test_model("p1", "model-a"), &context, None)
            .await;
        assert_eq!(message.stop_reason, StopReason::Error);
        assert_eq!(
            message.error_message.as_deref(),
            Some("Provider p1 has no API implementation for \"test-api\"")
        );
    }

    /// In-memory env lookup for the wiremock round trip (the resolve.rs test
    /// pattern): avoids process-env global state.
    struct MapAuthContext {
        vars: BTreeMap<String, String>,
    }

    impl AuthContext for MapAuthContext {
        fn env<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Option<String>> {
            Box::pin(async move { self.vars.get(name).cloned() })
        }

        fn file_exists<'a>(&'a self, _path: &'a str) -> BoxFuture<'a, bool> {
            Box::pin(async { false })
        }
    }

    /// End-to-end routing over HTTP: a real [`OpenAiCompletions`] ApiImpl
    /// behind a wiremock server; the env-resolved key and the merged
    /// model/auth headers must reach the wire (upstream getClientApiKey /
    /// header assembly consume what `Models` merges in).
    #[tokio::test]
    async fn stream_simple_round_trips_resolved_auth_over_http() {
        use crate::ai::api::openai_completions::OpenAiCompletions;
        use wiremock::matchers::{header, method, path};

        let server = wiremock::MockServer::start().await;
        let body = format!(
            "{}{}{}",
            r#"data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}"#,
            "\n\n",
            format_args!(
                "{}\n\n{}\n\n",
                r#"data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
                "data: [DONE]"
            )
        );
        wiremock::Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer env-key"))
            .and(header("x-model", "model"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(body),
            )
            .expect(1)
            .mount(&server)
            .await;

        let mut models = create_models(CreateModelsOptions {
            auth_context: Some(Arc::new(MapAuthContext {
                vars: [("P1_API_KEY".to_string(), "env-key".to_string())]
                    .into_iter()
                    .collect(),
            }) as Arc<dyn AuthContext>),
            credentials: None,
        });
        let mut per_api: BTreeMap<String, Arc<dyn ApiImpl>> = BTreeMap::new();
        per_api.insert(
            "openai-completions".to_string(),
            Arc::new(OpenAiCompletions),
        );
        let mut model = test_model("p1", "model-a");
        model.api = "openai-completions".to_string();
        model.base_url = format!("{}/v1", server.uri());
        model.headers = Some(string_header_map(&[("x-model", "model")]));
        models.set_provider(test_provider_with_auth_and_api(
            "p1",
            vec![model.clone()],
            auth_with(crate::ai::auth::helpers::env_api_key_auth(
                "P1",
                &["P1_API_KEY"],
            )),
            ApiImpls::PerApi(per_api),
        ));

        let message = models.complete_simple(&model, &user_context(), None).await;
        assert_eq!(message.stop_reason, StopReason::Stop);
        server.verify().await;
    }
}
