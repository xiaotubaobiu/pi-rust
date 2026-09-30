// Runs the actual tools-manager.ts with deterministic filesystem/process/HTTP collaborators.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';import {Readable,Writable} from 'node:stream';import {pipeline} from 'node:stream/promises';
const source=process.env.PI_TOOLS_MANAGER_ORACLE_SOURCE,output=process.env.PI_TOOLS_MANAGER_ORACLE_OUTPUT;
if(!source||!output)throw Error('set PI_TOOLS_MANAGER_ORACLE_SOURCE and PI_TOOLS_MANAGER_ORACLE_OUTPUT');
const raw=fs.readFileSync(source,'utf8');const code=stripTypeScriptTypes(raw.replace(/^import\b[\s\S]*?;\s*$/gm,''),{mode:'strip'}).replace(/\bexport\s+/g,'');
const factory=new Function('spawnSync','chmodSync','createWriteStream','existsSync','mkdirSync','readdirSync','renameSync','rmSync','arch','platform','join','Readable','pipeline','APP_NAME','getBinDir','fetchWithRetry','process','Date','Math',code+'\nreturn {TOOLS,getToolPath,getLatestVersion,ensureTool,extractZipArchive,extractTarGzArchive,findBinaryRecursively};');
const specs=[];const add=(id,v)=>specs.push({id,...v});
for(const tool of ['fd','rg'])for(const platform of ['linux','darwin','win32','android','freebsd'])for(const arch of ['x64','arm64','ia32'])add(`asset-${tool}-${platform}-${arch}`,{op:'asset',tool,platform,arch});
for(const platform of ['linux','win32'])for(const tool of ['fd','rg']){
 add(`local-${platform}-${tool}`,{op:'discover',tool,platform,local:true});
 add(`system-${platform}-${tool}`,{op:'discover',tool,platform,commands:{[tool]:{status:0}}});
 add(`nonzero-${platform}-${tool}`,{op:'discover',tool,platform,commands:{[tool]:{status:9}}});
 add(`missing-${platform}-${tool}`,{op:'discover',tool,platform});
}
add('fdfind-fallback',{op:'discover',tool:'fd',commands:{fdfind:{status:0}}});
for(const offline of ['1','true','TRUE','YeS',' true','0','false',''])add('offline-'+offline,{op:'ensure',tool:'rg',env:{PI_OFFLINE:offline},failure:{message:'fetch failed',causes:['same','same','DNS failure','root','beyond depth']}});
for(const tool of ['fd','rg'])add('android-'+tool,{op:'ensure',tool,platform:'android'});
for(const [id,status,location] of [
 ['absolute',302,'https://github.com/sharkdp/fd/releases/tag/v10.4.2'],['relative',301,'/sharkdp/fd/releases/tag/v10.4.2'],['no-v',307,'/a/releases/tag/15.0.0'],['encoded',302,'/a/releases/tag/v1%2Fbeta%20x'],['double-v',303,'/a/releases/tag/vv1'],['fragment',308,'/a/releases/tag/v10?x=1#frag'],['external',302,'https://example.invalid/a/releases/tag/v2'],['no-redirect',200,'/a/releases/tag/v1'],['no-location',404,null],['empty',302,''],['wrong-path',302,'https://github.com/login'],['trailing',302,'/a/releases/tag/'],['malformed',302,'/a/releases/tag/v%ZZ'],['invalid-url',302,'https://[bad/releases/tag/v1'],['lowercase-v-only',302,'/a/releases/tag/V1'],['empty-version',302,'/a/releases/tag/v']
])add('latest-'+id,{op:'latest',status,location});
add('cancel-error-ignored',{op:'latest',status:302,location:'/a/releases/tag/v1',cancelError:true});
for(const platform of ['linux','darwin','win32'])for(const tool of ['fd','rg'])for(const layout of ['nested','root','recursive','missing'])add(`install-${platform}-${tool}-${layout}`,{op:'ensure',platform,tool,layout,commands:{tar:{status:0},'tar.exe':{status:0}}});
add('win-prefer-system-tar',{op:'ensure',platform:'win32',tool:'rg',layout:'root',env:{SYSTEMROOT:'C:\\Windows'},systemTar:true,commands:{'C:\\Windows\\System32\\tar.exe':{status:0}}});
add('win-powershell-fallback',{op:'ensure',platform:'win32',tool:'fd',layout:'root',commands:{'tar.exe':{status:1,stderr:' bad zip \n'},'powershell.exe':{status:0}}});
add('win-extract-failure',{op:'ensure',platform:'win32',tool:'fd',layout:'root',commands:{'tar.exe':{status:1,stderr:' bad zip \n'},'powershell.exe':{status:2,stdout:' failed \ufeff'}}});
add('tar-error-precedence',{op:'ensure',tool:'rg',commands:{tar:{error:'cannot spawn',status:1,stderr:'not used'}}});
add('tar-null-status',{op:'ensure',tool:'fd',commands:{tar:{status:null}}});
add('download-error',{op:'ensure',tool:'fd',downloadStatus:403});
add('download-no-body',{op:'ensure',tool:'rg',noBody:true});
add('unsupported-platform-after-version',{op:'ensure',tool:'fd',platform:'freebsd'});
for(const spec of specs){
 spec.platform??='linux';spec.arch??='x64';spec.tool??='fd';
 const p=spec.platform==='win32'?path.win32:path.posix;const root=spec.platform==='win32'?'C:\\tools':'/tools';
 const trace=[],statuses=[],files={};let extracted=false;const binary=spec.tool+(spec.platform==='win32'?'.exe':'');let asset='';
 const extraction=p.join(root,`extract_tmp_${spec.tool}_7_1000_i`);
 const nested=()=>p.join(extraction,asset.replace(/\.(tar\.gz|zip)$/,''),binary);
 const exists=name=>{trace.push(['exists',name]);return (spec.local&&name===p.join(root,binary))||(spec.systemTar&&name===p.join('C:\\Windows','System32','tar.exe'))||(extracted&&((spec.layout==='nested'&&name===nested())||(spec.layout==='root'&&name===p.join(extraction,binary))));};
 const env=new Proxy(spec.env??{},{get(target,key){return target[spec.platform==='win32'?Object.keys(target).find(k=>k.toLowerCase()===String(key).toLowerCase()):key];}});
 const http=async(url,init,options)=>{
  trace.push(['fetch',url,init??null,options]);
  if(spec.failure){let cause;for(const message of [...spec.failure.causes].reverse())cause=new Error(message,{cause});throw new TypeError(spec.failure.message,{cause});}
  if(url.endsWith('/latest')){const response={status:spec.status??302,headers:new Headers({...(spec.location===null?{}:{location:spec.location??`/a/releases/tag/${spec.tool==='fd'?'v':''}12.3.4`})}),body:{cancel:async()=>{trace.push(['cancel']);if(spec.cancelError)throw Error('cancel error');}}};return response;}
  asset=url.split('/').pop();return {status:spec.downloadStatus??200,ok:(spec.downloadStatus??200)<300,body:spec.noBody?null:new ReadableStream({start(c){c.enqueue(Buffer.from('archive'));c.close();}})};
 };
 const api=factory((command,args)=>{trace.push(['spawn',command,args]);const record=spec.commands?.[command]??{error:'not found'};if(args[0]!=='--version'&&!record.error&&record.status===0)extracted=true;return {...record,error:record.error?Error(record.error):undefined,stdout:Buffer.from(record.stdout??''),stderr:Buffer.from(record.stderr??'')};},(name,mode)=>trace.push(['chmod',name,mode]),name=>{trace.push(['create',name]);files[name]='';return new Writable({write(chunk,_encoding,cb){files[name]+=chunk.toString();cb();}});},exists,name=>trace.push(['mkdir',name]),name=>{trace.push(['readdir',name]);const entries=spec.layout==='recursive'?(name===extraction?[['a','dir'],['z','dir']]:name===p.join(extraction,'z')?[[binary,'file']]:[]):[];return entries.map(([name,kind])=>({name,isFile:()=>kind==='file',isDirectory:()=>kind==='dir'}));},(a,b)=>trace.push(['rename',a,b]),(name,opts)=>trace.push(['remove',name,opts]),()=>spec.arch,()=>spec.platform,p.join,Readable,pipeline,'pi',()=>root,http,{env,pid:7},{now:()=>1000},{random:()=>0.5});
 let outcome;try{
  let value;if(spec.op==='asset')value=api.TOOLS[spec.tool].getAssetName('1.2.3',spec.platform,spec.arch);
  else if(spec.op==='discover')value=api.getToolPath(spec.tool);
  else if(spec.op==='latest')value=await api.getLatestVersion('sharkdp/fd');
  else value=await api.ensureTool(spec.tool,status=>statuses.push(status));
  outcome={value:value??null};
 }catch(error){outcome={error:{name:error.name,message:error.message}};}
 spec.trace=trace;spec.statuses=statuses;spec.files=files;spec.outcome=outcome;
}
fs.writeFileSync(output,JSON.stringify({upstream:'packages/coding-agent/src/utils/tools-manager.ts',sha256:crypto.createHash('sha256').update(raw).digest('hex'),cases:specs},null,2)+'\n');console.log(specs.length+' tools-manager cases');
