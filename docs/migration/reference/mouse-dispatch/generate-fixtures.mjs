// All expectations invoke unchanged actual-source functions/classes.
import {writeFileSync} from 'node:fs';
import {dispatchMouseEvent,retargetMouseEvent} from './src/tui.ts';
import {TuiAltScreen} from './src/tui-alt-screen.ts';
import {Input} from './src/components/input.ts';
import {SelectList} from './src/components/select-list.ts';
const terminal={columns:12,rows:5,write(){throw Error('no OS');},start(){throw Error('no OS');},stop(){},hideCursor(){},showCursor(){}};
const tui=new TuiAltScreen(terminal);
const types=['press','release','move','drag','click','wheel'];
const flags=r=>r?{handled:!!r.handled,capture:!!r.capture,focus:!!r.focus,render:r.render??null}:null;
const target=t=>({id:t.component.id,originX:t.originX,originY:t.originY,width:t.width,height:t.height});
const result=r=>r?{...flags(r),target:target(r.target),focusTarget:r.focusTarget?.id??null}:null;
const leaf=id=>({id,render:()=>['x'],invalidate(){}});
const a=leaf('a'),b=leaf('b'),parent=leaf('parent');
const create=[],raw=[],dispatch=[],retarget=[],render=[],clicks=[],inputs=[],selects=[];
for(const type of types)for(const button of [...Array.from({length:256},(_,i)=>i),4294967360,9007199254740991])for(const [x,y,cols,rows] of [[-1,-1,0,0],[2,3,12,5]]){
 terminal.columns=cols;terminal.rows=rows;
 const extra=type==='wheel'?{wheelDelta:(button%3-1)*2.5}:type==='click'?{clickCount:button%3+1}:{};
 create.push({type,button,x,y,cols,rows,extra,expected:tui.createMouseEvent(type,button,x,y,extra)});
}
terminal.columns=12;terminal.rows=5;
// Observe type selection in the real handleMouseEvent, with all downstream
// hit tests empty;selection/paste are explicitly outside this fixture scope.
tui.handleSelectionMouseEvent=()=>{};tui.handleRightClickPaste=()=>false;
const originalCreate=tui.createMouseEvent.bind(tui);let observed;
tui.createMouseEvent=(...args)=>{observed=originalCreate(...args);return observed;};
for(let button=0;button<256;button++)for(const release of [false,true]){
 const event={button,x:-1,y:3,release};observed=undefined;tui.handleMouseEvent(event);
 if(!observed)throw Error('real handleMouseEvent did not normalize');raw.push({event,expected:observed});
}
tui.createMouseEvent=originalCreate;
const base=(type='press')=>({...tui.createMouseEvent(type,8,10,11),x:-3,y:4,width:7,height:2});
for(const type of types)for(let bits=0;bits<8;bits++)for(const rr of [null,false,true]){
 const response={handled:!!(bits&1),capture:!!(bits&2),focus:!!(bits&4),...(rr===null?{}:{render:rr})};
 const event=base(type),trace=[];a.handleMouse=e=>{trace.push(e);return response;};
 dispatch.push({event,response,expected:result(dispatchMouseEvent(a,event)),trace});
}
for(const response of [null,{}]){const event=base();a.handleMouse=()=>response??undefined;dispatch.push({event,response,expected:result(dispatchMouseEvent(a,event))});}
for(const focus of [false,true])for(const capture of [false,true])for(const rr of [null,false,true]){
 const response={handled:true,focus,capture,...(rr===null?{}:{render:rr}),target:{component:b,originX:-7,originY:12,width:3,height:8},focusTarget:parent};
 const event=base('drag');a.handleMouse=()=>response;const actual=dispatchMouseEvent(a,event);
 if(actual!==response)throw Error('forwarded result identity changed');
 dispatch.push({event,response:result(response),forwarded:true,expected:result(actual)});
}
for(const type of types)for(const sx of [-100,-1,0,20])for(const sy of [-3,0,100])for(const origin of [-7,0,30]){
 const event={...base(type),screenX:sx,screenY:sy,wheelDelta:0.25,clickCount:3};
 const t={component:a,originX:origin,originY:-origin,width:0,height:13};
 retarget.push({event,target:target(t),expected:retargetMouseEvent(event,t)});
}
// Only the return-value expression of real applyMouseDispatchResult is under
// test here;focus/capture side-effect integration remains host work.
for(const type of types)for(const focus of [false,true])for(const changed of [false,true])for(const rr of [null,false,true]){
 tui.resolveMouseFocusTarget=c=>c;tui.getFocusedComponent=()=>changed?b:a;tui.setFocus=()=>{};
 const r={handled:true,focus,capture:false,...(rr===null?{}:{render:rr}),target:{component:a,originX:0,originY:0,width:1,height:1}};
 render.push({type,focus,changed,render:rr,expected:tui.applyMouseDispatchResult(base(type),r)});
}
const savedNow=Date.now;let now=0;Date.now=()=>now;
try{
 const sequence=[];for(let i=0;i<12;i++)sequence.push({id:'a',x:1,y:2,ms:i*100});
 sequence.push({id:'a',x:1,y:2,ms:1600},{id:'a',x:1,y:2,ms:2101},{id:'a',x:1,y:2,ms:1600},{id:'b',x:1,y:2,ms:1601},{id:'b',x:2,y:2,ms:1602},{id:'b',x:2,y:3,ms:1603},{clear:true},{id:'b',x:2,y:3,ms:1604});
 let seed=14127;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
 for(let i=0;i<160;i++)sequence.push(i%29===0?{clear:true}:{id:rand(4)?'a':'b',x:rand(3)-1,y:rand(3)-1,ms:rand(3000)-1000});
 for(const action of sequence){if(action.clear){tui.lastComponentClick=undefined;clicks.push({action,expected:null});continue;}now=action.ms;const component=action.id==='a'?a:b;const count=tui.getComponentClickCount({component,originX:3,originY:4,width:10,height:2},action.x,action.y);clicks.push({action,expected:count});}
}finally{Date.now=savedNow;}
for(const value of ['', 'hello world', '界a😀é tail'])for(const width of [8,40])for(const end of [false,true])for(const x of [-100,-1,0,1,2,3,6,20,100]){
 const input=new Input();input.setValue(value);input.focused=true;if(end)input.handleInput('');input.render(width);
 const event={...base(),button:'left',x,y:0,width,height:1};const r=input.handleMouse(event);
 inputs.push({value,width,end,event,expected:flags(r),prefix:value.slice(0,input.cursor)});
}
const theme=Object.fromEntries(['selectedPrefix','selectedText','description','scrollInfo','noMatch'].map(k=>[k,s=>s]));
for(const count of [0,1,5])for(const start of [0,2])for(const delta of [null,0,-0,-2.5,0.25,-Infinity,Infinity,NaN]){
 const items=Array.from({length:count},(_,i)=>({value:String(i),label:'item'+i}));const list=new SelectList(items,3,theme);list.setSelectedIndex(start);
 const trace=[];list.onSelectionChange=item=>trace.push(item.value);
 const event={...base('wheel'),...(delta===null?{}:{wheelDelta:delta})};
 const r=list.handleMouse(event);selects.push({count,start,event,expected:flags(r),selected:list.getSelectedItem()?.value??null,trace});
}
const fixture={create,raw,dispatch,retarget,render,clicks,inputs,selects};
writeFileSync('fixtures.json',JSON.stringify(fixture,(_,v)=>typeof v==='number'&&!Number.isFinite(v)?String(v):v,2)+ '\n');
console.log(Object.fromEntries(Object.entries(fixture).map(([k,v])=>[k,v.length])));
