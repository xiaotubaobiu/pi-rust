// Real upstream bash.ts, powershell.ts, output accumulator and truncation.
// Injected operations/environment/clock; rendering and TypeBox are collaborators.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
const work=path.dirname(fileURLToPath(import.meta.url));
const root=process.env.PI_BASH_ORACLE_SOURCE??path.resolve(work,'../../../../../pi/packages/coding-agent/src/core/tools');
const sources={};
function load(name,deps,names){
 const raw=fs.readFileSync(path.join(root,name),'utf8');sources[name]=crypto.createHash('sha256').update(raw).digest('hex');
 const code=stripTypeScriptTypes(raw.replace(/^import\b[\s\S]*?;\s*$/gm,''),{mode:'strip'}).replace(/\bexport\s+/g,'');
 return new Function(...Object.keys(deps),code+'\nreturn {'+names.join(',')+'};')(...Object.values(deps));
}
const opt=Symbol('optional');const Type={String:(o={})=>({type:'string',...o}),Number:(o={})=>({type:'number',...o}),Optional:(v)=>{Object.defineProperty(v,opt,{value:true});return v;},Object:(properties)=>({type:'object',properties,required:Object.keys(properties).filter(k=>!properties[k][opt])})};
const trunc=load('truncate.ts',{},['DEFAULT_MAX_BYTES','DEFAULT_MAX_LINES','formatSize','truncateTail']);
const specs=[];function add(id,chunks=[],extra={}){specs.push({id,chunks,...extra});}
add('empty');add('text',[{text:'hello\n'}]);add('no-updates',[{text:'hello'}],{emitUpdates:false});
add('fast-chunks',[{text:'a'},{text:'b'},{text:'c'}]);
add('throttled',[{text:'a'},{text:'b',at:40},{text:'c',at:70},{text:'d',at:140},{text:'e',at:190}],{endAt:230});
add('idle-timer-before-finish',[{text:'a'},{text:'b',at:40}],{endAt:180});
add('finish-dirty',[{text:'a'},{text:'b',at:40}],{endAt:60});
add('incomplete-no-dirty-final',[{hex:'f09f'}]);
add('incomplete-dirty-final',[{hex:'f09f'},{hex:'99'}]);
add('split-bom',[{hex:'ef'},{hex:'bb'},{hex:'bf41'}]);
add('exit-nonzero',[{text:'stderr\n'}],{exitCode:7});add('exit-empty',[],{exitCode:2});add('exit-null',[],{exitCode:null});
add('aborted-partial',[{text:'partial'}],{error:'aborted'});add('aborted-empty',[],{error:'aborted'});
add('timeout-partial',[{text:'partial'}],{error:'timeout:5',timeout:5});add('timeout-extra-colon',[],{error:'timeout:2:ignored'});
add('other-error',[{text:'discarded'}],{error:'remote failure'});
add('truncate-lines',[{text:'a\n',repeat:2007}]);
add('truncate-bytes',[{text:'世界'.repeat(100)+'\n',repeat:110}]);
add('truncate-partial',[{text:'🙂',repeat:20000}]);
add('truncate-cancel',[{text:'a\n',repeat:2010}],{error:'aborted'});
const stale=[['PI_SESSION_ID','old'],['PI_SESSION_FILE','old-file'],['PI_PROVIDER','old-provider'],['PI_MODEL','old-model'],['PI_REASONING_LEVEL','old-reason'],['Path','orig'],['pi_model','lower']];
add('env-no-context',[],{env:stale});
add('env-session',[],{env:stale,context:{cwd:'$SESSION-CWD',sessionId:'session123',sessionFile:'$SESSION-FILE',model:{provider:'provider',id:'model'},thinkingLevel:'high'}});
add('env-no-file',[],{env:stale,context:{cwd:'',sessionId:'session456',thinkingLevel:'off'}});
add('env-empty-model',[],{context:{cwd:'$CWD',sessionId:'',model:{provider:'',id:''},thinkingLevel:''}});
add('env-disabled',[],{env:stale,exposeSessionEnvironment:false,context:{cwd:'$SESSION-CWD',sessionId:'session123',sessionFile:'$SESSION-FILE',model:{provider:'provider',id:'model'},thinkingLevel:'high'}});
add('prefix-before-hook',[],{commandPrefix:'setup',hook:'rewrite',env:stale,context:{cwd:'$SESSION-CWD',sessionId:'session123'}});
add('hook-error',[],{hook:'error'});
add('powershell',[{text:'雪🙂\n'}],{powershell:true});
add('powershell-disabled',[],{powershell:true,exposeSessionEnvironment:false});
const cases=[];let metadata,timeoutCases;
for(const spec of specs){
 const temp=fs.mkdtempSync(path.join(work,'shell-oracle-temp-'));
 const accumulator=load('output-accumulator.ts',{...trunc,randomBytes:crypto.randomBytes,createWriteStream:fs.createWriteStream,tmpdir:()=>temp,join:path.join},['OutputAccumulator']);
 let now=1000;let next=1;const timers=new Map();
 const advance=(relative)=>{const target=1000+relative;while(true){const item=[...timers].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!item)break;timers.delete(item[0]);now=item[1].at;item[1].fn();}now=target;};
 const bash=load('bash.ts',{...trunc,...accumulator,Type,BASH_UPDATE_THROTTLE_MS:100,createShellRenderers:()=>({}),getShellEnv:()=>Object.fromEntries(spec.env??[['PATH','base']]),Date:{now:()=>now},setTimeout:(fn,delay)=>{const id=next++;timers.set(id,{at:now+delay,fn});return id;},clearTimeout:id=>timers.delete(id)},['createBashToolDefinition','createShellToolDefinition','resolveTimeoutMs']);
 const powershell=load('powershell.ts',{...bash},['createPowerShellToolDefinition']);
 const calls=[],updates=[];
 const options={exposeSessionEnvironment:spec.exposeSessionEnvironment,commandPrefix:spec.commandPrefix,operations:{exec:async(command,cwd,o)=>{
   calls.push({command,cwd,env:Object.entries(o.env),timeout:o.timeout,aborted:o.signal?.aborted});
   for(const chunk of spec.chunks){advance(chunk.at??0);o.onData(chunk.hex!==undefined?Buffer.from(chunk.hex,'hex'):Buffer.from((chunk.text??'').repeat(chunk.repeat??1)));}
   if(spec.endAt!==undefined)advance(spec.endAt);
   if(spec.error)throw Error(spec.error);return {exitCode:spec.exitCode===undefined?0:spec.exitCode};
 }}};
 if(spec.hook)options.spawnHook=c=>{if(spec.hook==='error')throw Error('hook failed');return {command:c.command+'\nhook',cwd:'$HOOK-CWD',env:{...c.env,HOOK:'yes'}};};
 const tool=spec.powershell?powershell.createPowerShellToolDefinition('$CWD',options):bash.createBashToolDefinition('$CWD',options);
 const context=spec.context?{cwd:spec.context.cwd,model:spec.context.model,thinkingLevel:spec.context.thinkingLevel,sessionManager:{getSessionId:()=>spec.context.sessionId,getSessionFile:()=>spec.context.sessionFile}}:undefined;
 const files=()=>fs.readdirSync(temp);
 const normalize=(v)=>JSON.parse(JSON.stringify(v).split(temp.split('\\').join('\\\\')).join('$TEMP'));
 let outcome;try{outcome={value:await tool.execute('id',{command:'command',...(spec.timeout!==undefined?{timeout:spec.timeout}:{})},undefined,spec.emitUpdates===false?undefined:u=>updates.push(JSON.parse(JSON.stringify(u))),context)};}catch(e){outcome={error:e.message};}
 const paths=files();const spill=paths.length?path.join(temp,paths[0]):null;
 const clean=(v)=>{let s=JSON.stringify(v);if(spill)s=s.split(JSON.stringify(spill).slice(1,-1)).join('$SPILL');return JSON.parse(s);};
 cases.push(clean({...spec,calls,updates,outcome,fullOutputHex:spill?fs.readFileSync(spill).toString('hex'):null,pendingTimers:timers.size}));
 if(!metadata){const getMeta=t=>{const {name,label,description,promptSnippet,promptGuidelines,parameters,constrainedSampling}=t;return {name,label,description,promptSnippet,promptGuidelines,parameters,constrainedSampling};};metadata=[getMeta(tool),getMeta(powershell.createPowerShellToolDefinition('$CWD',options)),getMeta(bash.createBashToolDefinition('$CWD',{...options,exposeSessionEnvironment:false}))];
 timeoutCases=[null,0,-1,0.0001,1,2147483.647,2147483.648,'NaN','Infinity','-Infinity'].map(input=>{let outcome;try{outcome={value:bash.resolveTimeoutMs(input===null?undefined:Number(input))??null};}catch(e){outcome={error:e.message};}return {input,outcome};});}
 if(!path.resolve(temp).startsWith(path.resolve(work)+path.sep))throw Error('unsafe cleanup');fs.rmSync(temp,{recursive:true,force:true});
}
const result={provenance:{sources,boundary:'Actual upstream TypeScript execute/output/truncation with injected operations, environment and deterministic JS timers. TypeBox construction and rendering mocked; native process behavior tested separately.'},metadata,timeoutCases,cases};
const target=process.argv[2]??path.join(work,'bash-oracle.json');fs.writeFileSync(target,JSON.stringify(result,null,2)+'\n');console.log({cases:cases.length,sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')});
