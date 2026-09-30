// Offline oracle: execute the actual pinned upstream stream/streamSimple + retry +
// error-body composition and the pinned OpenAI SDK Responses.create/APIPromise/parse
// chain. Only dependency seams below are fake; no rewritten lifecycle business
// algorithm. Mirrors the sealed Anthropic callbacks oracle pattern
// (docs/migration/reference/anthropic-callbacks/oracle.mjs).
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const upstream = resolve(root, '../pi');
const sources = {};
function source(path, key) {
  const data = readFileSync(path);
  sources[key] = createHash('sha256').update(data).digest('hex');
  return data.toString('utf8');
}
function execute(ts, deps, exports) {
  const body = stripTypeScriptTypes(ts, {mode:'strip'})
    .replace(/^import[\s\S]*?;\s*/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const))/g, '');
  return new Function(...Object.keys(deps), body + `\nreturn {${exports.join(',')}};`)(...Object.values(deps));
}

// ---- vendored pinned OpenAI SDK 6.40.0 sources, hash-checked against provenance ----
const sdkResponses = source(resolve(here,'responses.ts'), 'sdk-6.40.0/src/resources/responses/responses.ts');
const sdkApiPromise = source(resolve(here,'api-promise.ts'), 'sdk-6.40.0/src/core/api-promise.ts');
const sdkParse = source(resolve(here,'parse.ts'), 'sdk-6.40.0/src/internal/parse.ts');
const provenance = JSON.parse(readFileSync(resolve(here,'provenance.json')));
assert.equal(sources['sdk-6.40.0/src/resources/responses/responses.ts'], provenance.sha256['package/src/resources/responses/responses.ts']);
assert.equal(sources['sdk-6.40.0/src/core/api-promise.ts'], provenance.sha256['package/src/core/api-promise.ts']);
assert.equal(sources['sdk-6.40.0/src/internal/parse.ts'], provenance.sha256['package/src/internal/parse.ts']);

// ---- per-case state the seam fakes read (the deps below are bound once) ----
let state = null;
const oracleClient = { post: fakePost };

// ---- real parse.ts; the SSE stream construction (core/streaming) is the seam ----
const {defaultParseResponse, addRequestID} = execute(sdkParse, {
  Stream: { fromSSEResponse: (_response, controller) => (async function* () {
    // Canned SSE seam: abort is observed where the real Stream reads the body.
    if (controller?.signal?.aborted) throw Error('Request was aborted');
    if (state.input.sseError) {
      yield {type:'error', code:'server_error', message:'stream refused'};
      return;
    }
    yield {type:'response.completed', response:{status:'completed'}};
  })() },
  loggerFor: () => ({debug(){}, info(){}, warn(){}, error(){}}),
  formatRequestDetails: (details) => details,
}, ['defaultParseResponse','addRequestID']);

// ---- real APIPromise: _thenUnwrap + withResponse + real defaultParseResponse ----
// Strip-only mode cannot desugar TS constructor parameter properties, so the
// constructor is rewritten to explicit assignments (same statements the TS
// compiler emits: super() first, then the field bindings).
const ctorStart = sdkApiPromise.indexOf('  constructor(');
const ctorBodyStart = sdkApiPromise.indexOf('\n  ) {', ctorStart);
const ctorEnd = sdkApiPromise.indexOf('\n  }', ctorBodyStart);
assert.ok(ctorStart > 0 && ctorBodyStart > ctorStart && ctorEnd > ctorBodyStart);
const apiPromiseJs = sdkApiPromise.slice(0, ctorStart)
  + '  constructor(client, responsePromise, parseResponse = defaultParseResponse) {\n'
  + '    super((resolve) => { resolve(null); });\n'
  + '    this.#client = client;\n'
  + '    this.responsePromise = responsePromise;\n'
  + '    this.parseResponse = parseResponse;\n'
  + '  }'
  + sdkApiPromise.slice(ctorEnd + '\n  }'.length);
const {APIPromise} = execute(apiPromiseJs, {defaultParseResponse, addRequestID}, ['APIPromise']);

// ---- the real Responses.create method (body.stream ?? false preflight, real
// _thenUnwrap object check). addOutputText (lib/ResponsesParser) is not vendored;
// it only mutates the parsed non-stream document, which the lifecycle never
// iterates successfully, so a no-op stub cannot change any recorded outcome. ----
const createBegin = sdkResponses.indexOf('  create(\n    body: ResponseCreateParams,');
const createAnchor = "    }) as APIPromise<Response> | APIPromise<Stream<ResponseStreamEvent>>;";
const createAnchorAt = sdkResponses.indexOf(createAnchor, createBegin);
const closingBrace = sdkResponses.indexOf('\n  }', createAnchorAt);
assert.ok(createBegin > 0 && createAnchorAt > createBegin && closingBrace > createAnchorAt);
const createSlice = `class Responses {\n  constructor(client) { this._client = client; }\n${sdkResponses.slice(createBegin, closingBrace + 4)}\n}`;
const {Responses} = execute(createSlice, {addOutputText: () => {}, APIPromise}, ['Responses']);

