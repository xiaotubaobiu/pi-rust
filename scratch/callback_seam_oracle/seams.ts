// Byte oracle for the M2 callback seams: the exact upstream statements from
// packages/ai/src/api/{azure-openai-responses,bedrock-converse-stream,
// google-generative-ai,mistral-conversations,openai-codex-responses}.ts are
// copied verbatim into these stubs and run under
// `node --experimental-strip-types`. Captured outcomes pin the observable
// seam behavior the Rust ports must reproduce:
//   - the `!== undefined` payload-replacement rule (all six adapters),
//   - onResponse timing (only-after-success for azure/bedrock,
//     before-ok-check for mistral/codex, absent for google),
//   - hook-rejection routing (pre-send error vs pre-start error, retry
//     composition for codex).
// Type annotations are structural stubs; the runtime statements are the
// upstream text.

type Hook = (payload: unknown, model: unknown) => Promise<unknown>;

interface Trace {
  events: string[];
  seen: unknown[];
  metadata: Array<{ status: number; headers: Record<string, string> }>;
  requests: Array<{ url: string; status: number; body: unknown }>;
  outcome: "done" | "error";
  errorMessage?: string;
}

function model() {
  return { id: "test-model", provider: "p1" };
}

// ---------------------------------------------------------------------------
// The payload seam, copied verbatim from each adapter (the statement text is
// identical in all six; only the variable name differs):
//   azure-openai-responses.ts:113-116, bedrock-converse-stream.ts:280-283,
//   google-generative-ai.ts:96-99, google-vertex.ts:105-108,
//   mistral-conversations.ts:147-150, openai-codex-responses.ts:278-281
// ---------------------------------------------------------------------------
async function payloadSeam(hook: Hook | undefined, built: unknown): Promise<{ params: unknown; seen: unknown[] }> {
  let params = built;
  const seen: unknown[] = [];
  const wrapped: Hook | undefined = hook
    ? async (payload, mdl) => {
        seen.push(payload);
        return hook(payload, mdl);
      }
    : undefined;
  const options = { onPayload: wrapped };
  const nextParams = await options?.onPayload?.(params, model());
  if (nextParams !== undefined) {
    params = nextParams;
  }
  return { params, seen };
}

// ---------------------------------------------------------------------------
// azure-openai-responses.ts:122-131 + 148-159 (retry seam collapsed to one
// send; `retryProviderRequest` rejects on non-success, skipping onResponse).
// ---------------------------------------------------------------------------
async function azureLifecycle(hooks: { onPayload?: Hook; onResponse?: Hook }, send: () => Promise<{ status: number }>): Promise<Trace> {
  const trace: Trace = { events: [], seen: [], metadata: [], requests: [], outcome: "done" };
  let started = false;
  try {
    let params: unknown = { built: true };
    const nextParams = await hooks.onPayload?.(params, model());
    if (nextParams !== undefined) {
      params = nextParams;
    }
    trace.seen.push(params);
    const response = await send();
    trace.requests.push({ url: "/responses", status: response.status, body: null });
    await hooks.onResponse?.({ status: response.status, headers: { "x-a": "b" } }, model());
    trace.metadata.push({ status: response.status, headers: { "x-a": "b" } });
    trace.events.push("start");
    started = true;
    trace.outcome = "done";
  } catch (error) {
    if (started) trace.events.push("start");
    trace.outcome = "error";
    trace.errorMessage = error instanceof Error ? error.message : String(error);
  }
  return trace;
}

