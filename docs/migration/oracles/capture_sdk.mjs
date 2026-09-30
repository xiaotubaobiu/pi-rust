// Execute COMPLETE UNMODIFIED sdk.ts/provider-attribution.ts/telemetry.ts,
// Agent/loop, ai models (thinking helpers only), messages, model-resolver and
// auth-guidance. Filesystem/session/resource/runtime collaborators are controlled
// in-memory doubles. This is factory/closure differential evidence, not an E2E
// CLI oracle; native tests separately use the real AgentSession and ModelRuntime.
import * as fs from "node:fs";
import * as path from "node:path";
import {createHash} from "node:crypto";
import {stripTypeScriptTypes} from "node:module";
import {createContext,SourceTextModule,SyntheticModule} from "node:vm";
const root=new URL("../../../../pi/",import.meta.url), hashes={}, cache=new Map();
const context=createContext({console,URL,Error,AbortController,setTimeout,clearTimeout,process:{env:{},cwd:()=>"C:\\r15-project"}});
const synth=exports=>new SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
const fail=()=>{throw Error("Unexpected oracle collaborator call")};
const stubs=new Map();
let aiBarrel,agentBarrel,compat;
const moduleKey=(file,spec)=>new URL(spec,new URL(file,root)).href.slice(root.href.length);
async function load(file){
 if(cache.has(file))return cache.get(file);
 if(stubs.has(file))return stubs.get(file);
 const source=fs.readFileSync(new URL(file,root),"utf8");hashes[file]=createHash("sha256").update(source).digest("hex");
 const mod=new SourceTextModule(stripTypeScriptTypes(source),{context,identifier:file});cache.set(file,mod);
 await mod.link(async spec=>{
  if(spec==="node:path")return synth({join:path.win32.join});
  if(spec==="@earendil-works/pi-ai")return aiBarrel;
  if(spec==="@earendil-works/pi-ai/compat")return compat;
  if(spec==="@earendil-works/pi-agent-core")return agentBarrel;
  if(spec==="chalk")return synth({default:{yellow:x=>x,red:x=>x}});
  if(spec==="minimatch")return synth({minimatch:fail});
  if(!spec.startsWith("."))throw Error(`Unexpected import ${spec}`);
  return load(moduleKey(file,spec));
 });
 await mod.evaluate();return mod;
}
function stub(file,exports){stubs.set(file,synth(exports));}
const ai="packages/ai/src/", core="packages/coding-agent/src/core/";
stub(ai+"api/lazy.ts",{lazyStream:fail});
stub(ai+"auth/context.ts",{defaultProviderAuthContext:fail});
stub(ai+"auth/credential-store.ts",{InMemoryCredentialStore:class{constructor(){fail()}}});
stub(ai+"auth/resolve.ts",{ModelsError:Error,resolveProviderAuth:fail});
stub(ai+"models-store.ts",{InMemoryModelsStore:class{constructor(){fail()}}});
stub(ai+"utils/abort.ts",{operationSignal:fail,raceWithAbortSignal:fail});
const transcript=(await load(ai+"utils/transcript.ts")).namespace;
const events=(await load(ai+"utils/event-stream.ts")).namespace;
const models=(await load(ai+"models.ts")).namespace;
aiBarrel=synth({...transcript,...events,modelsAreEqual:models.modelsAreEqual,validateToolArguments:fail});
const agent=(await load("packages/agent/src/agent.ts")).namespace;
const streamFn=(await load("packages/agent/src/stream-fn.ts")).namespace;
agentBarrel=synth({...agent,...streamFn});
compat=synth({clampThinkingLevel:models.clampThinkingLevel,streamSimple:fail});
stub("packages/coding-agent/src/config.ts",{getAgentDir:()=>"C:\\r15-agent",getDocsPath:()=>"<DOCS>"});
stub("packages/coding-agent/src/utils/paths.ts",{resolvePath:p=>path.win32.resolve(p)});
stub("packages/coding-agent/src/cli/args.ts",{isValidThinkingLevel:v=>["off","minimal","low","medium","high","xhigh","max"].includes(v)});
stub(core+"timings.ts",{time:()=>{}});
stub(core+"agent-session-runtime.ts",{});
stub(core+"tools/index.ts",Object.fromEntries(["createBashTool","createCodingTools","createEditTool","createFindTool","createGrepTool","createLsTool","createPowerShellTool","createReadOnlyTools","createReadTool","createWriteTool","withFileMutationQueue"].map(n=>[n,fail])));
let fixtureRunner;
class Session {constructor(config){this.agent=config.agent;this.config=config;this.ref=config.extensionRunnerRef;this.ref.current=fixtureRunner;}}
stub(core+"agent-session.ts",{AgentSession:Session});
stub(core+"model-runtime.ts",{ModelRuntime:{create:fail}});
stub(core+"settings-manager.ts",{SettingsManager:{create:fail}});
stub(core+"resource-loader.ts",{DefaultResourceLoader:class{constructor(){fail()}}});
stub(core+"session-manager.ts",{SessionManager:{create:fail},getDefaultSessionDir:fail});
const {createAgentSession}=(await load(core+"sdk.ts")).namespace;
const {mergeProviderAttributionHeaders}=(await load(core+"provider-attribution.ts")).namespace;
const {isInstallTelemetryEnabled}=(await load(core+"telemetry.ts")).namespace;
const m=(id="m1",provider="r15-provider")=>({id,name:id,provider,api:"openai-completions",baseUrl:"https://r15.invalid/v1",reasoning:true,input:["text","image"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:2000});
function settings(value={}) {return {
 getDefaultProvider:()=>value.defaultProvider,getDefaultModel:()=>value.defaultModel,getDefaultThinkingLevel:()=>value.defaultThinkingLevel,
 getAllModelThinkingLevels:()=>value.modelThinkingLevels??{},getModelThinkingLevel:(p,id)=>value.modelThinkingLevels?.[`${p}/${id}`],
 getDefaultTools:()=>value.defaultTools,getBlockImages:()=>value.images?.blockImages??false,
 getProviderRetrySettings:()=>({...value.retry?.provider,maxRetryDelayMs:value.retry?.provider?.maxRetryDelayMs??60000}),
 getHttpIdleTimeoutMs:()=>value.httpIdleTimeoutMs??300000,getWebSocketConnectTimeoutMs:()=>value.websocketConnectTimeoutMs,
 getEnableInstallTelemetry:()=>value.enableInstallTelemetry??true,getSteeringMode:()=>value.steeringMode??"one-at-a-time",getFollowUpMode:()=>value.followUpMode??"one-at-a-time",
 getTransport:()=>value.transport??"auto",getThinkingBudgets:()=>value.thinkingBudgets,
};}
const user={role:"user",content:"saved",timestamp:1};
async function factory(spec){
 const writes=[], calls=[]; const value=structuredClone(spec.settings??{}), setting=settings(value);
 const available=spec.models??[m()], configured=spec.configured??["r15-provider"];
 const runtime={getModel:(p,id)=>available.find(m=>m.provider===p&&m.id===id),hasConfiguredAuth:p=>configured.includes(p),getAvailableSnapshot:()=>available.filter(m=>configured.includes(m.provider)),getModels:()=>available,
 streamSimple:async(model,context,options)=>{const headers=await options.transformHeaders(options.headers??{});calls.push({options:JSON.parse(JSON.stringify({...options,transformHeaders:undefined})),headers});return "stream";}};
 const manager={getCwd:()=>"C:\\r15-project",getSessionId:()=>"r15-session",buildSessionContext:()=>({messages:spec.existing?[user]:[],model:spec.savedModel,thinkingLevel:spec.savedThinking??"off"}),getBranch:()=>spec.hasThinking?[{type:"thinking_level_change"}]:[],appendModelChange:(provider,modelId)=>writes.push({type:"model_change",provider,modelId}),appendThinkingLevelChange:thinkingLevel=>writes.push({type:"thinking_level_change",thinkingLevel})};
 const result=await createAgentSession({cwd:"C:\\r15-project",agentDir:"C:\\r15-agent",modelRuntime:runtime,settingsManager:setting,sessionManager:manager,resourceLoader:{getExtensions:()=>({extensions:[],errors:[]})},
 ...spec.options});
 return {result,writes,calls,value};
}
const factorySpecs=[
 {name:"new_default"},{name:"no_models",models:[],configured:[]},
 {name:"explicit_unauth_model",options:{model:m("explicit","unconfigured"),thinkingLevel:"max"}},
 {name:"saved_authenticated",existing:true,savedModel:{provider:"r15-provider",modelId:"m2"},models:[m(),m("m2")],hasThinking:true,savedThinking:"high"},
 {name:"saved_missing_fallback",existing:true,savedModel:{provider:"lost",modelId:"missing"}},
 {name:"saved_unauth_fallback",existing:true,savedModel:{provider:"unconfigured",modelId:"m2"},models:[m(),m("m2","unconfigured")]},
 {name:"saved_no_models",existing:true,savedModel:{provider:"lost",modelId:"missing"},models:[],configured:[]},
 {name:"saved_explicit_wins",existing:true,savedModel:{provider:"lost",modelId:"missing"},hasThinking:true,savedThinking:"low",options:{model:m("explicit"),thinkingLevel:"high"}},
 {name:"settings_model",models:[m(),m("m2")],settings:{defaultProvider:"r15-provider",defaultModel:"m2"}},
 {name:"scoped_not_initial",options:{scopedModels:[{model:m("scoped"),thinkingLevel:"high"}]}},
 {name:"per_model_thinking",settings:{defaultThinkingLevel:"low",modelThinkingLevels:{"r15-provider/m1":"high"}}},
 {name:"existing_without_thinking_uses_global",existing:true,settings:{defaultThinkingLevel:"low",modelThinkingLevels:{"r15-provider/m1":"high"}}},
 {name:"empty_existing_entries_not_session",hasThinking:true,savedThinking:"high",savedModel:{provider:"r15-provider",modelId:"m2"},models:[m(),m("m2")]},
 {name:"no_reasoning",options:{model:{...m(),reasoning:false},thinkingLevel:"high"}},
 {name:"thinking_map_clamp",options:{model:{...m(),thinkingLevelMap:{off:null,minimal:null,low:null,medium:"medium",high:"high",xhigh:null,max:null}},thinkingLevel:"low"}},
 {name:"tools_configured",settings:{defaultTools:["grep","read","read"]}},
 {name:"tools_builtin",options:{noTools:"builtin"}},
 {name:"tools_all",options:{noTools:"all"}},
 {name:"tools_empty",options:{tools:[]}},
 {name:"tools_explicit_wins",settings:{defaultTools:["read"]},options:{noTools:"all",tools:["grep","read","grep"],excludeTools:["read"]}},
 {name:"tools_deny",options:{excludeTools:["edit","write"]}},
 {name:"configured_runtime",settings:{steeringMode:"all",followUpMode:"all",transport:"websocket",thinkingBudgets:{high:99},retry:{provider:{maxRetryDelayMs:123}}}},
];
const factories=[];
for(const input of factorySpecs){const {result,writes}=await factory(input);const c=result.session.config,a=result.session.agent;const f=result.modelFallbackMessage;factories.push({input,expected:{model:a.state.model?`${a.state.model.provider}/${a.state.model.id}`:null,thinking:a.state.thinkingLevel,writes,initial:c.initialActiveToolNames,allowed:c.allowedToolNames??null,excluded:c.excludedToolNames??null,fallback:f?.startsWith("No models available.")?"NO_MODELS":f??null,steering:a.steeringMode,followUp:a.followUpMode,transport:a.transport,sessionId:a.sessionId,thinkingBudgets:a.thinkingBudgets??null,maxRetryDelayMs:a.maxRetryDelayMs}});}
const streamSpecs=[
 {name:"default"},{name:"idle_zero",settings:{httpIdleTimeoutMs:0}},
 {name:"idle_custom",settings:{httpIdleTimeoutMs:1234,websocketConnectTimeoutMs:456}},
 {name:"retry_timeout",settings:{httpIdleTimeoutMs:1234,retry:{provider:{timeoutMs:567,maxRetries:2,maxRetryDelayMs:3000}}}},
 {name:"explicit_zero",settings:{httpIdleTimeoutMs:1234,websocketConnectTimeoutMs:567,retry:{provider:{timeoutMs:890,maxRetries:2,maxRetryDelayMs:3000}}},request:{timeoutMs:0,websocketConnectTimeoutMs:0,maxRetries:0,maxRetryDelayMs:0}},
 {name:"forwarding",request:{timeoutMs:789,sessionId:"explicit-session",transport:"sse",apiKey:"test-not-real",headers:{"x-one":"one","x-delete":null},temperature:0.5,maxTokens:321,reasoning:"high",thinkingBudgets:{high:123},env:{R15:"offline"},metadata:{source:"oracle"}}},
 {name:"live_settings",settings:{httpIdleTimeoutMs:12},change:{httpIdleTimeoutMs:98,websocketConnectTimeoutMs:77,retry:{provider:{maxRetries:4,maxRetryDelayMs:99}}}},
];
const streams=[];
for(const input of streamSpecs){const {result,calls,value}=await factory({settings:input.settings});if(input.change)Object.assign(value,input.change);await result.session.agent.streamFunction(m(),transcript.normalizeContext({messages:[]}),input.request??{});if(calls.length!==1)throw Error("stream collaborator not reached");streams.push({input,expected:calls[0]});}
const attribution=[];
const attrs=[
 ["openrouter","invalid"],["custom","not-a-url/openrouter.ai"],["custom","https://openrouter.ai.evil/path"],["nvidia","https://host/openrouter.ai"],["custom","https://OPENROUTER.AI/path"],
 ["custom","https://INTEGRATE.API.NVIDIA.COM:443/v1"],["custom","https://integrate.api.nvidia.com.evil"],["custom","https://evil/?integrate.api.nvidia.com"],["nvidia","invalid"],
 ["custom","https://api.cloudflare.com/client/v4"],["custom","https://gateway.ai.cloudflare.com/v1"],["cloudflare-workers-ai","invalid"],["cloudflare-ai-gateway","invalid"],
 ["opencode","invalid"],["opencode-go","invalid"],["custom","https://OPENCODE.AI:443/v1"],["custom","https://opencode.ai.evil"],["custom","https://user@opencode.ai/v1"],["custom","//opencode.ai/v1"],["custom","https://opencode.ai./v1"],
 ["opencode","https://openrouter.ai"],["custom","https://elsewhere.invalid"]
];
for(const [provider,baseUrl] of attrs)for(const enabled of [true,false]){const input={provider,baseUrl,enabled,sessionId:"session-123"};attribution.push({input,expected:mergeProviderAttributionHeaders({...m(),provider,baseUrl},settings({enableInstallTelemetry:enabled}),input.sessionId)??null});}
for(const sessionId of [undefined,""]){const input={provider:"opencode",baseUrl:"invalid",enabled:true,...(sessionId===undefined?{}:{sessionId})};attribution.push({input,expected:mergeProviderAttributionHeaders({...m(),...input},settings(),sessionId)??null});}
const sourceInput={provider:"openrouter",baseUrl:"invalid",enabled:true,sessionId:"s",sources:[{"HTTP-Referer":"first","X-OpenRouter-Title":null},null,{"HTTP-Referer":null,"http-referer":"lower","X-Extra":"x"}]};
attribution.push({input:sourceInput,expected:mergeProviderAttributionHeaders({...m(),...sourceInput},settings(),"s",...sourceInput.sources)});
const telemetry=[];
for(const enabled of [true,false])for(const env of [undefined,"","1","0","true","TrUe","YES","yes "," true","on","false"]){const input={enabled,...(env===undefined?{}:{env})};telemetry.push({input,expected:isInstallTelemetryEnabled(settings({enableInstallTelemetry:enabled}),env)});}
const image={type:"image",data:"AA==",mimeType:"image/png"},disabled={type:"text",text:"Image reading is disabled."};
const imageSpecs=[
 {name:"block",block:true,messages:[{role:"user",content:[image,image,disabled,{type:"text",text:"gap"},image],timestamp:1},{role:"toolResult",toolCallId:"t",toolName:"read",content:[image,image],isError:false,timestamp:2}]},
 {name:"allow",block:false,messages:[{role:"user",content:[image,image],timestamp:1}]},
 {name:"no_images_no_dedup",block:true,messages:[{role:"user",content:[disabled,disabled],timestamp:1}]},
 {name:"custom_conversion",block:true,messages:[{role:"custom",customType:"notice",content:[image,image],display:true,timestamp:1}]},
];
const images=[];
for(const input of imageSpecs){const {result,value}=await factory({});value.images={blockImages:input.block};images.push({input,expected:await result.session.agent.convertToLlm(input.messages)});}
if(factories.length!==22||streams.length!==7||attribution.length!==47||images.length!==4)throw Error("oracle scenario count guard");
process.stdout.write(JSON.stringify({schema:1,sourceHashes:hashes,factories,streams,attribution,telemetry,images},null,2)+"\n");
