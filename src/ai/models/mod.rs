//! The model-catalog layer (upstream `packages/ai/src/model-catalog.ts` plus
//! the generated catalog shards `providers/*.models.ts` and the
//! `data/.manifest.json` manifest) and the `Models` collection (upstream
//! `packages/ai/src/models.ts`): the provider registry and its sync reads.
//! The collection's auth resolution and stream routing join in Task 3, the
//! refresh/publication machinery and the models store in Task 4, and the
//! built-in provider factories in Task 5.

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

use crate::ai::auth::context::default_provider_auth_context;
use crate::ai::auth::credential_store::{CredentialStore, InMemoryCredentialStore};
use crate::ai::auth::types::AuthContext;
use crate::ai::types::Model;

/// Upstream `CreateModelsOptions` (models.ts:244-249). The third upstream
/// field, `modelsStore`, joins with Task 4 together with the `ModelsStore`
/// trait it types (`store.rs`).
#[derive(Default)]
pub struct CreateModelsOptions {
    /// Credential store backing auth resolution (Task 3). Default: the
    /// in-memory store (upstream `InMemoryCredentialStore`).
    pub credentials: Option<Arc<dyn CredentialStore>>,
    /// Environment access for auth resolution (Task 3). Default: the
    /// process-env context (upstream `defaultAuthContext`).
    pub auth_context: Option<Arc<dyn AuthContext>>,
}

/// Upstream `Models` + `MutableModels` (models.ts:163-242): runtime collection
/// of providers plus auth application and stream convenience. The upstream
/// `Models`/`MutableModels` interface split (read surface vs registry
/// mutation) is a JS capability boundary; the port is one struct. Providers
/// are held in registration order (upstream `Map` insertion order — an upsert
/// keeps the original position).
pub struct Models {
    providers: Vec<(String, Arc<dyn Provider>)>,
    // Held for Task 3 (auth resolution reads them); unused until then.
    #[allow(dead_code)]
    credentials: Arc<dyn CredentialStore>,
    #[allow(dead_code)]
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

    // TODO(T3): getAuth/checkAuth/getAvailable/login/logout/stream/complete/
    // streamSimple/completeSimple over the registered providers and the held
    // credential store + auth context.
    // TODO(T4): refresh + ModelsStore + publication chains.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::api::ApiImpl;
    use crate::ai::auth::resolve::{ModelsError, ModelsErrorCode};
    use crate::ai::auth::types::{
        ApiKeyAuth, ApiKeyAuthInput, AuthError, AuthResult, ProviderAuth,
    };
    use crate::ai::transcript::TranscriptContext;
    use crate::ai::types::events::AssistantMessageEvent;
    use crate::ai::types::options::{SimpleStreamOptions, StreamOptions};
    use crate::ai::types::primitives::ModelCost;
    use crate::ai::types::ModelInput;
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
        create_provider(CreateProviderOptions {
            id: id.to_string(),
            name: None,
            base_url: None,
            headers: None,
            auth: ambient_auth(),
            models,
            api: ApiImpls::Single(Arc::new(StubApi)),
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
}
