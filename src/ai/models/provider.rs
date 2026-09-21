//! Upstream `packages/ai/src/models.ts` provider half: the [`Provider`]
//! interface (models.ts:99-156) and [`create_provider`] (models.ts:761-884) —
//! the builder both the built-in provider factories (Task 5) and config
//! custom providers go through.
//!
//! Upstream `Provider<TApi extends Api>` narrows model lists by API; the port
//! erases the generic exactly like [`Model`](crate::ai::types::Model) — `api`
//! stays an open-ended string. Upstream `hasApi()` (models.ts:896-898), the
//! runtime narrowing guard for dynamically looked-up models, is therefore a
//! plain `model.api == api` comparison here; there is no type erasure to
//! undo, so no helper is ported.
//!
//! # Task seams (M2e plan)
//!
//! - Stream behavior rides on the held `ApiImpl` handles
//!   ([`Provider::api_for`], the upstream `apiFor` dispatch, models.ts:801)
//!   and is routed by the `Models` collection with auth resolution in
//!   Task 3. `filterModels` (models.ts:136/773) rides with Task 4: its only
//!   consumer is `Models.getAvailable` (models.ts:551), which is Task 4
//!   scope alongside refresh.
//! - `refreshModels` (models.ts:129) and the dynamic-catalog publication join
//!   with Task 4; the overlay storage ([`StandardProvider::dynamic`]) and the
//!   baseline merge ([`merge_catalog`], upstream `currentModels`,
//!   models.ts:788-796) are already in place — the overlay starts empty, so a
//!   freshly built provider serves exactly its baseline.
//! - Upstream `fetchDeferred`/`cancelDeferred` (models.ts:150-155, attached
//!   conditionally at models.ts:856-881) are not ported: the M2b `ApiImpl`
//!   port dropped the deferred-response surface.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use crate::ai::api::ApiImpl;
use crate::ai::auth::resolve::ModelsError;
use crate::ai::auth::types::ProviderAuth;
use crate::ai::types::{Model, ProviderHeaders};

/// Upstream `Provider` (models.ts:99-156): the concrete runtime unit owning
/// id/name/base metadata, auth methods, and model listing. The upstream
/// stream methods (`stream`/`streamSimple`) are not on the port trait — the
/// `Models` collection routes streams through the held `ApiImpl` handles in
/// Task 3, so the trait carries only what the collection reads.
pub trait Provider: Send + Sync {
    /// Provider id, unique within a `Models` collection.
    fn id(&self) -> &str;

    /// Display name. Defaults to the id ([`create_provider`]).
    fn name(&self) -> &str;

    /// Base URL of the provider endpoint (upstream optional `baseUrl`).
    fn base_url(&self) -> Option<&str> {
        None
    }

    /// Custom HTTP headers merged over provider defaults (upstream optional
    /// `headers`).
    fn headers(&self) -> Option<&ProviderHeaders> {
        None
    }

    /// Provider auth (upstream `auth`). At least one of `api_key`/`oauth` is
    /// present — even ambient/keyless providers report configurability
    /// through api-key `resolve`.
    fn auth(&self) -> &ProviderAuth;

    /// Current known models, sync (upstream `getModels`, models.ts:121).
    /// Static providers return their catalog; dynamic providers the list as
    /// of the last refresh (empty before the first — Task 4). Upstream
    /// requires implementations not to throw and defends anyway ("`Models`
    /// treats a throwing implementation as having no models"): the port makes
    /// that failure channel explicit as `Err` — surfaced precisely by the
    /// provider itself, swallowed to no models by the collection.
    fn get_models(&self) -> Result<Vec<Model>, ModelsError>;

    /// The API implementation serving one model (upstream
    /// `Provider.stream`/`streamSimple`, models.ts:139-149: the port's
    /// `Models` collection routes streams through the held `ApiImpl` handles
    /// instead of stream methods on the trait, so the two upstream methods
    /// collapse into this lookup). `None` = no entry — upstream produces the
    /// stream error
    /// ``Provider {id} has no API implementation for "{api}"`` at dispatch
    /// time (models.ts:808-811).
    fn api_for(&self, model: &Model) -> Option<Arc<dyn ApiImpl>> {
        let _ = model;
        None
    }
}

/// Upstream `CreateProviderOptions.api`
/// (`ProviderStreams | Partial<Record<TApi, ProviderStreams>>`, models.ts:775):
/// a single implementation streams all models, or a map dispatches on
/// `model.api` for mixed-API providers.
pub enum ApiImpls {
    Single(Arc<dyn ApiImpl>),
    PerApi(BTreeMap<String, Arc<dyn ApiImpl>>),
}

