// Executes actual upstream shell.ts with injected platform/filesystem/process lookup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
const work=path.dirname(fileURLToPath(import.meta.url));
const source=process.env.PI_SHELL_ORACLE_SOURCE??path.resolve(work,'../../../../../pi/packages/coding-agent/src/utils/shell.ts');
const raw=fs.readFileSync(source,'utf8');
const code=stripTypeScriptTypes(raw.replace(/^import\b[\s\S]*?;\s*$/gm,''),{mode:'strip'}).replace(/\bexport\s+/g,'');
const factory=new Function('existsSync','delimiter','join','spawn','spawnSync','getBinDir','process',code+'\nreturn {getShellConfig,getPowerShellConfig,getShellEnv,isLegacyWslBashPath,sanitizeBinaryOutput};');
function load(spec){
 const trace=[];
 // Windows process.env property lookup is case-insensitive, even though object
 // spread (used in getShellEnv) preserves the original key spelling/order.
 const values=Object.fromEntries(spec.env??[]);
 const env=spec.windows&&!spec.plainEnvironment?new Proxy(values,{get(target,key){
   if(typeof key!=='string')return Reflect.get(target,key);
   return target[Object.keys(target).find(k=>k.toLowerCase()===key.toLowerCase())];
 }}):values;
 const api=factory(p=>{trace.push(['exists',p]);return (spec.exists??[]).includes(p);},spec.windows?';':':',path.join,()=>{throw Error('unexpected spawn')},(name,args,opts)=>{
   trace.push(['lookup',name,args,opts]);const value=spec.lookup?.[args[0]];return value===undefined?{status:1,stdout:''}:typeof value==='string'?{status:0,stdout:value}:value;
 },()=>spec.bin??'$BIN',{platform:spec.windows?'win32':'linux',env});
 return {api,trace};
}
const specs=[];const add=(id,spec)=>specs.push({id,...spec});
for(const windows of [false,true]){
 const suffix=windows?'win':'posix';
 add('custom-'+suffix,{windows,custom:'/custom/bash',exists:['/custom/bash']});
 add('missing-custom-'+suffix,{windows,custom:'/absent'});
 add('empty-custom-'+suffix,{windows,custom:'',exists:['/bin/bash']});
 add('default-'+suffix,{windows});
 add('which-trust-'+suffix,{windows,lookup:{[windows?'bash.exe':'bash']:'/special/bash\n'}});
 add('first-match-'+suffix,{windows,exists:['/first','/second'],lookup:{[windows?'bash.exe':'bash']:' \ufeff/first\r\n/second\n'}});
 add('bad-first-no-fallback-'+suffix,{windows,exists:['/second'],lookup:{[windows?'bash.exe':'bash']:'/absent\n/second\n'}});
 add('double-cr-'+suffix,{windows,exists:['/first\r'],lookup:{[windows?'bash.exe':'bash']:'/first\r\r\n/second'}});
 add('failed-lookup-'+suffix,{windows,lookup:{[windows?'bash.exe':'bash']:{status:1,stdout:'/not-found'}}});
 add('empty-lookup-'+suffix,{windows,lookup:{[windows?'bash.exe':'bash']:'\ufeff \r\n '}});
 add('powershell-'+suffix,{windows,kind:'powershell',exists:['C:\\pwsh.exe','C:\\powershell.exe'],lookup:{'pwsh.exe':'C:\\pwsh.exe\r\n','powershell.exe':'C:\\powershell.exe\n'}});
}
add('unix-bin-before-which',{exists:['/bin/bash'],lookup:{bash:'/custom'}});
add('git-primary',{windows:true,env:[['ProgramFiles','C:\\Programs'],['ProgramFiles(x86)','D:\\x86']],exists:['C:\\Programs\\Git\\bin\\bash.exe','D:\\x86\\Git\\bin\\bash.exe']});
add('git-secondary',{windows:true,env:[['ProgramFiles','C:\\Programs'],['ProgramFiles(x86)','D:\\x86']],exists:['D:\\x86\\Git\\bin\\bash.exe']});
add('git-missing-error',{windows:true,env:[['ProgramFiles','C:\\Programs'],['ProgramFiles(x86)','D:\\x86']]});
add('git-empty-env',{windows:true,env:[['ProgramFiles','']]});
for(const key of ['PROGRAMFILES','programfiles','pRoGrAmFiLeS'])add('git-case-'+key,{windows:true,env:[[key,'C:\\Programs']],exists:['C:\\Programs\\Git\\bin\\bash.exe']});
add('git-secondary-uppercase',{windows:true,env:[['PROGRAMFILES(X86)','D:\\x86']],exists:['D:\\x86\\Git\\bin\\bash.exe']});
add('powershell-fallback',{windows:true,kind:'powershell',exists:['C:\\powershell.exe'],lookup:{'pwsh.exe':'C:\\missing.exe','powershell.exe':'C:\\powershell.exe\r\n'}});
add('powershell-absent',{windows:true,kind:'powershell'});
const paths=['C:\\Windows\\System32\\bash.exe','d:/WINDOWS/sysnative/BASH.EXE','C:\\Windows\\System32\\bash.exe\n','C:\\Windows\\System32\\bash.exe\r\n','C:\\Windows\\System32\\bash.exe\u2028','C:/Windows/System32/bash.exe/','C:\\Git\\bin\\bash.exe','1:/windows/system32/bash.exe','é:/windows/system32/bash.exe','C:/Windows//System32/bash.exe','C:/Windows/System32/bash.exe\0'];
for(let i=0;i<paths.length;i++)add('custom-wsl-'+i,{windows:true,custom:paths[i],exists:[paths[i]]});
const cases=specs.map(spec=>{const {api,trace}=load(spec);let outcome;try{outcome={value:spec.kind==='powershell'?api.getPowerShellConfig():api.getShellConfig(spec.custom)};}catch(e){outcome={error:e.message};}return {...spec,outcome,trace};});
// Pure getShellEnv collaborators deliberately include duplicate PATH spellings.
// Use a plain record there; such duplicates cannot exist in native Windows
// process.env, but must not be collapsed by the test harness's property proxy.
const environments=[];
for(const windows of [false,true])for(const env of [[],[['X','a']],[['Path','']], [['PATH','$BIN']], [['Path','$BIN'+(windows?';':':')+'x']], [['PATH','x'+(windows?';;':'::')+'$BIN']], [['Path','lower'],['PATH','upper']], [['PATH',' $BIN']], [['path','$bin']]]){
 const spec={windows,env,bin:'$BIN'};environments.push({...spec,value:Object.entries(load({...spec,plainEnvironment:true}).api.getShellEnv())});
}
const unitsCases=[[],[0x09,10,13,0x1f,0,32],[0xd800],[0xdc00],[0xd83d,0xde42],[0x200b,0x200e,0x202a,0x2060,0xfeff,0xfff9,0xfffa,0xfffb,0xfffc,0xffff],Array.from({length:256},(_,i)=>i)];
const sanitize=unitsCases.map(units=>{const out=load({}).api.sanitizeBinaryOutput(String.fromCharCode(...units));return {units,value:Array.from({length:out.length},(_,i)=>out.charCodeAt(i))};});
const result={provenance:{sourceSha256:crypto.createHash('sha256').update(raw).digest('hex'),boundary:'Actual upstream shell.ts; injected platform/environment/path existence/spawnSync. Not an OS process integration test.'},cases,environments,sanitize};
const target=process.argv[2]??path.join(work,'shell-config-oracle.json');fs.writeFileSync(target,JSON.stringify(result,null,2)+'\n');console.log({cases:cases.length,environments:environments.length,sanitize:sanitize.length,sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')});