// ---------------------------------------------------------------------------
// bedrock-converse-stream.ts:251-255, 280-294, 510-526 (the deserialize-step
// middleware fires with the raw Smithy response before the stream is read;
// the $metadata fallback only runs when the middleware did not observe).
// ---------------------------------------------------------------------------
async function bedrockLifecycle(hooks: { onPayload?: Hook; onResponse?: Hook }, send: () => Promise<{ status: number }>): Promise<Trace> {
  const trace: Trace = { events: [], seen: [], metadata: [], requests: [], outcome: "done" };
  let observedRawResponse = false;
  try {
    let commandInput: unknown = { built: true };
    const nextCommandInput = await hooks.onPayload?.(commandInput, model());
    if (nextCommandInput !== undefined) {
      commandInput = nextCommandInput;
    }
    trace.seen.push(commandInput);
    const rawResponse = await send();
    trace.requests.push({ url: "/model/.../converse-stream", status: rawResponse.status, body: null });
    if (hooks.onResponse) {
      // addResponseHeadersMiddleware: fires at the deserialize step, before
      // the event stream is consumed.
      observedRawResponse = true;
      await hooks.onResponse({ status: rawResponse.status, headers: { "x-amzn-requestid": "req-1" } }, model());
      trace.metadata.push({ status: rawResponse.status, headers: { "x-amzn-requestid": "req-1" } });
    }
    if (!observedRawResponse && rawResponse.status !== undefined) {
      // lines 288-294: synthesized-metadata fallback (unreachable with the
      // real SDK while the middleware is installed).
      if (hooks.onResponse) {
        const responseHeaders: Record<string, string> = { "x-amzn-requestid": "req-1" };
        await hooks.onResponse({ status: rawResponse.status, headers: responseHeaders }, model());
        trace.metadata.push({ status: rawResponse.status, headers: responseHeaders });
      }
    }
    trace.events.push("start");
    trace.outcome = "done";
  } catch (error) {
    trace.outcome = "error";
    trace.errorMessage = error instanceof Error ? error.message : String(error);
  }
  return trace;
}

// ---------------------------------------------------------------------------
// mistral-conversations.ts:292-322 (`requestMistralStream` with an injected
// fetch): onResponse fires after the fetch resolves and BEFORE the ok check,
// so the hook observes non-success responses too.
// ---------------------------------------------------------------------------
async function mistralRequestStream(
  trace: Trace,
  fetchImpl: (url: string, init: { status: number }) => Promise<{ status: number; ok: boolean }>,
  hooks: { onResponse?: Hook },
): Promise<void> {
  const response = await fetchImpl("https://example.test/v1/chat/completions", { status: 200 });
  trace.requests.push({ url: "/v1/chat/completions", status: response.status, body: null });
  await hooks.onResponse?.({ status: response.status, headers: {} }, model());
  trace.metadata.push({ status: response.status, headers: {} });
  if (!response.ok) {
    throw new Error("MistralHttpError");
  }
}

// ---------------------------------------------------------------------------
// openai-codex-responses.ts:278-281 (payload seam feeds BOTH transports) and
// 390-465 (the SSE retry loop: onResponse per attempt before the ok check; a
// hook rejection rides the attempt catch and retries like any other error).
// ---------------------------------------------------------------------------
async function codexSseLoop(
  hooks: { onPayload?: Hook; onResponse?: Hook },
  fetchImpl: (init: { body: unknown }) => Promise<{ status: number; ok: boolean }>,
  maxRetries: number,
): Promise<Trace> {
  const trace: Trace = { events: [], seen: [], metadata: [], requests: [], outcome: "done" };
  try {
    let body: unknown = { built: true };
    const nextBody = await hooks.onPayload?.(body, model());
    if (nextBody !== undefined) {
      body = nextBody;
    }
    trace.seen.push(body);
    let response: { status: number; ok: boolean } | undefined;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        response = await fetchImpl({ body });
        trace.requests.push({ url: "/responses", status: response.status, body: null });
        await hooks.onResponse?.({ status: response.status, headers: {} }, model());
        trace.metadata.push({ status: response.status, headers: {} });
        if (response.ok) {
          break;
        }
        if (attempt < maxRetries && response.status === 429) {
          lastError = new Error("rate limited");
          continue;
        }
        throw new Error("request failed");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries && !lastError.message.includes("usage limit")) {
          continue;
        }
        throw lastError;
      }
    }
    if (!response?.ok) {
      throw lastError ?? new Error("Failed after retries");
    }
    trace.events.push("start");
    trace.outcome = "done";
  } catch (error) {
    trace.outcome = "error";
    trace.errorMessage = error instanceof Error ? error.message : String(error);
  }
  return trace;
}

