// Runs the checked-in TypeScript OutputAccumulator and truncateTail, never a
// reimplementation. IO is a real, isolated temp directory; only path identity
// is normalized. Every append has an intermediate snapshot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
const work=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(work,'../../../../../pi/packages/coding-agent/src/core/tools');
const sources={};
function load(name,deps,names){
 const raw=fs.readFileSync(path.join(root,name),'utf8');
 sources[name]=crypto.createHash('sha256').update(raw).digest('hex');
 const code=stripTypeScriptTypes(raw.replace(/^import\b[\s\S]*?;\s*$/gm,''),{mode:'strip'}).replace(/\bexport\s+/g,'');
 return new Function(...Object.keys(deps),code+'\nreturn {'+names.join(',')+'};')(...Object.values(deps));
}
const truncation=load('truncate.ts',{},['DEFAULT_MAX_BYTES','DEFAULT_MAX_LINES','truncateTail']);
const specs=[];
function add(id,chunks,options={}){specs.push({id,chunks:chunks.map(c=>Buffer.from(c).toString('hex')),options});}
for(const [name,text] of Object.entries({empty:'',ascii:'abc',trailing:'a\n',newline:'\n',crlf:'a\r\nb\r\n',emoji:'A🙂B\n世界\n',bom:'\ufeffA\ufeffB'})){
 const bytes=Buffer.from(text);
 for(let split=0;split<=bytes.length;split++)add(name+'-split-'+split,[bytes.subarray(0,split),bytes.subarray(split)],{maxLines:2,maxBytes:9});
}
const invalid=[[0xc0,0xaf],[0xe0,0x80,0xaf],[0xed,0xa0,0x80],[0xf4,0x90,0x80,0x80],[0xf0,0x9f,0x99],[0xe2,0x82],[0xe2,0x41],[0xff,0x80,0xef,0xbb,0xbf],[0xef,0xbb],[0xef,0xbb,0xbf]];
for(let i=0;i<invalid.length;i++){
 const bytes=Buffer.from(invalid[i]);
 add('invalid-bytewise-'+i,[...bytes].map(b=>[b]),{maxLines:3,maxBytes:2});
 for(let split=0;split<=bytes.length;split++)add('invalid-'+i+'-'+split,[bytes.subarray(0,split),bytes.subarray(split)],{maxLines:1,maxBytes:6});
}
add('rolling-partial-line',['0123456789abcdefghijklmnop','\nend\n','next'],{maxLines:3,maxBytes:4});
add('rolling-whole-lines',['a\nb\nc\nd\ne\nf\ng\nh\ni\n'],{maxLines:3,maxBytes:4});
add('rolling-utf8',['🙂'.repeat(50),'世界\nend'],{maxLines:10,maxBytes:5});
add('line-spill-no-byte-truncation',['a\n','b\n','c\n'],{maxLines:1,maxBytes:200});
add('raw-bom-spill-not-decoded-truncation',[[0xef],[0xbb],[0xbf]],{maxLines:9,maxBytes:2});
add('zero-lines',['a','\nb'],{maxLines:0,maxBytes:50});
add('zero-bytes',['a','\n世界'],{maxLines:20,maxBytes:0});
add('default-options',['normal output\n']);
let state=0x12abcd34;
const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
for(let i=0;i<64;i++){
 const chunks=[];
 for(let j=0;j<10;j++){
   const source=Buffer.from(['αβ🙂\n','xyz','a\r\n','x'.repeat(70),'','\ufeff','\n\n\n'][random()%7]);
   const cut=random()%(source.length+1);chunks.push(source.subarray(0,cut),source.subarray(cut));
 }
 add('seeded-'+i,chunks,{maxLines:random()%8,maxBytes:random()%34});
}
const cases=[];
for(const spec of specs){
 const temp=fs.mkdtempSync(path.join(work,'accumulator-oracle-temp-'));
 const {OutputAccumulator}=load('output-accumulator.ts',{...truncation,randomBytes:crypto.randomBytes,createWriteStream:fs.createWriteStream,tmpdir:()=>temp,join:path.join},['OutputAccumulator']);
 const acc=new OutputAccumulator({...spec.options,tempFilePrefix:'fixture-output'});
 const trace=[];
 const snapshot=(persist)=>{
   const value=acc.snapshot({persistIfTruncated:persist});
   if(value.fullOutputPath)value.fullOutputPath='$SPILL';
   trace.push({snapshot:value,lastLineBytes:acc.getLastLineBytes()});
 };
 snapshot(false);
 for(let i=0;i<spec.chunks.length;i++){acc.append(Buffer.from(spec.chunks[i],'hex'));snapshot(i%2===0);}
 acc.finish();snapshot(true);acc.finish();snapshot(false);
 let error;try{acc.append(Buffer.from('late'));}catch(e){error=e.message;}
 await acc.closeTempFile();await acc.closeTempFile();
 const files=fs.readdirSync(temp);if(files.length>1)throw new Error('extra spill file');
 const raw=files.length?fs.readFileSync(path.join(temp,files[0])).toString('hex'):null;
 cases.push({...spec,trace,appendAfterFinish:error,fullOutputHex:raw});
 const resolved=path.resolve(temp);if(!resolved.startsWith(path.resolve(work)+path.sep))throw new Error('unsafe cleanup');fs.rmSync(resolved,{recursive:true,force:true});
}
const out={provenance:{sources,boundary:'Real upstream TypeScript accumulator and truncation, actual Node TextDecoder and filesystem writes; random temp path normalized only.'},cases};
const target=process.argv[2]??path.join(work,'output-accumulator-oracle.json');fs.writeFileSync(target,JSON.stringify(out,null,2)+'\n');console.log({cases:cases.length,sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')});
