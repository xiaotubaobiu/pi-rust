//! Oracle `packages/ai/test/images-models.test.ts`, ported fixture for
//! fixture. The upstream `createImagesProvider` fixture parts (testImageModel,
//! okResult, testProvider, fakeAuthContext) live below.

use super::*;
use crate::ai::auth::types::{ApiKeyAuth, ApiKeyAuthInput, AuthResult, ModelAuth};
use crate::ai::models::CreateModelsOptions;
use crate::ai::types::content::{ImageContent, TextContent};
use crate::ai::types::message::TextOrImageBlock;
use crate::ai::types::model::ModelInput;
use crate::ai::types::options::ProviderEnv;
use futures::future::BoxFuture;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

/// Oracle `fakeAuthContext` (images-models.test.ts:7-12): env lookup from a
/// fixed map, no files.
struct FakeAuthContext {
    env: BTreeMap<String, String>,
}

impl AuthContext for FakeAuthContext {
    fn env<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { self.env.get(name).cloned() })
    }

    fn file_exists<'a>(&'a self, _path: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move { false })
    }
}

fn fake_auth_context(env: &[(&str, &str)]) -> Arc<dyn AuthContext> {
    Arc::new(FakeAuthContext {
        env: env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    })
}

/// Oracle `okResult` (images-models.test.ts:27-36).
fn ok_result(model: &ImagesModel) -> AssistantImages {
    AssistantImages {
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        output: vec![TextOrImageBlock::Image(ImageContent {
            data: "aGk=".to_string(),
            mime_type: "image/png".to_string(),
        })],
        response_id: None,
        usage: None,
        stop_reason: ImagesStopReason::Stop,
        error_message: None,
        timestamp: crate::ai::now_ms(),
    }
}

/// Oracle `GenerateCall` (images-models.test.ts:38-41).
struct GenerateCall {
    #[allow(dead_code)]
    model: ImagesModel,
    api_key: Option<String>,
    env: Option<ProviderEnv>,
}

/// Oracle `testProvider` (images-models.test.ts:43-69): api-key auth that
/// resolves the env var when `env_var` is set (ambient otherwise), one
/// default model, and a generateImages that records its calls.
fn test_provider(
    id: &str,
    models: Vec<ImagesModel>,
    env_var: Option<&str>,
    calls: Option<Arc<Mutex<Vec<GenerateCall>>>>,
) -> Arc<dyn ImagesProvider> {
    struct TestKeyAuth {
        env_var: Option<String>,
    }

    impl ApiKeyAuth for TestKeyAuth {
        fn name(&self) -> &str {
            "Test key"
        }

        fn resolve<'a>(
            &'a self,
            input: ApiKeyAuthInput<'a>,
        ) -> BoxFuture<'a, Result<Option<AuthResult>, AuthError>> {
            Box::pin(async move {
                let Some(env_var) = self.env_var.as_deref() else {
                    return Ok(Some(AuthResult::default()));
                };
                let key = input
                    .credential
                    .and_then(|credential| credential.key.clone())
                    .or(None);
                let key = match key {
                    Some(key) => Some(key),
                    None => input.ctx.env(env_var).await,
                };
                Ok(key.map(|key| AuthResult {
                    auth: ModelAuth {
                        api_key: Some(key.clone()),
                        headers: None,
                        base_url: None,
                    },
                    env: None,
                    source: Some(env_var.to_string()),
                }))
            })
        }
    }

    let models = if models.is_empty() {
        vec![test_image_model(id, "model-a")]
    } else {
        models
    };
    create_images_provider(CreateImagesProviderOptions {
        id: id.to_string(),
        name: None,
        auth: ProviderAuth {
            api_key: Some(Arc::new(TestKeyAuth {
                env_var: env_var.map(str::to_string),
            })),
            oauth: None,
        },
        models,
        refresh_models: None,
        api: Arc::new(move |model, _context, options| {
            let calls = calls.clone();
            Box::pin(async move {
                if let Some(calls) = calls {
                    calls.lock().unwrap().push(GenerateCall {
                        model: model.clone(),
                        api_key: options.as_ref().and_then(|options| options.api_key.clone()),
                        env: options.as_ref().and_then(|options| options.env.clone()),
                    });
                }
                Ok(ok_result(&model))
            })
        }),
    })
}