const cases: Array<Record<string, unknown>> = [];

// 1. Replacement rule: hook absent keeps; undefined keeps; null replaces;
//    value replaces; rejection throws before the request.
for (const [name, hook, built] of [
  ["absent", undefined, { built: true }],
  ["undefined-return", async () => undefined, { built: true }],
  ["null-replaces", async () => null, { built: true }],
  ["value-replaces", async () => ({ hooked: true }), { built: true }],
] as Array<[string, Hook | undefined, unknown]>) {
  const result = await payloadSeam(hook, built);
  cases.push({ name: `payload-${name}`, params: result.params, hookSaw: result.seen });
}
try {
  await payloadSeam(async () => {
    throw new Error("payload refused");
  }, { built: true });
  cases.push({ name: "payload-rejection", threw: false });
} catch (error) {
  cases.push({ name: "payload-rejection", threw: true, message: error instanceof Error ? error.message : String(error) });
}

// 2. Azure: onResponse only after a successful send; hook failure is a
//    pre-start error; payload replacement reaches the send.
const okSend = async () => ({ status: 200 });
const failingSend = async () => {
  throw new Error("boom");
};
cases.push({
  name: "azure-success",
  ...(await azureLifecycle(
    {
      onPayload: async (payload) => ({ ...(payload as object), hooked: true }),
      onResponse: async () => {},
    },
    okSend,
  )),
});
cases.push({
  name: "azure-http-failure-skips-onresponse",
  ...(await azureLifecycle({ onResponse: async () => {} }, failingSend)),
});
cases.push({
  name: "azure-response-hook-failure",
  ...(await azureLifecycle({ onResponse: async () => { throw new Error("response refused"); } }, okSend)),
});

// 3. Bedrock: middleware observation suppresses the fallback; hook failure is
//    an error before the stream is consumed.
cases.push({
  name: "bedrock-success",
  ...(await bedrockLifecycle(
    {
      onResponse: async () => {},
      onPayload: async (payload) => ({ ...(payload as object), hooked: true }),
    },
    okSend,
  )),
});
cases.push({
  name: "bedrock-no-onresponse-no-fallback-callback",
  ...(await bedrockLifecycle({}, okSend)),
});
cases.push({
  name: "bedrock-response-hook-failure",
  ...(await bedrockLifecycle({ onResponse: async () => { throw new Error("response refused"); } }, okSend)),
});

// 4. Mistral: onResponse fires before the ok check (non-success observed),
//    then the HTTP error throws.
{
  const trace: Trace = { events: [], seen: [], metadata: [], requests: [], outcome: "done" };
  try {
    await mistralRequestStream(trace, async () => ({ status: 429, ok: false }), {
      onResponse: async () => {},
    });
  } catch (error) {
    trace.outcome = "error";
    trace.errorMessage = error instanceof Error ? error.message : String(error);
  }
  cases.push({ name: "mistral-onresponse-precedes-ok-check", ...trace });
}

// 5. Codex: onResponse per attempt (before the ok check), payload feeds the
//    SSE body, hook rejection retries then throws.
cases.push({
  name: "codex-retry-fires-onresponse-per-attempt",
  ...(await codexSseLoop(
    {
      onPayload: async (payload) => ({ ...(payload as object), hooked: true }),
      onResponse: async () => {},
    },
    async () => ({ status: 429, ok: false }),
    1,
  )),
});
cases.push({
  name: "codex-response-hook-failure-retries-then-throws",
  ...(await codexSseLoop(
    { onResponse: async () => { throw new Error("response refused"); } },
    async () => ({ status: 200, ok: true }),
    1,
  )),
});
cases.push({
  name: "codex-success",
  ...(await codexSseLoop(
    { onPayload: async (payload) => ({ ...(payload as object), hooked: true }), onResponse: async () => {} },
    async () => ({ status: 200, ok: true }),
    0,
  )),
});

console.log(JSON.stringify(cases, null, 2));
