//! OpenAI-compatible chat-completions API (upstream
//! `packages/ai/src/api/openai-completions.ts`). This M2b stage ports the
//! compatibility auto-detection and per-field merge ([`compat_detect`]); the
//! request builders and streaming implementation land with the remaining
//! M2b tasks.

pub mod compat_detect;

pub use compat_detect::{
    detect_openai_completions_compat, detect_openai_completions_compat_for_model, merge_compat,
};
