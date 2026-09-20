//! OpenAI Responses API endpoint — full port of the stream/streamSimple
//! implementations from upstream `packages/ai/src/api/openai-responses.ts`
//! (lines 113-237 plus `buildParams` lines 283-368 and `createClient`
//! lines 239-281): the request body (model, converted `input` items, tools,
//! `stream: true`, `store: false`, the prompt-cache trio, max output tokens,
//! temperature, tool choice, reasoning effort mapping), the client headers
//! (pi User-Agent, model headers, session-affinity, caller overrides), the
//! retry-wrapped HTTP send (upstream `retryProviderRequest` around
//! `client.responses.create(...).withResponse()`), the SSE loop feeding the
//! T7 [`ResponsesStreamProcessor`], and the terminal/done/error framing of
//! the catch block (lines 199-213).
//!
//! Deviations from upstream, all structural:
//! - Upstream events carry the live `partial`; the port emits events without
//!   it and consumers reconstruct via `PartialAssistant` (the M2a contract).
//! - Upstream `options.signal` aborts have no equivalent here: `StreamOptions`
//!   carries no signal in the port, so the two abort checks (lines 186-188)
//!   and the catch block's `"aborted"` branch have no input to act on.
//! - The API-specific option extensions `reasoningSummary` and `serviceTier`
//!   (`OpenAIResponsesOptions`, lines 103-108) have no port option surface:
//!   `reasoning` is always sent with `summary: "auto"` when an explicit
//!   effort is requested, and no service-tier pricing hook is wired (the T7
//!   processor supports the hook once an options field exists).
//! - The `github-copilot` dynamic header block in `createClient`
//!   (lines 249-256) is not ported (no copilot provider plumbing yet), like
//!   the openai-completions port.
//! - HTTP error bodies are surfaced as `"{status}: {body}"` (the shared
//!   `format_http_error` composition from the openai-completions port);
//!   upstream delegates to the OpenAI SDK's `APIError` message.
//! - Retry covers request setup failures and retryable statuses before the
//!   first stream byte (upstream wraps only the `create` call); mid-flight
//!   stream errors surface as the `error` event with no retry.
//! - `streamSimple`-shaped calls fill `maxTokens` from `model.maxTokens`
//!   clamped to the context window (upstream `buildBaseOptions`); direct
//!   `stream` calls pass the caller's `maxTokens` through unchanged, so
//!   `max_output_tokens` is omitted when unset.
//! - JSON object key order follows `serde_json` (sorted), not JS insertion
//!   order — same documented deviation as the request builder.

use std::collections::HashSet;
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures::StreamExt;
use serde_json::{json, Map, Value};

use crate::ai::api::openai_completions::request::{
    clamp_max_tokens_to_context, clamp_openai_prompt_cache_key, clamp_thinking_level,
    create_grammar_tool_input_properties, level_key, map_level, remove_header,
    resolve_cache_retention, set_header, MappedLevel,
};
use crate::ai::api::openai_completions::stream::{format_http_error, get_client_api_key};
use crate::ai::api::openai_responses_shared::{
    convert_responses_messages, convert_responses_tools, detect_session_affinity_format,
    session_affinity_headers, ConvertResponsesMessagesOptions, ConvertResponsesToolsOptions,
    ResponsesStreamEvent, ResponsesStreamOptions, ResponsesStreamProcessor,
};
use crate::ai::api::{http_client, pi_user_agent, ApiImpl};
use crate::ai::retry::{retry_provider_request, ProviderError};
use crate::ai::transcript::{get_declared_tools, resolve_transcript, TranscriptContext};
use crate::ai::types::events::{AssistantMessageEvent, ErrorReason, SuccessReason};
use crate::ai::types::options::{SimpleStreamOptions, StreamOptions};
use crate::ai::types::primitives::{CacheRetention, SessionAffinityFormat, StopReason};
use crate::ai::types::Model;
use crate::ai::ProviderConfig;
use tokio::sync::mpsc;

/// Upstream `OPENAI_TOOL_CALL_PROVIDERS` (openai-responses.ts:31): providers
/// whose tool calls keep their `call_id|item_id` wire ids on replay.
const OPENAI_TOOL_CALL_PROVIDERS: [&str; 3] = ["openai", "openai-codex", "opencode"];

/// Upstream `OPENAI_RESPONSES_MIN_OUTPUT_TOKENS` (openai-responses.ts:33):
/// the Responses endpoint rejects `max_output_tokens` below 16.
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS: u64 = 16;

pub struct OpenAiResponses;

impl ApiImpl for OpenAiResponses {
    fn stream(
        &self,
        cfg: &ProviderConfig,
        model: &Model,
        ctx: &TranscriptContext,
        options: &StreamOptions,
    ) -> mpsc::Receiver<AssistantMessageEvent> {
        // Upstream `stream` takes the API-specific option extension
        // (`reasoningEffort`/`reasoningSummary`/`serviceTier`/`toolChoice`) on
        // top of the base options; the port's `StreamOptions` is the base set,
        // so the extension fields stay unset for direct `stream` calls.
        let simple = SimpleStreamOptions {
            stream: options.clone(),
            ..SimpleStreamOptions::default()
        };
        run_stream(cfg.clone(), model.clone(), ctx.clone(), simple)
    }

    fn stream_simple(
        &self,
        cfg: &ProviderConfig,
        model: &Model,
        ctx: &TranscriptContext,
        options: &SimpleStreamOptions,
    ) -> mpsc::Receiver<AssistantMessageEvent> {
        // Upstream `streamSimple` (lines 219-237): buildBaseOptions shaping
        // (context-clamped maxTokens default) plus the reasoning clamp
        // (`clampThinkingLevel`, mapped "off" drops the effort entirely),
        // then delegates to `stream`.
        let mut shaped = options.clone();
        shaped.stream.max_tokens = Some(clamp_max_tokens_to_context(
            model,
            ctx,
            options.stream.max_tokens.unwrap_or(model.max_tokens),
        ));
        shaped.reasoning = options
            .reasoning
            .and_then(|level| clamp_thinking_level(model, Some(level)));
        run_stream(cfg.clone(), model.clone(), ctx.clone(), shaped)
    }
}

fn run_stream(
    cfg: ProviderConfig,
    model: Model,
    ctx: TranscriptContext,
    options: SimpleStreamOptions,
) -> mpsc::Receiver<AssistantMessageEvent> {
    let (tx, rx) = mpsc::channel(64);
    tokio::spawn(async move {
        run_stream_task(cfg, model, ctx, options, tx).await;
    });
    rx
}

/// Upstream `getCompat` (openai-responses.ts:68-81): every field with its
/// documented default; `sessionAffinityFormat` falls back to the
/// provider/baseUrl auto-detection.
#[derive(Debug, Clone, PartialEq)]
pub struct ResponsesCompat {
    supports_developer_role: bool,
    supports_mid_convo_system_messages: bool,
    session_affinity_format: SessionAffinityFormat,
    supports_long_cache_retention: bool,
    supports_strict_mode: bool,
    supports_openai_grammar_tools: bool,
    supports_additional_tools: bool,
    supports_tool_search: bool,
    supports_explicit_prompt_cache_mode: bool,
    supports_max_output_tokens: bool,
}

