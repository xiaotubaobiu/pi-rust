// Offline actual-source oracle. Only import seams are substituted; business
// functions are the TypeScript source, erased by Node, not a JS reimplementation.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const upstream = resolve(root, "../pi");
const sources = {};
function load(relative, dependencies, exports) {
  const bytes = readFileSync(resolve(upstream, relative));
  sources[relative] = createHash("sha256").update(bytes).digest("hex");
  const erased = stripTypeScriptTypes(bytes.toString("utf8"), {mode:"strip"});
  const body = erased.replace(/^import[\s\S]*?;\s*/gm, "").replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const))/g, "");
  return new Function(...Object.keys(dependencies), body + `\nreturn {${exports.join(",")}};`)(...Object.values(dependencies));
}
const {operationScopeOf} = load("packages/agent/src/harness/session/types.ts", {}, ["operationScopeOf"]);
const {applyStreamOptionsPatch} = load("packages/agent/src/harness/hooks.ts", {}, ["applyStreamOptionsPatch"]);
const unused = () => {throw Error("unexpected dependency in this bounded oracle")};
const {prepareGeneration,publishGenerationIntent,runRetryWait} = load("packages/agent/src/harness/runtime/drive/generation.ts", {
  operationScopeOf, applyStreamOptionsPatch, Date:{now:()=>1000},
  readBoundedContext:async (lane)=>lane.cancel ? {kind:"cancel_requested"} : {kind:"result",value:[]},
  SessionInvariantError:Error, getTelemetryContext:unused, withAbortSignal:unused,
  streamHarnessAssistant:unused, openAssistantResponse:unused, publishConfigurationFailure:unused, publishResponse:unused, waitUntil:unused,
}, ["prepareGeneration","publishGenerationIntent","runRetryWait"]);
const tool = (name,description)=>({name,description,parameters:{type:"object"}});
const inputs = [
  {name:"missing-model",modelId:"missing"},
  {name:"missing-tools-duplicates",active:["b","a","b"]},
  {name:"partly-missing",active:["a","b","b"],tools:[tool("a","exists")]},
  {name:"empty"},
  {name:"duplicate-order",active:["b","a","b"],tools:[tool("a","old"),tool("b","middle"),tool("a","last")]},
  {name:"prompt",prompt:"system"},
  {name:"patch",prompt:"patched prompt",base:{timeoutMs:123,headers:{keep:"yes"},metadata:{base:1}},patch:{maxRetries:2,headers:{added:"value"},metadata:{next:2}}},
  {name:"cancel",cancel:true,prompt:"never reached"},
];
const preparation=[];
for (const input of inputs) {
  const gc={configuration:{model:{provider:"faux",modelId:input.modelId??"faux-1"},activeToolNames:input.active??[]},streamOptions:input.base??{}};
  const lane={name:"review",cancel:input.cancel,models:{getModel:(_p,id)=>id==="missing"?undefined:{id,maxTokens:1234,contextWindow:45678}},readConfig:()=>({tools:input.tools??[],systemPrompt:input.prompt}),hooks:{runWithGate:async()=>input.patch?{streamOptions:input.patch}:undefined}};
  const result=await prepareGeneration(lane,{operationId:"operation",gate:{},context:{}},{at:"assistant.ready",generationContext:gc,nextAttempt:1});
  const output=result.kind==="ready"?{kind:result.kind,tools:result.tools,systemPrompt:result.systemPrompt,streamOptions:result.streamOptions}:result;
  preparation.push({input,output});
}
const intent=[];
for (const attempt of [1,2]) {
  const scope={control:{status:"running"},settings:{setting:"current"},latestAssistantEntryId:"current-latest"};
  const ready={...scope,latestAssistantEntryId:"stale",at:"assistant.ready",nextAttempt:attempt,generationContext:{stepId:"turn"}};
  const times=[]; const events=[]; let stored;
  const lane={name:"review",session:{idGenerator:{next:at=>{times.push(at);return `id-${times.length}`;}}},continueOperation:async (_ready,plan)=>{const command=plan({}, {...ready,...scope});stored=command.operationState;events.push(...command.events());return {kind:"result",value:command.materialize()};}};
  await publishGenerationIntent(lane,{operationId:"operation",context:{}},ready,{model:{maxTokens:1234,contextWindow:45678}});
  intent.push({attempt,output:{at:stored.at,attempt:stored.attempt,intendedOutputLimit:stored.intendedOutputLimit,contextWindow:stored.contextWindow,scopePreserved:JSON.stringify(operationScopeOf(stored))===JSON.stringify(scope),distinctIds:stored.responseEntryId!==stored.usageId,sameTimestamp:times[0]===times[1],events:events.map(e=>({type:e.type,lane:e.lane,runIdMatches:e.runId==="operation",turnIdMatches:e.turnId==="turn"}))}});
}
const retry=[];
for (const future of [false,true]) {
  const state={control:{status:"running"},settings:{},latestAssistantEntryId:"latest",at:"assistant.retry_wait",generationContext:{stepId:"turn"},nextAttempt:2,notBefore:future?2000:0};
  let stored=state; const events=[];
  const lane={name:"review",continueOperation:async (_expected,plan)=>{const command=plan({},state);stored=command.operationState;events.push(...command.events());return {kind:"result",value:command.materialize()};}};
  const result=await runRetryWait(lane,{operationId:"operation",waitForRetry:false,context:{}},state);
  const output=result.kind==="waiting"?{kind:result.kind,reason:result.outcome.reason,deadlinePreserved:result.outcome.notBefore===state.notBefore,runIdMatches:result.outcome.operationId==="operation",unchanged:stored===state,events:events.length}:{kind:result.kind,at:stored.at,nextAttempt:stored.nextAttempt,scopePreserved:JSON.stringify(operationScopeOf(stored))===JSON.stringify(operationScopeOf(state)),events:events.map(e=>({type:e.type,lane:e.lane,runIdMatches:e.runId==="operation",stepMatches:e.step==="turn",attempt:e.attempt}))};
  retry.push({future,output});
}
const payload=JSON.stringify({schema:1,authority:"unmodified upstream TypeScript business functions; import seams mocked",sources,preparation,intent,retry},null,2)+"\n";
const destination=resolve(root,"src/agent_core/harness/runtime/drive/generation/oracle.json");
if(process.argv.includes("--check")){assert.equal(readFileSync(destination,"utf8"),payload);console.log("PASS generation oracle: 12 scenarios, byte-identical");}
else {writeFileSync(destination,payload);console.log("WROTE",destination);}
