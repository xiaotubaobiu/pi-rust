/** Offline oracle: executes the read-only upstream reducer (no npm packages).
 * Run from pi-rust: node docs/migration/reference/generate-runtime-reducer-oracles.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const sourcePath=path.join(repo,'../pi/packages/agent/src/harness/runtime/reducer.ts');
const source=await fs.readFile(sourcePath,'utf8');
const js=stripTypeScriptTypes(source,{mode:'strip'});
const {reduceLaneSnapshot}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const clone=structuredClone;
const usage=(n=0)=>({input:n,output:n,cacheRead:0,cacheWrite:0,totalTokens:n*2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
const configuration={model:{provider:'test',modelId:'model'},thinkingLevel:'off',activeToolNames:[]};
const base=()=>({lane:'main',transcript:[],tipId:null,configuration:clone(configuration),stats:{messageCount:0,usage:usage()},operation:null,queues:[],faulted:false});
const user=(text='question')=>({role:'user',content:text,timestamp:1});
const assistant=(stopReason='pending',text='answer')=>({role:'assistant',content:[{type:'text',text}],api:'test',provider:'test',model:'model',usage:usage(),stopReason,timestamp:2});
const result=text=>({content:[{type:'text',text}],details:{text}});
const ev=(type,fields={})=>({type,lane:'main',...fields});
const start=ev('run_start',{runId:'run',startedAt:10});
const entry=(id,message)=>({id,parentId:null,seq:1,timestamp:1,type:'message',message});
const toolStart=i=>ev('tool_start',{runId:'run',turnId:'turn',toolCallId:'call-'+i,toolName:'tool-'+i,args:{index:i}});
const toolEnd=i=>ev('tool_end',{runId:'run',turnId:'turn',toolCallId:'call-'+i,toolName:'tool-'+i,result:result('done-'+i),isError:false,terminate:false});
const toolEntry=i=>ev('entry_added',{entry:entry('result-'+i,{role:'toolResult',toolCallId:'call-'+i,toolName:'tool-'+i,content:[{type:'text',text:'done-'+i}],isError:false,timestamp:i+1})});
const deferred={provider:'test',modelId:'model',api:'test',id:'handle'};
const cases=[];
function capture(label,events,initial=base()) {let current=clone(initial);for(let i=0;i<events.length;i++){const before=clone(current);const event=clone(events[i]);const reduction=reduceLaneSnapshot(current,event);cases.push({label:label+':'+i,snapshot:before,event,expected:clone(current),rebase:reduction==='rebase'});}}
capture('ordinary',[ev('entry_added',{entry:entry('prompt',user())}),start,ev('message_start',{runId:'run',message:assistant()}),ev('message_update',{runId:'run',message:assistant('pending','partial'),event:{type:'text_delta'}}),ev('message_end',{runId:'run',message:assistant('stop')}),ev('entry_added',{entry:entry('answer',assistant('stop'))}),ev('usage',{totals:usage(3)}),ev('run_end',{runId:'run',status:'completed',fromTipId:'prompt',tipId:'answer',endedAt:20})]);
capture('deferred',[start,ev('message_start',{runId:'run',message:assistant()}),ev('run_suspend',{runId:'run',reason:'deferred',deferred,poll:0}),ev('run_resume',{runId:'stale'}),ev('run_resume',{runId:'run'}),ev('run_suspend',{runId:'stale',deferred,poll:2}),ev('operation_abort',{operationId:'run',steer:[],followUp:[]})]);
capture('parallel-tools',[start,toolStart(0),toolStart(1),toolStart(2),toolStart(0),ev('tool_update',{runId:'stale',toolCallId:'call-1',partialResult:result('stale')}),ev('tool_update',{runId:'run',toolCallId:'call-1',partialResult:result('partial')}),toolEnd(2),toolEnd(0),ev('tool_update',{runId:'run',toolCallId:'call-0',partialResult:result('too late')}),toolEntry(0),toolEnd(1),toolEntry(1),toolEntry(2)]);
const summary={id:'summary',parentId:null,seq:3,timestamp:3,type:'compaction',summary:'short',retainedTail:[user('tail')],tokensBefore:100,fromHook:false};
capture('standalone-compaction',[ev('entry_added',{entry:entry('history',user())}),ev('compaction_start',{runId:'compact',reason:'manual',startedAt:1}),ev('entry_added',{entry:summary}),ev('compaction_end',{runId:'compact',reason:'manual',status:'completed',entryId:'summary',endedAt:4})]);
capture('in-run-compaction',[start,ev('compaction_start',{runId:'run',reason:'threshold',startedAt:11}),ev('entry_added',{entry:summary}),ev('compaction_end',{runId:'run',reason:'threshold',status:'declined',endedAt:12})]);
capture('queue-null',[ev('queue_update',{queues:[{entryId:'u',kind:'nextRun',type:'message',message:user()},{entryId:'c',kind:'write',type:'custom',customType:'null-data',data:null},{entryId:'a',kind:'write',type:'custom',customType:'absent-data'}]}),ev('queue_update',{queues:[]})]);
capture('custom-null',[ev('entry_added',{entry:{id:'custom',parentId:null,seq:1,timestamp:1,type:'custom',customType:'null-data',data:null}})]);
capture('tool-null-details',[start,toolStart(0),ev('tool_update',{runId:'run',toolCallId:'call-0',partialResult:{content:[],details:null}}),ev('tool_end',{runId:'run',toolCallId:'call-0',toolName:'tool-0',result:{content:[],details:null},isError:false}),ev('entry_added',{entry:entry('result-0',{role:'toolResult',toolCallId:'call-0',toolName:'tool-0',content:[],details:null,isError:false,timestamp:3})})]);
capture('retry',[start,ev('retry_scheduled',{runId:'run',attempt:2,maxAttempts:4,notBefore:50}),ev('retry_start',{runId:'stale'}),ev('retry_end',{runId:'run'}),ev('retry_scheduled',{runId:'run',attempt:3,maxAttempts:4,notBefore:100}),ev('retry_start',{runId:'run'})]);
capture('terminal-families',[start,ev('run_end',{runId:'stale',status:'failed',error:{code:'X',message:'bad'},fromTipId:null,tipId:null,endedAt:3}),ev('compaction_end',{runId:'run',status:'failed',error:{code:'X',message:'ignored'},endedAt:4}),ev('run_end',{runId:'run',status:'failed',error:{code:'X',message:'failed',details:null},fromTipId:null,tipId:null,endedAt:5}),ev('compaction_start',{runId:'compact',startedAt:6}),ev('compaction_end',{runId:'compact',status:'failed',error:{code:'Y',message:'summary failed',details:null},endedAt:7}),ev('navigation_start',{runId:'nav',startedAt:8,targetId:null}),ev('navigation_end',{runId:'nav',status:'completed',fromTipId:null,tipId:'target',endedAt:9}),ev('fault',{code:'fault',message:'bad'})]);
capture('configuration',[ev('config_update',{property:'model',value:{provider:'new',modelId:'next'}}),ev('config_update',{property:'thinkingLevel',value:'high'}),ev('config_update',{property:'activeTools',value:['read','write']}),{type:'config_update',property:'activeTools',value:['global ignored']},{type:'config_update',property:'tools'},ev('config_update',{lane:'foreign',property:'model',value:{provider:'ignored',modelId:'ignored'}}),ev('usage',{lane:'foreign',totals:usage(15)})]);
const inert=[ev('handler_error',{kind:'event',event:'run_start',error:'ignored'}),ev('turn_start',{runId:'run',turnId:'turn'}),ev('turn_end',{runId:'run',turnId:'turn',message:assistant('stop'),toolResults:[]}),{type:'value_update',value:'session_name',name:'n'},ev('lane_created',{at:null}),ev('navigation_end',{lane:'foreign'}),ev('message_start',{message:user()}),ev('message_start',{runId:'run',message:assistant('stop')}),ev('message_update',{runId:'run',message:user()}),ev('message_end',{message:user()}),ev('operation_abort',{operationId:'stale'}),toolEnd(99)];
capture('ignored',[start,...inert]);
let seed=0x503172;const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
const pool=[start,...inert,toolStart(0),toolStart(1),toolEnd(0),toolEnd(1),toolEntry(0),toolEntry(1),ev('run_suspend',{runId:'run',deferred,poll:4}),ev('run_resume',{runId:'run'}),ev('retry_scheduled',{runId:'run',attempt:2,maxAttempts:4,notBefore:66}),ev('retry_end',{runId:'run'}),ev('message_start',{runId:'run',message:assistant()}),ev('message_update',{runId:'run',message:assistant('pending','random')}),ev('message_end',{runId:'run'}),ev('compaction_start',{runId:'compact',startedAt:30}),ev('compaction_end',{runId:'compact',status:'declined',endedAt:31}),ev('usage',{lane:'foreign',totals:usage(5)}),ev('queue_update',{queues:[]}),ev('run_end',{runId:'run',status:'aborted',fromTipId:null,tipId:null,endedAt:99})];
for(let sequence=0;sequence<20;sequence++){capture('seeded-'+sequence,Array.from({length:30},()=>pool[rand()%pool.length]));}
const output={upstream:'590144609',source:'packages/agent/src/harness/runtime/reducer.ts',sha256:crypto.createHash('sha256').update(source).digest('hex'),cases};
const destination=path.join(repo,'src/agent_core/harness/runtime/fixtures/reducer-oracles.json');await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({destination,sha256:output.sha256,cases:cases.length}));
