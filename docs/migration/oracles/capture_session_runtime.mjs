// Actual, complete, unchanged upstream Runtime and session-cwd modules.
// Explicit collaborators: the SDK/services re-exports are fail-on-use; a small
// SessionManager and AgentSession double isolate orchestration. Real node fs/path
// (only within a newly allocated temp directory) exercise import/exclusive copy.
// Native tests consume these traces using real AgentSession/SessionManager.
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
const root = fs.mkdtempSync(path.join(tmpdir(), "pi-runtime-oracle-"));
const upstream = new URL("../../../../pi/packages/coding-agent/src/core/", import.meta.url);
const sources = Object.fromEntries(["agent-session-runtime.ts", "session-cwd.ts"].map(name => [name, fs.readFileSync(new URL(name, upstream), "utf8")]));
const context = createContext({ console, Error });
const synth = exports => new SyntheticModule(Object.keys(exports), function () {
  for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
}, { context });
let active;
let serial = 0;
const header = (cwd, parentSession) => ({ type: "session", version: 3, id: "0199aaaa-0000-7000-8000-000000000001", timestamp: "2026-09-27T00:00:00.000Z", cwd, ...(parentSession ? { parentSession } : {}) });
const entries = () => [
  { type: "message", id: "root", parentId: null, timestamp: "2026-09-27T00:00:00.000Z", message: { role: "user", content: "first", timestamp: 1 } },
  { type: "message", id: "second", parentId: "root", timestamp: "2026-09-27T00:00:00.000Z", message: { role: "user", content: [{type:"text",text:"A"},{type:"image",data:"",mimeType:"image/png"},{type:"text",text:"B"}], timestamp: 2 } },
  { type: "custom", id: "custom", parentId: "second", timestamp: "2026-09-27T00:00:00.000Z", customType: "test", data: {} },
];
function writeSession(file, cwd, data = entries()) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, [header(cwd), ...data].map(JSON.stringify).join("\n")+"\n"); }
class Manager {
  constructor(cwd, dir, persist, file, data = entries()) { Object.assign(this, { cwd, dir, persist, file, data, parent: undefined }); }
  getCwd() { return this.cwd; } getSessionFile() { return this.file; } getSessionDir() { return this.dir; } isPersisted() { return this.persist; }
  getEntry(id) { return this.data.find(entry => entry.id === id); }
  newSession(options = {}) { this.parent = options.parentSession; this.data = []; if (this.persist) this.file = path.join(this.dir, `generated-${++serial}.jsonl`); }
  createBranchedSession(id) {
    const index = this.data.findIndex(entry => entry.id === id); if (index < 0) throw new Error(`Entry ${id} not found`);
    this.data = this.data.slice(0, index + 1); this.parent = this.persist ? this.file : undefined;
    if (this.persist) { this.file = path.join(this.dir, `generated-${++serial}.jsonl`); writeSession(this.file, this.cwd, this.data); return this.file; }
  }
  buildSessionContext() { return { messages: this.data.filter(e => e.type === "message").map(e => e.message) }; }
  static create(cwd, dir) { fs.mkdirSync(dir, { recursive: true }); return new Manager(cwd, dir, true, path.join(dir, `generated-${++serial}.jsonl`), []); }
  static inMemory(cwd) { return new Manager(cwd, "", false, undefined, []); }
  static open(file, dir, override) {
    const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    const manager = new Manager(override ?? rows[0].cwd, dir ?? path.dirname(file), true, file, rows.slice(1)); manager.parent = rows[0].parentSession; return manager;
  }
}
const cwdModule = new SourceTextModule(stripTypeScriptTypes(sources["session-cwd.ts"]), { context });
await cwdModule.link(specifier => { if (specifier !== "node:fs") throw new Error(specifier); return synth(fs); }); await cwdModule.evaluate();
const runtimeModule = new SourceTextModule(stripTypeScriptTypes(sources["agent-session-runtime.ts"]), { context });
await runtimeModule.link(specifier => {
  if (specifier === "node:fs") return synth(fs);
  if (specifier === "node:path") return synth(path);
  if (specifier === "../utils/paths.ts") return synth({ resolvePath: input => path.resolve(input) });
  if (specifier === "./session-cwd.ts") return cwdModule;
  if (specifier === "./session-manager.ts") return synth({ SessionManager: Manager });
  if (specifier === "./extensions/runner.ts") return synth({ emitSessionShutdownEvent: async (runner, event) => { if (runner.hasHandlers(event.type)) { await runner.emit(event); return true; } return false; } });
  if (specifier === "./agent-session-services.ts") return synth({ createAgentSessionFromServices() { throw new Error("unexpected SDK"); }, createAgentSessionServices() { throw new Error("unexpected services"); } });
  throw new Error("unexpected import: " + specifier);
}); await runtimeModule.evaluate();
const { AgentSessionRuntime, createAgentSessionRuntime } = runtimeModule.namespace;
const rows = [];
function norm(value) {
  if (typeof value === "string") return value.split(root).join("@ROOT").replaceAll("\\", "/").replace(/@ROOT\/[^ ]*?\/generated-\d+\.jsonl/g, "@NEW");
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).map(([k,v])=>[k,norm(v)]));
  return value;
}
function session(manager, start, id) {
  const result = { sessionManager: manager, agent: { state: { messages: manager.buildSessionContext().messages } }, active: true, id,
    get sessionFile() { return manager.file; },
    async abort() {},
    dispose() { this.active = false; },
    createReplacedSessionContext() { return { cwd: manager.cwd }; },
  };
  result.extensionRunner = { hasHandlers: () => true, async emit(event) {
    const phase = event.type === "session_shutdown" ? "shutdown" : "before";
    active.trace.push({ phase, event });
    if (phase === "before") {
      if (active.spec.race) fs.writeFileSync(event.targetSessionFile, "competitor");
      if (active.spec.cancel !== undefined) return { cancel: active.spec.cancel };
    }
  } };
  return result;
}
const specs = [
  {name:"new_memory",op:"new"}, {name:"new_persisted",op:"new",persist:true},
  {name:"new_parent",op:"new",parent:"parent.jsonl"}, {name:"new_empty_parent",op:"new",parent:""},
  {name:"new_cancel_true",op:"new",cancel:true}, {name:"new_cancel_string",op:"new",cancel:"stop"},
  {name:"new_cancel_number",op:"new",cancel:1}, {name:"new_cancel_false",op:"new",cancel:false},
  ...["factory","setup","rebind","with","invalidate"].map(fail=>({name:"new_fail_"+fail,op:"new",fail})),
  {name:"new_setup_reentrant",op:"new",reenter:true},
  {name:"switch",op:"switch",persist:true}, {name:"switch_cancel",op:"switch",persist:true,cancel:true},
  {name:"switch_missing_cwd",op:"switch",persist:true,missingCwd:true},
  {name:"switch_override",op:"switch",persist:true,missingCwd:true,override:true},
  {name:"switch_fail_trust",op:"switch",persist:true,fail:"trust"},
  ...[false,true].flatMap(persist=>["root","second","custom"].map(entry=>({name:`fork_${persist?"disk":"memory"}_${entry}`,op:"fork",persist,entry,position:entry==="custom"?"at":"before"}))),
  {name:"fork_invalid",op:"fork",entry:"missing"}, {name:"fork_non_user",op:"fork",entry:"custom"},
  {name:"fork_cancel_invalid",op:"fork",entry:"missing",cancel:true},
  {name:"fork_unflushed",op:"fork",persist:true,entry:"second",unflushed:true},
  ...["normal","collision","stored","missing","cancel","missing_cwd","override","race"].map(kind=>({name:"import_"+kind,op:"import",persist:true,kind,missingCwd:kind==="missing_cwd"||kind==="override",override:kind==="override",cancel:kind==="cancel"?true:undefined,race:kind==="race"})),
  {name:"dispose",op:"dispose"}, {name:"dispose_twice",op:"dispose",twice:true}, {name:"dispose_fail_invalidate",op:"dispose",fail:"invalidate"},
  {name:"initial_missing_cwd",op:"initial",persist:true,missingCwd:true},
];
try {
 for (const spec of specs) {
  // Stable scenario-relative paths, independent of oracle invocation.
  const base = path.join(root, spec.name); const a=path.join(base,"a"), b=path.join(base,"b"), store=path.join(base,"store"), agent=path.join(base,"agent");
  for (const dir of [a,b,store,agent]) fs.mkdirSync(dir,{recursive:true});
  const cwd = spec.op==="initial" && spec.missingCwd ? path.join(base,"missing-cwd") : a;
  const initialFile=path.join(store,"current.jsonl"), target=path.join(base,"target","target.jsonl");
  writeSession(initialFile,cwd); writeSession(target,spec.missingCwd?path.join(base,"missing-cwd"):b);
  if (spec.unflushed) fs.unlinkSync(initialFile);
  let manager=new Manager(cwd,spec.persist?store:"",!!spec.persist,spec.persist?initialFile:undefined);
  active={spec,trace:[]}; let count=0; let runtime;
  const factory=async options=> {
    active.trace.push({phase:"factory",cwd:options.cwd,agentDir:options.agentDir,start:options.sessionStartEvent,trust:!!options.projectTrustContext,oldActive:runtime?.session.active??null});
    if(spec.fail==="factory") throw new Error("factory rejected");
    const created=session(options.sessionManager,options.sessionStartEvent,++count);
    const diagnostics=[{type:"warning",message:`runtime-${count}`}];
    return {session:created,services:{cwd:options.cwd,agentDir:options.agentDir},diagnostics,modelFallbackMessage:`fallback-${count}`};
  };
  runtime=new AgentSessionRuntime(session(manager,undefined,0),{cwd:a,agentDir:agent},factory,[{type:"info",message:"initial"}],"initial-fallback");
  runtime.setBeforeSessionInvalidate(()=>{active.trace.push({phase:"invalidate",active:runtime.session.active});if(spec.fail==="invalidate")throw new Error("invalidate rejected");});
  runtime.setRebindSession(async s=>{active.trace.push({phase:"rebind",id:s.id});if(spec.fail==="rebind")throw new Error("rebind rejected");});
  const withSession=async ctx=>{active.trace.push({phase:"with",cwd:ctx.cwd});if(spec.fail==="with")throw new Error("with rejected");};
  let result,error;
  try {
   if(spec.op==="new") result=await runtime.newSession({parentSession:spec.parent,setup:async sm=>{
     active.trace.push({phase:"setup",id:runtime.session.id});if(spec.fail==="setup")throw new Error("setup rejected");
     sm.data.push({type:"message",id:"setup",message:{role:"user",content:"setup",timestamp:3}});
     if(spec.reenter)await runtime.newSession();
    },withSession});
   if(spec.op==="switch") result=await runtime.switchSession(target,{cwdOverride:spec.override?a:undefined,withSession,projectTrustContextFactory:cwd=>{active.trace.push({phase:"trust",cwd,oldActive:runtime.session.active});if(spec.fail==="trust")throw new Error("trust rejected");return{cwd};}});
   if(spec.op==="fork")result=await runtime.fork(spec.entry,{position:spec.position,withSession});
   if(spec.op==="import") {
     let source=spec.kind==="stored"?initialFile:target;
     if(spec.kind==="missing")source=path.join(base,"missing.jsonl");
     if(spec.kind==="collision") { fs.writeFileSync(path.join(store,"target.jsonl"),"existing");fs.writeFileSync(path.join(store,"target-1.jsonl"),"also-existing"); }
     result=await runtime.importFromJsonl(source,spec.override?a:undefined);
   }
   if(spec.op==="dispose") {await runtime.dispose();if(spec.twice)await runtime.dispose();}
   if(spec.op==="initial")await createAgentSessionRuntime(factory,{cwd:a,agentDir:agent,sessionManager:manager});
  } catch(e) { error=e.code==="EEXIST"?"exclusive copy refused":e.message; }
  const m=runtime.session.sessionManager;
  const files={}; for(const name of fs.readdirSync(store).filter(n=>["target.jsonl","target-1.jsonl","target-2.jsonl"].includes(n))) {
    const text=fs.readFileSync(path.join(store,name),"utf8");files[name]=text.startsWith('{')?"session":text;
  }
  rows.push({spec,observed:norm({trace:active.trace,result:result??null,error:error??null,slot:{id:runtime.session.id,cwd:runtime.cwd,active:runtime.session.active,diagnostics:runtime.diagnostics,fallback:runtime.modelFallbackMessage,parent:m.parent??null,messages:runtime.session.agent.state.messages.filter(m=>m.role==="user").map(m=>m.content)},files})});
 }
 const cwdRows=[];
 for(const [name,file,cwd] of [["memory",undefined,path.join(root,"absent")],["empty_file","",path.join(root,"absent")],["empty_cwd","session.jsonl",""],["present","session.jsonl",root],["missing","session.jsonl",path.join(root,"absent")]]) {
  const issue=cwdModule.namespace.getMissingSessionCwdIssue({getSessionFile:()=>file,getCwd:()=>cwd},"fallback");
  cwdRows.push({name,observed:norm({issue:issue??null,error:issue?cwdModule.namespace.formatMissingSessionCwdError(issue):null,prompt:issue?cwdModule.namespace.formatMissingSessionCwdPrompt(issue):null})});
 }
 console.log(JSON.stringify({provenance:{sources:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,createHash("sha256").update(v).digest("hex")])),collaborators:["SessionManager lifecycle double","AgentSession + extension runner trace double","SDK/service exports fail-on-use","resolvePath: absolute paths only; node path.resolve","real node:fs/path","complete unchanged session-cwd.ts"]},rows,cwdRows},null,2));
} finally {
 // Cleanup is restricted to the exact mkdtemp allocation, never user paths.
 if(!root.startsWith(path.join(tmpdir(),"pi-runtime-oracle-")))throw new Error("unsafe cleanup path");
 fs.rmSync(root,{recursive:true,force:true});
}
