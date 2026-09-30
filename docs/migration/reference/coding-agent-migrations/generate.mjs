import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
const work=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(work,'../../../../../pi/packages');
const sources={};
for(const [name,file] of Object.entries({migrations:'coding-agent/src/migrations.ts',keybindings:'coding-agent/src/core/keybindings.ts',tui:'tui/src/keybindings.ts'})) sources[name]=fs.readFileSync(path.join(root,file),'utf8');
const strip=s=>s.replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const tui=sources.tui.slice(sources.tui.indexOf('export const TUI_KEYBINDINGS'),sources.tui.indexOf('export interface KeybindingConflict'));
const key=sources.keybindings.slice(0,sources.keybindings.indexOf('function loadRawConfig'));
const code=stripTypeScriptTypes(strip(tui)+'\n'+strip(key)+'\n'+strip(sources.migrations)+'\nglobalThis.api={runMigrations,migrateAuthToAuthJson,migrateSessionsFromAgentRoot,showDeprecationWarnings};',{mode:'strip'});
const entries=[
 {id:'empty',files:{}},
 {id:'existing-auth-skips-all-auth-migration',files:{'agent/auth.json':'{ existing invalid auth }','agent/oauth.json':'{"a":{"token":"old"}}','agent/settings.json':'{"apiKeys":{"b":"new"}}'}},
 {id:'oauth-key-precedence-bom-and-numeric-keys',files:{'agent/oauth.json':'\uFEFF{"z":{"access":"offline","type":"custom"},"10":{"expires":1.0},"2":{"refresh":"fixture"}}','agent/settings.json':'\uFEFF{"apiKeys":{"z":"ignored","b":"key-only","n":42,"empty":""},"x":1.0}'}},
 {id:'malformed-oauth-valid-settings',files:{'agent/oauth.json':'{ malformed','agent/settings.json':'{"apiKeys":{"test":"fake"},"array":[1e21,1e-7,-0,1.5]}' }},
 {id:'null-oauth-unchanged-and-array-keys',files:{'agent/oauth.json':'null','agent/settings.json':'{"apiKeys":["zero",null,"two"]}'}},
 {id:'oauth-spread-scalars',files:{'agent/oauth.json':'{"a":null,"b":true,"c":"abc","d":[1,2]}' }},
 {id:'oauth-astral-string-spread',files:{'agent/oauth.json':'{"emoji":"x🙂","nested":{"access":"🙂","10":2,"3":1}}'}},
 {id:'oauth-top-level-astral-string',files:{'agent/oauth.json':'"🙂"'}},
 {id:'prototype-inherited-api-keys',files:{'agent/oauth.json':'{"__proto__":{"inherited":"value","falsey":false}}','agent/settings.json':'{"apiKeys":{"toString":"skip","constructor":"skip","inherited":"skip","falsey":"keep","normal":"key"}}'}},
 {id:'empty-keys-removed-but-no-auth-file',files:{'agent/settings.json':'{"apiKeys":{},"x":true}'}},
 {id:'keybindings-upgrade-collision-and-extra-order',files:{'agent/keybindings.json':'\uFEFF{"interrupt":"ctrl+c","app.interrupt":"escape","undo":["ctrl+z"],"zzz":null,"2":1,"a":{"9":1,"2":2}}'}},
 {id:'keybindings-non-object-ignored',files:{'agent/keybindings.json':'["interrupt"]'}},
 {id:'keybindings-no-legacy-is-byte-preserved',files:{'agent/keybindings.json':' { "app.interrupt" : "escape" } \r\n'}},
 {id:'commands-tools-and-deprecations',files:{'agent/commands/a.md':'global','project/.pi/commands/b.md':'project','agent/tools/rg':'old','agent/tools/fd.exe':'move','agent/bin/rg':'keep','agent/tools/custom.ts':'custom','project/.pi/tools/RG.exe':'ignored','project/.pi/tools/.hidden':'ignored','project/.pi/tools/a.ts':'warn'},dirs:['agent/hooks','project/.pi/hooks']},
 {id:'commands-existing-prompts-preserved',files:{'agent/commands/a.md':'old','agent/prompts/b.md':'new','project/.pi/tools/.hidden':'hidden','project/.pi/tools/FD':'recognized'}},
 {id:'session-root-migration',files:{'agent/old.jsonl':'{"type":"session","cwd":"/work/foo:bar"}\n{"keep":"exact"}\n','agent/invalid.jsonl':'bad\n','agent/empty.jsonl':'\nbody','agent/wrong.jsonl':'{"type":"message","cwd":"/tmp"}\n','agent/non-string.jsonl':'{"type":"session","cwd":42}\n','agent/bom.jsonl':'\uFEFF{"type":"session","cwd":"/work"}\n'}},
 {id:'session-destination-conflict',files:{'agent/old.jsonl':'{"type":"session","cwd":"/work"}\n','agent/sessions/--work--/old.jsonl':'existing'}},
];
const cases=[];
for(const platform of ["win32","posix"]) for(const spec of entries){
 const temp=fs.mkdtempSync(path.join(work,'migration-oracle-temp-'));
 const impl=platform==='win32'?path.win32:path.posix; const base=platform==='posix'?temp.replaceAll('\\','/'):temp;
 const agent=impl.join(base,'agent'),cwd=impl.join(base,'project');
 fs.mkdirSync(agent,{recursive:true});fs.mkdirSync(cwd,{recursive:true});
 for(const d of spec.dirs??[])fs.mkdirSync(path.join(temp,d),{recursive:true});
 for(const [p,text] of Object.entries(spec.files)){fs.mkdirSync(path.dirname(path.join(temp,p)),{recursive:true});fs.writeFileSync(path.join(temp,p),text);}
 const messages=[];let chalk;chalk=new Proxy(s=>s,{get:()=>chalk});
 const context=vm.createContext({...fs,join:impl.join,dirname:impl.dirname,CONFIG_DIR_NAME:'.pi',getAgentDir:()=>agent,getBinDir:()=>impl.join(agent,'bin'),stripBom:s=>s.startsWith('\uFEFF')?s.slice(1):s,chalk,console:{log:s=>messages.push(s??'')},process:{platform:process.platform,env:{}}});
 vm.runInContext(code,context);
 const result=JSON.parse(JSON.stringify(context.api.runMigrations(cwd)));
 function tree(dir,prefix=''){
   const output={};for(const ent of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=prefix+ent.name;if(ent.isDirectory())Object.assign(output,tree(path.join(dir,ent.name),p+'/'));else output[p]=fs.readFileSync(path.join(dir,ent.name),'utf8');}return output;
 }
 const after=tree(temp);const second=JSON.parse(JSON.stringify(context.api.runMigrations(cwd)));const afterSecond=tree(temp);
 cases.push({platform,...spec,result,messages,after,second,afterSecond});
 // Each resolved root is fixture-created beneath this generator workspace.
 const resolved=path.resolve(temp);if(!resolved.startsWith(path.resolve(work)+path.sep))throw new Error('unsafe cleanup');fs.rmSync(resolved,{recursive:true,force:true});
}
const warningCases=[];
for(const warnings of [[],['one'],['first','second']]){
 const trace=[];
 const context=vm.createContext({chalk:{yellow:message=>({style:'warning',message}),dim:message=>({style:'dim',message})},console:{log:value=>trace.push(['log',value?.style??'plain',value?.message??value??''])},process:{stdin:{setRawMode:value=>trace.push(['raw',value]),resume:()=>trace.push(['resume']),pause:()=>trace.push(['pause']),once:(event,callback)=>{trace.push(['once',event]);queueMicrotask(callback);}}}});
 vm.runInContext(code,context);await context.api.showDeprecationWarnings(warnings);warningCases.push({warnings,trace});
}
const out={provenance:{platform:process.platform,sources:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,crypto.createHash('sha256').update(v).digest('hex')])),boundary:'Real upstream migrations and real filesystem, real TUI/app keybinding definition/migration code. Config paths/chalk are injected. Windows paths run natively; POSIX joins use forward-slash paths on Windows (not a Linux OS validation). Records the Windows source filename split/join quirk.'},cases,warningCases};
const target=process.argv[2]||path.join(work,'migrations-oracle.json');fs.writeFileSync(target,JSON.stringify(out,null,2)+'\n');console.log({cases:cases.length,sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')});