/// Upstream `CreateProviderOptions` (models.ts:761-776).
pub struct CreateProviderOptions {
    pub id: String,
    /// Display name. Default: `id` (upstream `name?`).
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub headers: Option<ProviderHeaders>,
    /// Required — every provider has auth semantics, even ambient/keyless
    /// ones (upstream `auth`).
    pub auth: ProviderAuth,
    /// Static baseline model list (upstream `models`; empty for purely
    /// dynamic providers).
    pub models: Vec<Model>,
    /// Single implementation, or map keyed by `model.api` (upstream `api`).
    pub api: ApiImpls,
}

/// The provider [`create_provider`] builds — upstream's object literal
/// (models.ts:816-854). The dynamic overlay (`dynamicModels`) starts empty
/// and is published into by the Task 4 refresh; until then
/// [`Provider::get_models`] serves exactly the baseline.
pub struct StandardProvider {
    id: String,
    name: String,
    base_url: Option<String>,
    headers: Option<ProviderHeaders>,
    auth: ProviderAuth,
    baseline: Vec<Model>,
    dynamic: RwLock<Vec<Model>>,
    api: ApiImpls,
}

/// Upstream `createProvider` (models.ts:784-884).
pub fn create_provider(options: CreateProviderOptions) -> Arc<StandardProvider> {
    Arc::new(StandardProvider {
        name: options.name.unwrap_or_else(|| options.id.clone()),
        id: options.id,
        base_url: options.base_url,
        headers: options.headers,
        auth: options.auth,
        baseline: options.models,
        dynamic: RwLock::new(Vec::new()),
        api: options.api,
    })
}

/// Upstream `currentModels` closure (models.ts:788-796): the baseline with
/// the dynamic overlay merged in — a dynamic model replaces the baseline
/// entry with the same id in place, otherwise it appends after the baseline.
pub(crate) fn merge_catalog(baseline: &[Model], dynamic: &[Model]) -> Vec<Model> {
    let mut merged = baseline.to_vec();
    for model in dynamic {
        match merged.iter().position(|entry| entry.id == model.id) {
            Some(index) => merged[index] = model.clone(),
            None => merged.push(model.clone()),
        }
    }
    merged
}

