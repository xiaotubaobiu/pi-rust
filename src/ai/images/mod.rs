//! The image-generation side (upstream M2e surface): the image data types
//! live in [`crate::ai::types::images`]; this module ports the runtime half —
//!
//! - [`models`] — the [`ImagesProvider`](models::ImagesProvider) trait,
//!   [`create_images_provider`](models::create_images_provider), and the
//!   [`ImagesModels`](models::ImagesModels) collection with auth resolution
//!   and generation convenience (upstream `images-models.ts`).
//! - [`registry`] — the images API provider registry, the free
//!   [`generate_images`](registry::generate_images) entry point, the static
//!   image-model catalog (`image-models.ts` + embedded generated data), and
//!   the OpenRouter image-model parser (upstream `images-api-registry.ts`,
//!   `images.ts`, `image-models.ts`, `scripts/generate-image-models.ts`).
//! - [`openrouter_images`] — the `openrouter-images` API implementation and
//!   the built-in provider factory (upstream `api/openrouter-images.ts`,
//!   `providers/openrouter-images.ts`).
//!
//! Upstream `images.ts` pulls the built-in API registrations in through an
//! import side effect (`providers/images/register-builtins.ts`); the port
//! registers them lazily at first [`registry::generate_images`] call (Rust
//! has no import side effects).

pub mod models;
pub mod openrouter_images;
pub mod registry;

pub use models::{
    create_images_models, create_images_provider, CreateImagesProviderOptions, ImagesModels,
    ImagesProvider, RefreshImagesModelsFn, StandardImagesProvider,
};
pub use registry::{
    ensure_builtin_images_apis_registered, generate_images, get_image_model, get_image_models,
    get_image_providers, get_images_api_provider, parse_open_router_image_models,
    register_images_api_provider, ImagesApiFn, OPENROUTER_BASE_URL,
};

use std::sync::Arc;

use crate::ai::models::CreateModelsOptions;

/// Upstream `builtinImagesProviders()` (all.ts:148-151): every built-in
/// image-generation provider, freshly constructed.
pub fn builtin_images_providers() -> Vec<Arc<dyn ImagesProvider>> {
    vec![openrouter_images::openrouter_images_provider()]
}

/// Upstream `builtinImagesModels(options?)` (all.ts:149-155): an
/// [`ImagesModels`] collection with every built-in image-generation provider
/// registered.
pub fn builtin_images_models(options: CreateModelsOptions) -> ImagesModels {
    let mut models = create_images_models(options);
    for provider in builtin_images_providers() {
        models.set_provider(provider);
    }
    models
}