fn test_image_model(provider: &str, id: &str) -> ImagesModel {
    ImagesModel {
        id: id.to_string(),
        name: id.to_string(),
        api: "test-images".to_string(),
        provider: provider.to_string(),
        base_url: "https://example.test/v1".to_string(),
        input: vec![ModelInput::Text],
        output: vec![ModelInput::Image],
        cost: crate::ai::types::primitives::ModelCost::default(),
        thinking_level_map: None,
        sampling_params: None,
        headers: None,
    }
}

fn context() -> ImagesContext {
    ImagesContext {
        input: vec![TextOrImageBlock::Text(TextContent {
            text: "a red circle".to_string(),
            text_signature: None,
        })],
    }
}

/// Oracle: "registers providers and reads models synchronously".
#[test]
fn registers_providers_and_reads_models_synchronously() {
    let mut models = create_images_models(CreateModelsOptions::default());
    models.set_provider(test_provider(
        "p1",
        vec![test_image_model("p1", "m1"), test_image_model("p1", "m2")],
        None,
        None,
    ));
    models.set_provider(test_provider(
        "p2",
        vec![test_image_model("p2", "m3")],
        None,
        None,
    ));

    let provider_ids: Vec<String> = models
        .get_providers()
        .iter()
        .map(|provider| provider.id().to_string())
        .collect();
    assert_eq!(provider_ids, ["p1", "p2"]);
    let all: Vec<String> = models
        .get_models(None)
        .iter()
        .map(|m| m.id.clone())
        .collect();
    assert_eq!(all, ["m1", "m2", "m3"]);
    let p1: Vec<String> = models
        .get_models(Some("p1"))
        .iter()
        .map(|m| m.id.clone())
        .collect();
    assert_eq!(p1, ["m1", "m2"]);
    assert_eq!(models.get_model("p2", "m3").unwrap().id, "m3");
    assert!(models.get_model("p2", "missing").is_none());

    models.delete_provider("p1");
    assert!(models.get_provider("p1").is_none());
}

/// Oracle: "resolves auth through the provider and merges it into requests;
/// explicit options win".
#[tokio::test]
async fn resolves_auth_through_the_provider_and_merges_it() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut models = create_images_models(CreateModelsOptions {
        auth_context: Some(fake_auth_context(&[("TEST_KEY", "env-key")])),
        ..CreateModelsOptions::default()
    });
    models.set_provider(test_provider(
        "p1",
        Vec::new(),
        Some("TEST_KEY"),
        Some(Arc::clone(&calls)),
    ));
    let model = models.get_model("p1", "model-a").unwrap();

    // getAuth(model) and getAuth(provider) resolve the same key; the
    // explicit override wins.
    let resolved = models
        .get_auth_for_model(&model, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resolved.auth.api_key.as_deref(), Some("env-key"));
    let resolved = models.get_auth("p1", None).await.unwrap().unwrap();
    assert_eq!(resolved.auth.api_key.as_deref(), Some("env-key"));
    let overrides = AuthResolutionOverrides {
        api_key: Some("explicit-key".to_string()),
        ..AuthResolutionOverrides::default()
    };
    let resolved = models
        .get_auth_for_model(&model, Some(&overrides))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resolved.auth.api_key.as_deref(), Some("explicit-key"));

    // The resolved key rides into the dispatched options.
    let result = models.generate_images(model.clone(), context(), None).await;
    assert_eq!(result.stop_reason, ImagesStopReason::Stop);
    assert_eq!(calls.lock().unwrap()[0].api_key.as_deref(), Some("env-key"));

    let options = ImagesOptions {
        api_key: Some("explicit".to_string()),
        ..ImagesOptions::default()
    };
    models
        .generate_images(model, context(), Some(options))
        .await;
    assert_eq!(
        calls.lock().unwrap()[1].api_key.as_deref(),
        Some("explicit")
    );
}