impl Provider for StandardProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn base_url(&self) -> Option<&str> {
        self.base_url.as_deref()
    }

    fn headers(&self) -> Option<&ProviderHeaders> {
        self.headers.as_ref()
    }

    fn auth(&self) -> &ProviderAuth {
        &self.auth
    }

    fn get_models(&self) -> Result<Vec<Model>, ModelsError> {
        let dynamic = self
            .dynamic
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(merge_catalog(&self.baseline, &dynamic))
    }

    /// Upstream `apiFor` (models.ts:801): a single implementation serves every
    /// model; the map form dispatches on `model.api`. The "no API
    /// implementation" stream error for a `None` result is produced by the
    /// `Models` collection at dispatch time (models.ts:808-811).
    fn api_for(&self, model: &Model) -> Option<Arc<dyn ApiImpl>> {
        match &self.api {
            ApiImpls::Single(implementation) => Some(Arc::clone(implementation)),
            ApiImpls::PerApi(map) => map.get(&model.api).cloned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::auth::types::{ApiKeyAuth, ApiKeyAuthInput, AuthError, AuthResult};
    use crate::ai::transcript::TranscriptContext;
    use crate::ai::types::events::AssistantMessageEvent;
    use crate::ai::types::options::{SimpleStreamOptions, StreamOptions};
    use crate::ai::types::primitives::ModelCost;
    use crate::ai::types::ModelInput;
    use crate::ai::ProviderConfig;
    use futures::future::BoxFuture;
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

    /// Upstream `ambientAuth` fixture (models-runtime.test.ts:49-53): reports
    /// configured with no auth values.
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

    /// Eventless API implementation for handle-identity assertions (the
    /// provider methods are never invoked by these tests).
    struct StubApi;

    impl ApiImpl for StubApi {
        fn stream(
            &self,
            _cfg: &ProviderConfig,
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
            _cfg: &ProviderConfig,
            _model: &Model,
            _ctx: &TranscriptContext,
            _options: &SimpleStreamOptions,
        ) -> mpsc::Receiver<AssistantMessageEvent> {
            let (tx, rx) = mpsc::channel(1);
            drop(tx);
            rx
        }
    }

    fn options(
        id: &str,
        name: Option<&str>,
        models: Vec<Model>,
        api: ApiImpls,
    ) -> CreateProviderOptions {
        CreateProviderOptions {
            id: id.to_string(),
            name: name.map(str::to_string),
            base_url: None,
            headers: None,
            auth: ambient_auth(),
            models,
            api,
        }
    }

    #[test]
    fn create_provider_defaults_name_to_id_and_holds_metadata() {
        let provider = create_provider(options(
            "p1",
            None,
            vec![],
            ApiImpls::Single(Arc::new(StubApi)),
        ));
        assert_eq!(provider.id(), "p1");
        assert_eq!(provider.name(), "p1");

        let named = create_provider(options(
            "p2",
            Some("P Two"),
            vec![],
            ApiImpls::Single(Arc::new(StubApi)),
        ));
        assert_eq!(named.id(), "p2");
        assert_eq!(named.name(), "P Two");
    }

    #[test]
    fn create_provider_serves_the_static_baseline() {
        let baseline = vec![test_model("p1", "m1"), test_model("p1", "m2")];
        let provider = create_provider(options(
            "p1",
            None,
            baseline.clone(),
            ApiImpls::Single(Arc::new(StubApi)),
        ));
        // Freshly built providers serve exactly the baseline: the dynamic
        // overlay starts empty (models.ts:786) until Task 4 publishes into it.
        assert_eq!(provider.get_models().unwrap(), baseline);

        // Purely dynamic providers ship an empty baseline (upstream radius).
        let dynamic_only = create_provider(options(
            "radius",
            None,
            vec![],
            ApiImpls::Single(Arc::new(StubApi)),
        ));
        assert!(dynamic_only.get_models().unwrap().is_empty());
    }

    /// Upstream `currentModels` merge semantics (models.ts:788-796).
    #[test]
    fn merge_catalog_overlays_dynamic_models_on_the_baseline() {
        let baseline = vec![test_model("p", "a"), test_model("p", "b")];
        let mut refreshed_b = test_model("p", "b");
        refreshed_b.context_window = 999;
        let dynamic = vec![refreshed_b, test_model("p", "c")];

        let merged = merge_catalog(&baseline, &dynamic);
        let ids: Vec<&str> = merged.iter().map(|model| model.id.as_str()).collect();
        // Replaced in place, new entries appended after the baseline.
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(merged[1].context_window, 999);
        assert_eq!(merged[2].context_window, 10_000);

        // An empty overlay returns the baseline unchanged.
        assert_eq!(merge_catalog(&baseline, &[]), baseline);
    }

    #[test]
    fn api_for_dispatches_single_and_per_api_choices() {
        let single: Arc<dyn ApiImpl> = Arc::new(StubApi);
        let provider = create_provider(options(
            "p1",
            None,
            vec![],
            ApiImpls::Single(Arc::clone(&single)),
        ));
        // A single implementation serves every model regardless of api.
        let mut model = test_model("p1", "m1");
        assert!(Arc::ptr_eq(&provider.api_for(&model).unwrap(), &single));
        model.api = "anything-else".to_string();
        assert!(Arc::ptr_eq(&provider.api_for(&model).unwrap(), &single));

        let completions: Arc<dyn ApiImpl> = Arc::new(StubApi);
        let mut per_api: BTreeMap<String, Arc<dyn ApiImpl>> = BTreeMap::new();
        per_api.insert("test-api".to_string(), Arc::clone(&single));
        per_api.insert("anthropic-messages".to_string(), Arc::clone(&completions));
        let mixed = create_provider(options("p2", None, vec![], ApiImpls::PerApi(per_api)));

        model.api = "test-api".to_string();
        assert!(Arc::ptr_eq(&mixed.api_for(&model).unwrap(), &single));
        model.api = "anthropic-messages".to_string();
        assert!(Arc::ptr_eq(&mixed.api_for(&model).unwrap(), &completions));
        // A model whose api has no entry has no implementation (upstream
        // turns this into the "no API implementation" stream error, Task 3).
        model.api = "unknown-api".to_string();
        assert!(mixed.api_for(&model).is_none());
    }

    /// The registry contract: created providers live in collections as
    /// `Arc<dyn Provider>` (the `Agent`-field pattern).
    #[test]
    fn standard_provider_is_usable_as_the_provider_trait_object() {
        let provider: Arc<dyn Provider> = create_provider(options(
            "p1",
            None,
            vec![test_model("p1", "m1")],
            ApiImpls::Single(Arc::new(StubApi)),
        ));
        assert_eq!(provider.id(), "p1");
        assert_eq!(provider.get_models().unwrap().len(), 1);
        assert_eq!(
            provider.auth().api_key.as_ref().map(|auth| auth.name()),
            Some("Ambient")
        );
        assert!(provider.base_url().is_none());
        assert!(provider.headers().is_none());
    }
}
