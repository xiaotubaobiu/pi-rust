// Actual upstream executor + ANSI/sanitizer/truncation. Operations are injected;
// only random temp paths are normalized. Spill writes are real filesystem IO.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {finished} from 'node:stream/promises';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
const work=path.dirname(fileURLToPath(import.meta.url));
const root=process.env.PI_BASH_EXECUTOR_ORACLE_SOURCE??path.resolve(work,'../../../../../pi/packages/coding-agent/src');
const sources={};
function load(name,deps,names){
 const raw=fs.readFileSync(path.join(root,name),'utf8');sources[name]=crypto.createHash('sha256').update(raw).digest('hex');
 const code=stripTypeScriptTypes(raw.replace(/^import\b[\s\S]*?;\s*$/gm,''),{mode:'strip'}).replace(/\bexport\s+/g,'');
 return new Function(...Object.keys(deps),code+'\nreturn {'+names.join(',')+'};')(...Object.values(deps));
}
const ansi=load('utils/ansi.ts',{},['stripAnsi']);
const shell=load('utils/shell.ts',{},['sanitizeBinaryOutput']);
const trunc=load('core/tools/truncate.ts',{},['DEFAULT_MAX_BYTES','truncateTail']);
const specs=[];function add(id,chunks=[],extra={}){specs.push({id,chunks,...extra});}
add('empty');add('success',[{text:'hi\n'}]);add('no-callback',[{text:'not streamed'}],{emitChunks:false});
add('nonzero',[{text:'failed'}],{exitCode:7});add('null-exit',[],{exitCode:null});add('undefined-exit',[],{missingExit:true});
add('throw',[{text:'discarded'}],{error:'remote failure'});add('cancel-throw',[{text:'partial'}],{signal:'after',error:'aborted'});
add('cancel-success',[{text:'partial'}],{signal:'after'});add('pre-cancel',[{text:'injected still emits'}],{signal:'before'});
add('false-abort-message',[{text:'data'}],{error:'aborted'});
add('ansi-control',[{text:'\u001b[31mred\u001b[0m\r\n\u0000\u0001\u0007tab\t\ufff9ok\ufffb\u007f\u200b'}]);
add('osc-link',[{text:'\u001b]8;;https://invalid.test\u0007link\u001b]8;;\u001b\\'}]);
add('split-ansi',[{text:'\u001b['},{text:'31mred'},{text:'\u001b'},{text:'[0m'}]);
add('no-flush-at-eof',[{hex:'41f09f99'}]);add('bad-sequence-before-eof',[{hex:'e241f09f'}]);
add('split-bom',[{hex:'ef'},{hex:'bb'},{hex:'bf41efbbbf'}]);
add('repeat-bom',[{hex:'efbbbf'},{hex:'efbbbf'}]);
add('empty-then-bom',[{hex:''},{hex:'efbbbf41'}]);
add('raw-at-limit',[{text:'\u0000',repeat:51200}]);add('raw-over-limit-sanitized-empty',[{text:'\u0000',repeat:51201}]);
add('line-spill-only',[{text:'line\n',repeat:2001}]);
add('line-spill-abort',[{text:'line\n',repeat:2001}],{signal:'after',error:'aborted'});
add('line-no-spill-error',[{text:'line\n',repeat:2001}],{error:'failure'});
add('byte-spill',[{text:'x'.repeat(79)+'\n',repeat:1000}]);
add('byte-spill-error',[{text:'x'.repeat(79)+'\n',repeat:1000}],{error:'failure'});
add('partial-long-line',[{text:'界',repeat:30000}]);
add('rolling-cjk-uses-utf16',[{text:'界\n',repeat:40000},{text:'end\n'}]);
add('rolling-astral-uses-utf16',[{text:'🙂\n',repeat:30000},{text:'end\n'}]);
add('rolling-eviction',[{text:'a\n',repeat:45000},{text:'b\n',repeat:45000},{text:'c\n'}]);
add('rolling-empty-chunk',[{text:'a',repeat:110000},{hex:''}]);
add('raw-split-threshold',[{text:'\u001b[31m',repeat:10000},{text:'x',repeat:1200},{text:'\r\n'}]);
const bytes=Buffer.from('\ufeff雪🙂\u001b[31mred\u001b[0m\r\n\0last');
for(let at=0;at<=bytes.length;at++)add('every-split-'+at,[{hex:bytes.subarray(0,at).toString('hex')},{hex:bytes.subarray(at).toString('hex')}]);
for(const hex of ['c0af','eda080','f4908080','f5808080','e08080','f0808080','e228a1','80bfff','e2','e282','f0','f09f','f09f99','ef','efbb'])add('invalid-'+hex,[{hex}]);
const cases=[];
for(const spec of specs){
 const temp=fs.mkdtempSync(path.join(work,'executor-oracle-temp-'));const streams=[];
 const api=load('core/bash-executor.ts',{...ansi,...shell,...trunc,randomBytes:crypto.randomBytes,tmpdir:()=>temp,join:path.join,createWriteStream:(...args)=>{const stream=fs.createWriteStream(...args);streams.push(stream);return stream;}},['executeBashWithOperations']);
 const chunks=[];const calls=[];const controller=new AbortController();if(spec.signal==='before')controller.abort();
 const ops={exec:async(command,cwd,{onData})=>{calls.push({command,cwd});for(const chunk of spec.chunks){onData(chunk.hex!==undefined?Buffer.from(chunk.hex,'hex'):Buffer.from(chunk.text.repeat(chunk.repeat??1)));}if(spec.signal==='after')controller.abort();if(spec.error)throw Error(spec.error);return spec.missingExit?{}:{exitCode:spec.exitCode===undefined?0:spec.exitCode};}};
 let outcome;try{outcome={value:await api.executeBashWithOperations('command','$CWD',ops,{...(spec.emitChunks===false?{}:{onChunk:text=>chunks.push(text)}),...(spec.signal?{signal:controller.signal}:{})})};}catch(error){outcome={error:error.message};}
 await Promise.all(streams.map(stream=>finished(stream)));
 const files=fs.readdirSync(temp);if(files.length>1)throw Error('multiple spill files');
 const spill=files.length?path.join(temp,files[0]):null;
 if(outcome.value?.fullOutputPath)outcome.value.fullOutputPath='$SPILL';
 cases.push({...spec,calls,streamedChunks:chunks,outcome,fullOutputHex:spill?fs.readFileSync(spill).toString('hex'):null});
 if(!path.resolve(temp).startsWith(path.resolve(work)+path.sep))throw Error('unsafe cleanup');fs.rmSync(temp,{recursive:true,force:true});
}
const result={provenance:{sources,boundary:'Actual upstream executor, ANSI regex, sanitizer and truncation with raw-byte injected operations and real sanitized spill IO. Native process discovery, cancellation and lifetime are tested separately.'},cases};
const target=process.argv[2]??path.join(work,'bash-executor-oracle.json');fs.writeFileSync(target,JSON.stringify(result,null,2)+'\n');console.log({cases:cases.length,sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')});
