// Controlled INPUTS only. The state machine is the unmodified full upstream class.
import {writeFileSync} from 'node:fs';
import {Container,dispatchMouseEvent} from './src/tui.ts';
import {TuiAltScreen} from './src/tui-alt-screen.ts';
import {renderLayoutFrame} from './src/layout.ts';
const raw=(button=0,x=1,y=0,release=false)=>({op:'raw',raw:{button,x,y,release}});
const response=(id,response,responses)=>({op:'response',id,response,responses});
const configure=value=>({op:'config',value});
const press=()=>raw(),release=()=>raw(0,1,0,true);
const target=(id='a',extra={})=>({id,originX:0,originY:0,width:12,height:2,...extra});
const apply=(id,flags,extra={})=>({op:'apply',target:target(id),flags,type:'move',...extra});
function run(input){
 let trace=[],config={},now=1000,focused=null;
 const objects=new Map(),names=new Map(),states=new Map();
 const savedSet=globalThis.setTimeout,savedClear=globalThis.clearTimeout,savedNow=Date.now;
 globalThis.setTimeout=()=>({unref(){}});globalThis.clearTimeout=()=>{};
 const terminal={columns:12,rows:8,write(){},start(){throw Error('no terminal start');},stop(){throw Error('no terminal stop');},hideCursor(){},showCursor(){}};
 const tui=new TuiAltScreen(terminal),root=new Container();
 const resolveTarget=t=>({component:objects.get(t.id),originX:t.originX,originY:t.originY,width:t.width,height:t.height});
 const targetValue=t=>t?{id:names.get(t.component),originX:t.originX,originY:t.originY,width:t.width,height:t.height}:null;
 const result=r=>r?.forward?{...r.flags,target:resolveTarget(r.forward),...(r.focusTarget?{focusTarget:objects.get(r.focusTarget)}:{})}:r??undefined;
 for(const id of ['a','b','owner']){
  const state={response:{handled:true},responses:{}};states.set(id,state);
  const o={render(){return [id,id];},invalidate(){},handleMouse(event){
   trace.push({op:'mouse',id,event:{...event}});
   return result(Object.hasOwn(state.responses??{},event.type)?state.responses[event.type]:state.response);
  }};objects.set(id,o);names.set(o,id);
 }
 objects.set('root',root);names.set(root,'root');root.addChild(objects.get('a'));root.addChild(objects.get('b'));
 const layout=()=>{tui.currentLayout=renderLayoutFrame(root,terminal.columns,terminal.rows,()=>{});};layout();
 const rawHook=(name,key)=>(r)=>{trace.push({op:name,raw:{...r}});return !!config[key];};
 tui.handleSearchMouseEvent=rawHook('search','search');
 tui.handleScrollToEndIndicatorMouseEvent=rawHook('indicator','indicator');
 tui.handleScrollbarMouseEvent=r=>{trace.push({op:'scrollbar',raw:{...r}});if(Object.hasOwn(config,'dragAfter'))tui.scrollbarDrag=config.dragAfter?{}:undefined;return !!config.scrollbar;};
 tui.updateScrollbarHover=(x,y)=>trace.push({op:'hover',x,y});
 tui.stopScrollbarHover=()=>trace.push({op:'stopHover'});
 tui.dispatchMouseToOverlay=e=>{
  trace.push({op:'overlay',event:{...e}});const o=config.overlay??{};
  const t=o.target?resolveTarget(o.target):undefined;
  const r=t?dispatchMouseEvent(t.component,{...e,x:e.screenX-t.originX,y:e.screenY-t.originY,width:t.width,height:t.height}):undefined;
  return {hit:!!o.hit,result:r};
 };
 const actualLayout=tui.dispatchMouseToLayout;
 tui.dispatchMouseToLayout=e=>{trace.push({op:'layout',event:{...e}});return actualLayout.call(tui,e);};
 tui.resolveMouseFocusTarget=c=>{trace.push({op:'resolveFocus',id:names.get(c)});return objects.get(config.focusMap?.[names.get(c)])??c;};
 tui.getFocusedComponent=()=>{trace.push({op:'getFocus'});return focused;};
 tui.setFocus=c=>{trace.push({op:'setFocus',id:names.get(c)});focused=c;};
 tui.clearTextSelection=()=>trace.push({op:'clearSelection'});
 tui.requestRender=()=>trace.push({op:'render'});
 tui.handleRightClickPaste=rawHook('paste','paste');
 tui.handleSelectionMouseEvent=r=>trace.push({op:'selection',raw:{...r}});
 Date.now=()=>{trace.push({op:'now',value:now});return now;};
 const snapshot=()=>({capture:targetValue(tui.mouseCapture),pressTarget:targetValue(tui.mousePressTarget),point:tui.mousePressPoint??null,moved:tui.mousePressMoved,lastClick:tui.lastComponentClick?{id:names.get(tui.lastComponentClick.component),timestamp:tui.lastComponentClick.timestamp,count:tui.lastComponentClick.count,x:tui.lastComponentClick.x,y:tui.lastComponentClick.y}:null,focused:focused?names.get(focused):null});
 const expected=[];
 try{
  for(const op of input.ops){
   let value=null;
   if(op.op==='raw')tui.handleMouseEvent(op.raw);
   else if(op.op==='response')Object.assign(states.get(op.id),{response:op.response,responses:op.responses??{}});
   else if(op.op==='config'){Object.assign(config,op.value);if(Object.hasOwn(op.value,'drag'))tui.scrollbarDrag=op.value.drag?{}:undefined;}
   else if(op.op==='time')now=op.value;
   else if(op.op==='size'){terminal.columns=op.columns;terminal.rows=op.rows;}
   else if(op.op==='layout')layout();
   else if(op.op==='remove')root.removeChild(objects.get(op.id));
   else if(op.op==='add')root.addChild(objects.get(op.id));
   else if(op.op==='delegate'){if(op.value)root.handleInput=()=>{};else delete root.handleInput;}
   else if(op.op==='apply'){
    const e=tui.createMouseEvent(op.type,op.button??0,op.x??1,op.y??0);
    value=tui.applyMouseDispatchResult(e,{...op.flags,target:resolveTarget(op.target),...(op.focusTarget?{focusTarget:objects.get(op.focusTarget)}:{})});
   }else if(op.op==='clear')tui.clearComponentMouseGesture();
   else if(['focusOut','start','stop'].includes(op.op)){
    // The full actual lifecycle helper executes, but compare ONLY mouse state.
    // All non-gesture effects are controlled/no-op, not a host lifecycle test.
    const oldHover=tui.stopScrollbarHover,oldRender=tui.requestRender;
    tui.stopScrollbarHover=()=>{};tui.requestRender=()=>{};tui.stopSelectionAutoScroll=()=>{};
    tui.stopScrollbarDrag=()=>{tui.scrollbarDrag=undefined;};tui.closeSearch=()=>{};
    tui.getSelectionBounds=()=>undefined;tui.resetRenderState=()=>{};tui.flashes={dispose(){}};
    if(op.op==='focusOut')tui.handleViewportInput('\x1b[O');
    else if(op.op==='start')tui.beforeTerminalStart();
    else{tui.altScreenActive=false;tui.beforeTerminalStop({});}
    tui.stopScrollbarHover=oldHover;tui.requestRender=oldRender;trace=[];
   }else throw Error('Unknown operation '+op.op);
   expected.push({value,state:snapshot(),trace});trace=[];
  }
  return {...input,expected};
 }finally{globalThis.setTimeout=savedSet;globalThis.clearTimeout=savedClear;Date.now=savedNow;}
}
const gestures=[],routes=[],clicks=[],retained=[],lifecycle=[];
// Release+click render OR; click side-effects must execute even if release renders.
for(const capture of [false,true])for(const releaseRender of [null,false,true])for(const clickRender of [null,false,true])for(const focus of [false,true]){
 const f=(render)=>({handled:true,focus,...(render===null?{}:{render})});
 gestures.push(run({name:`release-click-${capture}-${releaseRender}-${clickRender}-${focus}`,ops:[
  response('a',{handled:true,capture},{release:f(releaseRender),click:f(clickRender)}),press(),release(),
 ]}));
}
for(const r of [null,{render:true},{handled:true,render:false},{focus:true},{capture:true}])for(const c of [null,{handled:true,render:false},{focus:true}]){
 gestures.push(run({name:`decline-${JSON.stringify(r)}-${JSON.stringify(c)}`,ops:[response('a',{handled:true},{release:r,click:c}),press(),release()]}));
}
for(const button of [0,1,2,3,28,29,30,31,32,33,34,35,60,63]){
 gestures.push(run({name:`buttons-${button}`,ops:[raw(button),raw(button|32,1,0),raw(button,1,0,true)]}));
}
// Movement is sticky even after returning to press point, and all active events
// pre-empt search/overlay/indicator/scrollbar including another press.
for(const moved of [raw(32,2,0),raw(35,-4,90),raw(0,1,1),raw(0,2,0,true)]){
 gestures.push(run({name:`movement-${JSON.stringify(moved)}`,ops:[press(),release(),press(),configure({search:true,overlay:{hit:true},scrollbar:true,drag:true}),moved,raw(32),release()]}));
}
const routingConfigs=[{}, {search:true},{indicator:true},{scrollbar:true},{scrollbar:true,dragAfter:true},{scrollbar:false,dragAfter:true},{drag:true,dragAfter:false,scrollbar:true},{overlay:{hit:true}},{overlay:{hit:true},paste:true},{overlay:{hit:true,target:target('b',{originX:4,originY:6,width:3,height:1})}},{overlay:{hit:false,target:target('b')}},{paste:true}];
for(const config of routingConfigs)for(const e of [press(),raw(35),raw(2,30,30)]){
 routes.push(run({name:`route-${JSON.stringify(config)}-${JSON.stringify(e)}`,ops:[configure(config),e]}));
}
for(const input of [null,{render:true},{handled:true,render:false}])routes.push(run({name:`overlay-decline-${JSON.stringify(input)}`,ops:[response('b',input),configure({overlay:{hit:true,target:target('b')}}),press()]}));
// Input event kinds, focus identity/delegation, and explicit render false.
for(const type of ['press','release','move','drag','click','wheel'])for(const render of [null,false,true]){
 const flags={focus:true,...(render===null?{}:{render})};
 routes.push(run({name:`apply-${type}-${render}`,ops:[configure({focusMap:{a:'owner',b:'owner'}}),apply('a',flags,{type}),apply('b',flags,{type}),apply('a',{handled:true},{type,focusTarget:'b'})]}));
}
for(const times of [[0,500,1000,1500],[0,501,1002,1503],[900,700,500,300],[0,500,1001,1002]]){
 clicks.push(run({name:`click-cycle-${times}`,ops:times.flatMap(value=>[{op:'time',value},press(),release()])}));
}
clicks.push(run({name:'identity-and-cell',ops:[press(),release(),raw(0,1,2),raw(0,1,2,true),raw(0,2,2),raw(0,2,2,true),press(),release()]}));
clicks.push(run({name:'clear-retains-click-history',ops:[press(),release(),{op:'clear'},press(),release()]}));
retained.push(run({name:'removed-stale-target-and-resize',ops:[response('a',{handled:true,capture:true}),press(),{op:'remove',id:'a'},{op:'size',columns:4,rows:2},{op:'layout'},raw(32,99,-9),release()]}));
retained.push(run({name:'removed-click-and-history',ops:[press(),{op:'remove',id:'a'},{op:'layout'},release(),{op:'add',id:'a'},{op:'layout'},raw(0,1,2),raw(0,1,2,true)]}));
retained.push(run({name:'capture-precedes-press-target',ops:[press(),apply('b',{capture:true},{target:target('b',{originX:5,originY:7,width:3,height:4})}),release()]}));
retained.push(run({name:'capture-without-press-no-click',ops:[apply('b',{capture:true}),configure({search:true}),raw(35,19,20),release()]}));
retained.push(run({name:'release-recapture-click-still-original',ops:[response('a',{handled:true},{release:{flags:{capture:true,focus:true,render:true},forward:target('b',{originX:7,originY:9}),focusTarget:'owner'},click:{handled:true,focus:true,render:false}}),press(),release()]}));
retained.push(run({name:'forwarded-capture-from-move',ops:[response('a',{handled:true},{move:{flags:{capture:true},forward:target('b',{originX:2,originY:1})}}),raw(35),release()]}));
retained.push(run({name:'parent-focus-concrete-click-identity',ops:[{op:'delegate',value:true},response('a',{focus:true,capture:true,render:false}),press(),release(),press(),release()]}));
for(const kind of ['focusOut','start','stop']){
 lifecycle.push(run({name:`lifecycle-${kind}`,ops:[press(),release(),response('a',{handled:true,capture:true}),press(),{op:kind},press(),release()]}));
}
lifecycle.push(run({name:'stop-then-start-clears-history',ops:[press(),release(),{op:'stop'},{op:'start'},press(),release()]}));
// Appended coverage; the first 143 cases / 498 steps remain unchanged.
for(const decline of [null,{render:true},{handled:false}])routes.push(run({name:`press-decline-selection-${JSON.stringify(decline)}`,ops:[response('a',decline),press(),release()]}));
routes.push(run({name:'handled-noop-motion-no-render',ops:[response('a',null,{move:{handled:true}}),raw(35),raw(35)]}));
routes.push(run({name:'focus-only-move-renders-only-on-change',ops:[response('a',{focus:true}),raw(35),raw(35),release()]}));
for(const columns of [0,1])for(const rows of [0,1])routes.push(run({name:`clamped-event-size-${columns}-${rows}`,ops:[{op:'size',columns,rows},press(),release()]}));
gestures.push(run({name:'native-test-inspired-capture-drag-outside',ops:[response('a',{handled:true},{press:{handled:true,capture:true,focus:true}}),press(),raw(32,4,1),raw(0,4,1,true)]}));
clicks.push(run({name:'declined-click-still-advances-count',ops:[response('a',{handled:true},{release:null,click:null}),press(),release(),press(),release(),press(),release()]}));
clicks.push(run({name:'capture-without-point-does-not-clear-prior-click',ops:[press(),release(),apply('b',{capture:true}),raw(35,8,8),raw(0,8,8,true),press(),release()]}));
retained.push(run({name:'drag-recapture-next-event-new-target',ops:[response('a',{handled:true},{drag:{flags:{capture:true},forward:target('b',{originX:8,originY:9,width:4,height:3})}}),press(),raw(32,2,1),raw(32,9,10),raw(0,9,10,true)]}));
retained.push(run({name:'active-component-precedes-scrollbar-drag',ops:[configure({drag:true}),press(),raw(32),release()]}));
writeFileSync('fixtures.json',JSON.stringify({gestures,routes,clicks,retained,lifecycle},null,2)+'\n');
console.log('cases',JSON.stringify(Object.fromEntries(Object.entries({gestures,routes,clicks,retained,lifecycle}).map(([k,v])=>[k,{cases:v.length,steps:v.reduce((n,c)=>n+c.ops.length,0)}]))));
