// Real upstream fetchWithRetry, with an injected fetch (never a network request).
import fs from 'node:fs';
import crypto from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const source=process.env.PI_MANAGEMENT_ORACLE_SOURCE;
const output=process.env.PI_MANAGEMENT_ORACLE_OUTPUT;
if(!source||!output)throw Error('set PI_MANAGEMENT_ORACLE_SOURCE and PI_MANAGEMENT_ORACLE_OUTPUT');
const raw=fs.readFileSync(source,'utf8');
const code=stripTypeScriptTypes(raw,{mode:'strip'}).replace(/\bexport\s+/g,'');
const factory=new Function('fetch',code+'\nreturn fetchWithRetry;');
const specs=[];const add=(id,value)=>specs.push({id,...value});
for(const status of [200,201,204,301,302,304,400,401,403,404,408,409,418,425,429,499,500,501,502,503,504,505]){
 add('status-'+status,{steps:[{status},{status:200}]});
 add('no-status-retry-'+status,{options:{retryOnStatus:false},steps:[{status},{status:201}]});
}
for(const retries of [-8,-0.1,0,0.9,1,1.9,2,3,'NaN','Infinity','-Infinity']){
 add('transport-retries-'+retries,{options:{maxRetries:retries},steps:[{error:'TypeError',message:'fetch failed'}]});
 add('status-retries-'+retries,{options:{maxRetries:retries},steps:[{status:503}]});
}
add('errors-then-success',{steps:[{error:'Error',message:'first'},{error:'TypeError',message:'second'},{status:200}]});
add('last-error',{steps:[{status:503},{error:'Error',message:'second'},{error:'RangeError',message:'third'}]});
add('ignore-body-cancel-error',{steps:[{status:429,cancelError:true},{status:200}]});
add('no-body-to-cancel',{steps:[{status:503,noBody:true},{status:200}]});
add('abort-error-terminal',{steps:[{error:'AbortError',message:'caller-like abort'},{status:200}]});
add('abort-error-with-overall-retries',{options:{timeoutMs:100000},steps:[{error:'AbortError',message:'transient abort'},{status:200}]});
add('attempt-option-does-not-retry-unrelated-abort',{options:{attemptTimeoutMs:100000},steps:[{error:'AbortError',message:'unrelated abort'},{status:200}]});
add('zero-overall-not-present',{options:{timeoutMs:0},steps:[{error:'AbortError',message:'unrelated abort'},{status:200}]});
add('pre-aborted',{preAbort:true,steps:[{status:200}]});
add('cancel-during-fetch',{steps:[{abortParent:true},{status:200}]});
add('cancel-during-discard',{steps:[{status:503,cancelParent:true},{status:200}]});
const cases=[];
for(const spec of specs){
 const trace=[];let attempt=0;const parent=new AbortController();if(spec.preAbort)parent.abort();
 const fetchWithRetry=factory(async(input,init)=>{
  const index=attempt++;trace.push(['fetch',index]);const step=spec.steps[Math.min(index,spec.steps.length-1)];
  if(step.abortParent){parent.abort();init.signal.throwIfAborted();}
  if(step.error){const error=new Error(step.message);error.name=step.error;throw error;}
  return {status:step.status,body:step.noBody?null:{cancel:async()=>{trace.push(['cancel',index]);if(step.cancelParent)parent.abort();if(step.cancelError)throw Error('cannot cancel');}}};
 });
 const options={...spec.options};if(typeof options.maxRetries==='string')options.maxRetries=Number(options.maxRetries);
 let outcome;try{const response=await fetchWithRetry('https://example.invalid',{signal:parent.signal},options);outcome={status:response.status};}catch(error){outcome={error:{name:error.name,message:error.message}};}
 cases.push({...spec,trace,outcome});
}
const jsonSpecs=[
 ['object',Buffer.from('{"version":"1.2.3"}')],
 ['bom',Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('{"ok":true}')])],
 ['double-bom',Buffer.concat([Buffer.from([0xef,0xbb,0xbf,0xef,0xbb,0xbf]),Buffer.from('{}')])],
 ['null',Buffer.from('null')], ['empty',Buffer.from('')], ['empty-bom',Buffer.from([0xef,0xbb,0xbf])],
 ['non-leading-bom',Buffer.from(' \ufeff{}')], ['invalid-json',Buffer.from('{"bad":}')],
 ['valid-unicode',Buffer.from('{"text":"你好😀"}')],
 ...[[0xff],[0xc0,0xaf],[0xe2,0x82],[0xed,0xa0,0x80],[0xe0,0x80,0x80],[0xf4,0x90,0x80,0x80],[0xf0,0x9f,0x92]].map((bytes,i)=>['invalid-utf8-'+i,Buffer.concat([Buffer.from('{"text":"'),Buffer.from(bytes),Buffer.from('"}')])]),
 ['embedded-bom',Buffer.from('{"text":"\ufeff"}')],
 ['utf16-is-not-sniffed',Buffer.from([0xff,0xfe,0x7b,0x00,0x7d,0x00])],
];
const responseJson=[];
for(const [id,bytes] of jsonSpecs){
 let outcome;try{outcome={value:await new Response(bytes).json()};}catch(error){outcome={error:{name:error.name}};}
 responseJson.push({id,bytes:[...bytes],outcome});
}
const result={responseJson,upstream:'packages/coding-agent/src/utils/management-http.ts',sha256:crypto.createHash('sha256').update(raw).digest('hex'),cases};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(cases.length+' oracle cases');
