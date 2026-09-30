// Input probes; algorithms execute on complete, unchanged upstream classes.
import {writeFileSync} from 'node:fs';
import {Container} from './src/tui.ts';
import {TuiAltScreen} from './src/tui-alt-screen.ts';
import {HStack} from './src/components/h-stack.ts';
import {VStack} from './src/components/v-stack.ts';
import {ScrollView} from './src/components/scroll-view.ts';
import {MouseRegion} from './src/components/mouse-region.ts';
const event=(type='press',x=3,y=2,extra={})=>({type,button:'left',x:90,y:-80,screenX:x,screenY:y,width:30,height:20,shift:false,alt:false,ctrl:false,...extra});
const leaf=(id,response={handled:true},extra={})=>({id,kind:'leaf',response,...extra});
const container=(id,children,extra={})=>({id,kind:'container',children,...extra});
const stack=entries=>({op:'stack',entries});
const entry=(key,component,extra={})=>({key,component,...extra});
const rect=(key,extra={})=>({key,row:2,col:3,width:6,height:4,...extra});
const frame=layouts=>({op:'frame',layouts});
const owner=id=>({op:'owner',id});
const hit=(e=event(),save)=>({op:'hit',event:e,...(save?{save}:{})});
const raw=(button=0,x=3,y=2,release=false)=>({op:'raw',raw:{button,x,y,release}});
function run(input){
 let trace=[],focused=null,now=1000;const objects=new Map(),names=new Map(),states=new Map(),entries=new Map(),saved=new Map();
 const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout,oldNow=Date.now;
 globalThis.setTimeout=()=>({unref(){}});globalThis.clearTimeout=()=>{};
 const terminal={columns:30,rows:20,write(){throw Error('No IO');},start(){throw Error('No IO');},stop(){},hideCursor(){},showCursor(){}};
 const tui=new TuiAltScreen(terminal);
 const target=t=>t?{id:names.get(t.component),originX:t.originX,originY:t.originY,width:t.width,height:t.height}:null;
 const result=r=>r?{handled:!!r.handled,capture:!!r.capture,focus:!!r.focus,render:r.render??null,target:target(r.target),focusTarget:r.focusTarget?names.get(r.focusTarget):null}:null;
 const handler=id=>e=>{
  trace.push({op:'mouse',id,event:{...e}});const v=states.get(id).response;
  return v?.forward?{...v.flags,target:{...v.forward,component:objects.get(v.forward.id)},...(v.focusTarget?{focusTarget:objects.get(v.focusTarget)}:{})}:v??undefined;
 };
 try{
  for(const spec of input.nodes){
   states.set(spec.id,structuredClone(spec));let o;
   if(spec.kind==='leaf')o={render(){return [spec.id,spec.id];},invalidate(){},...(!spec.noHandler?{handleMouse:handler(spec.id)}:{})};
   else if(spec.kind==='container'){o=new Container();for(const id of spec.children)o.addChild(objects.get(id));if(spec.input)o.handleInput=()=>{};if(spec.override)o.handleMouse=handler(spec.id);}
   else if(spec.kind==='region')o=new MouseRegion(objects.get(spec.child),handler(spec.id));
   else if(spec.kind==='foreign')o={children:spec.children.map(id=>objects.get(id)),render(){return [];},invalidate(){}};
   else if(spec.kind==='scroll')o=new ScrollView(objects.get(spec.child),{scrollbar:'hidden'});
   else o=new(spec.kind==='hstack'?HStack:VStack)(spec.children.map(id=>({component:objects.get(id),...(spec.hiddenChild?{visible:()=>false}:{})})),{gap:0});
   objects.set(spec.id,o);names.set(o,spec.id);
  }
  const visibility=(key,s)=>(columns,rows)=>{trace.push({op:'visible',key,columns,rows});const v=s.visible;return v===true||(v&&typeof v==='object'&&columns>=(v.columns??0)&&rows>=(v.rows??0));};
  const actualResolve=tui.resolveMouseFocusTarget,actualOverlay=tui.dispatchMouseToOverlay;
  tui.resolveMouseFocusTarget=c=>{trace.push({op:'resolve',id:names.get(c)});return actualResolve.call(tui,c);};
  tui.dispatchMouseToOverlay=e=>{trace.push({op:'overlay',event:{...e}});return actualOverlay.call(tui,e);};
  for(const [method,name] of [['handleSearchMouseEvent','search'],['handleScrollToEndIndicatorMouseEvent','indicator'],['handleScrollbarMouseEvent','scrollbar'],['handleRightClickPaste','paste']])tui[method]=r=>{trace.push({op:name,raw:{...r}});return false;};
  tui.updateScrollbarHover=(x,y)=>trace.push({op:'hover',x,y});tui.stopScrollbarHover=()=>trace.push({op:'stopHover'});
  tui.dispatchMouseToLayout=e=>{trace.push({op:'layout',event:{...e}});return undefined;};
  tui.getFocusedComponent=()=>{trace.push({op:'getFocus'});return focused;};
  tui.setFocus=c=>{trace.push({op:'setFocus',id:names.get(c)});focused=c;};
  tui.clearTextSelection=()=>trace.push({op:'clearSelection'});tui.requestRender=()=>trace.push({op:'render'});
  tui.handleSelectionMouseEvent=r=>trace.push({op:'selection',raw:{...r}});
  Date.now=()=>{trace.push({op:'now',value:now});return now;};
  const snapshot=()=>({capture:target(tui.mouseCapture),pressTarget:target(tui.mousePressTarget),point:tui.mousePressPoint??null,moved:tui.mousePressMoved,lastClick:tui.lastComponentClick?{id:names.get(tui.lastComponentClick.component),timestamp:tui.lastComponentClick.timestamp,count:tui.lastComponentClick.count,x:tui.lastComponentClick.x,y:tui.lastComponentClick.y}:null,focused:focused?names.get(focused):null});
  const expected=[];
  for(const op of input.ops){
   let value=null;
   if(op.op==='stack'){
    tui.overlayStack=op.entries.map(spec=>{const s=structuredClone(spec);const e={component:objects.get(s.component),hidden:!!s.hidden,focusOrder:s.focusOrder??0,options:{nonCapturing:!!s.nonCapturing,...(Object.hasOwn(s,'visible')?{visible:visibility(s.key,s)}:{})}};entries.set(s.key,{entry:e,state:s});return e;});
   }else if(op.op==='frame')tui.renderedOverlayLayouts=op.layouts.map(x=>({...x,entry:entries.get(x.key).entry}));
   else if(op.op==='contains')value=tui.containsComponent(objects.get(op.root),objects.get(op.id));
   else if(op.op==='owner')value=names.get(tui.resolveMouseFocusTarget(objects.get(op.id)));
   else if(op.op==='hit'){const o=tui.dispatchMouseToOverlay(op.event);value={hit:o.hit,result:result(o.result)};if(op.save&&o.result)saved.set(op.save,o.result.target);}
   else if(op.op==='target')value=result(tui.dispatchMouseToTarget(op.event,saved.get(op.saved)));
   else if(op.op==='render')value=objects.get(op.id).render(op.width);
   else if(op.op==='hidden')entries.get(op.key).entry.hidden=op.value;
   else if(op.op==='visibility')entries.get(op.key).state.visible=op.value;
   else if(op.op==='drop'){const e=entries.get(op.key).entry;tui.overlayStack=tui.overlayStack.filter(x=>x!==e);}
   else if(op.op==='reverse')tui.overlayStack.reverse();
   else if(op.op==='frameReverse')tui.renderedOverlayLayouts.reverse();
   else if(op.op==='remove')objects.get(op.root).removeChild(objects.get(op.id));
   else if(op.op==='add')objects.get(op.root).addChild(objects.get(op.id));
   else if(op.op==='response')states.get(op.id).response=op.response;
   else if(op.op==='size'){terminal.columns=op.columns;terminal.rows=op.rows;}
   else if(op.op==='raw')tui.handleMouseEvent(op.raw);
   else if(op.op==='time')now=op.value;
   else throw Error('Unknown op '+op.op);
   expected.push({value,state:snapshot(),trace});trace=[];
  }
  return {...input,expected};
 }finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;Date.now=oldNow;}
}
const ownership=[],visibility=[],hits=[],mutations=[],gestures=[];
const tree=[leaf('a',{focus:true}),leaf('b'),leaf('outside'),{id:'region',kind:'region',child:'a',response:{focus:true}},{id:'foreign',kind:'foreign',children:['a']},container('inner',['a','a']),container('wrapper',['region']),{id:'horizontal',kind:'hstack',children:['a','b'],hiddenChild:true},{id:'vertical',kind:'vstack',children:['a','b'],hiddenChild:true},{id:'scroll',kind:'scroll',child:'a'},container('custom',['a'],{override:true,response:{focus:true}}),container('outer',['inner','b'])];
for(const root of tree.map(n=>n.id)){
 const ops=[stack([entry('o',root,{visible:true,nonCapturing:true,focusOrder:-1})])];
 for(const id of tree.map(n=>n.id))ops.push({op:'contains',root,id},owner(id));
 ownership.push(run({name:'structural-'+root,nodes:tree,ops}));
}
for(const spec of [{},{hidden:true,visible:true},{visible:false},{visible:true},{visible:{columns:31}},{visible:{rows:21}},{visible:{columns:10,rows:10},nonCapturing:true,focusOrder:999}]){
 const ops=[stack([entry('back','outer',{visible:true,focusOrder:10000}),entry('front','inner',spec)]),owner('a'),owner('outside'),{op:'size',columns:0,rows:0},owner('a'),{op:'size',columns:60,rows:30},owner('a'),{op:'reverse'},owner('a')];
 visibility.push(run({name:'visibility-'+JSON.stringify(spec),nodes:tree,ops}));
}
const responses=[null,{render:true},{handled:true},{capture:true},{focus:true},{focus:true,render:false},{forward:{id:'b',originX:-4,originY:7,width:13,height:2},flags:{handled:true,focus:false,capture:true,render:false},focusTarget:'outside'},{forward:{id:'b',originX:-4,originY:7,width:13,height:2},flags:{handled:true,focus:true,capture:true},focusTarget:'outside'}];
for(const response of responses)for(const kind of ['leaf','container','region']){
 const nodes=[leaf('a',response),leaf('b'),leaf('outside')];let top='a';
 if(kind==='container'){nodes.push(container('top',['a','b'],{input:true}));top='top';}
 if(kind==='region'){nodes.push({id:'top',kind:'region',child:'a',response:{focus:true}});top='top';}
 const ops=[stack([entry('back','b'),entry('top',top)]),frame([rect('back',{row:-10,col:-10,width:40,height:40}),rect('top')])];
 for(const type of ['press','release','move','drag','click','wheel'])for(const [x,y] of [[2,2],[3,1],[3,2],[8,5],[9,5],[8,6]])ops.push(hit(event(type,x,y,{shift:true,alt:true,ctrl:true,...(type==='click'?{clickCount:3}:{}),...(type==='wheel'?{wheelDelta:-1.5}:{}),button:type==='wheel'?'none':'right'})));
 hits.push(run({name:'hit-'+kind+'-'+JSON.stringify(response),nodes,ops}));
}
for(const geometry of [{width:0},{height:0},{row:-2,col:-3,width:4,height:3},{row:0,col:0,width:1,height:1}]){
 const nodes=[leaf('a',null,{noHandler:true}),leaf('b')];const ops=[stack([entry('back','b'),entry('top','a')]),frame([rect('back',{row:-10,col:-10,width:40,height:40}),rect('top',geometry)])];
 for(const [x,y] of [[-4,-2],[-3,-2],[-1,-1],[0,0],[1,1],[3,2],[8,5]])ops.push(hit(event('press',x,y)));
 hits.push(run({name:'geometry-no-handler-'+JSON.stringify(geometry),nodes,ops}));
}
for(const change of [{op:'hidden',key:'top',value:true},{op:'visibility',key:'top',value:false},{op:'drop',key:'top'},{op:'reverse'},{op:'frameReverse'},{op:'remove',root:'inner',id:'a'}]){
 const ops=[stack([entry('back','b',{visible:true}),entry('top','inner',{visible:true})]),{op:'render',id:'inner',width:6},frame([rect('back'),rect('top')]),hit(event(),'saved'),owner('a'),change,owner('a'),hit(event()),{op:'target',saved:'saved',event:event('drag',-20,40)},{op:'frame',layouts:[]},hit(event()),{op:'target',saved:'saved',event:event('release',3,2)}];
 mutations.push(run({name:'stale-'+JSON.stringify(change),nodes:tree,ops}));
}
for(const change of [{op:'drop',key:'top'},{op:'hidden',key:'top',value:true},{op:'visibility',key:'top',value:false},{op:'remove',root:'root',id:'a'},{op:'frame',layouts:[]},{op:'size',columns:1,rows:1}]){
 const nodes=[leaf('a',{capture:true,focus:true,render:false}),leaf('b'),container('root',['a'],{input:true})];
 const ops=[stack([entry('top','root',{visible:true})]),{op:'render',id:'root',width:6},frame([rect('top')]),raw(),change,raw(0,3,2,true),{op:'time',value:1100},raw(),raw(0,3,2,true)];
 gestures.push(run({name:'composed-'+JSON.stringify(change),nodes,ops}));
}
for(const response of [null,{render:true},{handled:true},{focus:true}]){
 const nodes=[leaf('a',response),leaf('b')];gestures.push(run({name:'route-decline-'+JSON.stringify(response),nodes,ops:[stack([entry('top','a')]),frame([rect('top')]),raw(),raw(0,3,2,true),raw(0,25,15),raw(0,25,15,true)]}));
}
// Append-only edge cases after the initial five Rust groups passed.
mutations.push(run({name:'all-aliases-removed-but-render-cache-retains-target',nodes:tree,ops:[stack([entry('top','inner',{visible:true})]),{op:'render',id:'inner',width:6},frame([rect('top')]),hit(event(),'a'),{op:'remove',root:'inner',id:'a'},owner('a'),{op:'remove',root:'inner',id:'a'},owner('a'),{op:'contains',root:'inner',id:'a'},hit(event()),{op:'add',root:'inner',id:'b'},owner('a'),hit(event()),{op:'target',saved:'a',event:event('release',100,-10)}]}));
ownership.push(run({name:'empty-and-unrendered-stack',nodes:tree,ops:[owner('a'),hit(event()),stack([entry('o','outer',{visible:true})]),owner('a'),hit(event()),frame([rect('o')]),hit(event()),{op:'drop',key:'o'},owner('a'),hit(event())]}));
visibility.push(run({name:'current-owner-order-is-independent-of-rendered-and-focus-order',nodes:tree,ops:[stack([entry('outer','outer',{visible:true,focusOrder:1000}),entry('inner','inner',{visible:true,focusOrder:-1000,nonCapturing:true})]),frame([rect('inner'),rect('outer')]),owner('a'),hit(event()),{op:'reverse'},owner('a'),hit(event()),{op:'hidden',key:'outer',value:true},owner('a'),hit(event()),{op:'frameReverse'},hit(event())]}));
hits.push(run({name:'custom-container-mouse-override-is-still-structural',nodes:tree,ops:[stack([entry('top','custom',{visible:true})]),frame([rect('top')]),owner('a'),{op:'contains',root:'custom',id:'a'},hit(event()),hit(event('release')),hit(event('wheel',3,2,{button:'none',wheelDelta:2.5})),{op:'hidden',key:'top',value:true},owner('a'),hit(event())]}));
writeFileSync('fixtures.json',JSON.stringify({ownership,visibility,hits,mutations,gestures},null,2)+'\n');
console.log(JSON.stringify({groups:Object.fromEntries(Object.entries({ownership,visibility,hits,mutations,gestures}).map(([k,v])=>[k,{cases:v.length,steps:v.reduce((n,c)=>n+c.ops.length,0)}]))}));
