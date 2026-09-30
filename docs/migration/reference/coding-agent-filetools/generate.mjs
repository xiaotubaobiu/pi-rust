// Execute the real upstream coding-agent file tools with deterministic IO.
// TypeBox construction and renderer imports are collaborators; execution,
// edit-diff (diff 8.0.4), truncation, path rules and queue come from pi.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
const scratch=path.dirname(fileURLToPath(import.meta.url));
const workspace=path.resolve(scratch,'../../../../..');
const upstream=path.join(workspace,'pi/packages/coding-agent/src');
const provenance={};
function load(file,deps,names) {
 const text=fs.readFileSync(path.join(upstream,file),'utf8');
 provenance[file]=createHash('sha256').update(text).digest('hex');
 const source=stripTypeScriptTypes(text.replace(/^import\b[\s\S]*?;\s*$/gm,''),{mode:'strip'}).replace(/\bexport\s+/g,'');
 return new Function(...Object.keys(deps),source+'\nreturn {'+names.join(',')+'};')(...Object.values(deps));
}
const optional=Symbol('optional');
const Type={String:(o={})=>({type:'string',...o}),Number:(o={})=>({type:'number',...o}),Array:(items,o={})=>({type:'array',items,...o}),Optional:(item)=>{Object.defineProperty(item,optional,{value:true});return item;},Object:(properties,o={})=>{const required=Object.keys(properties).filter(key=>!properties[key][optional]);return {type:'object',properties,...required.length?{required}:{},...o};}};
const diffDir=path.join(workspace,'.migration-handoff/reference-deps/diff-8.0.4/package');
const Diff=await import(pathToFileURL(path.join(diffDir,'libesm/index.js')));
const text=load('utils/text.ts',{},['splitBom']);
const paths=load('utils/paths.ts',{realpathSync:fs.realpathSync,statSync:fs.statSync,homedir:os.homedir,isAbsolute:path.isAbsolute,join:path.join,nodeResolvePath:path.resolve,relative:path.relative,sep:path.sep,fileURLToPath,spawnProcessSync:()=>{throw Error('unexpected process');}},['normalizePath','resolvePath']);
const toolPaths=load('core/tools/path-utils.ts',{...paths,constants:fs.constants,accessSync:fs.accessSync,access:fsp.access},['resolveToCwd','resolveReadPathAsync']);
const queue=load('core/tools/file-mutation-queue.ts',{realpath:fsp.realpath,resolve:path.resolve},['withFileMutationQueue']);
const truncate=load('core/tools/truncate.ts',{},['DEFAULT_MAX_BYTES','DEFAULT_MAX_LINES','formatSize','truncateHead']);
const diff=load('core/tools/edit-diff.ts',{Diff,...text,constants:fs.constants,access:fsp.access,readFile:fsp.readFile,...toolPaths},['applyEditsToNormalizedContent','detectLineEnding','generateDiffString','generateUnifiedPatch','normalizeToLF','restoreLineEndings']);
const shared={...text,...toolPaths,...queue,...truncate,...diff,Type,constants:fs.constants,fsAccess:fsp.access,fsReadFile:fsp.readFile,fsWriteFile:fsp.writeFile,fsMkdir:fsp.mkdir,dirname:path.dirname,wrapToolDefinition:()=>{throw Error('not under test');},readRenderers:{},writeRenderers:{},editRenderers:{},processImage:()=>{throw Error('images validated separately');},detectSupportedImageMimeTypeFromFile:async()=>undefined};
const read=load('core/tools/read.ts',shared,['createReadToolDefinition']).createReadToolDefinition;
const write=load('core/tools/write.ts',shared,['createWriteToolDefinition']).createWriteToolDefinition;
const edit=load('core/tools/edit.ts',shared,['createEditToolDefinition']).createEditToolDefinition;
const cwd=path.join(scratch,'oracle-file-tools');fs.mkdirSync(cwd,{recursive:true});
const cases=[];const clean=value=>JSON.parse(JSON.stringify(value));
function metadata(tool){const {name,label,description,promptSnippet,promptGuidelines,parameters,constrainedSampling,renderShell}=tool;return clean({name,label,description,promptSnippet,promptGuidelines,parameters,constrainedSampling,renderShell});}
const metadataRows=[read(cwd),write(cwd),edit(cwd)].map(metadata);
const inputs=[['empty','',{}],['bom','\uFEFFone\r\ntwo\r\n',{}],['limit','a\nb\nc\n',{offset:2,limit:1}],['zero-limit','a\nb',{limit:0}],['negative-limit','a\nb\nc\nd',{limit:-1}],['negative-offset','a\nb',{offset:-3,limit:1}],['fraction','a\nb\nc\nd',{offset:1.5,limit:1.8}],['out-of-bounds','a\nb',{offset:3}],['trailing-line','a\n',{offset:2}],['too-long','🙂'.repeat(14000),{}],['lines',Array.from({length:2005},(_,i)=>'L'+i).join('\n'),{}],['bytes',('界'.repeat(400)+'\n').repeat(60),{}],['unicode','a\u2028b\u0000c\r\nd',{}]];
for(const [id,contents,args] of inputs){const input={path:'fixture.txt',...args};const tool=read(cwd,{operations:{access:async()=>{},readFile:async()=>Buffer.from(contents)}});let result;try{result={ok:await tool.execute('call',input)}}catch(error){result={error:error.message}}cases.push({id:'read-'+id,kind:'read',contents,input,...clean(result)});}
for(const [id,contents,edits]of [['multi','a\nb\nc\n',[['a','A'],['c','C']]],['bom-crlf','\uFEFFa\r\nb\r\nc\r\n',[['b','B\nB2']]],['overlap','a\nb\nc\n',[['a\nb','X'],['b\nc','Y']]],['repeat','foo foo',[['foo','bar']]],['not-found','foo',[['nope','X']]],['unchanged','foo',[['foo','foo']]],['fuzzy','quote “value”  \nkeep\n', [['quote "value"','fixed']]],['original-coordinates','a\nb\n',[['a','b'],['b','c']]],['empty-edits','foo',[]]]){
 let written=null;const input={path:'fixture.txt',edits:edits.map(([oldText,newText])=>({oldText,newText}))};const tool=edit(cwd,{operations:{access:async()=>{},readFile:async()=>Buffer.from(contents),writeFile:async(_,value)=>{written=value}}});let result;try{result={ok:await tool.execute('call',input)}}catch(error){result={error:error.message}}cases.push({id:'edit-'+id,kind:'edit',contents,input,written,...clean(result)});
}
for(const [id,args]of [['legacy',{path:'f',oldText:'a',newText:'b'}],['json-array',{path:'f',edits:'[{"oldText":"a","newText":"b"}]'}],['single',{path:'f',edits:{oldText:'a',newText:'b'}}],['json-single',{path:'f',edits:'{"oldText":"a","newText":"b"}'}],['both',{path:'f',edits:[{oldText:'x',newText:'y'}],oldText:'a',newText:'b'}],['invalid-json',{path:'f',edits:'{oops'}]]) cases.push({id:'prepare-'+id,kind:'prepare',input:clean(args),ok:clean(edit(cwd).prepareArguments(args))});
const abort=new AbortController();abort.abort();for(const [kind,factory,input]of [['read',read,{path:'f'}],['write',write,{path:'f',content:'x'}],['edit',edit,{path:'f',edits:[{oldText:'a',newText:'b'}]}]]) {try{await factory(cwd).execute('c',input,abort.signal);throw Error('unexpected success');}catch(error){cases.push({id:kind+'-preabort',kind:'preabort',tool:kind,input,error:error.message});}}
let effects=[];const written=await write(cwd,{operations:{mkdir:async p=>effects.push(['mkdir',path.relative(cwd,p).replaceAll('\\','/')]),writeFile:async(p,v)=>effects.push(['write',path.relative(cwd,p).replaceAll('\\','/'),v])}}).execute('c',{path:'nested/file.txt',content:'hello\uFEFF🙂'});cases.push({id:'write-effects',kind:'write',input:{path:'nested/file.txt',content:'hello\uFEFF🙂'},effects,ok:clean(written)});
const output={upstream:'local-readonly-pi',node:process.version,diffVersion:'8.0.4',collaborators:['schema Type constructors','empty renderers','read/edit/write injected IO; image handling excluded'],provenance,metadata:metadataRows,cases};
const dest=process.argv[2]||path.join(scratch,'filetools-oracle.json');fs.writeFileSync(dest,JSON.stringify(output,null,2)+'\n');console.log({cases:cases.length,sha256:createHash('sha256').update(fs.readFileSync(dest)).digest('hex')});
