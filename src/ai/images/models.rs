//! The image-generation provider layer, ported from upstream
//! `packages/ai/src/images-models.ts`: the [`ImagesProvider`] trait
//! (images-models.ts:12-43, the image-side counterpart of the chat
//! `Provider`), [`create_images_provider`] (images-models.ts:251-275), and
//! the [`ImagesModels`] collection with [`create_images_models`]
//! (images-models.ts:49-229, the counterpart of the chat `Models`).
//!
//! The upstream `ImagesModels`/`MutableImagesModels` interface split (read
//! surface vs registry mutation) is a JS capability boundary; the port is
//! one struct, same as the chat side. Providers are held in registration
//! order (upstream `Map` insertion order — an upsert keeps the original
//! position).
//!
//! Where upstream images-side code throws, the port keeps the chat-side
//! error channels: [`ImagesProvider::get_models`] returns
//! `Result<_, ModelsError>` (upstream "must not throw; `ImagesModels`
//! treats a throwing implementation as having no models" — the failure
//! channel is explicit and the collection swallows it), and
//! [`ImagesModels::refresh`] propagates the provider's [`ModelsError`] with
//! the `model_source` code (the standard provider wraps raw fetch failures
//! with the upstream `"Model refresh failed for {id}"` message and the cause
//! folded in, resolve.ts `withCauseDetail` style).

use std::sync::{Arc, RwLock};

use futures::future::{join_all, BoxFuture};

use crate::ai::auth::context::default_provider_auth_context;
use crate::ai::auth::credential_store::{CredentialStore, InMemoryCredentialStore};
use crate::ai::auth::resolve::{
    resolve_provider_auth, AuthResolutionOverrides, ModelsError, ModelsErrorCode,
};
use crate::ai::auth::types::{AuthContext, AuthError, AuthResult, ProviderAuth};
use crate::ai::types::images::{
    AssistantImages, ImagesContext, ImagesModel, ImagesOptions, ImagesStopReason,
};

use super::registry::ImagesApiFn;

/// Upstream `ImagesProvider` (images-models.ts:12-43). The generation method
/// returns [`AssistantImages`] directly (upstream `Promise<AssistantImages>`
/// that "never rejects" at the collection layer); provider-internal failures
/// are error results, like upstream.
pub trait ImagesProvider: Send + Sync {
    /// Provider id, unique within an [`ImagesModels`] collection.
    fn id(&self) -> &str;

    /// Display name. Defaults to the id ([`create_images_provider`]).
    fn name(&self) -> &str;

    /// Provider auth (upstream `auth`). At least one of `api_key`/`oauth` is
    /// present — even ambient/keyless providers report configurability.
    fn auth(&self) -> &ProviderAuth;

    /// Current known models, sync (upstream `getModels`). Static providers
    /// return their catalog; dynamic providers the list as of the last
    /// [`ImagesProvider::refresh_models`] (empty before the first). The port
    /// makes the upstream "must not throw" contract explicit; the collection
    /// maps `Err` to no models.
    fn get_models(&self) -> Result<Vec<ImagesModel>, ModelsError>;

    /// Upstream `refreshModels?` (images-models.ts:36): dynamic providers
    /// only. Fetches and stores the current list; the stored list stays at
    /// its last-known state on failure and a later call retries. `None` =
    /// static provider.
    fn refresh_models(&self) -> Option<BoxFuture<'static, Result<(), ModelsError>>> {
        None
    }

    /// Generate images through this provider's API implementation (upstream
    /// `generateImages`, images-models.ts:38-42).
    fn generate_images(
        &self,
        model: ImagesModel,
        context: ImagesContext,
        options: Option<ImagesOptions>,
    ) -> BoxFuture<'static, AssistantImages>;
}

/// Upstream `CreateImagesProviderOptions.refreshModels` (images-models.ts:246):
/// fetch the current image-model list; concurrent calls share one in-flight
/// fetch ([`create_images_provider`]).
pub type RefreshImagesModelsFn =
    Arc<dyn Fn() -> BoxFuture<'static, Result<Vec<ImagesModel>, ModelsError>> + Send + Sync>;

