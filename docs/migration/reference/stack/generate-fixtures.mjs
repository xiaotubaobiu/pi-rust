import { writeFileSync } from 'node:fs';
import { allocateStackSizes } from './src/components/stack.ts';
import { HStack } from './src/components/h-stack.ts';
import { VStack } from './src/components/v-stack.ts';
import { LAYOUT_NODE } from './src/layout-node.ts';
import { compositeTuiLine } from './src/tui.ts';
import { visibleWidth, wrapTextWithAnsi } from './src/utils.ts';

const number = x => x === 'NaN' ? NaN : x === 'Infinity' ? Infinity : x === '-Infinity' ? -Infinity : x;
const encode = x => Number.isNaN(x) ? 'NaN' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : x;
const options = o => Object.fromEntries(Object.entries(o ?? {}).filter(([k])=>k!=='visible').map(([k,v])=>[k,number(v)]));
let seed=0x19280924;
const random=n=>{ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed%n; };
const allocations=[];
function allocation(name,entries,intrinsic,available,gap) {
 const input={name,entries,intrinsic,available,gap};
 const result=allocateStackSizes(entries.map(options),intrinsic.map(number),available===null?undefined:number(available),number(gap));
 allocations.push({...input,sizes:result.map(encode)});
}
allocation('ordered_grow',[{basis:0,grow:1},{basis:0,grow:1}],[],10,0);
allocation('shrinks_to_minimum',[{minSize:1},{shrink:0}],[3,3],4,0);
allocation('nested_intrinsic_minima',[{minSize:3},{basis:'auto'}],[1,4],null,1);
for(let i=0;i<4096;i++){
 const count=random(6),entries=[],intrinsic=[];
 for(let j=0;j<count;j++){
  const e={}; if(random(3))e.basis=random(3)?random(20)-3:'auto';
  for(const k of ['grow','shrink','minSize','maxSize'])if(random(3))e[k]=random(k==='maxSize'?24:6);
  entries.push(e); if(random(5))intrinsic.push(random(18));
 }
 allocation('seeded_'+i,entries,intrinsic,random(5)?random(45):null,random(5));
}
for(const field of ['basis','grow','shrink','minSize','maxSize'])for(const value of [-2.5,0.4,1.8,7.9,'NaN','Infinity','-Infinity']){
 for(const available of [null,4])allocation('numeric_'+field+'_'+value+'_'+available,[{[field]:value},{basis:3,grow:1}],[2.8,4.7],available,1);
}
const normalizations=[];
for(const gap of [null,-2.8,0,1.9,'NaN','Infinity','-Infinity'])for(const value of [null,-2.8,0,1.9,'NaN','Infinity','-Infinity']){
 const opt=value===null?{}:{basis:value,grow:value,shrink:value,minSize:value,maxSize:value};
 const stack=new VStack([{component:{render:()=>[],invalidate(){}},...options(opt)}],gap===null?{}:{gap:number(gap)});
 const node=stack[LAYOUT_NODE]();
 const entries=node.entries.map(({component,...e})=>Object.fromEntries(Object.entries(e).map(([k,v])=>[k,encode(v)])));
 normalizations.push({gap,value,node:{type:node.type,gap:node.gap,align:node.align,entries}});
}
const scenarios=[
 {name:'basic',children:[{lines:['left']},{lines:['right']}]},
 {name:'wrap',children:[{lines:['alpha beta gamma'],mode:'wrap'},{lines:['x y z'],mode:'wrap'}],gap:1},
 {name:'zero',children:[{lines:['hidden'],basis:0,shrink:0},{lines:['shown'],basis:0,grow:1}]},
 {name:'visibility',children:[{lines:['one']},{lines:['hidden'],visible:'never'},{lines:['two'],visible:'wide'}],gap:1},
 {name:'minmax',children:[{lines:['a'],minSize:3,maxSize:2,grow:4},{lines:['b','c'],basis:9,maxSize:4,grow:1}],gap:2},
 {name:'overflow',children:[{lines:['long'] ,basis:7,shrink:0},{lines:['tail'],basis:4,shrink:0}],gap:3},
 {name:'grow',children:[{lines:['a'],basis:0,grow:1},{lines:['b'],basis:0,grow:2},{lines:['c'],basis:0,grow:1,maxSize:2}]},
 {name:'heights',children:[{lines:['a']},{lines:['b','c','d']},{lines:['e','f']}],gap:1},
 {name:'empty',children:[{lines:[]},{lines:['x']},{lines:[]}]},
 {name:'stateful',children:[{lines:['x'],mode:'stateful'},{lines:['y'],mode:'width'}]},
 {name:'color',children:[{lines:['\x1b[31mred','tail']},{lines:['\x1b[42mgreen']}]},
 {name:'hyperlink',children:[{lines:['\x1b]8;;https://example.invalid\x07abc\x1b]8;;\x07']},{lines:['def']}]},
 {name:'unicode',children:[{lines:['界a','😀','é'],mode:'wrap'},{lines:['中🙂']}]},
 {name:'image',children:[{lines:['\x1b_Gi=1;AAAA\x1b\\']},{lines:['overlay']}]},
 {name:'fractional',children:[{lines:['a'],basis:1.8,grow:1.9},{lines:['b'],grow:0.8,minSize:-2,maxSize:7.5}],gap:1.8},
 {name:'none',children:[],gap:2},
 {name:'nested',children:[{stack:'v',children:[{lines:['a']},{lines:['b','c']}],gap:1},{stack:'h',children:[{lines:['界']},{lines:['z']}],gap:1}],gap:1}
];
function build(direction,spec,trace,path='root',align='stretch'){
 const C=direction==='h'?HStack:VStack;
 const children=spec.children.map((entry,i)=>{
  const id=path+'.'+i; let count=0;
  const component=entry.stack?build(entry.stack,entry,trace,id,entry.align):{
   render(width){trace.push(['render',id,width]);count++;if(entry.mode==='width')return [String(width)+':'+id];if(entry.mode==='stateful')return [String(count),...entry.lines];return entry.mode==='wrap'?entry.lines.flatMap(s=>wrapTextWithAnsi(s,width)):[...entry.lines];},
   invalidate(){trace.push(['invalidate',id]);}
  };
  const o=options(Object.fromEntries(Object.entries(entry).filter(([k])=>['basis','grow','shrink','minSize','maxSize'].includes(k))));
  if(entry.visible)o.visible=viewport=>{trace.push(['visible',id,viewport.width,viewport.height]);return entry.visible!=='never'&&viewport.width>=4;};
  return {component,...o};
 });
 return new C(children,{gap:spec.gap,align});
}
const renders=[];
for(const scenario of scenarios)for(const direction of ['v','h'])for(const align of ['stretch','start','center','end'])for(const width of [0,1,2,4,8,12,20]){
 const trace=[],stack=build(direction,scenario,trace,'root',align);
 const first=stack.render(width),second=stack.render(width);stack.invalidate();const invalidated=stack.render(width);
 renders.push({name:scenario.name+'_'+direction+'_'+align+'_'+width,direction,align,width,scenario,first,second,invalidated,trace});
}
// Mutable lifecycle oracle. Component identities are unique; removal uses the
// current index to select the real upstream object. JS aliases are not modeled
// by Rust's Box<dyn Component> ownership boundary.
const lifecycleInitial=[
 {id:'initial-a',lines:['alpha'],bare:true},
 {id:'initial-b',lines:['hidden'],visible:'never',basis:2,grow:1.9}
];
const lifecycleActions=[
 {op:'render'},
 {op:'add',child:{id:'added-c',lines:['one','two'],basis:3,minSize:1}},
 {op:'add',child:{id:'added-d',lines:['tail'],mode:'stateful',grow:2}},
 {op:'render'},
 {op:'remove',index:1},
 {op:'render'},
 {op:'remove',index:99},
 {op:'invalidate'},
 {op:'render'},
 {op:'remove',index:0},
 {op:'remove',index:0},
 {op:'render'},
 {op:'clear'},
 {op:'invalidate'},
 {op:'render'},
 {op:'add',child:{id:'after-clear',lines:['fresh'],mode:'width',shrink:0.8,maxSize:7.9}},
 {op:'render'},
 {op:'remove',index:0},
 {op:'render'},
 {op:'clear'}
];
const lifecycles=[];
for(const direction of ['v','h'])for(const align of ['stretch','start','center','end'])for(const width of [0,8])for(const gap of [0,1.9,'NaN']){
 const trace=[],ids=new Map();
 function child(spec){
  let count=0;const component={
   render(width){trace.push(['render',spec.id,width]);count++;return spec.mode==='width'?[String(width)+':'+spec.id]:spec.mode==='stateful'?[String(count),...spec.lines]:[...spec.lines];},
   invalidate(){trace.push(['invalidate',spec.id]);}
  };
  ids.set(component,spec.id);
  const o=options(Object.fromEntries(Object.entries(spec).filter(([k])=>['basis','grow','shrink','minSize','maxSize'].includes(k))));
  if(spec.visible)o.visible=viewport=>{trace.push(['visible',spec.id,viewport.width,viewport.height]);return spec.visible!=='never'&&viewport.width>=4;};
  return spec.bare?component:{component,...o};
 }
 const C=direction==='h'?HStack:VStack;
 const stack=new C(lifecycleInitial.map(child),{gap:number(gap),align});
 const unknown={render:()=>[],invalidate(){}};
 const steps=[];
 for(const action of lifecycleActions){
  let lines=null;
  if(action.op==='render')lines=stack.render(width);
  else if(action.op==='add'){const entry=child(action.child);if('render' in entry)stack.addChild(entry);else stack.addChild(entry.component,entry);}
  else if(action.op==='remove')stack.removeChild(stack.children[action.index]??unknown);
  else if(action.op==='invalidate')stack.invalidate();
  else if(action.op==='clear')stack.clear();
  else throw Error('Unknown lifecycle action');
  const node=stack[LAYOUT_NODE]();
  const entries=node.entries.map(({component,visible,...o})=>({id:ids.get(component),...Object.fromEntries(Object.entries(o).map(([k,v])=>[k,encode(v)])),...(visible?{visible:true}:{})}));
  steps.push({lines,node:{type:node.type,align:node.align,gap:node.gap,entries},children:stack.children.map(c=>ids.get(c)),trace:[...trace]});
 }
 lifecycles.push({name:direction+'_'+align+'_'+width+'_'+gap,direction,align,width,gap,initial:lifecycleInitial,actions:lifecycleActions,steps});
}
const composites=[];
const bases=['','abc','\x1b[31ma界b','a😀bc','\x1b]8;;url\x07link\x1b]8;;\x07','\x1b_Gi=1;AAAA\x1b\\'];
const overlays=['','XY','界a','😀x','\x1b[42mcolor','\x1b]8;;uri\x1b\\link\x1b]8;;\x1b\\','\x1b_Gi=2;AAAA\x1b\\'];
function composite(base,overlay,start,width,total){const output=compositeTuiLine(base,overlay,start,width,total);composites.push({base,overlay,start,width,total,output,visibleWidth:visibleWidth(output)});}
composite('hello world','THERE',6,5,40);composite('ab','XY',6,2,20);composite('abc','0123456789',0,4,40);
for(const base of bases)for(const overlay of overlays)for(const start of [0,1,3,12])for(const width of [0,1,3,8])for(const total of [0,1,5,12])composite(base,overlay,start,width,total);
writeFileSync('fixtures.json',JSON.stringify({provenance:'Actual upstream 590144609: no layout or compositor reimplementation in generator',allocations,normalizations,renders,composites,lifecycles},null,2)+'\n');
console.log(JSON.stringify({allocations:allocations.length,normalizations:normalizations.length,renders:renders.length,composites:composites.length,lifecycles:lifecycles.length}));
