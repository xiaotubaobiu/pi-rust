//! Auth surface ported from upstream `packages/ai/src/auth/` plus
//! `env-api-keys.ts`: the type-tagged [`Credential`] wire format
//! (`types`), app-owned credential storage (`credential_store`), and
//! provider API-key env discovery (`env_api_keys`).
//!
//! auth.json wire-compat is a hard goal: [`types::Credential`] round-trips
//! upstream-written files byte-for-byte, including unknown OAuth extension
//! fields. Interactive auth goes through [`types::AuthInteraction`] — flows
//! never touch stdio or a browser directly (M2d controller ruling) — and
//! Models-collection integration lands in M2e.
//!
//! Environment variables here are the process env plus the scoped
//! [`crate::ai::types::ProviderEnv`] overrides, resolved by
//! [`crate::ai::api::azure_openai_responses::get_provider_env_value`]
//! (upstream `getProviderEnvValue`).

pub mod credential_store;
pub mod env_api_keys;
pub mod types;

pub use credential_store::{CredentialStore, InMemoryCredentialStore, ModifyCallback};
pub use env_api_keys::{
    find_env_keys, get_api_key_env_vars, get_env_api_key, ANTHROPIC_API_KEY_ENV,
    ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV,
};
pub use types::*;
