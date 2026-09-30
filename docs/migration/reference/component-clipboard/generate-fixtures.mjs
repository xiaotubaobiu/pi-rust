// Actual complete upstream classes execute all reference behavior. Host inputs only.
import {writeFileSync} from 'node:fs';
import {TuiAltScreen} from './src/tui-alt-screen.ts';
import {getWordSegmenter} from './src/utils.ts';
const groups={delivery:[],osc52:[],selection:[],flashes:[],sequences:[]},wordSegments={};
const copy=(text='alpha',task='a')=>({op:'copyText',text,task});
const active=(task='a')=>({op:'copyActive',task});
const mode=value=>({op:'mode',value});
const ready=value=>({kind:'ready',value});
const deferred={kind:'deferred'};
const resolve=(request,value)=>({op:'resolve',request,value});
const reject=(request,error='delivery rejected')=>({op:'reject',request,error});
const flash=(message,duration)=>({op:'flash',message,duration});
const render=width=>({op:'render',width});
const fire=timer=>({op:'fire',timer});
const select=(x,y=0,button=0,release=false)=>({op:'select',raw:{button,x,y,release}});
const drag=(x,y=0)=>select(x,y,32), release=(x,y=0)=>select(x,y,0,true);
const add=(group,name,ops,extra={})=>groups[group].push({name,injected:true,mode:ready(true),screen:['alpha beta','second line','third row',''],columns:20,rows:4,copyOnSelect:false,ops,...extra});
const number=value=>value==='NaN'?NaN:value==='Infinity'?Infinity:value==='-Infinity'?-Infinity:value;
const wire=value=>Number.isNaN(value)?'NaN':value===Infinity?'Infinity':value===-Infinity?'-Infinity':value;
async function run(spec){
 let trace=[],nextTimer=0,nextRequest=0,auto=0,now=1000,currentMode=spec.mode,writeError,flashError;
 const timers=new Map(),deliveries=new Map(),tasks=new Map();
 const record=value=>trace.push(value);
 const old={timeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,interval:globalThis.setInterval,clearInterval:globalThis.clearInterval,now:Date.now};
 globalThis.setTimeout=(callback,duration)=>{const token=++nextTimer;const timer={token,callback,duration:wire(duration),active:true,unreferenced:false,unref(){this.unreferenced=true;record({op:'unref',timer:token});}};timers.set(token,timer);record({op:'timeout',timer:token,duration:wire(duration)});return timer;};
 globalThis.clearTimeout=timer=>{record({op:'cancel',timer:timer.token});timers.get(timer.token).active=false;};
 globalThis.setInterval=()=>{throw Error('unexpected interval in non-scroll selection fixture');};globalThis.clearInterval=()=>{throw Error('unexpected interval cancellation');};
 Date.now=()=>{record({op:'now',value:now});return now;};
 const segmenter=getWordSegmenter(),oldSegment=segmenter.segment;
 segmenter.segment=function(line){const parts=Array.from(oldSegment.call(this,line));const input=parts.map(s=>({text:s.segment,isWordLike:s.isWordLike===true}));if(wordSegments[line]&&JSON.stringify(input)!==JSON.stringify(wordSegments[line]))throw Error('nonstable Intl service');wordSegments[line]=input;record({op:'segments',line});return parts;};
 const terminal={columns:spec.columns,rows:spec.rows,write(sequence){record({op:'write',sequence});if(writeError)throw Error(writeError);},hideCursor(){},showCursor(){},start(){throw Error('OS start forbidden');},stop(){}};
 const options={copyOnSelect:spec.copyOnSelect};
 if(spec.injected) options.copySelection=text=>{
  const request=++nextRequest;record({op:'copy',request,text});
  if(currentMode.kind==='throw')throw Error(currentMode.error);
  if(currentMode.kind==='reject')return Promise.reject(Error(currentMode.error));
  if(currentMode.kind==='ready')return Promise.resolve(currentMode.value);
  if(currentMode.kind==='deferred')return new Promise((resolve,reject)=>deliveries.set(request,{resolve,reject}));
  throw Error('bad mode');
 };
 try{
  const tui=new TuiAltScreen(terminal,undefined,undefined,options);
  tui.previousScreen=[...spec.screen];tui.currentLayout=undefined;tui.requestRender=()=>record({op:'render'});
  const realFlash=tui.flash.bind(tui);tui.flash=(message,duration)=>{record({op:'flash',message,duration:duration===undefined?null:wire(duration)});if(flashError)throw Error(flashError);realFlash(message,duration);};
  const start=(name,promise)=>{if(tasks.has(name))throw Error('duplicate task');const state={name,status:'pending'};tasks.set(name,state);promise.then(value=>{state.status='ready';state.value=value;},error=>{state.status='error';state.error=error.message;});};
  // Retain actual private release delivery in an explicit test host task queue.
  const originalCopy=tui.copySelectionToClipboard.bind(tui);
  tui.copySelectionToClipboard=()=>{const text=tui.getActiveSelectionText();const promise=originalCopy();if(text)start('auto-'+(++auto),promise);return promise;};
  // Constructor/lifecycle is outside this oracle's operation phase.
  trace=[];nextTimer=0;timers.clear();
  const point=p=>p?{row:p.row,col:p.col,boundary:p.boundary===true}:null;
  const state=()=>({anchor:point(tui.selectionAnchor),focus:point(tui.selectionFocus),granularity:tui.selectionGranularity,initialRange:tui.selectionInitialRange?{start:point(tui.selectionInitialRange.start),end:point(tui.selectionInitialRange.end)}:null,lastClick:tui.lastClick?{timestamp:tui.lastClick.timestamp,count:tui.lastClick.count,row:tui.lastClick.row,wordStart:tui.lastClick.wordStart,wordEnd:tui.lastClick.wordEnd}:null,pressActive:tui.selectionPressActive,dragged:tui.selectionDragged,pressedUrl:tui.pressedUrl??null,autoScrollDirection:tui.selectionAutoScrollDirection,dragPointer:tui.selectionDragPointer??null,timer:tui.selectionAutoScrollTimer??null,copyOnSelect:tui.getCopyOnSelect(),bounds:tui.getSelectionBounds()?{start:point(tui.getSelectionBounds().start),end:point(tui.getSelectionBounds().end)}:null,text:tui.getActiveSelectionText()??null});
  const snapshot=()=>({tasks:[...tasks.values()].map(t=>({...t})),flash:{nextId:tui.flashes.nextId,entries:tui.flashes.entries.map(e=>({id:e.id,message:e.message,timer:e.timer.token}))},timers:[...timers.values()].map(t=>({timer:t.token,duration:t.duration,active:t.active,unreferenced:t.unreferenced})),selection:state()});
  const expected=[];
  for(const op of spec.ops){
   trace=[];let result=null;
   try{switch(op.op){
    case 'mode':currentMode=op.value;break;
    case 'errors':writeError=op.write;flashError=op.flash;break;
    case 'copyText':start(op.task,tui.copyTextToClipboard(op.text));break;
    case 'copyActive':start(op.task,tui.copyActiveSelectionToClipboard());break;
    case 'resolve':{const d=deliveries.get(op.request);if(!d)throw Error('unknown delivery');d.resolve(op.value);break;}
    case 'reject':{const d=deliveries.get(op.request);if(!d)throw Error('unknown delivery');d.reject(Error(op.error));break;}
    case 'flash':tui.flash(op.message,op.duration===undefined?undefined:number(op.duration));break;
    case 'render':result=tui.flashes.render(op.width);break;
    case 'dispose':tui.flashes.dispose();break;
    case 'invalidate':tui.flashes.invalidate();break;
    case 'fire':{const t=timers.get(op.timer);if(!t)throw Error('unknown timer');record({op:'fire',timer:op.timer});t.active=false;t.callback();break;}
    case 'select':tui.handleSelectionMouseEvent(op.raw);break;
    case 'clear':tui.clearTextSelection();break;
    case 'screen':tui.previousScreen=[...op.lines];break;
    case 'copyOnSelect':tui.setCopyOnSelect(op.value);break;
    case 'time':now=op.value;break;
    case 'drain':break;
    default:throw Error('bad operation '+op.op);
   }}catch(error){result={error:error.message};}
   const beforeDrain={trace:[...trace],...snapshot()};
   // Explicit quiescence boundary, not a replacement for the host microtask loop.
   for(let i=0;i<16;i++)await Promise.resolve();
   expected.push({result,beforeDrain,trace:[...trace],...snapshot()});
  }
  return expected;
 }finally{globalThis.setTimeout=old.timeout;globalThis.clearTimeout=old.clearTimeout;globalThis.setInterval=old.interval;globalThis.clearInterval=old.clearInterval;Date.now=old.now;segmenter.segment=oldSegment;}
}
for(const [name,value] of [['true',true],['false',false],['empty',''],['specific','Clipboard unavailable: install wl-clipboard'],['unicode','复制失败 🚫'],['ansi','\x1b[31mfailed\x1b[0m'],['undefined',undefined],['null',null],['one',1],['truthy-object',{}],['array',[]]]){
 add('delivery','ready-'+name,[copy(),render(32),fire(1),render(32)],{mode:ready(value)});
 add('delivery','deferred-'+name,[copy('雪 é 👩‍💻\nline'),{op:'drain'},resolve(1,value),render(20),fire(1),fire(1)],{mode:deferred});
}
for(const kind of ['throw','reject'])for(const error of ['unavailable','', '错误\nline'])add('delivery',kind+'-'+JSON.stringify(error),[copy(),{op:'drain'},render(10)],{mode:{kind,error}});
add('delivery','deferred-rejection',[copy(),reject(1,'offline'),{op:'drain'},render(20)],{mode:deferred});
add('delivery','promise-first-settlement-wins',[copy(),resolve(1,true),reject(1,'late'),resolve(1,false)],{mode:deferred});
add('delivery','failure-does-not-osc52-fallback',[copy(),resolve(1,false),render(20)],{mode:deferred});
for(const injected of [true,false]){
 add('delivery','flash-throw-'+injected,[{op:'errors',flash:'flash callback failed'},copy(),render(10)],{injected});
 add('delivery','write-throw-'+injected,[{op:'errors',write:'terminal failed'},copy(),render(20)],{injected});
}
const texts=['','f','fo','foo','foob','fooba','foobar','\0','a\0b','\x1b]52;c;x\x07','雪','한글','😀','é','👩‍💻','🇨🇳','\r\n\t','𝄞','é','\ufeff\u200b','alpha\nbeta\n','\x1b[31mred\x1b[0m'];
for(let n=0;n<=65;n++)texts.push(Array.from({length:n},(_,i)=>String.fromCharCode(32+(i*17)%95)).join(''));
for(const n of [127,128,129,255,256,257,511,512,513])texts.push('雪🙂é'.repeat(n));
for(const [i,text] of texts.entries())add('osc52','utf8-padding-'+i,[copy(text),render(20),fire(1)],{injected:false});
const messages=['','First','Second','alpha beta','雪中文','👩‍💻 é 🇨🇳','\x1b[31mred\x1b[0m','\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07','\n','a\tb','\0','combining éé','\x1b[0m','\x1b[7mX\x1b[27m'];
for(const [i,message] of messages.entries())for(const width of [0,1,2,3,4,7,12,32])add('flashes','render-'+i+'-'+width,[flash(message),render(width),{op:'invalidate'},render(width),{op:'dispose'},render(width)]);
for(const duration of [undefined,-100,-0.5,0,0.5,1,80,500,1000,5000,1e12,'NaN','Infinity','-Infinity'])add('flashes','duration-'+String(duration),[flash('duration',duration),fire(1),fire(1),{op:'dispose'}]);
add('flashes','stack-expire-out-of-order',[flash('First',80),flash('Second',500),flash('Third',10),render(20),fire(2),render(20),fire(1),render(20),flash('Fourth',0),{op:'dispose'},fire(3),fire(4),{op:'dispose'},flash('After dispose'),render(20)]);
add('flashes','dispose-pending-delivery',[copy(),{op:'dispose'},resolve(1,true),render(20),fire(1)],{mode:deferred});
add('selection','empty-selection-public',[active(),render(10)]);
for(const injected of [true,false])for(const [i,screen] of [['plain',['alpha beta','second line']],['unicode',['雪 é 👩‍💻','second line']],['ansi',['\x1b[31malpha\x1b[0m beta','tail  ']],['empty',['','']],['spaces',['   ',' \t']]]){
 add('selection','active-'+i+'-'+injected,[select(1),drag(3,1),release(3,1),active(),render(20),{op:'clear'},active('b')],{screen,injected});
 add('selection','release-'+i+'-'+injected,[select(1),drag(3,1),release(3,1),render(20)],{screen,injected,copyOnSelect:true});
}
add('selection','capture-before-poll-and-clear',[select(0),drag(4),active(),{op:'clear'},{op:'screen',lines:['changed','']},resolve(1,true),render(20)],{mode:deferred});
add('selection','release-retained-awaits',[select(0),drag(4),release(4),{op:'clear'},resolve(1,false),render(20)],{mode:deferred,copyOnSelect:true});
add('selection','rejection-from-auto-release',[select(0),drag(3),release(3),reject(1,'release rejected'),render(20)],{mode:deferred,copyOnSelect:true});
add('selection','toggle-copy-on-select',[select(0),drag(2),release(2),{op:'copyOnSelect',value:true},select(0,1),drag(2,1),release(2,1),render(20)]);
add('selection','single-empty-release',[select(0),release(0),active(),render(10)],{screen:[''],copyOnSelect:true});
add('selection','double-triple-click-copy',[select(1),release(1),{op:'time',value:1200},select(1),release(1),active('word'),{op:'time',value:1300},select(1),release(1),active('line'),render(20)]);
for(let seed=0;seed<10;seed++){
 const ops=[mode(deferred),copy('first-'+seed,'first'),copy('second-'+seed,'second'),copy('third-'+seed,'third'),render(20),resolve(2,seed%2===0?true:'specific '+seed),flash('manual-'+seed,seed-4),resolve(1,false),reject(3,'third rejected'),render(seed*3),fire(2),render(30),{op:'dispose'},fire(1),fire(3),mode(ready(true)),copy('last','last'),render(30),fire(4)];
 add('sequences','interleaved-'+seed,ops);
}
// Append-only regression matrix after inherited trimEnd defect was exposed.
// These are inputs, not a hand-coded expected trim implementation. The actual
// upstream getActiveSelectionText/clipboard methods generate every result.
const trimCodePoints=[9,10,11,12,13,32,160,5760,...Array.from({length:11},(_,i)=>8192+i),8232,8233,8239,8287,12288,65279,133,6158,8203,8288];
for(const codePoint of trimCodePoints)for(const injected of [true,false]){
 const ch=String.fromCodePoint(codePoint);
 add('selection','trimend-U'+codePoint.toString(16).padStart(4,'0')+'-'+injected,
  [select(0),drag(79,1),release(79,1),active(),render(20),fire(1)],
  {screen:[' \talpha'+ch,' beta'+ch],columns:80,injected});
}
for(const cases of Object.values(groups))for(const spec of cases)spec.expected=await run(spec);
writeFileSync('fixtures.json',JSON.stringify({...groups,wordSegments},null,2)+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(groups).map(([g,cases])=>[g,{cases:cases.length,steps:cases.reduce((n,c)=>n+c.ops.length,0)}])),null,2));
