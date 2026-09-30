// r14 differential capture. Complete unmodified upstream Agent/loop/default-stream,
// transcript/text and EventStream sources execute in an isolated Node VM. The only
// AI barrel collaborator is fail-on-use argument validation (no tool executions
// in these fixtures). Stream/key callbacks are controlled offline test doubles.
// No Models/SDK/services implementation, credentials or network are exercised.
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
const root = new URL("../../../../pi/", import.meta.url);
const context = createContext({ console, Error, AbortController, setTimeout, clearTimeout });
const cache = new Map(), hashes = {};
let barrel;
const synth = exports => new SyntheticModule(Object.keys(exports), function () {
  for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
}, { context });
async function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const source = fs.readFileSync(new URL(relative, root), "utf8");
  hashes[relative] = createHash("sha256").update(source).digest("hex");
  const module = new SourceTextModule(stripTypeScriptTypes(source), { context, identifier: relative });
  cache.set(relative, module);
  await module.link(async (specifier) => {
    if (specifier === "@earendil-works/pi-ai") return barrel;
    if (!specifier.startsWith(".")) throw new Error(`Unexpected import: ${specifier}`);
    const url = new URL(specifier, new URL(relative, root));
    return load(url.href.slice(root.href.length));
  });
  await module.evaluate();
  return module;
}
const transcript = await load("packages/ai/src/utils/transcript.ts");
const events = await load("packages/ai/src/utils/event-stream.ts");
barrel = synth({ ...transcript.namespace, ...events.namespace, validateToolArguments() { throw new Error("Unexpected tool validation in stream boundary oracle"); } });
await barrel.link(() => { throw new Error("Unexpected barrel import"); }); await barrel.evaluate();
const { Agent } = (await load("packages/agent/src/agent.ts")).namespace;
const { runAgentLoop } = (await load("packages/agent/src/agent-loop.ts")).namespace;
const { setDefaultStreamFn } = (await load("packages/agent/src/stream-fn.ts")).namespace;
const model = { id: "r14-model", name: "r14-model", api: "r14-api", provider: "r14-provider", baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = text => ({ role: "user", content: text, timestamp: 1 });
const message = (reason = "stop", error) => ({ role: "assistant", content: [{type:"text",text:"ok"}], api: model.api, provider: model.provider, model: model.id, usage, stopReason: reason, ...(error ? {errorMessage:error} : {}), timestamp: 2 });
const optionKeys = ["apiKey","transport","sessionId","reasoning","thinkingBudgets","maxRetryDelayMs","headers","timeoutMs","maxRetries","temperature","maxTokens","cacheRetention","websocketConnectTimeoutMs","metadata","env","toolChoice","deferred","samplingParams"];
const specs = [
  { name:"agent_default" },
  { name:"agent_default_stream_fallback", omit:true },
  { name:"agent_configured", options:{transport:"websocket",sessionId:"r14-session",reasoning:"high",thinkingBudgets:{high:99},maxRetryDelayMs:456}, callbacks:true, keys:["offline-key"] },
  { name:"agent_transform_convert", transform:true, keys:[null] },
  { name:"agent_refresh_each_turn", followup:true, keys:["first","second"] },
  { name:"raw_inherited_options", raw:true, options:{apiKey:"explicit",transport:"sse",sessionId:"raw-session",reasoning:"low",thinkingBudgets:{low:12},maxRetryDelayMs:432,headers:{"x-test":"yes","x-hide":null},timeoutMs:123,maxRetries:2,temperature:0.2,maxTokens:321,cacheRetention:"long",websocketConnectTimeoutMs:765,metadata:{source:"r14"},env:{R14:"not-real"},toolChoice:"auto",deferred:false,samplingParams:{top_k:4}} },
  { name:"raw_key_missing", raw:true, options:{apiKey:"explicit"}, keys:[null] },
  { name:"raw_key_empty", raw:true, options:{apiKey:"explicit"}, keys:[""] },
  { name:"raw_key_override", raw:true, options:{apiKey:"explicit"}, keys:["resolved"] },
  { name:"agent_factory_reject", reject:"factory failed" },
  { name:"raw_factory_reject", raw:true, reject:"factory failed" },
  { name:"agent_key_reject", keyReject:true },
  { name:"raw_key_reject", raw:true, keyReject:true },
  { name:"agent_terminal_error", terminal:"error" },
  { name:"agent_terminal_error_before_start", terminal:"error", noStart:true },
  { name:"agent_terminal_aborted", terminal:"aborted" },
];
function eventSummary(event) {
  const result = { type:event.type };
  if (event.message && event.type !== "turn_end") result.role = event.message.role;
  if ((event.type === "message_end" && event.message.role === "assistant") || event.type === "turn_end") {
    result.reason = event.message.stopReason; result.error = event.message.errorMessage ?? null;
  }
  if (event.type === "agent_end") result.count = event.messages.length;
  return result;
}
const rows = [];
for (const spec of specs) {
  const trace = []; let keyIndex = 0;
  const onPayload = spec.callbacks ? async (payload, m) => { trace.push({phase:"payload",model:m.id,payload}); return {changed:true}; } : undefined;
  const onResponse = spec.callbacks ? async (response, m) => { trace.push({phase:"response",model:m.id,response}); } : undefined;
  const streamFn = async (m, llm, options) => {
    trace.push({ phase:"stream", model:m.id, roles:llm.messages.map(x=>x.role), texts:llm.messages.map(x=>typeof x.content === "string" ? x.content : x.content.filter(b=>b.type==="text").map(b=>b.text).join("\n")), normalized:!Object.hasOwn(llm,"systemPrompt")&&!Object.hasOwn(llm,"tools"), options:Object.fromEntries(optionKeys.filter(k=>options[k]!==undefined).map(k=>[k,options[k]])), signal:options.signal!==undefined, payload:options.onPayload===onPayload&&!!onPayload, response:options.onResponse===onResponse&&!!onResponse });
    if (spec.reject) throw new Error(spec.reject);
    if (onPayload) { const result = await options.onPayload({original:true},m); trace.push({phase:"payload_result",result}); await options.onResponse({status:201,headers:{"x-test":"yes"}},m); }
    const stream = new events.namespace.AssistantMessageEventStream();
    const final = message(spec.terminal ?? "stop", spec.terminal ? "terminal failure" : undefined);
    if (!spec.noStart) stream.push({type:"start",partial:{...final,content:[],stopReason:"pending"}});
    stream.push(spec.terminal ? {type:"error",reason:spec.terminal,error:final} : {type:"done",reason:"stop",message:final});
    return stream;
  };
  const getApiKey = spec.keys || spec.keyReject ? async provider => { trace.push({phase:"key",provider}); if (spec.keyReject) throw new Error("key failed"); return spec.keys[keyIndex++] ?? undefined; } : undefined;
  const transformContext = spec.transform ? async messages => { trace.push({phase:"transform"}); return [...messages,{role:"custom",content:"injected"}]; } : undefined;
  const convertToLlm = async messages => { if(spec.transform) trace.push({phase:"convert"}); return messages.map(x=>x.role==="custom"?user("converted"):x); };
  let error = null, state;
  if (spec.raw) {
    const abort = new AbortController();
    try { await runAgentLoop([user("hello")], {messages:[],tools:[]}, {model,convertToLlm,getApiKey,...spec.options}, e=>trace.push(eventSummary(e)), abort.signal,streamFn); } catch (e) { error = e.message; }
  } else {
    if (spec.omit) setDefaultStreamFn(streamFn);
    const agent = new Agent({initialState:{model,systemPrompt:"system",thinkingLevel:spec.options?.reasoning??"off"}, ...(spec.omit?{}:{streamFn}), convertToLlm, transformContext, getApiKey, onPayload, onResponse, ...spec.options});
    agent.subscribe(e=>{ trace.push(eventSummary(e)); });
    if (spec.followup) agent.followUp(user("follow"));
    await agent.prompt(user("hello"));
    state = { streaming:agent.state.isStreaming,error:agent.state.errorMessage??null,roles:agent.state.messages.map(x=>x.role) };
    if (spec.omit) setDefaultStreamFn(undefined);
  }
  // Guard the harness itself: every case must enter the real loop, and only
  // the deliberately invalid raw callbacks may reject it. Bad argument order
  // must fail capture rather than becoming a misleading empty "oracle".
  const expectedError = spec.raw ? (spec.reject ?? (spec.keyReject ? "key failed" : null)) : null;
  if (trace[0]?.type !== "agent_start" || error !== expectedError) {
    throw new Error(`Invalid capture for ${spec.name}: ${JSON.stringify({error, expectedError, trace})}`);
  }
  if (!spec.keyReject && !trace.some(row => row.phase === "stream")) {
    throw new Error(`Capture did not enter stream factory for ${spec.name}`);
  }
  rows.push({spec,trace,error,...(state?{state}:{})});
}
process.stdout.write(JSON.stringify({ sources:hashes, collaborators:["synthetic AI barrel re-exports actual upstream transcript/text/EventStream", "fail-on-use validateToolArguments; no executed tools", "offline stream/key callback doubles; not Models or SDK/services", "trace intentionally projects away timestamps, JS object identity and stack"], cases:rows },null,2)+"\n");