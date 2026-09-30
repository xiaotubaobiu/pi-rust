// Only input scenarios and host probes; all focus algorithms run in unchanged upstream modules.
import {writeFileSync} from 'node:fs';
import {Container} from './src/tui.ts';
import {TuiAltScreen} from './src/tui-alt-screen.ts';
const set=id=>({op:'set',id}), show=(key,id=key,extra={})=>({op:'show',key,id,...extra});
const focus=key=>({op:'focus',key}), hide=key=>({op:'hide',key}), hidden=(key,value)=>({op:'hidden',key,value});
const unfocus=(key,...target)=>({op:'unfocus',key,...(target.length?{target:target[0]}:{})});
const input=(data='x')=>({op:'input',data}), visible=(key,value)=>({op:'visibility',key,value});
const leaf=(id,extra={})=>({id,kind:'leaf',...extra});
const baseNodes=()=>['editor','a','b','c','first','second','target'].map(id=>leaf(id));
const pop={op:'pop'}, roots=ids=>({op:'roots',ids}), children=(id,ids)=>({op:'children',id,ids});
function run(spec){
 let trace=[],columns=80,rows=24,now=1000,mounted=[];
 const objects=new Map(),names=new Map(),nodeStates=new Map(),handles=new Map(),entries=new Map(),entryNames=new Map(),visibility=new Map();
 const terminal={get columns(){trace.push({op:'columns',value:columns});return columns;},get rows(){trace.push({op:'rows',value:rows});return rows;},hideCursor(){trace.push({op:'hideCursor'});},write(){throw Error('IO forbidden');},start(){throw Error('IO forbidden');},stop(){},showCursor(){}};
 const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout,oldNow=Date.now;
 globalThis.setTimeout=()=>({unref(){}});globalThis.clearTimeout=()=>{};
 const tui=new TuiAltScreen(terminal);
 const name=c=>c?names.get(c):null;
 const target=t=>t?{id:name(t.component),originX:t.originX,originY:t.originY,width:t.width,height:t.height}:null;
 const bounds=b=>b?{row:b.row,col:b.col,width:b.width,height:b.height}:null;
 try {
  for(const node of spec.nodes){
   const state={...structuredClone(node),focused:false};nodeStates.set(node.id,state);
   let object=node.kind==='container'?new Container():{render(){return [node.id,node.id];},invalidate(){}};
   if(node.kind==='container')for(const id of node.children??[])object.addChild(objects.get(id));
   if(node.kind==='foreign')object.children=(node.children??[]).map(id=>objects.get(id));
   if(node.focusable!==false)Object.defineProperty(object,'focused',{get(){return state.focused;},set(value){trace.push({op:'focused',id:node.id,value});state.focused=value;}});
   if(node.input!==false)object.handleInput=data=>{trace.push({op:'input',id:node.id,data});for(const op of spec.onInput?.[node.id]?.[data]??[])step(op);};
   if(node.mouse!==undefined)object.handleMouse=event=>{trace.push({op:'mouse',id:node.id,event:{...event}});return node.mouse??undefined;};
   objects.set(node.id,object);names.set(object,node.id);
  }
  tui.getMountedRoots=()=>{trace.push({op:'roots'});return mounted;};
  tui.requestRender=()=>trace.push({op:'render'});tui.requestImmediateRender=()=>trace.push({op:'immediate'});
  for(const [method,op] of [['handleSearchMouseEvent','search'],['handleScrollToEndIndicatorMouseEvent','indicator'],['handleScrollbarMouseEvent','scrollbar'],['handleRightClickPaste','paste']])tui[method]=raw=>{trace.push({op,raw:{...raw}});return false;};
  tui.updateScrollbarHover=(x,y)=>trace.push({op:'hover',x,y});tui.stopScrollbarHover=()=>trace.push({op:'stopHover'});
  tui.dispatchMouseToLayout=event=>{trace.push({op:'layout',event:{...event}});return undefined;};
  tui.clearTextSelection=()=>trace.push({op:'clearSelection'});tui.handleSelectionMouseEvent=raw=>trace.push({op:'selection',raw:{...raw}});
  Date.now=()=>{trace.push({op:'now',value:now});return now;};
  function step(op){
   const object=objects.get(op.id),handle=handles.get(op.key),entry=entries.get(op.key);
   switch(op.op){
    case 'set':tui.setFocus(object??null);break;
    case 'show':{
     const state={value:op.visible,index:0};visibility.set(op.key,state);
     const options={nonCapturing:op.nonCapturing??false};
     if(Object.hasOwn(op,'visible'))options.visible=(columns,rows)=>{
      let v=state.value;if(Array.isArray(v))v=v[Math.min(state.index++,v.length-1)];
      const value=v===true||!!(v&&typeof v==='object'&&columns>=(v.columns??0)&&rows>=(v.rows??0));
      trace.push({op:'visible',key:op.key,columns,rows,value});return value;
     };
     const h=tui.showOverlay(object,options),e=tui.overlayStack.at(-1);handles.set(op.key,h);entries.set(op.key,e);entryNames.set(e,op.key);break;
    }
    case 'focus':handle.focus();break;
    case 'hide':handle.hide();break;
    case 'hidden':handle.setHidden(op.value);break;
    case 'unfocus':Object.hasOwn(op,'target')?handle.unfocus({target:objects.get(op.target)??null}):handle.unfocus();break;
    case 'pop':tui.hideOverlay();break;
    case 'visibility':visibility.get(op.key).value=structuredClone(op.value);visibility.get(op.key).index=0;break;
    case 'size':columns=op.columns;rows=op.rows;break;
    case 'roots':mounted=op.ids.map(id=>objects.get(id));break;
    case 'children':object.children=op.ids.map(id=>objects.get(id));break;
    case 'input':tui.handleTerminalInput(op.data);break;
    case 'has':return tui.hasOverlay();
    case 'overlayFocused':return tui.isOverlayFocused();
    case 'isHidden':return handle.isHidden();
    case 'isFocused':return handle.isFocused();
    case 'bounds':entry.bounds=op.value?{...op.value}:undefined;break;
    case 'getBounds':{const b=handle.getBounds();const value=bounds(b);if(b&&op.mutate)b.row=999;return value;}
    case 'owner':return name(tui.resolveMouseFocusTarget(object));
    case 'render':object.render(op.width);break;
    case 'frame':tui.renderedOverlayLayouts=op.layouts.map(r=>({...r,entry:entries.get(r.key)}));break;
    case 'raw':tui.handleMouseEvent(op.raw);break;
    case 'time':now=op.value;break;
    default:throw Error('Unknown op '+op.op);
   }
   return null;
  }
  function snapshot(){
   const r=tui.overlayFocusRestore;
   const restore=r.status==='inactive'?{status:r.status}:{status:r.status,overlay:entryNames.get(r.overlay),...(r.status==='blocked'?{blockedBy:name(r.blockedBy),resume:r.resume.status==='restore-overlay'?{status:'restore-overlay'}:{status:'focus-target',target:name(r.resume.target)}}:{})};
   return {focused:name(tui.focusedComponent),restore,counter:tui.focusOrderCounter,stack:tui.overlayStack.map(e=>entryNames.get(e)),entries:Object.fromEntries([...entries].map(([key,e])=>[key,{component:name(e.component),preFocus:name(e.preFocus),hidden:e.hidden,nonCapturing:!!e.options?.nonCapturing,focusOrder:e.focusOrder,bounds:bounds(e.bounds)}])),flags:Object.fromEntries([...nodeStates].map(([id,s])=>[id,s.focusable===false?null:s.focused])),gesture:{capture:target(tui.mouseCapture),pressTarget:target(tui.mousePressTarget),point:tui.mousePressPoint??null,moved:tui.mousePressMoved,lastClick:tui.lastComponentClick?{id:name(tui.lastComponentClick.component),timestamp:tui.lastComponentClick.timestamp,count:tui.lastComponentClick.count,x:tui.lastComponentClick.x,y:tui.lastComponentClick.y}:null}};
  }
  trace=[];
  const expected=spec.ops.map(op=>{trace=[];const value=step(op);return {value,state:snapshot(),trace};});
  return {...spec,expected};
 }finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;Date.now=oldNow;}
}
const lifecycle=[],restore=[],visibility=[],identity=[],composed=[],sequences=[];
const add=(group,name,ops,extra={})=>group.push(run({name,nodes:baseNodes(),ops,...extra}));
for(const nc of [false,true]){
 add(lifecycle,'create-focus-unfocus-'+nc,[set('editor'),show('a','a',{nonCapturing:nc}),{op:'isFocused',key:'a'},focus('a'),focus('a'),unfocus('a'),input(),focus('a'),hide('a'),input(),hide('a'),focus('a')]);
 add(lifecycle,'hidden-idempotence-'+nc,[set('editor'),show('a','a',{nonCapturing:nc,visible:true}),hidden('a',false),hidden('a',true),hidden('a',true),focus('a'),{op:'isHidden',key:'a'},hidden('a',false),{op:'isFocused',key:'a'},input()]);
 add(lifecycle,'stale-hidden-is-not-membership-guarded-'+nc,[set('editor'),show('a','a',{nonCapturing:nc,visible:true}),hide('a'),hidden('a',true),hidden('a',false),{op:'isFocused',key:'a'},focus('a'),unfocus('a','target'),input(),hidden('a',true),pop]);
}
add(lifecycle,'nonfocused-explicit-unfocus-is-noop',[set('editor'),show('a','a',{nonCapturing:true,visible:true}),unfocus('a','target'),unfocus('a',null),unfocus('a'),input()]);
add(lifecycle,'timer-and-controller-cleanup',[set('editor'),show('a','a',{nonCapturing:true}),show('b'),hide('a'),pop,input(),pop]);
add(lifecycle,'focused-child-removal-retargets-parent',[set('editor'),show('a','a',{nonCapturing:true}),focus('a'),show('b'),show('c','c',{nonCapturing:true}),hide('a'),hide('b'),focus('c'),hide('c'),input()]);
add(lifecycle,'mixed-removal-chain',[set('editor'),show('a'),show('first','first',{nonCapturing:true}),show('b'),show('second','second',{nonCapturing:true}),hide('b'),hide('a'),pop,pop,input()]);
add(lifecycle,'pop-uses-insertion-not-focus-order',[set('editor'),show('a'),show('b'),show('c'),focus('a'),pop,input(),pop,input(),pop,input()]);
add(lifecycle,'fallback-uses-highest-focus-order',[set('editor'),show('a'),show('b'),show('c'),focus('a'),focus('b'),hidden('b',true),input(),hidden('b',false),hide('b'),input()]);
add(lifecycle,'noncapture-cycle',[set('editor'),show('a','a',{nonCapturing:true}),show('b','b',{nonCapturing:true}),focus('a'),focus('b'),focus('a'),unfocus('a'),input()]);
add(lifecycle,'three-overlays-explicit-cycle',[set('editor'),show('a'),show('b'),show('c'),focus('a'),input('a'),focus('b'),input('b'),focus('c'),input('c'),unfocus('c','editor'),input('e'),focus('a'),unfocus('a','editor'),input('E')]);
for(const target of [undefined,null,'target','a','b'])add(lifecycle,'unfocus-explicit-fallback-'+target,[set('editor'),show('a','a',{visible:true}),show('b','b',{visible:true}),focus('a'),...(target===undefined?[unfocus('a')]:[unfocus('a',target)]),input()]);
for(const focusable of [false,true])for(const hasInput of [false,true])add(lifecycle,'focusability-vs-keyboard-presence-'+focusable+'-'+hasInput,[set('editor'),show('a'),set('a'),input(),hide('a'),input()],{nodes:[leaf('editor'),leaf('a',{focusable,input:hasInput})]});
for(const mounted of [false,true]){
 add(restore,'replacement-internal-transfer-'+mounted,[roots(mounted?['first','second']:[]),set('editor'),show('a'),input('b'),input('n'),input('2'),input('close'),input('x')],{onInput:{a:{b:[set('first')]},first:{n:[set('second')]},second:{close:[roots([]),set('editor')]}}});
 for(const t of [undefined,null,'target','b'])add(restore,'blocked-unfocus-resume-'+mounted+'-'+t,[roots(mounted?['first']:[]),set('editor'),show('b','b',{nonCapturing:true}),show('a','a',{visible:true}),input('b'),...(t===undefined?[unfocus('a')]:[unfocus('a',t)]),input('wait'),input('close'),input('after')],{onInput:{a:{b:[set('first')]},first:{close:[set('editor')]}}});
}
add(restore,'replacement-preFocus-differs-from-next',[roots(['editor','first','second']),set('second'),show('a'),set('first'),roots(['editor']),set('editor'),input()]);
add(restore,'replacement-is-another-overlay-preFocus',[set('first'),show('b','b',{nonCapturing:true}),set('editor'),show('a'),set('first'),input(),set('editor'),input()]);
add(restore,'base-ancestor-steal-eligible',[set('editor'),show('a'),set('editor'),input(),set('editor'),unfocus('a'),input()]);
add(restore,'explicit-noncapturing-restore',[set('editor'),show('a'),show('b','b',{nonCapturing:true}),focus('b'),set('editor'),input()]);
add(restore,'explicit-null-clears-eligible',[set('editor'),show('a'),set(null),input()]);
add(restore,'null-resumes-blocked',[set('editor'),show('a'),set('first'),set(null),input()]);
add(restore,'pending-unfocus-without-focus',[set('editor'),show('a'),set('editor'),unfocus('a','target'),input(),unfocus('a','first'),input()]);
for(const useForeign of [false,true])add(restore,'mounted-structural-container-'+useForeign,[roots(['base']),set('editor'),show('a'),set('first'),set('second'),children('base',['editor']),set('editor'),input()],{nodes:[...baseNodes(),{id:'base',kind:useForeign?'foreign':'container',children:['editor','first','second'],focusable:false,input:false}]});
add(restore,'self-preFocus-cycle',[set('a'),show('a','a',{nonCapturing:true}),focus('a'),set('editor'),input(),set(null),input()]);
add(restore,'two-node-preFocus-cycle',[set('b'),show('a'),show('b'),focus('a'),set('first'),input(),set(null),input()]);
for(const action of [hide('a'),hidden('a',true),pop])add(restore,'blocked-entry-removal-'+JSON.stringify(action),[set('editor'),show('a'),set('first'),action,set('editor'),input()]);
for(const pre of [null,'editor'])add(visibility,'temporary-invisible-preserves-'+pre,[set(pre),show('a','a',{visible:true}),visible('a',false),input('x'),{op:'has'},{op:'overlayFocused'},visible('a',true),input('y')]);
add(visibility,'inactive-projection-not-deletion',[set('editor'),show('a','a',{visible:true}),set('editor'),visible('a',false),input(),unfocus('a'),visible('a',true),input()]);
add(visibility,'invisible-blocker-retains-raw-resume',[set('editor'),show('a','a',{visible:true}),set('first'),visible('a',false),unfocus('a','target'),set('editor'),visible('a',true),input()]);
add(visibility,'fallback-skips-noncapturing',[set('editor'),show('a','a',{visible:true}),show('b','b',{nonCapturing:true,visible:true}),show('c','c',{visible:true}),visible('c',false),input()]);
add(visibility,'dynamic-terminal-dimensions',[set('editor'),show('a','a',{visible:{columns:40,rows:10}}),{op:'size',columns:20,rows:24},input(),{op:'has'},focus('a'),{op:'size',columns:80,rows:5},input(),{op:'size',columns:80,rows:24},input()]);
add(visibility,'noncapturing-skips-visible-until-query',[set('editor'),show('a','a',{nonCapturing:true,visible:[false,true,false,true]}),hidden('a',true),{op:'has'},hidden('a',false),{op:'has'},focus('a'),input(),unfocus('a','target'),input()]);
for(const values of [[true,false,true],[false,true],[true,true,false,false,true]])add(visibility,'side-effectful-predicate-'+values,[set('editor'),show('a','a',{visible:values}),focus('a'),set('editor'),input(),{op:'has'},{op:'overlayFocused'},unfocus('a','target'),input()]);
add(visibility,'hidden-focus-target-counts-as-overlay',[set('editor'),show('a','a',{visible:true}),show('b','b',{visible:true}),hidden('b',true),set('first'),set('b'),input(),visible('a',false),input()]);
add(visibility,'bounds-copy-and-stale',[show('a','a',{visible:true}),{op:'getBounds',key:'a'},{op:'bounds',key:'a',value:{row:2,col:3,width:8,height:4}},{op:'getBounds',key:'a',mutate:true},{op:'getBounds',key:'a'},visible('a',false),{op:'getBounds',key:'a'},visible('a',true),hidden('a',true),{op:'getBounds',key:'a'},hidden('a',false),{op:'getBounds',key:'a'},hide('a'),{op:'getBounds',key:'a'}]);
add(identity,'duplicate-component-first-visible-entry',[set('editor'),show('one','a',{visible:true}),show('two','a',{visible:true}),focus('two'),set('first'),unfocus('two','target'),unfocus('one','editor'),set(null),hide('one'),{op:'isFocused',key:'two'},hide('two')]);
add(identity,'duplicate-first-invisible-second-visible',[set('editor'),show('one','a',{visible:false}),show('two','a',{visible:true}),set('editor'),input(),focus('two'),hidden('one',true),hide('one'),input(),hide('two'),input()]);
add(identity,'duplicate-stale-unhide-reuses-live-component',[set('editor'),show('one','a'),show('two','a'),hide('one'),hidden('one',true),hidden('one',false),unfocus('one',null),{op:'isFocused',key:'two'},focus('two'),hide('two'),hidden('one',true),hidden('one',false),input()]);
add(identity,'transitive-preFocus-retarget',[set('editor'),show('a'),show('b'),show('c'),hide('a'),hide('b'),hide('c'),input()]);
add(identity,'removed-entry-retained-preFocus',[set('editor'),show('a'),show('b'),hide('b'),hide('a'),hidden('b',true),hidden('b',false),unfocus('b'),input()]);
// Real mouse lifecycle + real focus controller (not the old focus-assignment seam).
const raw=(button=0,x=3,y=2,release=false)=>({op:'raw',raw:{button,x,y,release}});
const frame={op:'frame',layouts:[{key:'a',row:2,col:3,width:6,height:4}]};
for(const change of [hide('a'),hidden('a',true),visible('a',false),children('root',[]),{op:'frame',layouts:[]},set('first')]){
 const nodes=[...baseNodes(),leaf('mouse',{mouse:{capture:true,focus:true,render:false}}),{id:'root',kind:'container',children:['mouse'],input:true}];
 add(composed,'capture-survives-'+JSON.stringify(change),[set('editor'),show('a','root',{nonCapturing:true,visible:true}),{op:'render',id:'root',width:6},frame,raw(),change,raw(0,3,2,true),{op:'time',value:1100},raw(),raw(0,3,2,true),input()],{nodes});
}
for(const response of [null,{handled:true},{focus:true},{capture:true,focus:true}])add(composed,'direct-overlay-'+JSON.stringify(response),[set('editor'),show('a','a',{nonCapturing:true}),frame,raw(),raw(0,3,2,true),set('editor'),input()],{nodes:[leaf('editor'),leaf('a',{mouse:response})]});
// Deterministic operation sequences supplement named regressions; no random clock/entropy.
for(let seed=1;seed<=24;seed++){
 let x=seed;const next=n=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return x%n;};
 const ops=[roots(['editor','first','second']),set('editor'),show('a','a',{visible:true}),show('b','b',{visible:true,nonCapturing:!!(seed%2)}),show('c','c',{visible:true})];
 for(let j=0;j<36;j++){
  const key=['a','b','c'][next(3)];switch(next(11)){
   case 0:ops.push(focus(key));break;case 1:ops.push(hidden(key,!!next(2)));break;case 2:ops.push(visible(key,!!next(2)));break;
   case 3:ops.push(unfocus(key));break;case 4:ops.push(unfocus(key,[null,'editor','first','a','b'][next(5)]));break;
   case 5:ops.push(set([null,'editor','first','second','a','b','c'][next(7)]));break;case 6:ops.push(input());break;
   case 7:ops.push(roots(next(2)?['editor','first','second']:[]));break;case 8:ops.push({op:'has'},{op:'overlayFocused'});break;
   case 9:ops.push(j>24?hide(key):{op:'isFocused',key});break;case 10:ops.push({op:'size',columns:40+next(50),rows:10+next(20)});break;
  }
 }
 add(sequences,'seed-'+seed,ops);
}
// Append-only edge probes after the original six groups / 98 cases passed.
add(identity,'nested-live-owner-ignores-focus-order',[
 set('editor'),show('i','inner',{nonCapturing:true,visible:true}),show('o','outer',{nonCapturing:true,visible:true}),
 {op:'owner',id:'mouse'},focus('i'),{op:'owner',id:'mouse'},hidden('o',true),{op:'owner',id:'mouse'},hidden('o',false),
 {op:'owner',id:'mouse'},children('outer',[]),{op:'owner',id:'mouse'},children('inner',[]),{op:'owner',id:'mouse'},hide('i'),{op:'owner',id:'mouse'}
],{nodes:[...baseNodes(),leaf('mouse'),{id:'inner',kind:'container',children:['mouse']},{id:'outer',kind:'container',children:['inner']}]});
add(identity,'foreign-child-list-does-not-own-focus',[
 show('f','foreign',{visible:true}),{op:'owner',id:'a'},{op:'owner',id:'foreign'},show('g','base',{nonCapturing:true,visible:true}),
 {op:'owner',id:'a'},hide('g'),{op:'owner',id:'a'}
],{nodes:[...baseNodes(),{id:'foreign',kind:'foreign',children:['a']},{id:'base',kind:'container',children:['a']}]});
add(identity,'same-component-different-entry-bounds',[
 show('one','a',{visible:true}),show('two','a',{visible:true}),{op:'bounds',key:'one',value:{row:0,col:0,width:1,height:1}},
 {op:'bounds',key:'two',value:{row:3,col:4,width:8,height:2}},{op:'getBounds',key:'one'},{op:'getBounds',key:'two'},
 hide('one'),{op:'getBounds',key:'one'},{op:'getBounds',key:'two'},hidden('two',true),{op:'isFocused',key:'one'}
]);
add(restore,'invisible-blocker-moved-then-pending-explicit-unfocus',[
 set('editor'),show('a','a',{visible:true}),set('first'),visible('a',false),set('second'),visible('a',true),unfocus('a','target'),input()
]);
add(visibility,'bounds-null-and-no-predicate-dimensions-short-circuit',[
 {op:'has'},show('a'),{op:'getBounds',key:'a'},{op:'bounds',key:'a',value:{row:0,col:0,width:0,height:0}},{op:'getBounds',key:'a'},
 {op:'bounds',key:'a',value:null},{op:'getBounds',key:'a'},hidden('a',true),{op:'has'},focus('a'),hidden('a',false),hide('a'),{op:'getBounds',key:'a'}
]);
add(visibility,'hidden-first-same-component-falls-back-before-input',[
 set('editor'),show('first','a',{visible:true}),show('second','a',{nonCapturing:true,visible:true}),hidden('first',true),
 focus('second'),input(),{op:'isFocused',key:'first'},hide('first'),input(),hide('second'),input()
]);
const groups={lifecycle,restore,visibility,identity,composed,sequences};
writeFileSync('fixtures.json',JSON.stringify(groups,null,2)+'\n');
console.log(JSON.stringify({groups:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,{cases:v.length,steps:v.reduce((n,c)=>n+c.ops.length,0)}]))}));