/// Upstream `CreateImagesProviderOptions` (images-models.ts:231-248).
pub struct CreateImagesProviderOptions {
    pub id: String,
    /// Display name. Default: `id` (upstream `name?`).
    pub name: Option<String>,
    /// Required — every provider has auth semantics, even ambient/keyless
    /// ones (upstream `auth`).
    pub auth: ProviderAuth,
    /// Initial model list (empty for purely dynamic providers).
    pub models: Vec<ImagesModel>,
    /// Dynamic providers: fetch the current list (upstream `refreshModels?`).
    pub refresh_models: Option<RefreshImagesModelsFn>,
    /// The generation behavior (upstream `api: ProviderImages`).
    pub api: ImagesApiFn,
}

/// Shared mutable state of the provider [`create_images_provider`] builds —
/// upstream's closure variables `models`/`inflightRefresh`
/// (images-models.ts:252-254), Arc-shared so [`ImagesProvider::refresh_models`]
/// can hand back a `'static` future.
struct StandardImagesProviderInner {
    models: RwLock<Vec<ImagesModel>>,
    fetch: Option<RefreshImagesModelsFn>,
    /// In-flight dedupe: the async lock is held for the duration of one
    /// fetch; followers await the same lock and then read the memoized
    /// result instead of fetching (upstream `inflightRefresh ??= ...`,
    /// images-models.ts:261-271 — concurrent callers share one fetch, a call
    /// after completion fetches again, and a failed fetch is not memoized).
    inflight: tokio::sync::Mutex<()>,
    inflight_result: std::sync::Mutex<Option<Result<Vec<ImagesModel>, ModelsError>>>,
}

/// The image provider [`create_images_provider`] builds — upstream's object
/// literal (images-models.ts:256-274).
pub struct StandardImagesProvider {
    id: String,
    name: String,
    auth: ProviderAuth,
    api: ImagesApiFn,
    inner: Arc<StandardImagesProviderInner>,
}

/// Upstream `createImagesProvider` (images-models.ts:251-275).
pub fn create_images_provider(options: CreateImagesProviderOptions) -> Arc<StandardImagesProvider> {
    Arc::new(StandardImagesProvider {
        name: options.name.unwrap_or_else(|| options.id.clone()),
        id: options.id,
        auth: options.auth,
        api: options.api,
        inner: Arc::new(StandardImagesProviderInner {
            models: RwLock::new(options.models),
            fetch: options.refresh_models,
            inflight: tokio::sync::Mutex::new(()),
            inflight_result: std::sync::Mutex::new(None),
        }),
    })
}

impl StandardImagesProviderInner {
    /// Upstream `createImagesProvider`'s `refreshModels` closure
    /// (images-models.ts:261-271): fetch, store, share one in-flight fetch.
    /// Upstream `ImagesModels.refresh` (images-models.ts:157-163) rethrows
    /// provider-authored `ModelsError`s unchanged and wraps raw failures in
    /// `ModelsError("model_source", "Model refresh failed for {id}",
    /// { cause })`; the port's typed fetch channel can only carry
    /// `ModelsError`s, so the standard provider applies the raw-failure wrap
    /// uniformly (disclosed deviation: the passthrough branch is
    /// unreachable in this signature).
    async fn refresh(&self, id: &str) -> Result<(), ModelsError> {
        let Some(fetch) = self.fetch.as_ref() else {
            return Ok(());
        };
        let fetch = Arc::clone(fetch);
        let store = |models: &Vec<ImagesModel>| {
            let mut slot = self
                .models
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *slot = models.clone();
        };
        match self.inflight.try_lock() {
            Ok(guard) => {
                // Leader: run the fetch holding the in-flight lock.
                let result = fetch().await;
                let result = match result {
                    Ok(models) => {
                        store(&models);
                        Ok(models)
                    }
                    Err(error) => Err(wrap_refresh_error(id, error)),
                };
                *lock(&self.inflight_result) = Some(match &result {
                    Ok(models) => Ok(models.clone()),
                    Err(error) => Err(error.clone()),
                });
                drop(guard);
                result.map(|_| ())
            }
            Err(_) => {
                // Follower: share the leader's in-flight fetch.
                let guard = self.inflight.lock().await;
                let memo = lock(&self.inflight_result).take();
                drop(guard);
                match memo {
                    Some(Ok(_)) => Ok(()),
                    Some(Err(error)) => Err(error),
                    // The leader finished between our try_lock and lock
                    // without leaving a memo (a completed call before us
                    // drained it): fetch directly, like a post-completion
                    // upstream call.
                    None => {
                        let models = fetch()
                            .await
                            .map_err(|error| wrap_refresh_error(id, error))?;
                        store(&models);
                        Ok(())
                    }
                }
            }
        }
    }
}