pub fn get_compat(model: &Model) -> ResponsesCompat {
    let raw = model.openai_responses_compat().unwrap_or_default();
    ResponsesCompat {
        supports_developer_role: raw.supports_developer_role.unwrap_or(true),
        supports_mid_convo_system_messages: raw.supports_mid_convo_system_messages.unwrap_or(false),
        session_affinity_format: raw
            .session_affinity_format
            .unwrap_or_else(|| detect_session_affinity_format(model)),
        supports_long_cache_retention: raw.supports_long_cache_retention.unwrap_or(true),
        supports_strict_mode: raw.supports_strict_mode.unwrap_or(false),
        supports_openai_grammar_tools: raw.supports_openai_grammar_tools.unwrap_or(false),
        supports_additional_tools: raw.supports_additional_tools.unwrap_or(false),
        supports_tool_search: raw.supports_tool_search.unwrap_or(false),
        supports_explicit_prompt_cache_mode: raw
            .supports_explicit_prompt_cache_mode
            .unwrap_or(false),
        supports_max_output_tokens: raw.supports_max_output_tokens.unwrap_or(true),
    }
}

/// The pure output of [`build_request`]: the JSON request body and the ordered
/// header pairs an HTTP layer would put on the wire (upstream `buildParams` +
/// `createClient`).
#[derive(Debug, Clone, PartialEq)]
pub struct RequestAssembly {
    pub body: Value,
    pub headers: Vec<(String, String)>,
}

/// Assemble the Responses request body and headers for one stream request
/// (upstream `buildParams` + `createClient`). Pure: no HTTP, no I/O.
/// Upstream does not consult `baseUrl` for the body (the prompt-cache trio is
/// sent on every Responses endpoint).
pub fn build_request(
    model: &Model,
    ctx: &TranscriptContext,
    options: &SimpleStreamOptions,
    compat: &ResponsesCompat,
) -> Result<RequestAssembly, String> {
    let grammar_tool_input_properties = create_grammar_tool_input_properties(
        &get_declared_tools(ctx.messages()),
        compat.supports_openai_grammar_tools,
    )?;
    assemble(model, ctx, options, compat, &grammar_tool_input_properties)
}

fn assemble(
    model: &Model,
    ctx: &TranscriptContext,
    options: &SimpleStreamOptions,
    compat: &ResponsesCompat,
    grammar_tool_input_properties: &std::collections::HashMap<String, String>,
) -> Result<RequestAssembly, String> {
    let cache_retention =
        resolve_cache_retention(options.stream.cache_retention, options.stream.env.as_ref());
    let cache_session_id = (cache_retention != CacheRetention::None)
        .then(|| options.stream.session_id.clone())
        .flatten();
    let headers = build_headers(model, options, compat, cache_session_id.as_deref());
    let body = build_params(
        model,
        ctx,
        options,
        compat,
        cache_retention,
        grammar_tool_input_properties,
    )?;
    Ok(RequestAssembly { body, headers })
}

/// Upstream `createClient` header assembly (openai-responses.ts:239-281)
/// without the HTTP client: the pi User-Agent, model headers,
/// session-affinity headers, and the caller's headers merged last.
fn build_headers(
    model: &Model,
    options: &SimpleStreamOptions,
    compat: &ResponsesCompat,
    session_id: Option<&str>,
) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = vec![("User-Agent".to_string(), pi_user_agent())];
    for (name, value) in model.headers.iter().flatten() {
        set_header(&mut headers, name, value);
    }
    // Upstream lines 258-267; the github-copilot dynamic block is not ported.
    if let Some(session_id) = session_id {
        for (name, value) in session_affinity_headers(compat.session_affinity_format, session_id) {
            set_header(&mut headers, &name, &value);
        }
    }
    // Merge options headers last so they can override defaults; a `None`
    // value (upstream `null`) suppresses a default header.
    if let Some(option_headers) = &options.stream.headers {
        for (name, value) in option_headers {
            match value {
                Some(value) => set_header(&mut headers, name, value),
                None => remove_header(&mut headers, name),
            }
        }
    }
    headers
}

