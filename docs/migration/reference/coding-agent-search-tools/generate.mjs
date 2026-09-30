// Real find.ts / grep.ts execution. Only process/fs, TypeBox constructors and
// renderers are injected. Readline, JSON handling and truncate.ts are upstream.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {stripTypeScriptTypes} from 'node:module';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';import {createInterface} from 'node:readline';
const source=process.env.PI_SEARCH_ORACLE_SOURCE,output=process.env.PI_SEARCH_ORACLE_OUTPUT;if(!source||!output)throw Error('set source and output');
const provenance={};function load(file,deps,names){const raw=fs.readFileSync(path.join(source,file),'utf8');provenance[file]=crypto.createHash('sha256').update(raw).digest('hex');const code=stripTypeScriptTypes(raw.replace(/^import\b[\s\S]*?;\s*$/gm,''),{mode:'strip'}).replace(/\bexport\s+/g,'');return new Function(...Object.keys(deps),code+'\nreturn {'+names.join(',')+'};')(...Object.values(deps));}
const optional=Symbol();const Type={String:(o={})=>({type:'string',...o}),Number:(o={})=>({type:'number',...o}),Boolean:(o={})=>({type:'boolean',...o}),Optional:v=>{Object.defineProperty(v,optional,{value:true});return v;},Object:properties=>{const required=Object.keys(properties).filter(k=>!properties[k][optional]);return {type:'object',properties,...required.length?{required}:{}};}};
const truncation=load('core/tools/truncate.ts',{},['DEFAULT_MAX_BYTES','GREP_MAX_LINE_LENGTH','formatSize','truncateHead','truncateLine']);
const specs=[];const add=(id,v)=>specs.push({id,...v});
for(const windows of [false,true]){
 const root=windows?'C:\\work':'/work';const p=windows?path.win32:path.posix;const file=p.join(root,'src','file.ts');const elsewhere=windows?'D:\\outside.txt':'/outside.txt';
 const f=(id,v)=>add('find-'+(windows?'win-':'posix-')+id,{kind:'find',windows,root,input:{pattern:'*.ts'},...v});
 f('custom',{custom:true,results:[file,'relative.txt',p.join(root,'dir')+p.sep,elsewhere]});
 for(const limit of [0,-1,1,2.5,3])f('custom-limit-'+limit,{custom:true,input:{pattern:'*',limit},results:['a','b','c']});
 f('custom-empty',{custom:true,results:[]});f('custom-missing',{custom:true,exists:false});f('custom-error',{custom:true,globError:'glob failed'});
 f('custom-bytes',{custom:true,results:Array.from({length:100},(_,i)=>i+'-'+'界'.repeat(1000))});
 for(const pattern of ['*.ts','src/**/*.spec.ts','**/*.json','/absolute/*','**',''])f('native-pattern-'+pattern,{input:{pattern},lines:[file],gitAt:root});
 f('parent-git',{input:{pattern:'*',path:'src'},gitAt:root,lines:[file]});
 f('no-git',{lines:[file]});f('native-clean-lines',{lines:['  '+file+'  ','','  ','\ufeffrelative  ',p.join(root,'dir')+p.sep]});
 f('native-whitespace-only',{lines:['   ']});f('empty',{lines:[]});f('nonzero-empty',{code:2,lines:[]});f('nonzero-stderr',{code:2,stderr:' \ufefffd error\n',lines:[]});f('nonzero-partial',{code:2,stderr:'ignored error',lines:[file]});
 f('spawn-error',{spawnError:'spawn fd ENOENT'});f('missing-tool',{unavailable:true});f('preabort',{preAbort:true});f('native-limit',{input:{pattern:'*',limit:1},lines:[file,'other']});
 const g=(id,v)=>add('grep-'+(windows?'win-':'posix-')+id,{kind:'grep',windows,root,input:{pattern:'needle'},...v});
 const match=(n,text='needle\n',name=file)=>({type:'match',data:{path:{text:name},line_number:n,lines:text===null?{}:{text}}});
 g('inline',{events:[match(2,'abc\r\n'),match(3,'x\ry\n\n'),match(1,'other',elsewhere)]});
 g('file-basename',{isDirectory:false,events:[match(2)]});g('no-match',{events:[{type:'begin'},'invalid json',''],code:1});
 g('empty-valid-match',{events:[{type:'match',data:{path:{bytes:'AA=='},line_number:1}}]});
 for(const limit of [-1,0,1,1.5,2,100])g('limit-'+limit,{input:{pattern:'needle',limit},events:[match(1),match(2),match(3)]});
 g('missing-data-counts-to-limit',{input:{pattern:'needle',limit:1},events:[{type:'match'},match(1)]});
 g('context-cached',{input:{pattern:'needle',context:1},events:[match(2),match(3)],files:{[file]:'first\r\nsecond\rthird\nfourth\n'}});
 for(const context of [-1,0,0.5,1.5,9])g('context-'+context,{input:{pattern:'needle',context},events:[match(2,null)],files:{[file]:'first\nsecond\nthird'}});
 g('context-unreadable',{input:{pattern:'needle',context:2},events:[match(2)]});g('context-empty',{input:{pattern:'needle',context:2},events:[match(1)],files:{[file]:''}});
 g('long-line',{events:[match(1,'x'.repeat(505))]});g('astral-line-units',{events:[match(1,'🙂'.repeat(251))]});
 g('byte-limit',{input:{pattern:'needle',limit:200},events:Array.from({length:150},(_,i)=>match(i+1,'界'.repeat(500)))});
 g('all-flags',{input:{pattern:'[literal]',ignoreCase:true,literal:true,glob:'**/*.ts',context:0},events:[match(1)]});
 g('rg-unavailable',{unavailable:true});g('stat-failure',{statError:true});g('process-error',{spawnError:'spawn rg ENOENT'});g('stderr-error',{code:2,stderr:' bad regex \ufeff'});g('null-exit',{code:null});g('preabort',{preAbort:true});
}
const cases=[],metadata={};
for(const spec of specs){
 const p=spec.windows?path.win32:path.posix;const trace=[];
 const ensureTool=async tool=>{trace.push(['ensure',tool]);return spec.unavailable?undefined:tool;};
 const exists=async absolute=>{trace.push(['exists',absolute]);return spec.exists!==false;};
 const pathExists=async absolute=>{trace.push(['pathExists',absolute]);return spec.gitAt&&absolute===p.join(spec.gitAt,'.git');};
 const spawn=(program,args)=>{
  trace.push(['spawn',program,args]);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;child.kill=()=>{if(!child.killed){child.killed=true;trace.push(['kill']);}return true;};
  setImmediate(()=>{
   if(spec.spawnError){child.emit('error',new Error(spec.spawnError));child.stdout.end();child.stderr.end();return;}
   const lines=spec.kind==='find'?(spec.lines??[]):(spec.events??[]).map(v=>typeof v==='string'?v:JSON.stringify(v));
   for(const line of lines)child.stdout.write(line+'\n');child.stdout.end();if(spec.stderr)child.stderr.write(spec.stderr);child.stderr.end();
   setImmediate(()=>child.emit('close',child.killed?null:Object.hasOwn(spec,'code')?spec.code:0));
  });return child;
 };
 const deps={...truncation,Type,path:p,createInterface,spawn,ensureTool,pathExists,resolveToCwd:(v,cwd)=>p.resolve(cwd,v),findRenderers:{},grepRenderers:{},wrapToolDefinition:()=>{throw Error('not tested');},process:{platform:spec.windows?'win32':'linux'},fsStat:()=>{throw Error('use operations');},fsReadFile:()=>{throw Error('use operations');}};
 const name=spec.kind==='find'?'createFindToolDefinition':'createGrepToolDefinition';const api=load('core/tools/'+spec.kind+'.ts',deps,spec.kind==='find'?[name,'relativizeFindResultPath']:[name]);
 const operations=spec.kind==='find'?(spec.custom?{exists,glob:async(pattern,cwd,options)=>{trace.push(['glob',pattern,cwd,options]);if(spec.globError)throw Error(spec.globError);return spec.results??[];}}:undefined):{isDirectory:async absolute=>{trace.push(['isDirectory',absolute]);if(spec.statError)throw Error('missing');return spec.isDirectory!==false;},readFile:async absolute=>{trace.push(['readFile',absolute]);if(!Object.hasOwn(spec.files??{},absolute))throw Error('unreadable');return spec.files[absolute];}};
 const tool=api[name](spec.root,{operations});if(!metadata[spec.kind]){const {name,label,description,promptSnippet,parameters}=tool;metadata[spec.kind]={name,label,description,promptSnippet,parameters};}
 const abort=new AbortController();if(spec.preAbort)abort.abort();let outcome;try{outcome={value:await tool.execute('id',spec.input,abort.signal)};}catch(error){outcome={error:error.message};}
 cases.push({...spec,trace,outcome});
}
// Include both path implementations irrespective of the host executing Rust tests.
const pathCases=[];for(const windows of [false,true]){const p=windows?path.win32:path.posix;const root=windows?'C:\\work':'/work';const deps={...truncation,Type,path:p,findRenderers:{},pathExists:()=>{},ensureTool:()=>{},process:{platform:windows?'win32':'linux'}};const api=load('core/tools/find.ts',deps,['relativizeFindResultPath']);for(const value of [root,root+p.sep,root+p.sep+'a',root+p.sep+'a'+p.sep,'relative/','relative\\',windows?'D:\\other\\':'/other/',windows?'C:/work/forward/':'/work/x\\y'])pathCases.push({windows,root,input:value,value:api.relativizeFindResultPath(value,root,p)});}
fs.writeFileSync(output,JSON.stringify({provenance,metadata,pathCases,cases},null,2)+'\n');console.log(cases.length+' execution cases; '+pathCases.length+' path cases');