/// Oracle: "merges provider-resolved env into image options" — provider env
/// merges under the request env, request wins per key, apiKey does not.
#[tokio::test]
async fn merges_provider_resolved_env_into_image_options() {
    struct ProviderEnvAuth;
    impl ApiKeyAuth for ProviderEnvAuth {
        fn name(&self) -> &str {
            "Test key"
        }
        fn resolve<'a>(
            &'a self,
            _input: ApiKeyAuthInput<'a>,
        ) -> BoxFuture<'a, Result<Option<AuthResult>, AuthError>> {
            Box::pin(async move {
                Ok(Some(AuthResult {
                    auth: ModelAuth {
                        api_key: Some("provider-key".to_string()),
                        headers: None,
                        base_url: None,
                    },
                    env: Some(ProviderEnv::from([
                        ("PROVIDER_ONLY".to_string(), "provider".to_string()),
                        ("SHARED".to_string(), "provider".to_string()),
                    ])),
                    source: None,
                }))
            })
        }
    }

    let calls = Arc::new(Mutex::new(Vec::new()));
    let calls_for_api = Arc::clone(&calls);
    let mut models = create_images_models(CreateModelsOptions::default());
    models.set_provider(create_images_provider(CreateImagesProviderOptions {
        id: "p1".to_string(),
        name: None,
        auth: ProviderAuth {
            api_key: Some(Arc::new(ProviderEnvAuth)),
            oauth: None,
        },
        models: vec![test_image_model("p1", "model-a")],
        refresh_models: None,
        api: Arc::new(move |model, _context, options| {
            let calls = Arc::clone(&calls_for_api);
            Box::pin(async move {
                calls.lock().unwrap().push(GenerateCall {
                    model: model.clone(),
                    api_key: options.as_ref().and_then(|options| options.api_key.clone()),
                    env: options.as_ref().and_then(|options| options.env.clone()),
                });
                Ok(ok_result(&model))
            })
        }),
    }));
    let model = models.get_model("p1", "model-a").unwrap();

    let options = ImagesOptions {
        api_key: Some("request-key".to_string()),
        env: Some(ProviderEnv::from([
            ("REQUEST_ONLY".to_string(), "request".to_string()),
            ("SHARED".to_string(), "request".to_string()),
        ])),
        ..ImagesOptions::default()
    };
    models
        .generate_images(model, context(), Some(options))
        .await;

    let call = calls.lock().unwrap();
    assert_eq!(call[0].api_key.as_deref(), Some("request-key"));
    let env = call[0].env.as_ref().unwrap();
    assert_eq!(
        env.get("PROVIDER_ONLY").map(String::as_str),
        Some("provider")
    );
    assert_eq!(env.get("REQUEST_ONLY").map(String::as_str), Some("request"));
    assert_eq!(env.get("SHARED").map(String::as_str), Some("request"));
}

/// Oracle: "returns an error result for unknown providers and unconfigured
/// auth rejections".
#[tokio::test]
async fn error_result_for_unknown_providers_and_unconfigured_auth() {
    let mut models = create_images_models(CreateModelsOptions {
        auth_context: Some(fake_auth_context(&[])),
        ..CreateModelsOptions::default()
    });
    let ghost = models
        .generate_images(test_image_model("ghost", "m"), context(), None)
        .await;
    assert_eq!(ghost.stop_reason, ImagesStopReason::Error);
    assert!(
        ghost
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("Unknown provider: ghost"),
        "{ghost:?}"
    );

    // Unconfigured (resolve -> undefined) still dispatches; the provider
    // decides what to do without auth.
    let calls = Arc::new(Mutex::new(Vec::new()));
    models.set_provider(test_provider(
        "p1",
        Vec::new(),
        Some("MISSING"),
        Some(Arc::clone(&calls)),
    ));
    let model = models.get_model("p1", "model-a").unwrap();
    assert!(models
        .get_auth_for_model(&model, None)
        .await
        .unwrap()
        .is_none());
    models.generate_images(model, context(), None).await;
    assert_eq!(calls.lock().unwrap()[0].api_key, None);
}

