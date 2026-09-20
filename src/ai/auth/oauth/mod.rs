//! OAuth login flows ported from upstream `packages/ai/src/auth/oauth/`:
//! PKCE utilities (`pkce`), the local redirect landing page (`oauth_page`),
//! and the Anthropic (Claude Pro/Max) flow (`anthropic`, exposing
//! [`AnthropicOAuth`]). The remaining upstream flows (device-code, GitHub
//! Copilot, OpenAI Codex, ...) land with their provider wiring.
//!
//! Flows are interactive through [`crate::ai::auth::types::AuthInteraction`]
//! only: the browser gets the authorize URL via the `auth_url` event, the
//! user's paste arrives through the `manual_code` prompt, and progress is
//! reported as events — flows never touch stdio or a browser directly
//! (M2d controller ruling).

pub mod anthropic;
pub mod oauth_page;
pub mod pkce;

pub use anthropic::AnthropicOAuth;
