// Inputs/probes only; routing/forwarding/cache behavior comes from complete actual sources.
import {writeFileSync} from 'node:fs';
import {Container,dispatchMouseEvent} from './src/tui.ts';
import {TuiAltScreen} from './src/tui-alt-screen.ts';
import {HStack} from './src/components/h-stack.ts';
import {VStack} from './src/components/v-stack.ts';
import {ScrollView} from './src/components/scroll-view.ts';
import {MouseRegion} from './src/components/mouse-region.ts';
import {renderLayoutFrame} from './src/layout.ts';
const flags=r=>r?{handled:!!r.handled,capture:!!r.capture,focus:!!r.focus,render:r.render??null}:null;
const event=(type='press',x=1,y=0,extra={})=>({type,button:'left',x,y,screenX:x+10,screenY:y+20,width:8,height:8,shift:false,alt:false,ctrl:false,...extra});
const leaf=(id,lines=['x'],response={handled:true},extra={})=>({id,kind:'leaf',lines,response,...extra});
const container=(id,children,input=false)=>({id,kind:'container',children,input});
const stack=(id,kind,children,extra={})=>({id,kind,children,options:{gap:1},...extra});
function run(input){
 let trace=[];const objects=new Map(),names=new Map(),states=new Map(),frames=new Map(),saved=new Map();
 const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
 globalThis.setTimeout=()=>({unref(){}});globalThis.clearTimeout=()=>{};
 const terminal={columns:8,rows:5,write(){throw Error('no terminal IO');},start(){throw Error('no terminal IO');},stop(){},hideCursor(){},showCursor(){}};
 const tui=new TuiAltScreen(terminal);
 const target=t=>({id:names.get(t.component),originX:t.originX,originY:t.originY,width:t.width,height:t.height});
 const result=r=>r?{...flags(r),target:target(r.target),focusTarget:r.focusTarget?names.get(r.focusTarget):null}:null;
 const handler=id=>e=>{trace.push({op:'mouse',id,event:{...e}});const s=states.get(id);return Object.hasOwn(s.responses??{},e.type)?s.responses[e.type]??undefined:s.response??undefined;};
 const setInput=(o,id,on)=>{if(on)o.handleInput=data=>trace.push({op:'input',id,data});else delete o.handleInput;};
 try{
  for(const spec of input.nodes){
   const s=structuredClone(spec);states.set(spec.id,s);let o;
   if(spec.kind==='leaf')o={render(width){trace.push({op:'render',id:spec.id,width});return s.lines.map(line=>line.replaceAll('{w}',String(width)));},invalidate(){trace.push({op:'invalidate',id:spec.id});},handleMouse:handler(spec.id)};
   else if(spec.kind==='container'){o=new Container();for(const id of spec.children)o.addChild(objects.get(id));setInput(o,spec.id,spec.input);}
   else if(spec.kind==='region')o=new MouseRegion(objects.get(spec.child),handler(spec.id));
   else if(spec.kind==='scroll')o=new ScrollView(objects.get(spec.child),{scrollbar:'hidden',...spec.options});
   else o=new (spec.kind==='hstack'?HStack:VStack)(spec.children.map(c=>typeof c==='string'?objects.get(c):{component:objects.get(c.id),...c.options,visible:c.options?.hidden?()=>false:undefined}),spec.options);
   if(spec.override)o.handleMouse=handler(spec.id);
   objects.set(spec.id,o);names.set(o,spec.id);
  }
  const boxSummary=b=>({id:names.get(b.component),rect:b.rect,clip:b.clip,children:b.children.map(boxSummary)});
  const pathBox=(frame,path)=>{let b=frame.root;for(const i of path)b=b.children[i];return b;};
  const expected=[];
  for(const op of input.ops){
   let value=null;const obj=objects.get(op.id);
   if(op.op==='render')value=obj.render(op.width);
   else if(op.op==='layout'){const f=renderLayoutFrame(objects.get(op.root),op.width,op.height,()=>trace.push({op:'requestRender'}));frames.set(op.name??'current',f);tui.currentLayout=f;value={lines:f.lines,root:boxSummary(f.root)};}
   else if(op.op==='hit'||op.op==='dispatch'||op.op==='target'){
    if(op.op==='hit'&&Object.hasOwn(op,'frame'))tui.currentLayout=op.frame===null?undefined:frames.get(op.frame);
    const r=op.op==='hit'?tui.dispatchMouseToLayout(op.event):op.op==='target'?tui.dispatchMouseToTarget(op.event,saved.get(op.saved)):dispatchMouseEvent(obj,op.event);
    if(op.save&&r)saved.set(op.save,r.target);value=result(r);
   }else if(op.op==='lines')states.get(op.id).lines=op.lines;
   else if(op.op==='response'){states.get(op.id).response=op.response;states.get(op.id).responses=op.responses;}
   else if(op.op==='add')obj.addChild(objects.get(op.child),op.options??{});
   else if(op.op==='remove')obj.removeChild(objects.get(op.child));
   else if(op.op==='clear')obj.clear();
   else if(op.op==='reverse')obj.children.reverse();
   else if(op.op==='input')obj.handleInput?.(op.data);
   else if(op.op==='delegate')setInput(obj,op.id,op.value);
   else if(op.op==='invalidate')obj.invalidate();
   else if(op.op==='geometry'){
    const f=frames.get(op.frame??'current'),b=pathBox(f,op.path);
    if(op.rect)b.rect={...op.rect};if(op.clip)b.clip={...op.clip};if(op.layer!==undefined)b.layer=op.layer;
   }else throw Error('unknown op '+op.op);
   expected.push({value,trace});trace=[];
  }
  return {...input,expected};
 }finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
}
const containers=[],layouts=[],mutations=[],regions=[];
// Cached and uncached Container forwarding: negative/out-of-bounds y, x is NOT clipped.
for(const rendered of [false,true])for(const delegate of [false,true])for(const nested of [false,true]){
 const nodes=[leaf('a',[],{handled:true}),leaf('b',['b0','b1'],{focus:true,capture:true}),leaf('c',['c'],null),container('inner',['a','b','c'],delegate),container('root',nested?['inner']:['a','b','c'],!delegate)];
 const ops=rendered?[{op:'render',id:'root',width:8}]:[];
 for(const width of [8,4])for(const type of ['press','release','move','drag','click','wheel'])for(const y of [-1,0,1,2,3,7,8])ops.push({op:'dispatch',id:'root',event:event(type,-3,y,{width,wheelDelta:type==='wheel'?-2.5:undefined,clickCount:type==='click'?2:undefined})});
 containers.push(run({name:`container-${rendered}-${delegate}-${nested}`,nodes,ops}));
}
// Layout engine + real router. Inherited Stack/ScrollView handlers must be skipped.
for(const kind of ['hstack','vstack'])for(const response of [null,{render:true},{handled:true},{capture:true},{focus:true,render:false}])for(const width of [1,8]){
 const nodes=[leaf('a',['a','a2'],response),leaf('b',['b'],{handled:true}),leaf('hidden',['hidden'],{handled:true}),container('wrapped',['a'],true),{id:'scroll',kind:'scroll',child:'wrapped'},stack('root',kind,[{id:'hidden',options:{hidden:true}},'scroll','b'])];
 const ops=[{op:'hit',frame:null,event:event()}, {op:'layout',root:'root',width,height:5}];
 for(const type of ['press','move','wheel'])for(const [x,y] of [[-1,0],[0,-1],[0,0],[0,1],[0,2],[1,0],[3,1],[7,4],[8,0],[0,5]])ops.push({op:'hit',event:event(type,x,y,{screenX:x,screenY:y,width,height:5,wheelDelta:type==='wheel'?1:undefined})});
 layouts.push(run({name:`layout-${kind}-${JSON.stringify(response)}-${width}`,nodes,ops}));
}
// Aliases overlap only via explicit geometry inputs, verifying visited identity and layer priority.
for(const response of [null,{handled:true}])for(const override of [false,true])for(const layer of [-1,0,5]){
 const nodes=[leaf('a',['a'],response),leaf('b',['b'],{handled:true}),stack('root','vstack',['a','a','b'],{override,response:{handled:true},options:{gap:0}})];
 const ops=[{op:'layout',root:'root',width:8,height:4}];
 const rect={x:0,y:0,width:8,height:4};for(const path of [[0],[1],[2]])ops.push({op:'geometry',path,clip:rect});ops.push({op:'geometry',path:[],layer});
 for(const type of ['press','move'])ops.push({op:'hit',event:event(type,1,0,{screenX:1,screenY:0})});
 layouts.push(run({name:`aliases-${!!response}-${override}-${layer}`,nodes,ops}));
}
// Zero-width boxes should preserve identity but must not dispatch through empty clips.
layouts.push(run({name:'zero-width',nodes:[leaf('a',['a'],null),leaf('b',['b'],{handled:true}),stack('root','hstack',[{id:'a',options:{basis:0,minSize:0,maxSize:0}},'b'],{options:{gap:0}})],ops:[{op:'layout',root:'root',width:4,height:3},{op:'hit',event:event('press',0,0,{screenX:0,screenY:0})}]}));
// A custom layout-node handler is not the inherited Container method and must be called.
layouts.push(run({name:'custom-scroll-handler',nodes:[leaf('a',['a'],null),{id:'root',kind:'scroll',child:'a',override:true,response:{focus:true}}],ops:[{op:'layout',root:'root',width:6,height:3},{op:'hit',event:event('press',0,0,{screenX:0,screenY:0})}]}));
// Container caches include removed children and survive add/clear/invalidate; width mismatch measures current children WITHOUT replacing cache.
for(const mutation of ['remove','clear','add','reverse','lines','invalidate']){
 const nodes=[leaf('a',['a0','a1'],{focus:true}),leaf('b',['b'],{handled:true}),leaf('new',['n0','n1','n2'],{capture:true}),container('root',['a','b'],true)];
 const change=mutation==='remove'?{op:'remove',id:'root',child:'a'}:mutation==='clear'?{op:'clear',id:'root'}:mutation==='add'?{op:'add',id:'root',child:'new'}:mutation==='reverse'?{op:'reverse',id:'root'}:mutation==='lines'?{op:'lines',id:'a',lines:[]}: {op:'invalidate',id:'root'};
 const ops=[{op:'render',id:'root',width:8},{op:'dispatch',id:'root',event:event(),save:'press'},change,{op:'dispatch',id:'root',event:event('press',1,0)},{op:'dispatch',id:'root',event:event('press',1,2,{width:5})},{op:'dispatch',id:'root',event:event('press',1,0)},{op:'target',saved:'press',event:event('drag',-20,-10,{screenX:-20,screenY:-10})},{op:'render',id:'root',width:8},{op:'dispatch',id:'root',event:event('press',1,0)}];
 mutations.push(run({name:`cached-${mutation}`,nodes,ops}));
}
mutations.push(run({name:'stale-layout-and-captured-target',nodes:[leaf('a',['a','a'],{capture:true,focus:true}),leaf('b',['b'],{handled:true}),stack('root','vstack',['a','b'],{options:{gap:0}})],ops:[{op:'layout',root:'root',width:8,height:5,name:'old'},{op:'hit',event:event('press',1,1,{screenX:1,screenY:1}),save:'target'},{op:'remove',id:'root',child:'a'},{op:'add',id:'root',child:'a'},{op:'layout',root:'root',width:4,height:3,name:'new'},{op:'hit',frame:'old',event:event('press',1,0,{screenX:1,screenY:0})},{op:'target',saved:'target',event:event('drag',20,-2,{screenX:20,screenY:-2})},{op:'clear',id:'root'},{op:'target',saved:'target',event:event('release',-2,12,{screenX:-2,screenY:12})},{op:'hit',frame:'new',event:event('press',1,0,{screenX:1,screenY:0})}]}));
mutations.push(run({name:'delegation-changes',nodes:[leaf('a',['a'],{focus:true}),container('inner',['a'],true),container('root',['inner'],true)],ops:[{op:'render',id:'root',width:8},{op:'dispatch',id:'root',event:event()},{op:'delegate',id:'root',value:false},{op:'dispatch',id:'root',event:event()},{op:'delegate',id:'inner',value:false},{op:'dispatch',id:'root',event:event()}]}));
// MouseRegion always calls the child first; only unhandled/render-only permits fallback.
for(const child of [null,{render:true},{handled:true},{capture:true},{focus:true}])for(const own of [null,{render:true},{handled:true},{focus:true,render:false}]){
 const nodes=[leaf('a',['a'],child),{id:'region',kind:'region',child:'a',response:own},container('root',['region'],true)];
 regions.push(run({name:`region-${JSON.stringify(child)}-${JSON.stringify(own)}`,nodes,ops:[{op:'render',id:'root',width:8},{op:'dispatch',id:'root',event:event()},{op:'invalidate',id:'root'}]}));
}
// Additional inputs: direct inherited handlers are intentionally different from layout routing.
const directLayouts=[];
for(const kind of ['hstack','vstack'])for(const width of [1,8]){
 const nodes=[leaf('hidden',['h0','h1'],{handled:true}),leaf('a',['a{w}'],null),leaf('b',['b0','b1'],{focus:true}),stack('root',kind,[{id:'hidden',options:{hidden:true}},'a','b'])];
 const ops=[{op:'render',id:'root',width}];
 for(const y of [-1,0,1,2,3,5])ops.push({op:'dispatch',id:'root',event:event('press',-8,y,{width})});
 ops.push({op:'layout',root:'root',width,height:6},{op:'hit',event:event('press',0,0,{screenX:0,screenY:0,width,height:6})});
 directLayouts.push(run({name:`direct-${kind}-${width}`,nodes,ops}));
}
for(const width of [1,8]){
 const nodes=[leaf('a',['a{w}','b'],{capture:true}),{id:'root',kind:'scroll',child:'a',options:{scrollbar:'always'}}];
 const ops=[{op:'render',id:'root',width}];
 for(const y of [-1,0,1,2])ops.push({op:'dispatch',id:'root',event:event('press',-8,y,{width})});
 ops.push({op:'layout',root:'root',width,height:4},{op:'hit',event:event('press',0,0,{screenX:0,screenY:0,width,height:4})});
 directLayouts.push(run({name:`direct-scroll-${width}`,nodes,ops}));
}
directLayouts.push(run({name:'region-keeps-stack-opaque',nodes:[leaf('a',['a'],null),leaf('b',['b'],{focus:true}),stack('stack','hstack',['a','b']),{id:'root',kind:'region',child:'stack',response:{handled:true}}],ops:[{op:'layout',root:'root',width:8,height:4},{op:'hit',event:event('press',0,0,{screenX:0,screenY:0})},{op:'hit',event:event('press',0,1,{screenX:0,screenY:1})}]}));
const fixture={containers,layouts,mutations,regions,directLayouts};
writeFileSync('fixtures.json',JSON.stringify(fixture,null,2)+'\n');
console.log(Object.fromEntries(Object.entries(fixture).map(([k,v])=>[k,{cases:v.length,steps:v.reduce((n,c)=>n+c.ops.length,0)}])));