// ---- actual upstream utils ----
const retrySource = source(resolve(upstream,'packages/ai/src/utils/provider-retry.ts'), 'packages/ai/src/utils/provider-retry.ts');
const {retryProviderRequest} = execute(retrySource, {}, ['retryProviderRequest']);
const errorBodySource = source(resolve(upstream,'packages/ai/src/utils/error-body.ts'), 'packages/ai/src/utils/error-body.ts');
const {formatProviderError, normalizeProviderError} = execute(errorBodySource, {}, ['formatProviderError','normalizeProviderError']);
const simpleOptionsSource = source(resolve(upstream,'packages/ai/src/api/simple-options.ts'), 'packages/ai/src/api/simple-options.ts');
const {buildBaseOptions} = execute(simpleOptionsSource, {estimateContextTokens: () => ({tokens: 0})}, ['buildBaseOptions']);

// ---- actual upstream stream + streamSimple (helpers included) ----
const streamSource = source(resolve(upstream,'packages/ai/src/api/openai-responses.ts'), 'packages/ai/src/api/openai-responses.ts');
const sliceBegin = streamSource.indexOf('function hasHeader(');
const sliceEnd = streamSource.indexOf('\nfunction createClient(', sliceBegin);
assert.ok(sliceBegin > 0 && sliceEnd > sliceBegin);
class Events {
  events = [];
  constructor() { state.streamInstance = this; }
  push(event) { this.events.push(structuredClone(event)); state.trace.push(event.type); }
  end() { state.complete(); }
}
const lifecycle = execute(streamSource.slice(sliceBegin, sliceEnd), {
  AssistantMessageEventStream: Events,
  resolveTranscript: (context) => context,
  getDeclaredTools: () => [],
  createGrammarToolInputProperties: () => new Map(),
  getProviderEnvValue: () => undefined,
  // Params seam: reproduces the upstream projections the fixture body depends on
  // (model/input/stream/store plus the maxTokens floor, openai-responses.ts:309-323);
  // the full builder is validated by the port's own request-shape tests.
  buildParams: (model, _context, options) => ({
    model: model.id,
    input: [],
    stream: true,
    store: false,
    ...(options?.maxTokens ? {max_output_tokens: Math.max(options.maxTokens, 16)} : {}),
  }),
  createClient: () => ({responses: {create: (body, options) => new Responses(oracleClient).create(body, options)}}),
  retryProviderRequest,
  formatProviderError,
  normalizeProviderError,
  headersToRecord: (headers) => Object.fromEntries(headers.entries()),
  // Controlled seam: reproduces only the real shared function's iteration contract,
  // error-event throw, terminal guard and settlement (openai-responses-shared.ts:598,
  // 744-765). The event business processing is the ported T7 processor's domain.
  processResponsesStream: async function(openaiStream, output, _stream, _model, _options) {
    let sawTerminalResponseEvent = false;
    for await (const event of openaiStream) {
      if (event.type === 'error') {
        throw new Error(`Error Code ${event.code}: ${event.message}` || 'Unknown error');
      }
      if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
        sawTerminalResponseEvent = true;
      }
    }
    if (!sawTerminalResponseEvent) {
      throw new Error('OpenAI Responses stream ended before a terminal response event');
    }
    if (output.stopReason === 'pending') {
      output.stopReason = 'stop';
    }
  },
  applyServiceTierPricing: () => {},
  buildBaseOptions,
  clampThinkingLevel: () => undefined,
  Date: {now: () => 1},
}, ['stream', 'streamSimple']);

// ---- SDK transport seam: no network; the canned outcome reacts to the request the
// pinned create actually assembled (stream mode comes from `body.stream ?? false`). ----
function fakePost(url, options) {
  if (options.signal?.aborted) throw Error('Request aborted');
  state.trace.push('request');
  state.requests.push({url, body: structuredClone(options.body)});
  const status = (state.input.statuses ?? [200])[state.requests.length - 1] ?? 200;
  if (status !== 200) {
    // Canned SDK-shaped error (status + parsed body fields the real SDK sets);
    // the exact SDK message composition is not claimed.
    const error = Error('denied');
    error.status = status;
    error.error = {denied: true};
    error.headers = new Headers({'retry-after-ms': '0'});
    throw error;
  }
  const streaming = !!options.stream;
  const response = new Response(
    streaming ? 'sse' : (state.input.responseBody ?? '{"object":"response","output":[],"usage":{}}'),
    {status, headers: {'x-callback': 'observed', 'content-type': streaming ? 'text/event-stream' : 'application/json'}},
  );
  return new APIPromise(oracleClient, Promise.resolve({
    response,
    options,
    controller: {signal: options.signal},
    requestLogID: 'req',
    retryOfRequestLogID: undefined,
    startTime: 0,
  }));
}