/// Upstream `buildParams` (openai-responses.ts:283-368).
fn build_params(
    model: &Model,
    ctx: &TranscriptContext,
    options: &SimpleStreamOptions,
    compat: &ResponsesCompat,
    cache_retention: CacheRetention,
    grammar_tool_input_properties: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let messages_slice = ctx.messages();
    let transcript_tools = crate::ai::transcript::resolve_transcript_tools(
        messages_slice,
        compat.supports_additional_tools || compat.supports_tool_search,
    );
    let tool_options = ConvertResponsesToolsOptions {
        supports_strict_mode: compat.supports_strict_mode,
        supports_openai_grammar_tools: compat.supports_openai_grammar_tools,
        ..Default::default()
    };
    let allowed_providers: HashSet<String> = OPENAI_TOOL_CALL_PROVIDERS
        .iter()
        .map(|provider| (*provider).to_string())
        .collect();
    let input = convert_responses_messages(
        model,
        ctx,
        &allowed_providers,
        &ConvertResponsesMessagesOptions {
            include_system_prompt: None,
            grammar_tool_input_properties: grammar_tool_input_properties.clone(),
            supports_mid_convo_system_messages: compat.supports_mid_convo_system_messages,
            supports_additional_tools: compat.supports_additional_tools,
            supports_tool_search: compat.supports_tool_search,
            tool_options: Some(tool_options.clone()),
        },
    )?;

    let mut params = Map::new();
    params.insert("model".into(), json!(model.id));
    params.insert("input".into(), Value::Array(input));
    params.insert("stream".into(), json!(true));

    // Upstream line 315: `prompt_cache_key` unless retention is "none".
    if cache_retention != CacheRetention::None {
        if let Some(key) = clamp_openai_prompt_cache_key(options.stream.session_id.as_deref()) {
            params.insert("prompt_cache_key".into(), json!(key));
        }
    }
    // Upstream `getPromptCacheRetention` (lines 83-90).
    if cache_retention == CacheRetention::Long
        && compat.supports_long_cache_retention
        && !compat.supports_explicit_prompt_cache_mode
    {
        params.insert("prompt_cache_retention".into(), json!("24h"));
    }
    // Upstream `getPromptCacheOptions` (lines 92-100).
    if compat.supports_explicit_prompt_cache_mode {
        if cache_retention == CacheRetention::None {
            params.insert("prompt_cache_options".into(), json!({"mode": "explicit"}));
        } else if cache_retention == CacheRetention::Long && compat.supports_long_cache_retention {
            params.insert("prompt_cache_options".into(), json!({"ttl": "30m"}));
        }
    }
    params.insert("store".into(), json!(false));

    // Upstream lines 321-323: the truthy `options?.maxTokens &&` check omits
    // the field for 0, and `Math.max(options.maxTokens, 16)` floors the rest.
    if let Some(max_tokens) = options
        .stream
        .max_tokens
        .filter(|max_tokens| *max_tokens > 0)
    {
        if compat.supports_max_output_tokens {
            params.insert(
                "max_output_tokens".into(),
                json!(max_tokens.max(OPENAI_RESPONSES_MIN_OUTPUT_TOKENS)),
            );
        }
    }

    if let Some(temperature) = options.stream.temperature {
        params.insert("temperature".into(), json!(temperature));
    }

    if !transcript_tools.request_tools.is_empty() {
        params.insert(
            "tools".into(),
            Value::Array(convert_responses_tools(
                &transcript_tools.request_tools,
                &tool_options,
            )?),
        );
    }

    if let Some(tool_choice) = options.tool_choice {
        params.insert("tool_choice".into(), json!(tool_choice));
    }

    // Upstream lines 344-360: the reasoning effort mapping. The port's
    // `options.reasoning` is the clamped effort from `streamSimple`; the
    // `reasoningSummary` extension has no port surface so `summary` is always
    // the `"auto"` default, and the effortless-`"medium"` branch is
    // unreachable.
    if model.reasoning {
        if let Some(level) = options.reasoning {
            let effort = match map_level(model, level_key(Some(level))) {
                MappedLevel::Value(value) => value,
                // JS `null ?? effort`: a null mapping falls back to the level.
                MappedLevel::Null | MappedLevel::Absent => level_key(Some(level)).to_string(),
            };
            params.insert(
                "reasoning".into(),
                json!({"effort": effort, "summary": "auto"}),
            );
            params.insert("include".into(), json!(["reasoning.encrypted_content"]));
        } else if model.provider != "github-copilot" && map_level(model, "off") != MappedLevel::Null
        {
            let effort = match map_level(model, "off") {
                MappedLevel::Value(value) => value,
                MappedLevel::Null | MappedLevel::Absent => "none".to_string(),
            };
            params.insert("reasoning".into(), json!({"effort": effort}));
        }
        if model.provider == "xai" {
            params.insert("include".into(), json!(["reasoning.encrypted_content"]));
        }
    }

    // Last so custom keys override the named request fields (upstream
    // lines 363-365). The streamSimple base-option merge folds
    // `model.samplingParams` in upstream; the port merges both here.
    let mut sampling = model.sampling_params.clone().unwrap_or_default();
    if let Some(option_params) = &options.stream.sampling_params {
        for (key, value) in option_params {
            sampling.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in sampling {
        params.insert(key, value);
    }

    Ok(Value::Object(params))
}

/// Send the assembled request (upstream
/// `client.responses.create(params, requestOptions).withResponse()`), wrapped
/// in the provider retry policy with `options.maxRetries`/`maxRetryDelayMs`.
/// Retries cover transport failures and retryable statuses only — the SDK
/// throws before `withResponse()` resolves, so once stream bytes flow an
/// error is never retried.
async fn send_stream_request(
    cfg: &ProviderConfig,
    api_key: &str,
    assembly: &RequestAssembly,
    options: &SimpleStreamOptions,
) -> Result<reqwest::Response, String> {
    let url = format!("{}/responses", cfg.base_url.trim_end_matches('/'));
    // Bearer auth first: assembly headers (model.headers then the caller's
    // options headers) are inserted after and override it — the upstream SDK
    // lets `defaultHeaders` override the SDK auth header, which is what makes
    // the gateway `"unused"` key flow in `getClientApiKey` work.
    let mut headers = reqwest::header::HeaderMap::new();
    let auth = reqwest::header::HeaderValue::from_str(&format!("Bearer {api_key}"))
        .map_err(|error| format!("Invalid authorization header: {error}"))?;
    headers.insert(reqwest::header::AUTHORIZATION, auth);
    for (name, value) in &assembly.headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| format!("Invalid header name \"{name}\": {error}"))?;
        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|error| format!("Invalid header value for \"{name}\": {error}"))?;
        headers.insert(name, value);
    }
    let mut request = http_client()
        .post(&url)
        .headers(headers)
        .json(&assembly.body);
    if let Some(ms) = options.stream.timeout_ms {
        request = request.timeout(Duration::from_millis(ms));
    }
    let max_retries = options.stream.max_retries.unwrap_or(0);
    let max_retry_delay_ms = options.stream.max_retry_delay_ms;
    retry_provider_request(max_retries, max_retry_delay_ms, || async {
        let response = request
            .try_clone()
            .expect("JSON request body is buffered and clonable")
            .send()
            .await
            .map_err(|error| ProviderError::transport(error.to_string()))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let status_code = status.as_u16();
        let response_headers = response.headers().clone();
        let body = response.text().await.unwrap_or_default();
        Err(ProviderError::http(
            status_code,
            response_headers,
            format_http_error(status_code, &body),
        ))
    })
    .await
    .map_err(|error| error.message)
}