/// Upstream `new ModelsError("model_source", "Model refresh failed for
/// ${provider}", { cause: error })` (images-models.ts:161): the cause detail
/// folds into the message (`withCauseDetail`, resolve.ts:37-42).
fn wrap_refresh_error(id: &str, error: ModelsError) -> ModelsError {
    let message = if error.message.is_empty() {
        format!("Model refresh failed for {id}")
    } else {
        format!("Model refresh failed for {id}: {}", error.message)
    };
    ModelsError::new(ModelsErrorCode::ModelSource, message)
}

fn lock<T>(guard: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    guard
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl ImagesProvider for StandardImagesProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn auth(&self) -> &ProviderAuth {
        &self.auth
    }

    fn get_models(&self) -> Result<Vec<ImagesModel>, ModelsError> {
        let models = self
            .inner
            .models
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(models.clone())
    }

    fn refresh_models(&self) -> Option<BoxFuture<'static, Result<(), ModelsError>>> {
        // Upstream: `refreshModels: refreshModels ? () => ... : undefined`
        // (images-models.ts:261-272) — absent without a fetch function.
        self.inner.fetch.as_ref()?;
        let inner = Arc::clone(&self.inner);
        let id = self.id.clone();
        Some(Box::pin(async move { inner.refresh(&id).await }))
    }

    fn generate_images(
        &self,
        model: ImagesModel,
        context: ImagesContext,
        options: Option<ImagesOptions>,
    ) -> BoxFuture<'static, AssistantImages> {
        let api = Arc::clone(&self.api);
        Box::pin(async move {
            api(model, context, options)
                .await
                .unwrap_or_else(panic_on_contract_violation)
        })
    }
}

/// The registered API handlers only fail on contract violations
/// (`Mismatched api`), which the collection never triggers — it dispatches
/// through the provider that owns the model. Reaching this means a
/// hand-rolled provider mismatched its own model; panic loudly rather than
/// fabricate an error result.
fn panic_on_contract_violation(message: String) -> AssistantImages {
    panic!("images api contract violation: {message}");
}

/// Upstream `createImagesModels` (images-models.ts:227-229) +
/// `ImagesModelsImpl` (images-models.ts:97-225): the runtime collection of
/// image-generation providers plus auth application and generation
/// convenience.
pub struct ImagesModels {
    providers: Vec<(String, Arc<dyn ImagesProvider>)>,
    credentials: Arc<dyn CredentialStore>,
    auth_context: Arc<dyn AuthContext>,
}

/// Upstream `createImagesModels(options?)` (images-models.ts:227-229); the
/// options are the chat [`CreateModelsOptions`] subset upstream shares
/// (`credentials`, `authContext`).
pub fn create_images_models(options: crate::ai::models::CreateModelsOptions) -> ImagesModels {
    ImagesModels {
        providers: Vec::new(),
        credentials: options.credentials.unwrap_or_else(|| {
            Arc::new(InMemoryCredentialStore::default()) as Arc<dyn CredentialStore>
        }),
        auth_context: options
            .auth_context
            .unwrap_or_else(|| Arc::new(default_provider_auth_context()) as Arc<dyn AuthContext>),
    }
}

