// Offline oracle: execute actual pinned upstream stream + retry and SDK create.
// Only dependency seams below are fake; no rewritten lifecycle business algorithm.
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
const sdk = source(resolve(here,'messages.ts'), 'sdk-0.124.0/src/resources/beta/messages/messages.ts');
const headers = source(resolve(here,'headers.ts'), 'sdk-0.124.0/src/internal/headers.ts');
const provenance = JSON.parse(readFileSync(resolve(here,'provenance.json')));
assert.equal(sources['sdk-0.124.0/src/resources/beta/messages/messages.ts'], provenance.sha256['package/src/resources/beta/messages/messages.ts']);
assert.equal(sources['sdk-0.124.0/src/internal/headers.ts'], provenance.sha256['package/src/internal/headers.ts']);
const {buildHeaders} = execute(headers, {isReadonlyArray:Array.isArray}, ['buildHeaders']);
const createBegin = sdk.indexOf('  create(\n    params: MessageCreateParams,');
const createEnd = sdk.indexOf('\n  /**', createBegin);
const transformBegin = sdk.indexOf('function transformOutputFormat');
const transformEnd = sdk.indexOf('\n/**', transformBegin);
assert.ok(createBegin>0 && createEnd>createBegin && transformBegin>0);
const sdkSlice = `class Messages { constructor(client: any) { this._client = client; }\n${sdk.slice(createBegin,createEnd)}\n}\n${sdk.slice(transformBegin,transformEnd)}`;
const {Messages} = execute(sdkSlice, {
  buildHeaders, AnthropicError:Error, DEPRECATED_MODELS:{}, MODELS_TO_WARN_WITH_THINKING_ENABLED:[],
  stainlessHelperHeader:()=>undefined,
}, ['Messages']);
const retrySource = source(resolve(upstream,'packages/ai/src/utils/provider-retry.ts'), 'packages/ai/src/utils/provider-retry.ts');
const {retryProviderRequest} = execute(retrySource, {}, ['retryProviderRequest']);
const streamSource = source(resolve(upstream,'packages/ai/src/api/anthropic-messages.ts'), 'packages/ai/src/api/anthropic-messages.ts');
const start = streamSource.indexOf('export const stream:');
const end = streamSource.indexOf('\n/**\n * Map ThinkingLevel', start);
assert.ok(start>0 && end>start);
const cases = [
  {name:'callback-free', payload:'absent', response:false},
  {name:'callback-free-beta', payload:'absent', response:false,clientBeta:'client-beta'},
  {name:'undefined-preserves'},
  {name:'replacement-stream-false', replacement:{model:'patched',stream:false,betas:['beta-a','beta-b'],user_profile_id:'profile',workspace_id:'workspace',custom:true}},
  {name:'null-is-object', replacement:null},
  {name:'array-spread', replacement:[1,'x']},
  {name:'bmp-string-spread', replacement:'A中'},
  {name:'number-spread', replacement:12},
  {name:'bool-spread', replacement:false},
  {name:'empty-beta-overrides-client', clientBeta:'client-beta', replacement:{betas:[],stream:false}},
  {name:'removed-beta-restores-client', clientBeta:'client-beta', replacement:{custom:true}},
  {name:'null-beta-restores-client', clientBeta:'client-beta', replacement:{betas:null}},
  {name:'beta-array-coercion', replacement:{betas:['a',null,['b','c']],user_profile_id:4,workspace_id:false}},
  {name:'output-format', replacement:{output_format:{type:'json_schema',schema:{}},output_config:{effort:'high'}}},
  {name:'output-format-conflict', replacement:{output_format:{type:'json_schema'},output_config:{format:{type:'json_schema'}}}},
  {name:'aborted-sdk-preflight-error',cancel:'payload',replacement:{output_format:{type:'json_schema'},output_config:{format:{type:'json_schema'}}}},
  {name:'payload-failure', payload:'error'},
  {name:'response-failure', response:'error'},
  {name:'non2xx', statuses:[401]},
  {name:'retry-success', statuses:[503,200]},
  {name:'retry-exhausted', statuses:[503,503,503]},
  {name:'pre-aborted', cancel:'before'},
  {name:'payload-cancels', cancel:'payload'},
  {name:'payload-cancels-throws', cancel:'payload', payload:'error'},
  {name:'response-cancels', cancel:'response'},
  {name:'response-cancels-throws', cancel:'response', response:'error'},
  {name:'sse-error-no-retry', sseError:true},
];
const results = [];
for(const input of cases) {
  const trace=[], requests=[], seen=[], metadata=[];
  const controller=new AbortController();
  if(input.cancel==='before') controller.abort();
  let completion;
  const complete=new Promise(resolve=>{completion=resolve;});
  class Events {
    events=[];
    push(event) { this.events.push(structuredClone(event)); trace.push(event.type); }
    end() { completion(); }
  }
  const clientHeaders = input.clientBeta ? {'anthropic-beta':input.clientBeta} : {};
  const client={_options:{},post(url, options) {
    return {asResponse: async()=>{
      // SDK transport seam: no network, only controlled statuses and AbortSignal.
      if(options.signal?.aborted) throw Error('Request aborted');
      trace.push('request');
      const h=buildHeaders([clientHeaders,options.headers]).values;
      requests.push({url,body:options.body,headers:Object.fromEntries(h.entries())});
      const status=(input.statuses??[200])[requests.length-1]??200;
      if(status!==200) { const error=Error(`${status}: denied`); error.status=status; error.headers=new Headers({'retry-after-ms':'0'}); throw error; }
      return new Response('',{status,headers:{'x-callback':'observed','content-type':'text/event-stream'}});
    }};
  }};
  const api = new Messages(client);
  const params={model:'claude-callback',messages:[],max_tokens:64,stream:true};
  if(input.clientBeta) params.betas=[input.clientBeta];
  const {stream}=execute(streamSource.slice(start,end), {
    AssistantMessageEventStream:Events,
    getAnthropicCompat:()=>({supportsMidConvoSystemMessages:false}),resolveTranscript:c=>c,getCurrentTools:()=>[],
    assertRequestAuth:()=>{},resolveCacheRetention:()=> 'none',
    createClient:()=>({client:{beta:{messages:api}},isOAuthToken:false}),
    buildParams:()=>structuredClone(params),retryProviderRequest,
    headersToRecord:h=>Object.fromEntries(h.entries()),
    iterateAnthropicEvents:async function*(_response,signal) {
      if(signal?.aborted) throw Error('Request was aborted');
      if(input.sseError) throw Error('stream refused');
      yield {type:'message_delta',delta:{stop_reason:'end_turn'}};
      yield {type:'message_stop'};
    },mapStopReason:()=>({stopReason:'stop'}),calculateCost:()=>{},Date:{now:()=>1},
  },['stream']);
  const model={id:'claude-callback',provider:'anthropic',api:'anthropic-messages'};
  const options={apiKey:'local-test-only',signal:controller.signal,maxRetries:2};
  if(input.payload!=='absent') options.onPayload=async(payload,m)=> {
    assert.equal(m,model); trace.push('payload'); seen.push(payload);
    if(input.cancel==='payload') controller.abort();
    if(input.payload==='error') throw Error('payload refused');
    return input.replacement;
  };
  if(input.response!==false) options.onResponse=async(response,m)=> {
    assert.equal(m,model);trace.push('response');metadata.push(response);
    if(input.cancel==='response') controller.abort();
    if(input.response==='error') throw Error('response refused');
  };
  const events=stream(model,{messages:[]},options);await complete;
  const terminal=events.events.at(-1);
  results.push({input,output:{trace,seen,requests,metadata,stopReason:(terminal.message??terminal.error).stopReason,error:(terminal.error?.errorMessage??null)}});
}
const data=JSON.stringify({schema:1,authority:'actual upstream stream/retry and pinned SDK Messages.create; transcript/params/SSE/HTTP dependency seams controlled',sources,cases:results},null,2)+'\n';
const dest=resolve(root,'src/ai/api/anthropic/stream/callback_oracle.json');
if(process.argv.includes('--check')) { assert.equal(readFileSync(dest,'utf8'),data);console.log(`PASS Anthropic lifecycle oracle: ${results.length} scenarios, byte-identical`); }
else { writeFileSync(dest,data);console.log(`WROTE ${dest}: ${results.length} scenarios`); }
