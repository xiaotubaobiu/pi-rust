//! The model-catalog layer (upstream `packages/ai/src/model-catalog.ts` plus
//! the generated catalog shards `providers/*.models.ts` and the
//! `data/.manifest.json` manifest). The `Models` collection and provider
//! factories (`models.ts`, `providers/*.ts`) join in later tasks.

pub mod catalog;

pub use catalog::{
    catalog_provider_ids, embedded_provider_catalog, embedded_provider_groups,
    flatten_model_catalog, model_data_manifest, model_data_structure, model_data_structure_hash,
    validate_embedded_catalog, ModelDataManifest, ModelDataStructure, MODEL_DATA_MANIFEST_FILE,
    MODEL_DATA_SCHEMA_VERSION,
};