impl ImagesModels {
    /// Upstream `MutableImagesModels.setProvider` (images-models.ts:107-109):
    /// upsert by provider id — ids are unique, replacement keeps position.
    pub fn set_provider(&mut self, provider: Arc<dyn ImagesProvider>) {
        match self
            .providers
            .iter_mut()
            .find(|(id, _)| *id == provider.id())
        {
            Some((_, existing)) => *existing = provider,
            None => self.providers.push((provider.id().to_string(), provider)),
        }
    }

    /// Upstream `deleteProvider` (images-models.ts:111-114): no-op unknown.
    pub fn delete_provider(&mut self, id: &str) {
        self.providers.retain(|(existing, _)| existing != id);
    }

    /// Upstream `clearProviders` (images-models.ts:116-118).
    pub fn clear_providers(&mut self) {
        self.providers.clear();
    }

    /// Upstream `getProviders` (images-models.ts:119-122), registration order.
    pub fn get_providers(&self) -> Vec<Arc<dyn ImagesProvider>> {
        self.providers
            .iter()
            .map(|(_, provider)| Arc::clone(provider))
            .collect()
    }

    /// Upstream `getProvider` (images-models.ts:123-126).
    pub fn get_provider(&self, id: &str) -> Option<Arc<dyn ImagesProvider>> {
        self.providers
            .iter()
            .find(|(existing, _)| existing == id)
            .map(|(_, provider)| Arc::clone(provider))
    }