const model = {id:'gpt-5.4', name:'GPT-5.4', api:'openai-responses', provider:'openai', baseUrl:'https://api.openai.com/v1', reasoning:false, thinkingLevelMap:undefined, contextWindow:400000, maxTokens:128000};
const context = {messages: []};
const cases = [
  {name:'callback-free'},
  {name:'undefined-preserves', payload:'defined'},
  {name:'replacement-keeps-stream', payload:'defined', replacement:{model:'patched', input:[{role:'user', content:[{type:'input_text', text:'hi'}]}], stream:true, store:false, custom:true}},
  {name:'null-replacement', payload:'defined', replacement:null},
  {name:'replacement-drops-stream', payload:'defined', replacement:{model:'patched', custom:true}},
  {name:'array-replacement', payload:'defined', replacement:[1,'x']},
  {name:'string-replacement', payload:'defined', replacement:'🙂'},
  {name:'number-replacement', payload:'defined', replacement:12},
  {name:'nonstream-primitive-response', payload:'defined', replacement:{model:'patched', custom:true}, responseBody:'"just text"'},
  {name:'payload-failure', payload:'error'},
  {name:'response-failure', response:'error'},
  {name:'response-hook-observed', response:'defined'},
  {name:'non2xx', statuses:[401]},
  {name:'retry-success', statuses:[503,200]},
  {name:'retry-exhausted', statuses:[503,503,503]},
  {name:'pre-aborted', cancel:'before'},
  {name:'payload-cancels', cancel:'payload', payload:'defined', replacement:{model:'patched', stream:true}},
  {name:'payload-cancels-throws', cancel:'payload', payload:'error'},
  {name:'response-cancels', cancel:'response', response:'defined'},
  {name:'response-cancels-throws', cancel:'response', response:'error'},
  {name:'sse-error-no-retry', sseError:true},
];

const results = [];
for (const input of cases) {
  const output = {};
  for (const entry of ['normal', 'simple']) {
    const trace = [], requests = [], seen = [], metadata = [], events = [];
    const controller = new AbortController();
    if (input.cancel === 'before') controller.abort();
    let completion;
    const complete = new Promise((resolve) => { completion = resolve; });
    state = {input, trace, requests, seen, metadata, events, complete: () => completion()};
    const options = {apiKey: 'local-test-only', maxRetries: 2, signal: controller.signal};
    if (input.payload !== undefined && input.payload !== 'absent') {
      options.onPayload = async (payload, m) => {
        assert.equal(m, model);
        trace.push('payload');
        seen.push(structuredClone(payload));
        if (input.cancel === 'payload') controller.abort();
        if (input.payload === 'error') throw Error('payload refused');
        return input.replacement === undefined ? undefined : input.replacement;
      };
    }
    if (input.response !== undefined && input.response !== false) {
      options.onResponse = async (response, m) => {
        assert.equal(m, model);
        trace.push('response');
        metadata.push(structuredClone(response));
        if (input.cancel === 'response') controller.abort();
        if (input.response === 'error') throw Error('response refused');
      };
    }
    if (entry === 'normal') {
      lifecycle.stream(model, context, options);
    } else {
      lifecycle.streamSimple(model, context, options);
    }
    await complete;
    const terminal = state.streamInstance.events.at(-1);
    output[entry] = {trace, seen, requests, metadata, stopReason: (terminal.message ?? terminal.error).stopReason, error: terminal.error?.errorMessage ?? null};
  }
  results.push({input, output});
}

const data = JSON.stringify({schema:1, authority:'actual upstream stream/streamSimple + provider-retry + error-body and pinned OpenAI 6.40.0 Responses.create/APIPromise/parse chain; transcript/params/grammar/SSE-business-logic/addOutputText/HTTP-transport dependency seams controlled', sources, cases: results}, null, 2) + '\n';
const dest = resolve(root, 'src/ai/api/openai_responses/callback_oracle.json');
if (process.argv.includes('--check')) { assert.equal(readFileSync(dest, 'utf8'), data); console.log(`PASS OpenAI Responses lifecycle oracle: ${results.length} scenarios x normal/simple, byte-identical`); }
else { writeFileSync(dest, data); console.log(`WROTE ${dest}: ${results.length} scenarios x normal/simple`); }