async fn run_stream_task(
    cfg: ProviderConfig,
    model: Model,
    ctx: TranscriptContext,
    options: SimpleStreamOptions,
    tx: mpsc::Sender<AssistantMessageEvent>,
) {
    let compat = get_compat(&model);
    // Upstream resolves the transcript synchronously before anything else
    // (openai-responses.ts:119), then computes the grammar input properties
    // from the NORMALIZED messages (lines 147-150) — computing them from the
    // raw context would see tools declared in mid-convo system messages that
    // the default collapse drops (an unsupportable grammar there would fail
    // a request upstream never surfaces). Both steps are infallible, so
    // running them up front keeps the upstream error precedence — apiKey
    // line 143 -> grammar line 147 -> params line 159 — in the check order
    // inside the block below (the processor needs the grammar map at
    // construction).
    let normalized = resolve_transcript(ctx, Some(compat.supports_mid_convo_system_messages));
    let grammar_result = create_grammar_tool_input_properties(
        &get_declared_tools(normalized.messages()),
        compat.supports_openai_grammar_tools,
    );
    let processor_options = ResponsesStreamOptions {
        grammar_tool_input_properties: grammar_result.clone().unwrap_or_default(),
        ..Default::default()
    };
    let mut processor = ResponsesStreamProcessor::new(&model, processor_options);
    let outcome = async {
        // Upstream line 143 (apiKey) precedes line 147 (grammar properties).
        let api_key = get_client_api_key(
            &model.provider,
            &cfg.api_key,
            options.stream.headers.as_ref(),
        )?;
        let grammar_tool_input_properties = grammar_result?;
        let assembly = assemble(
            &model,
            &normalized,
            &options,
            &compat,
            &grammar_tool_input_properties,
        )?;

        let response = send_stream_request(&cfg, &api_key, &assembly, &options).await?;

        // Upstream line 178: `start` after the response arrives, before any
        // event.
        let _ = tx
            .send(AssistantMessageEvent::Start {
                message: processor.output().clone(),
            })
            .await;

        let mut events = response.bytes_stream().eventsource();
        while let Some(item) = events.next().await {
            let event = item.map_err(|error| error.to_string())?;
            let payload: Value = serde_json::from_str(&event.data)
                .map_err(|error| format!("Could not parse Responses SSE event: {error}"))?;
            processor
                .process_event(&ResponsesStreamEvent::from_value(payload), &tx)
                .await?;
        }

        // Upstream post-loop guard inside processResponsesStream
        // (lines 758-760).
        processor.finish()?;
        let output = processor.output();
        // Upstream lines 190-195 (the signal-aborted check has no port input).
        if output.stop_reason == StopReason::Pending {
            return Err("OpenAI Responses stream ended without a stop reason".to_string());
        }
        if output.stop_reason == StopReason::Aborted || output.stop_reason == StopReason::Error {
            return Err(output
                .error_message
                .clone()
                .unwrap_or_else(|| "An unknown error occurred".to_string()));
        }
        let reason = match output.stop_reason {
            StopReason::Length => SuccessReason::Length,
            StopReason::ToolUse => SuccessReason::ToolUse,
            _ => SuccessReason::Stop,
        };
        let _ = tx
            .send(AssistantMessageEvent::Done {
                reason,
                message: processor.output().clone(),
            })
            .await;
        Ok(())
    };
    match outcome.await {
        Ok(()) => {}
        Err(message) => {
            // Upstream catch block (lines 199-213): the partial message keeps
            // its content; stopReason settles to "error" (the `signal`
            // aborted branch is unreachable in the port) and the thrown value
            // becomes errorMessage.
            let mut output = processor.into_output();
            output.stop_reason = StopReason::Error;
            output.error_message = Some(message);
            let _ = tx
                .send(AssistantMessageEvent::Error {
                    reason: ErrorReason::Error,
                    error: output,
                })
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::transcript::{normalize_context, Context};
    use crate::ai::types::events::PartialAssistant;
    use crate::ai::types::message::{
        AssistantBlock, AssistantMessage, Message, StringOrBlocks, SystemMessage, UserMessage,
    };
    use crate::ai::types::primitives::{ModelCost, ToolChoice};
    use crate::ai::types::tool::{
        ConstrainedSampling, GrammarSampling, JsonSchemaSampling, Strict, Tool,
    };
    use crate::ai::types::{Model, ModelInput, ThinkingLevel};
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// The API id stamped on every emitted message.
    const API: &str = "openai-responses";

    const TS: i64 = 1758240000000;

    // ---- fixtures ----

    fn model() -> Model {
        Model {
            id: "gpt-5.4".to_string(),
            name: "GPT-5.4".to_string(),
            api: API.to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            reasoning: true,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: ModelCost::default(),
            context_window: 400000,
            max_tokens: 128000,
            sampling_params: None,
            headers: None,
            compat: None,
        }
    }

    fn model_with_map(map: serde_json::Value) -> Model {
        let mut model = model();
        model.thinking_level_map = Some(serde_json::from_value(map).unwrap());
        model
    }

    fn model_with_compat(compat: serde_json::Value) -> Model {
        let mut model = model();
        model.compat = Some(compat);
        model
    }

    fn ctx_with(
        system_prompt: Option<&str>,
        messages: Vec<Message>,
        tools: Option<Vec<Tool>>,
    ) -> TranscriptContext {
        normalize_context(&Context {
            system_prompt: system_prompt.map(str::to_string),
            messages,
            tools,
        })
    }

    fn user_msg(text: &str) -> Message {
        Message::User(UserMessage {
            content: StringOrBlocks::Text(text.to_string()),
            timestamp: TS,
        })
    }

    fn tool(name: &str) -> Tool {
        Tool {
            name: name.into(),
            description: "A tool".into(),
            parameters: json!({"type": "object", "properties": {}}),
            constrained_sampling: None,
        }
    }

    fn strict_schema_tool(name: &str, strict: Strict) -> Tool {
        Tool {
            name: name.into(),
            description: "A constrained tool".into(),
            parameters: json!({"type": "object", "properties": {"value": {"type": "string"}}}),
            constrained_sampling: Some(ConstrainedSampling::JsonSchema(JsonSchemaSampling {
                strict,
            })),
        }
    }

    fn cfg(server: &wiremock::MockServer) -> ProviderConfig {
        ProviderConfig {
            base_url: format!("{}/v1", server.uri()),
            api_key: "test-key".to_string(),
            max_tokens: 8192,
        }
    }

    fn sse(body: &str) -> wiremock::ResponseTemplate {
        wiremock::ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string(body.to_string())
    }

    fn completed_sse() -> String {
        format!(
            "data: {}\n\n",
            json!({
                "type": "response.completed",
                "response": {
                    "id": "resp_ok",
                    "status": "completed",
                    "usage": {
                        "input_tokens": 20,
                        "output_tokens": 7,
                        "total_tokens": 27,
                        "input_tokens_details": {"cached_tokens": 2, "cache_write_tokens": 3},
                    },
                },
            })
        )
    }

    /// First response is an HTTP error, second (and later) responses succeed.
    struct Flaky {
        attempts: AtomicU32,
        error: wiremock::ResponseTemplate,
        success: wiremock::ResponseTemplate,
    }

    impl wiremock::Respond for Flaky {
        fn respond(&self, _request: &wiremock::Request) -> wiremock::ResponseTemplate {
            if self.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                self.error.clone()
            } else {
                self.success.clone()
            }
        }
    }

    async fn mount(server: &wiremock::MockServer, body: &str) {
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/responses"))
            .respond_with(sse(body))
            .mount(server)
            .await;
    }

    async fn collect_simple(
        server: &wiremock::MockServer,
        model: &Model,
        ctx: &TranscriptContext,
        options: &SimpleStreamOptions,
    ) -> Vec<AssistantMessageEvent> {
        let api = OpenAiResponses;
        let mut rx = api.stream_simple(&cfg(server), model, ctx, options);
        let mut out = Vec::new();
        while let Some(event) = rx.recv().await {
            out.push(event);
        }
        out
    }

    async fn collect_stream(
        server: &wiremock::MockServer,
        model: &Model,
        ctx: &TranscriptContext,
        options: &crate::ai::types::options::StreamOptions,
    ) -> Vec<AssistantMessageEvent> {
        let api = OpenAiResponses;
        let mut rx = api.stream(&cfg(server), model, ctx, options);
        let mut out = Vec::new();
        while let Some(event) = rx.recv().await {
            out.push(event);
        }
        out
    }

    /// Runs one stream and returns the captured request body, its headers,
    /// and the event sequence.
    async fn capture_simple(
        server: &wiremock::MockServer,
        model: &Model,
        ctx: &TranscriptContext,
        options: &SimpleStreamOptions,
    ) -> (
        Value,
        reqwest::header::HeaderMap,
        Vec<AssistantMessageEvent>,
    ) {
        let events = collect_simple(server, model, ctx, options).await;
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1, "one request expected");
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        (body, requests[0].headers.clone(), events)
    }

    /// Runs one `stream` (direct options) call and returns the captured
    /// request body, its headers, and the event sequence.
    async fn capture_stream(
        server: &wiremock::MockServer,
        model: &Model,
        ctx: &TranscriptContext,
        options: &crate::ai::types::options::StreamOptions,
    ) -> (
        Value,
        reqwest::header::HeaderMap,
        Vec<AssistantMessageEvent>,
    ) {
        let events = collect_stream(server, model, ctx, options).await;
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1, "one request expected");
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        (body, requests[0].headers.clone(), events)
    }

    fn apply_all(events: &[AssistantMessageEvent]) -> PartialAssistant {
        let mut partial = PartialAssistant::new();
        for event in events {
            partial
                .apply(event)
                .unwrap_or_else(|error| panic!("reducer rejected {}: {error}", event.event_type()));
        }
        partial
    }

    fn event_types(events: &[AssistantMessageEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(AssistantMessageEvent::event_type)
            .collect()
    }

    fn error_of(events: &[AssistantMessageEvent]) -> (ErrorReason, AssistantMessage) {
        match events.last() {
            Some(AssistantMessageEvent::Error { reason, error }) => (*reason, error.clone()),
            other => panic!("expected terminal error, got {other:?}"),
        }
    }

    fn body_of<'a>(header_map: &'a reqwest::header::HeaderMap, name: &str) -> Option<&'a str> {
        header_map.get(name).and_then(|value| value.to_str().ok())
    }

    // ---- 1. default request shape (openai-responses-compat.test.ts) ----

    #[tokio::test]
    async fn default_request_shape_sends_model_input_stream_store() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let (body, headers, events) =
            capture_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;

        assert_eq!(body["model"], json!("gpt-5.4"));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["store"], json!(false));
        // The replayed system prompt rides in `input` as a developer item
        // (reasoning model + default supportsDeveloperRole).
        assert_eq!(
            body["input"][0],
            json!({"role": "developer", "content": "sys"})
        );
        assert_eq!(
            body["input"][1],
            json!({"role": "user", "content": [{"type": "input_text", "text": "hi"}]})
        );
        // No reasoning requested, no map: the upstream default-off branch
        // sends `{"effort": "none"}` (thinkingLevelMap.off ?? "none").
        assert_eq!(body["reasoning"], json!({"effort": "none"}));
        assert!(body.get("include").is_none());
        assert!(body.get("tools").is_none());
        assert!(body.get("prompt_cache_key").is_none());
        assert!(body.get("prompt_cache_retention").is_none());
        assert!(body.get("prompt_cache_options").is_none());
        // The pi User-Agent header.
        assert_eq!(
            body_of(&headers, "user-agent"),
            Some(pi_user_agent().as_str())
        );
        assert_eq!(body_of(&headers, "authorization"), Some("Bearer test-key"));
        // Terminal framing.
        assert_eq!(event_types(&events), ["start", "done"], "{events:?}");
    }

    #[tokio::test]
    async fn sends_none_reasoning_effort_when_no_reasoning_requested() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model_with_map(json!({"off": "none"}));
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let (body, _, _) =
            capture_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;
        assert_eq!(body["reasoning"], json!({"effort": "none"}));
    }

    #[tokio::test]
    async fn omits_reasoning_effort_when_off_is_unsupported() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model_with_map(json!({"off": null}));
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let (body, _, _) =
            capture_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;
        assert!(body.get("reasoning").is_none(), "{body}");
    }

    #[tokio::test]
    async fn omits_reasoning_for_github_copilot_without_reasoning_option() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let mut model = model();
        model.provider = "github-copilot".to_string();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let (body, _, _) =
            capture_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;
        assert!(body.get("reasoning").is_none(), "{body}");
    }

    #[tokio::test]
    async fn maps_requested_effort_through_thinking_level_map() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model_with_map(json!({"minimal": "low"}));
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            reasoning: Some(ThinkingLevel::Minimal),
            ..SimpleStreamOptions::default()
        };
        let (body, _, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(
            body["reasoning"],
            json!({"effort": "low", "summary": "auto"})
        );
        assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
    }

    #[tokio::test]
    async fn unmapped_effort_is_sent_verbatim() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            reasoning: Some(ThinkingLevel::High),
            ..SimpleStreamOptions::default()
        };
        let (body, _, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(
            body["reasoning"],
            json!({"effort": "high", "summary": "auto"})
        );
    }

    #[tokio::test]
    async fn xhigh_and_max_gate_down_to_high_when_unmapped() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model_with_map(json!({"off": "none"}));
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        for level in [ThinkingLevel::Xhigh, ThinkingLevel::Max] {
            let options = SimpleStreamOptions {
                reasoning: Some(level),
                ..SimpleStreamOptions::default()
            };
            let events = collect_simple(&server, &model, &ctx, &options).await;
            assert!(matches!(
                events.last(),
                Some(AssistantMessageEvent::Done { .. })
            ));
        }
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 2);
        for request in &requests {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(
                body["reasoning"],
                json!({"effort": "high", "summary": "auto"}),
                "{body}"
            );
        }
    }

    #[tokio::test]
    async fn null_mapped_effort_clamps_to_the_next_supported_level() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        // JS `thinkingLevelMap[level] ?? level` only matters for direct
        // stream() callers; streamSimple clamps first, so a null-mapped low
        // becomes medium before the map lookup.
        let model = model_with_map(json!({"low": null}));
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            reasoning: Some(ThinkingLevel::Low),
            ..SimpleStreamOptions::default()
        };
        let (body, _, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(
            body["reasoning"],
            json!({"effort": "medium", "summary": "auto"})
        );
    }

    #[test]
    fn effort_falls_back_to_level_when_map_value_is_null() {
        // Upstream line 346-348 for direct stream() callers:
        // `thinkingLevelMap[effort] ?? effort` — a null mapping falls back to
        // the requested level string.
        let model = model_with_map(json!({"low": null}));
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let compat = get_compat(&model);
        let options = SimpleStreamOptions {
            reasoning: Some(ThinkingLevel::Low),
            ..SimpleStreamOptions::default()
        };
        let assembly = build_request(&model, &ctx, &options, &compat).unwrap();
        assert_eq!("low", assembly.body["reasoning"]["effort"]);
        assert_eq!("auto", assembly.body["reasoning"]["summary"]);
    }

    // ---- 2. max_output_tokens compat ----

    #[tokio::test]
    async fn sends_max_output_tokens_by_default() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = crate::ai::types::options::StreamOptions {
            max_tokens: Some(1024),
            ..Default::default()
        };
        let (body, _, _) = capture_stream(&server, &model, &ctx, &options).await;
        assert_eq!(body["max_output_tokens"], json!(1024));
    }

    #[tokio::test]
    async fn clamps_max_output_tokens_to_the_sixteen_minimum() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = crate::ai::types::options::StreamOptions {
            max_tokens: Some(8),
            ..Default::default()
        };
        let (body, _, _) = capture_stream(&server, &model, &ctx, &options).await;
        assert_eq!(body["max_output_tokens"], json!(16));
    }

    #[tokio::test]
    async fn stream_simple_fills_context_clamped_default_max_tokens() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let (body, _, _) =
            capture_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;
        // buildBaseOptions: clamp(maxTokens ?? model.maxTokens) to the context
        // window; 128000 fits comfortably in 400000.
        assert_eq!(body["max_output_tokens"], json!(128000));
    }

    #[tokio::test]
    async fn omits_max_output_tokens_when_supports_max_output_tokens_is_false() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model_with_compat(json!({"supportsMaxOutputTokens": false}));
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let (body, _, _) = capture_simple(
            &server,
            &model,
            &ctx,
            &SimpleStreamOptions {
                stream: crate::ai::types::options::StreamOptions {
                    max_tokens: Some(1024),
                    ..Default::default()
                },
                ..SimpleStreamOptions::default()
            },
        )
        .await;
        assert!(body.get("max_output_tokens").is_none(), "{body}");
    }

    // ---- 3. tools and tool choice ----

    #[tokio::test]
    async fn forwards_tools_and_tool_choice() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(
            None,
            vec![user_msg("Do not call ping.")],
            Some(vec![tool("ping")]),
        );
        let options = SimpleStreamOptions {
            tool_choice: Some(ToolChoice::Auto),
            ..SimpleStreamOptions::default()
        };
        let (body, _, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(body["tool_choice"], json!("auto"));
        assert_eq!(
            body["tools"],
            json!([{
                "type": "function",
                "name": "ping",
                "description": "A tool",
                "parameters": {"type": "object", "properties": {}}
            }])
        );
    }

    #[tokio::test]
    async fn sets_strict_mode_explicitly_when_supported() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model_with_compat(json!({"supportsStrictMode": true}));
        let ctx = ctx_with(
            None,
            vec![user_msg("Use a tool.")],
            Some(vec![
                tool("ordinary"),
                strict_schema_tool("constrained", Strict::Prefer),
            ]),
        );
        let (body, _, _) =
            capture_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;
        assert_eq!(body["tools"][0]["strict"], json!(false));
        assert_eq!(body["tools"][1]["strict"], json!(true));
    }

    #[tokio::test]
    async fn omits_strict_when_unsupported() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(
            None,
            vec![user_msg("Use a tool.")],
            Some(vec![tool("ping")]),
        );
        let (body, _, _) =
            capture_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;
        assert!(body["tools"][0].get("strict").is_none(), "{body}");
    }

    /// The grammar map is computed from the NORMALIZED transcript (upstream
    /// resolves the transcript at openai-responses.ts:119 before the grammar
    /// properties at 147-150). The default collapse rebuilds the leading
    /// system message from the NET tool set (`getCurrentTools`), while
    /// `getDeclaredTools` over the raw transcript collects every
    /// `toolsAdded` and ignores `toolsRemoved` — so a grammar tool declared
    /// mid-conversation and later removed must never reach grammar
    /// resolution: an unsupportable grammar on a removed tool must not fail
    /// the request.
    #[tokio::test]
    async fn removed_grammar_tool_in_mid_convo_system_message_does_not_error() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model_with_compat(json!({"supportsOpenAIGrammarTools": true}));
        let broken_grammar_tool = Tool {
            name: "broken-grammar".into(),
            description: "Grammar tool without a usable variant".into(),
            parameters: json!({"type": "object", "properties": {}}),
            constrained_sampling: Some(ConstrainedSampling::Grammar(GrammarSampling {
                variants: BTreeMap::new(),
            })),
        };
        let ctx = normalize_context(&Context {
            system_prompt: None,
            messages: vec![
                user_msg("hello"),
                Message::System(SystemMessage {
                    content: StringOrBlocks::Text("tool available".into()),
                    sections: None,
                    tools_added: Some(vec![broken_grammar_tool]),
                    tools_removed: None,
                    timestamp: TS,
                }),
                user_msg("again"),
                Message::System(SystemMessage {
                    content: StringOrBlocks::Text("tool removed".into()),
                    sections: None,
                    tools_added: None,
                    tools_removed: Some(vec![crate::ai::types::tool::ToolReference {
                        name: "broken-grammar".into(),
                    }]),
                    timestamp: TS,
                }),
                user_msg("go"),
            ],
            tools: None,
        });
        let events = collect_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;
        assert_eq!(event_types(&events), ["start", "done"], "{events:?}");
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        // The removed tool is not sent and left no grammar state behind.
        assert!(body.get("tools").is_none(), "{body}");
    }

    #[tokio::test]
    async fn forwards_temperature() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                temperature: Some(0.5),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let (body, _, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(body["temperature"], json!(0.5));
    }

    // ---- 4. session affinity + prompt cache (compat oracle) ----

    #[tokio::test]
    async fn sets_cache_affinity_headers_for_openai_with_session_id() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                session_id: Some("session-123".to_string()),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let (body, headers, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(body_of(&headers, "session_id"), Some("session-123"));
        assert_eq!(
            body_of(&headers, "x-client-request-id"),
            Some("session-123")
        );
        assert_eq!(body["prompt_cache_key"], json!("session-123"));
    }

    #[tokio::test]
    async fn clamps_prompt_cache_key_to_64_characters() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                session_id: Some("x".repeat(67)),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let (body, _, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(body["prompt_cache_key"], json!("x".repeat(64)));
    }

    #[tokio::test]
    async fn uses_openrouter_session_affinity_header_when_configured() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model_with_compat(json!({"sessionAffinityFormat": "openrouter"}));
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                session_id: Some("session-proxy".to_string()),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let (body, headers, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(body_of(&headers, "session_id"), None);
        assert_eq!(body_of(&headers, "x-client-request-id"), None);
        assert_eq!(body_of(&headers, "x-session-id"), Some("session-proxy"));
        assert_eq!(body["prompt_cache_key"], json!("session-proxy"));
    }

    #[tokio::test]
    async fn auto_detects_openrouter_session_affinity_by_base_url() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let mut model = model();
        model.provider = "openrouter".to_string();
        model.base_url = server.uri();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                session_id: Some("session-openrouter".to_string()),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let (_, headers, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(
            body_of(&headers, "x-session-id"),
            Some("session-openrouter")
        );
        assert_eq!(body_of(&headers, "session_id"), None);
        assert_eq!(body_of(&headers, "x-client-request-id"), None);
    }

    #[tokio::test]
    async fn uses_openai_nosession_format_when_configured() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model_with_compat(json!({"sessionAffinityFormat": "openai-nosession"}));
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                session_id: Some("session-proxy".to_string()),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let (body, headers, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(body_of(&headers, "session_id"), None);
        assert_eq!(
            body_of(&headers, "x-client-request-id"),
            Some("session-proxy")
        );
        assert_eq!(body_of(&headers, "x-session-id"), None);
        assert_eq!(body["prompt_cache_key"], json!("session-proxy"));
    }

    #[tokio::test]
    async fn lets_explicit_headers_override_affinity_headers() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let mut option_headers = crate::ai::types::options::ProviderHeaders::new();
        option_headers.insert(
            "session_id".to_string(),
            Some("override-session".to_string()),
        );
        option_headers.insert(
            "x-client-request-id".to_string(),
            Some("override-request".to_string()),
        );
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                session_id: Some("session-123".to_string()),
                headers: Some(option_headers),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let (_, headers, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(body_of(&headers, "session_id"), Some("override-session"));
        assert_eq!(
            body_of(&headers, "x-client-request-id"),
            Some("override-request")
        );
    }

    #[tokio::test]
    async fn omits_affinity_headers_and_cache_key_when_retention_is_none() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                session_id: Some("session-123".to_string()),
                cache_retention: Some(CacheRetention::None),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let (body, headers, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(body_of(&headers, "session_id"), None);
        assert_eq!(body_of(&headers, "x-client-request-id"), None);
        assert!(body.get("prompt_cache_key").is_none(), "{body}");
    }

    #[tokio::test]
    async fn long_retention_sends_24h_prompt_cache_retention() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                session_id: Some("session-123".to_string()),
                cache_retention: Some(CacheRetention::Long),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let (body, _, _) = capture_simple(&server, &model, &ctx, &options).await;
        assert_eq!(body["prompt_cache_retention"], json!("24h"));
        assert!(body.get("prompt_cache_options").is_none());
    }

    #[tokio::test]
    async fn explicit_prompt_cache_mode_sends_mode_or_ttl() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model_with_compat(json!({"supportsExplicitPromptCacheMode": true}));
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);

        // retention none -> {mode: "explicit"}, no prompt_cache_key.
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                session_id: Some("session-123".to_string()),
                cache_retention: Some(CacheRetention::None),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let events = collect_simple(&server, &model, &ctx, &options).await;
        assert!(matches!(
            events.last(),
            Some(AssistantMessageEvent::Done { .. })
        ));

        // retention long -> {ttl: "30m"}, no prompt_cache_retention field.
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                session_id: Some("session-123".to_string()),
                cache_retention: Some(CacheRetention::Long),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let events = collect_simple(&server, &model, &ctx, &options).await;
        assert!(matches!(
            events.last(),
            Some(AssistantMessageEvent::Done { .. })
        ));

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 2);
        let none_body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(
            none_body["prompt_cache_options"],
            json!({"mode": "explicit"})
        );
        assert!(none_body.get("prompt_cache_retention").is_none());
        assert!(none_body.get("prompt_cache_key").is_none());
        let long_body: Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(long_body["prompt_cache_options"], json!({"ttl": "30m"}));
        assert!(long_body.get("prompt_cache_retention").is_none());
        assert_eq!(long_body["prompt_cache_key"], json!("session-123"));
    }

    // ---- 5. setup errors ----

    #[tokio::test]
    async fn missing_api_key_is_a_lone_error_event() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let mut model = model();
        model.provider = "some-proxy".to_string();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions::default();
        let api = OpenAiResponses;
        let mut request_cfg = cfg(&server);
        request_cfg.api_key = String::new();
        let mut rx = api.stream_simple(&request_cfg, &model, &ctx, &options);
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        let (reason, error) = error_of(&events);
        assert_eq!(reason, ErrorReason::Error);
        assert_eq!(
            error.error_message.as_deref(),
            Some("No API key for provider: some-proxy")
        );
        assert_eq!(events.len(), 1);
        assert_eq!(error.api, API);
        let partial = apply_all(&events);
        assert!(partial.message().is_some());
        assert!(partial.is_terminal());
    }

    #[tokio::test]
    async fn header_owned_authorization_uses_unused_key() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let mut model = model();
        model.provider = "some-gateway".to_string();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let mut option_headers = crate::ai::types::options::ProviderHeaders::new();
        option_headers.insert(
            "authorization".to_string(),
            Some("Bearer token-from-header".to_string()),
        );
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                headers: Some(option_headers),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let api = OpenAiResponses;
        let mut request_cfg = cfg(&server);
        request_cfg.api_key = String::new();
        let mut rx = api.stream_simple(&request_cfg, &model, &ctx, &options);
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        // No error: the gateway header carries the auth.
        assert!(
            matches!(events.last(), Some(AssistantMessageEvent::Done { .. })),
            "{events:?}"
        );
        let requests = server.received_requests().await.unwrap();
        let headers = &requests[0].headers;
        assert_eq!(
            body_of(headers, "authorization"),
            Some("Bearer token-from-header")
        );
    }

    // ---- 6. terminal events over the wire (terminal-event oracle) ----

    fn early_eof_sse() -> String {
        [
            json!({
                "type": "response.created",
                "response": {"id": "resp_early_eof"},
            }),
            json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {"type": "reasoning", "id": "rs_early_eof", "summary": []},
            }),
            json!({
                "type": "response.reasoning_text.delta",
                "output_index": 0,
                "item_id": "rs_early_eof",
                "delta": "partial reasoning before the stream ends",
            }),
        ]
        .map(|value| format!("data: {value}\n\n"))
        .concat()
    }

    #[tokio::test]
    async fn stream_ending_before_terminal_event_errors() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &early_eof_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let events = collect_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;

        assert_eq!(
            event_types(&events),
            ["start", "thinking_start", "thinking_delta", "error"]
        );
        let (reason, error) = error_of(&events);
        assert_eq!(reason, ErrorReason::Error);
        assert_eq!(
            error.error_message.as_deref(),
            Some("OpenAI Responses stream ended before a terminal response event")
        );
        assert_eq!(error.stop_reason, StopReason::Error);
        // Events stay PartialAssistant-consumable and terminal; the reducer
        // keeps the streamed thinking content and settles the error.
        let partial = apply_all(&events);
        assert!(partial.is_terminal());
        assert_eq!(
            partial.message().map(|message| message.content.clone()),
            Some(error.content.clone())
        );
    }

    #[tokio::test]
    async fn completed_terminal_finalizes_stop_with_usage() {
        let server = wiremock::MockServer::start().await;
        mount(&server, &completed_sse()).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let events = collect_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;

        assert_eq!(event_types(&events), ["start", "done"]);
        match &events[1] {
            AssistantMessageEvent::Done { reason, message } => {
                assert_eq!(*reason, SuccessReason::Stop);
                assert_eq!(message.response_id.as_deref(), Some("resp_ok"));
                assert_eq!(message.raw_stop_reason.as_deref(), Some("completed"));
                assert_eq!(message.stop_reason, StopReason::Stop);
                assert_eq!(message.usage.input, 15);
                assert_eq!(message.usage.output, 7);
                assert_eq!(message.usage.cache_read, 2);
                assert_eq!(message.usage.cache_write, 3);
                assert_eq!(message.usage.total_tokens, 27);
            }
            other => panic!("expected done, got {other:?}"),
        }
        let partial = apply_all(&events);
        assert!(partial.is_terminal());
    }

    #[tokio::test]
    async fn incomplete_max_output_tokens_is_a_length_stop() {
        let server = wiremock::MockServer::start().await;
        let body = format!(
            "data: {}\n\n",
            json!({
                "type": "response.incomplete",
                "response": {
                    "id": "resp_incomplete",
                    "status": "incomplete",
                    "incomplete_details": {"reason": "max_output_tokens"},
                    "usage": {
                        "input_tokens": 30,
                        "output_tokens": 12,
                        "total_tokens": 42,
                        "input_tokens_details": {"cached_tokens": 5},
                    },
                },
            })
        );
        mount(&server, &body).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let events = collect_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;

        match &events[1] {
            AssistantMessageEvent::Done { reason, message } => {
                assert_eq!(*reason, SuccessReason::Length);
                assert_eq!(message.response_id.as_deref(), Some("resp_incomplete"));
                assert_eq!(
                    message.raw_stop_reason.as_deref(),
                    Some("incomplete.max_output_tokens")
                );
                assert_eq!(message.stop_reason, StopReason::Length);
                assert_eq!(message.usage.input, 25);
                assert_eq!(message.usage.cache_read, 5);
                assert_eq!(message.usage.total_tokens, 42);
            }
            other => panic!("expected done, got {other:?}"),
        }
        assert!(apply_all(&events).is_terminal());
    }

    #[tokio::test]
    async fn content_filtered_incomplete_is_a_non_retryable_error() {
        let server = wiremock::MockServer::start().await;
        let body = format!(
            "data: {}\n\n",
            json!({
                "type": "response.incomplete",
                "response": {
                    "id": "resp_filter",
                    "status": "incomplete",
                    "incomplete_details": {"reason": "content_filter"},
                },
            })
        );
        mount(&server, &body).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let events = collect_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;

        let (reason, error) = error_of(&events);
        assert_eq!(reason, ErrorReason::Error);
        assert_eq!(
            error.error_message.as_deref(),
            Some("Response incomplete: content_filter")
        );
        assert_eq!(
            error.raw_stop_reason.as_deref(),
            Some("incomplete.content_filter")
        );
        assert!(apply_all(&events).is_terminal());
    }

    #[tokio::test]
    async fn failed_terminal_event_errors_with_provider_details() {
        let server = wiremock::MockServer::start().await;
        let body = format!(
            "data: {}\n\n",
            json!({
                "type": "response.failed",
                "response": {
                    "id": "resp_failed",
                    "status": "failed",
                    "error": {"code": "server_error", "message": "boom"},
                },
            })
        );
        mount(&server, &body).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let events = collect_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;

        let (reason, error) = error_of(&events);
        assert_eq!(reason, ErrorReason::Error);
        assert_eq!(error.error_message.as_deref(), Some("server_error: boom"));
        assert_eq!(error.raw_stop_reason.as_deref(), Some("failed"));
        assert!(apply_all(&events).is_terminal());
    }

    #[tokio::test]
    async fn top_level_error_event_errors_with_code_and_message() {
        let server = wiremock::MockServer::start().await;
        let body = format!(
            "data: {}\n\n",
            json!({"type": "error", "code": "server_error", "message": "boom"})
        );
        mount(&server, &body).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let events = collect_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;

        let (reason, error) = error_of(&events);
        assert_eq!(reason, ErrorReason::Error);
        assert_eq!(
            error.error_message.as_deref(),
            Some("Error Code server_error: boom")
        );
        assert!(apply_all(&events).is_terminal());
    }

    #[tokio::test]
    async fn phased_final_answer_message_stops() {
        let server = wiremock::MockServer::start().await;
        let body = [
            json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {"type": "message", "id": "msg_phase", "role": "assistant", "status": "in_progress", "content": [], "phase": "commentary"},
            }),
            json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {"type": "message", "id": "msg_phase", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "answer", "annotations": []}], "phase": "final_answer"},
            }),
            json!({"type": "response.completed", "response": {"id": "resp_phase", "status": "completed"}}),
        ]
        .map(|value| format!("data: {value}\n\n"))
        .concat();
        mount(&server, &body).await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let events = collect_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;

        assert_eq!(
            event_types(&events),
            ["start", "text_start", "text_end", "done"]
        );
        match &events[3] {
            AssistantMessageEvent::Done { reason, message } => {
                assert_eq!(*reason, SuccessReason::Stop);
                assert_eq!(message.content.len(), 1);
                match &message.content[0] {
                    AssistantBlock::Text(text) => {
                        assert_eq!(text.text, "answer");
                        // The processor persists the message id + phase as the
                        // text signature for cross-model replay.
                        assert!(text.text_signature.is_some());
                    }
                    other => panic!("expected text block, got {other:?}"),
                }
                assert_eq!(message.stop_reason, StopReason::Stop);
            }
            other => panic!("expected done, got {other:?}"),
        }
        assert!(apply_all(&events).is_terminal());
    }

    // ---- 7. retry over the wire ----

    #[tokio::test]
    async fn retries_a_429_before_the_first_stream_byte() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/responses"))
            .respond_with(Flaky {
                attempts: AtomicU32::new(0),
                error: wiremock::ResponseTemplate::new(429)
                    .insert_header("retry-after-ms", "15")
                    .set_body_string("rate limited"),
                success: sse(&completed_sse()),
            })
            .mount(&server)
            .await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                max_retries: Some(1),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let events = collect_simple(&server, &model, &ctx, &options).await;
        assert_eq!(event_types(&events), ["start", "done"]);
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn non_retryable_status_fails_fast_without_retry() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/responses"))
            .respond_with(wiremock::ResponseTemplate::new(401).set_body_string("bad key"))
            .mount(&server)
            .await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let options = SimpleStreamOptions {
            stream: crate::ai::types::options::StreamOptions {
                max_retries: Some(3),
                ..Default::default()
            },
            ..SimpleStreamOptions::default()
        };
        let events = collect_simple(&server, &model, &ctx, &options).await;
        let (reason, error) = error_of(&events);
        assert_eq!(reason, ErrorReason::Error);
        assert!(error
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("401"));
        assert_eq!(events.len(), 1, "lone error event before start: {events:?}");
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn retry_disabled_by_default() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/responses"))
            .respond_with(wiremock::ResponseTemplate::new(429).set_body_string("no"))
            .mount(&server)
            .await;
        let model = model();
        let ctx = ctx_with(Some("sys"), vec![user_msg("hi")], None);
        let events = collect_simple(&server, &model, &ctx, &SimpleStreamOptions::default()).await;
        assert!(matches!(
            events.last(),
            Some(AssistantMessageEvent::Error { .. })
        ));
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }
}