    /// Upstream `getModels` (images-models.ts:127-147): sync read of
    /// last-known models from one provider or all providers, best-effort —
    /// a provider whose `getModels()` fails yields no models, for the
    /// single-provider filter, the all-providers concatenation, and unknown
    /// provider ids alike.
    pub fn get_models(&self, provider: Option<&str>) -> Vec<ImagesModel> {
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

    /// Upstream `getModel` (images-models.ts:149-151).
    pub fn get_model(&self, provider: &str, id: &str) -> Option<ImagesModel> {
        self.get_models(Some(provider))
            .into_iter()
            .find(|model| model.id == id)
    }

    /// Upstream `refresh(provider)` (images-models.ts:153-164): ask one
    /// dynamic provider to re-fetch its list. Unknown and static providers
    /// are no-ops; the provider's failure propagates as a `model_source`
    /// [`ModelsError`].
    pub async fn refresh_provider(&self, provider: &str) -> Result<(), ModelsError> {
        let Some(entry) = self.get_provider(provider) else {
            return Ok(());
        };
        let Some(refresh) = entry.refresh_models() else {
            return Ok(());
        };
        refresh.await
    }

    /// Upstream `refresh()` (images-models.ts:153-169): refresh every
    /// provider concurrently, best-effort — all failures are swallowed, like
    /// upstream `Promise.allSettled`.
    pub async fn refresh(&self) {
        let refreshes: Vec<_> = self
            .get_providers()
            .into_iter()
            .map(|entry| async move {
                if let Some(refresh) = entry.refresh_models() {
                    let _ = refresh.await;
                }
            })
            .collect();
        join_all(refreshes).await;
    }

    /// Upstream `getAuth(providerId)` (images-models.ts:171-174): resolve
    /// request auth by provider id. `Ok(None)` when unknown/unconfigured;
    /// real failures surface as [`AuthError::Models`] carrying the
    /// [`ModelsError`] (upstream rejects with the `ModelsError`).
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

    /// Upstream `getAuth(model)` (images-models.ts:171-181): the model's
    /// provider-scoped resolution.
    pub async fn get_auth_for_model(
        &self,
        model: &ImagesModel,
        overrides: Option<&AuthResolutionOverrides>,
    ) -> Result<Option<AuthResult>, AuthError> {
        self.get_auth(&model.provider, overrides).await
    }

    /// Upstream `ImagesModels.generateImages` (images-models.ts:183-224):
    /// generate through the owning provider with auth resolved and merged
    /// (explicit options win per field). Never rejects; failures are
    /// returned as an [`AssistantImages`] with `stopReason: "error"`.
    pub async fn generate_images(
        &self,
        model: ImagesModel,
        context: ImagesContext,
        options: Option<ImagesOptions>,
    ) -> AssistantImages {
        // The error-result identity fields are captured up front: `model`
        // itself moves into the dispatch (upstream's catch reads the same
        // fields off the closure-captured `model`).
        let result_model = (model.api.clone(), model.provider.clone(), model.id.clone());
        let dispatch = async {
            let provider = self
                .get_provider(&model.provider)
                .ok_or_else(|| format!("Unknown provider: {}", model.provider))?;

            let overrides = options.as_ref().map(|options| AuthResolutionOverrides {
                api_key: options.api_key.clone(),
                env: options.env.clone(),
                signal: options.signal.clone(),
                ..AuthResolutionOverrides::default()
            });
            let resolution = self
                .get_auth_for_model(&model, overrides.as_ref())
                .await
                .map_err(|error| error.to_string())?;
            let Some(resolution) = resolution.as_ref() else {
                // Unconfigured (resolve -> undefined) still dispatches; the
                // provider decides what to do without auth (images-models.ts:199-202).
                let result = provider.generate_images(model, context, options).await;
                return Ok::<_, String>(result);
            };
            let auth = &resolution.auth;

            // Auth-derived baseUrl overrides the model's (images-models.ts:204).
            let mut request_model = model.clone();
            if let Some(base_url) = auth.base_url.as_ref() {
                request_model.base_url = base_url.clone();
            }

            // Explicit request options win per-field; headers/env merge per key
            // (images-models.ts:207-210).
            let api_key = options
                .as_ref()
                .and_then(|options| options.api_key.clone())
                .or_else(|| auth.api_key.clone());
            let headers = merge_maps(
                auth.headers.as_ref(),
                options
                    .as_ref()
                    .and_then(|options| options.headers.as_ref()),
            );
            let env = match (
                resolution.env.as_ref(),
                options.as_ref().and_then(|options| options.env.as_ref()),
            ) {
                (None, None) => None,
                (resolved, explicit) => {
                    let mut merged = resolved.cloned().unwrap_or_default();
                    merged.extend(explicit.cloned().unwrap_or_default());
                    Some(merged)
                }
            };
            let mut options = options.unwrap_or_default();
            options.api_key = api_key;
            options.headers = headers;
            options.env = env;

            Ok(provider
                .generate_images(request_model, context, Some(options))
                .await)
        };
        match dispatch.await {
            Ok(result) => result,
            // Catch: any failure (unknown provider, auth resolution error)
            // becomes an error result (images-models.ts:213-223).
            Err(error) => AssistantImages {
                api: result_model.0,
                provider: result_model.1,
                model: result_model.2,
                output: Vec::new(),
                response_id: None,
                usage: None,
                stop_reason: ImagesStopReason::Error,
                error_message: Some(error.to_string()),
                timestamp: crate::ai::now_ms(),
            },
        }
    }
}

/// Upstream `auth.headers || options?.headers ? { ...auth.headers,
/// ...options?.headers } : undefined` (images-models.ts:208): options win
/// per key; defined when either side is.
fn merge_maps(
    base: Option<&crate::ai::types::options::ProviderHeaders>,
    override_headers: Option<&crate::ai::types::options::ProviderHeaders>,
) -> Option<crate::ai::types::options::ProviderHeaders> {
    match (base, override_headers) {
        (None, None) => None,
        (base, override_headers) => {
            let mut merged = base.cloned().unwrap_or_default();
            for (name, value) in override_headers.into_iter().flatten() {
                merged.insert(name.clone(), value.clone());
            }
            Some(merged)
        }
    }
}

#[cfg(test)]
mod tests;