/// Oracle: "supports dynamic providers via refresh with in-flight dedupe".
#[tokio::test]
async fn dynamic_providers_refresh_with_inflight_dedupe() {
    let fetches = Arc::new(AtomicU32::new(0));
    let fetches_for_closure = Arc::clone(&fetches);
    let provider = create_images_provider(CreateImagesProviderOptions {
        id: "dyn".to_string(),
        name: None,
        auth: ambient_auth(),
        models: Vec::new(),
        refresh_models: Some(Arc::new(move || {
            let fetches = Arc::clone(&fetches_for_closure);
            Box::pin(async move {
                fetches.fetch_add(1, Ordering::SeqCst);
                // Hold the fetch open so the concurrent second refresh joins
                // the in-flight one instead of racing a second fetch.
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                Ok(vec![test_image_model("dyn", "listed")])
            })
        })),
        api: ok_api(),
    });
    let mut models = create_images_models(CreateModelsOptions::default());
    models.set_provider(provider);

    assert!(models.get_models(Some("dyn")).is_empty());
    let (first, second) = tokio::join!(
        models.refresh_provider("dyn"),
        models.refresh_provider("dyn")
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(fetches.load(Ordering::SeqCst), 1);
    assert!(models.get_model("dyn", "listed").is_some());

    // Failures reject with a model_source ModelsError for a single provider.
    let flaky = create_images_provider(CreateImagesProviderOptions {
        id: "flaky".to_string(),
        name: None,
        auth: ambient_auth(),
        models: Vec::new(),
        refresh_models: Some(Arc::new(|| {
            Box::pin(async {
                Err(ModelsError::new(
                    ModelsErrorCode::ModelSource,
                    "fetch failed",
                ))
            })
        })),
        api: ok_api(),
    });
    models.set_provider(flaky);
    let error = models.refresh_provider("flaky").await.unwrap_err();
    assert_eq!(error.code, ModelsErrorCode::ModelSource);

    // The all-providers refresh is best-effort and still resolves.
    models.refresh().await;
}

fn ambient_auth() -> ProviderAuth {
    struct Ambient;
    impl ApiKeyAuth for Ambient {
        fn name(&self) -> &str {
            "Test"
        }
        fn resolve<'a>(
            &'a self,
            _input: ApiKeyAuthInput<'a>,
        ) -> BoxFuture<'a, Result<Option<AuthResult>, AuthError>> {
            Box::pin(async move { Ok(Some(AuthResult::default())) })
        }
    }
    ProviderAuth {
        api_key: Some(Arc::new(Ambient)),
        oauth: None,
    }
}

fn ok_api() -> ImagesApiFn {
    Arc::new(|model, _context, _options| Box::pin(async move { Ok(ok_result(&model)) }))
}

/// Oracle: "builtinImagesModels registers the openrouter provider with its
/// catalog".
#[tokio::test]
async fn builtin_images_models_registers_the_openrouter_provider() {
    let models = super::super::builtin_images_models(CreateModelsOptions {
        auth_context: Some(fake_auth_context(&[("OPENROUTER_API_KEY", "or-key")])),
        ..CreateModelsOptions::default()
    });
    let provider_ids: Vec<String> = models
        .get_providers()
        .iter()
        .map(|provider| provider.id().to_string())
        .collect();
    assert_eq!(provider_ids, ["openrouter"]);

    let list = models.get_models(Some("openrouter"));
    assert!(!list.is_empty());
    assert!(list.iter().all(|model| model.api == "openrouter-images"));

    let resolved = models
        .get_auth_for_model(&list[0], None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resolved.auth.api_key.as_deref(), Some("or-key"));
}

/// A provider whose get_models fails yields no models through the
/// collection (the port's explicit form of upstream's try/catch defense).
#[test]
fn broken_provider_yields_no_models() {
    struct Broken {
        auth: ProviderAuth,
    }
    impl ImagesProvider for Broken {
        fn id(&self) -> &str {
            "broken"
        }
        fn name(&self) -> &str {
            "broken"
        }
        fn auth(&self) -> &ProviderAuth {
            &self.auth
        }
        fn get_models(&self) -> Result<Vec<ImagesModel>, ModelsError> {
            Err(ModelsError::new(ModelsErrorCode::ModelSource, "boom"))
        }
        fn generate_images(
            &self,
            _model: ImagesModel,
            _context: ImagesContext,
            _options: Option<ImagesOptions>,
        ) -> BoxFuture<'static, AssistantImages> {
            unreachable!()
        }
    }

    let mut models = create_images_models(CreateModelsOptions::default());
    models.set_provider(Arc::new(Broken {
        auth: ambient_auth(),
    }));
    models.set_provider(test_provider(
        "ok",
        vec![test_image_model("ok", "m1")],
        None,
        None,
    ));
    let all: Vec<String> = models
        .get_models(None)
        .iter()
        .map(|m| m.id.clone())
        .collect();
    assert_eq!(all, ["m1"]);
    assert!(models.get_models(Some("broken")).is_empty());
    assert_eq!(
        models
            .get_provider("broken")
            .unwrap()
            .get_models()
            .unwrap_err()
            .message,
        "boom"
    );
}
