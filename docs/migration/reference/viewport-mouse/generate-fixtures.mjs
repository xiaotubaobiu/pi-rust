// Expected values exclusively from the actual upstream classes and methods.
import {writeFileSync} from 'node:fs';
import {TuiAltScreen} from './src/tui-alt-screen.ts';
import {ScrollView} from './src/components/scroll-view.ts';
import {HStack} from './src/components/h-stack.ts';
import {VStack} from './src/components/v-stack.ts';
import {renderLayoutFrame} from './src/layout.ts';
const number=v=>typeof v==='string'?Number(v):v;
const leaf=(id,count)=>({kind:'leaf',id,count});
const scroll=(id,child,options={})=>({kind:'scroll',id,child,options:{scrollbarHideDelayMs:10,...options}});
const entry=(node,options={})=>({node,options});
const stack=(kind,id,children,options={})=>({kind,id,children:children.map(c=>c.node?c:entry(c)),options});
const terminal=(columns,rows)=>({columns,rows,write(){throw Error('OS/render path outside this oracle');},hideCursor(){},showCursor(){},start(){throw Error('No terminal loop');},stop(){}});
const parseTui=new TuiAltScreen(terminal(10,5));
const parseCases=[];
const parse=units=>{const text=String.fromCharCode(...units);parseCases.push({units,sgr:parseTui.parseSgrMouseEvent(text)??null,wheel:parseTui.parseWheelEvent(text)??null});};
const units=text=>Array.from({length:text.length},(_,i)=>text.charCodeAt(i));
for(let b=0;b<256;b++)for(const [x,y] of [[0,0],[1,1],[8,99]])for(const end of ['M','m'])parse(units(`[<${b};${x};${y}${end}`));
for(const b of [0,2,32,35,64,65,66,67,72,73,127,255])for(const suffix of ['','\n','\r','\r\n','\u2028','\u2029','\n\n','x',' ','\t']){
 parse(units(`[<${b};5;6M`+suffix));
}
for(const text of ['', '\x1b[<;1;1M','\x1b[<1;1M','\x1b[<+1;1;1M','\x1b[<-1;1;1M','\x1b[<1; 1;1M','\x1b[<1;1;1.0M','\x1b[<１;1;1M','x\x1b[<1;1;1M','\x1b[<1;1;1m\x1b[<1;1;1M','\x1b[<00064;00001;00000M','\x1b[<4294967360;1;1M','\x1b[<9007199254740991;9007199254740991;1M'])parse(units(text.replaceAll('\\x1b','\x1b')));
for(const b of [0,1,2,31,32,64,65,66,67,72,73,95,96,97,98,99,104,105,127,255,65535])for(const [x,y] of [[0,0],[32,32],[33,33],[100,255],[0xd800,0xdc00],[0xffff,1]])parse([27,91,77,b,x,y]);
for(const raw of [[27,91,77],[27,91,77,96,40,40,40],[27,91,109,96,40,40],[27,91,77,0xd800,0xdc00,33],[27,91,77,96,0xd800,0xdc00]])parse(raw);
const wheelLines=[];for(const value of [null,-8,0,0.9,1,1.9,3,6.7,'NaN','Infinity','-Infinity'])for(const button of [0,4,8,16,64,65,72,73,4294967304]){const tui=new TuiAltScreen(terminal(1,1),undefined,undefined,value===null?{}:{wheelScrollLines:number(value)});wheelLines.push({value,button,result:tui.getWheelScrollLines(button)});}
function runCase(input){
 let trace=[],now=0,next=0,frame,overlay=false;const jobs=new Map(),scrolls=new Map(),names=new Map();
 const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
 globalThis.setTimeout=(callback,delay)=>{const id=++next;jobs.set(id,{at:now+Math.max(1,Math.trunc(delay)),callback});return {id,unref(){}};};globalThis.clearTimeout=t=>{if(t)jobs.delete(t.id);};
 const tui=new TuiAltScreen(terminal(input.width,input.height),undefined,undefined,{wheelScrollLines:number(input.wheelLines)});
 tui.requestRender=()=>trace.push('render');tui.hasOverlay=()=>overlay;tui.stopSelectionAutoScroll=()=>trace.push('clearSelection');
 const implicit=tui.implicitScrollView;implicit.updateLayout(40,Math.max(1,input.height),()=>trace.push('render'));scrolls.set('implicit',implicit);names.set(implicit,'implicit');
 function build(spec){let obj;if(spec.kind==='leaf')obj={render(){return Array.from({length:spec.count},(_,i)=>`${spec.id}:${i}`);},invalidate(){}};
 else if(spec.kind==='scroll'){obj=new ScrollView(build(spec.child),spec.options);scrolls.set(spec.id,obj);names.set(obj,spec.id);}
 else obj=new (spec.kind==='hstack'?HStack:VStack)(spec.children.map(({node,options})=>({component:build(node),...options})),spec.options);return obj;}
 const root=build(input.tree),steps=[];trace=[];
 const state=()=>Object.fromEntries([...scrolls].map(([id,s])=>[id,{top:s.scrollTop,content:s.contentHeight,viewport:s.viewportHeight,follow:s.isFollowingEnd,visible:s.isScrollbarVisible,active:s.isScrollbarActive,bar:s.scrollbar}]));
 const target=(x,y,hidden)=>{const t=tui.getScrollbarTargetAt(x,y,hidden);return t?{id:names.get(t.scrollView),geometry:t.geometry}:null;};
 try{for(const action of input.steps){let result=null;switch(action.op){
 case 'frame':frame=renderLayoutFrame(root,action.width??input.width,action.height??input.height,()=>trace.push('render'));tui.currentLayout=frame;break;
 case 'clearFrame':frame=undefined;tui.currentLayout=undefined;break;
 case 'overlay':overlay=action.value;break;
 case 'wheel':tui.routeWheel({direction:action.direction,x:action.x,y:action.y,button:action.button});break;
 case 'mouse':result=tui.handleScrollbarMouseEvent(action.event);break;
 case 'hover':tui.updateScrollbarHover(action.x,action.y);break;
 case 'stopHover':tui.stopScrollbarHover();break;
 case 'stopDrag':tui.stopScrollbarDrag();break;
 case 'to':scrolls.get(action.id).scrollTo(action.value,{disableFollow:action.disableFollow??false});break;
 case 'bar':scrolls.get(action.id).setScrollbar(action.value);break;
 case 'tick':{const until=now+action.ms;while(true){const job=[...jobs].filter(([,j])=>j.at<=until).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!job)break;jobs.delete(job[0]);now=job[1].at;job[1].callback();}now=until;break;}
 case 'hit':result=target(action.x,action.y,action.hidden??false);break;
 default:throw Error('unknown action '+action.op);
 }
 steps.push({action,result,states:state(),hover:tui.scrollbarHover?names.get(tui.scrollbarHover):null,drag:tui.scrollbarDrag?{id:names.get(tui.scrollbarDrag.scrollView),offset:tui.scrollbarDrag.grabOffset}:null,trace});trace=[];
 }}finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
 return {...input,steps};
}
const shapes=[
 scroll('a',leaf('body',50),{primary:true,scrollbar:'always'}),
 scroll('a',leaf('body',50),{primary:true,scrollbar:'auto'}),
 scroll('a',leaf('body',50),{primary:true,scrollbar:'hidden',follow:'end'}),
 scroll('a',leaf('body',2),{primary:true,scrollbar:'always'}),
 stack('hstack','root',[entry(scroll('a',leaf('left',20),{primary:true,scrollbar:'always',follow:'end'}),{grow:1}),entry(scroll('b',leaf('right',18),{scrollbar:'auto'}),{grow:1})],{gap:1}),
 stack('hstack','root',[entry(scroll('a',leaf('left',20),{primary:true,scrollbar:'always'}),{grow:1}),entry(scroll('b',leaf('right',4),{overscroll:'contain',scrollbar:'always'}),{grow:1})]),
 scroll('a',stack('vstack','nested',[entry(scroll('b',leaf('inner',12),{scrollbar:'always'}),{basis:3}),leaf('tail',7)]),{primary:true,scrollbar:'always'}),
 scroll('a',stack('vstack','nested',[entry(scroll('b',leaf('inner',12),{overscroll:'contain',scrollbar:'auto'}),{basis:2}),leaf('tail',10)]),{primary:true,scrollbar:'auto'}),
 stack('vstack','root',[leaf('head',2),entry(scroll('a',leaf('body',30),{scrollbar:'always'}),{grow:1})]),
 leaf('empty',0)
];
const cases=[];let seed=0x50e117;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
for(let shape=0;shape<shapes.length;shape++)for(const width of [1,10])for(const height of [1,5,10])for(const wheel of [1,3]){
 const mouse=(button,x,y,release=false)=>({op:'mouse',event:{button,x,y,release}}),steps=[{op:'frame'},{op:'hit',x:width-1,y:0},{op:'hit',x:width-1,y:0,hidden:true},{op:'hover',x:width-1,y:0},mouse(0,width-1,Math.floor(height/2)),mouse(32,width+4,height+4),mouse(0,width+4,height+4,true),{op:'stopHover'},{op:'tick',ms:11},{op:'to',id:'a',value:0}].filter(a=>a.op!=='to'||shape<9);
 for(const [x,y,direction,button] of [[0,0,1,65],[width-1,0,1,73],[width-1,height-1,-1,72],[-1,-1,-1,64],[width,height,1,65]])steps.push({op:'wheel',x,y,direction,button});
 steps.push({op:'frame'},{op:'overlay',value:true},{op:'hover',x:width-1,y:0},mouse(0,width-1,0),{op:'wheel',x:0,y:0,direction:1,button:65},{op:'overlay',value:false},{op:'hover',x:width-1,y:0},mouse(0,width-1,0),{op:'clearFrame'},mouse(32,width-1,height),mouse(3,0,0,true),{op:'wheel',x:0,y:0,direction:-1,button:72},{op:'stopDrag'},{op:'frame',width:width+1,height:height+1});
 for(let i=0;i<22;i++){const x=random(width+3)-1,y=random(height+5)-2,n=random(8);steps.push(n<2?{op:'wheel',x,y,direction:n===0?-1:1,button:random(2)?72+n:64+n}:n===2?{op:'hover',x,y}:n===3?mouse(0,x,y):n===4?mouse(32,x,y):n===5?mouse(3,x,y,true):n===6?{op:'tick',ms:12}:{op:'hit',x,y,hidden:true});}
 steps.push({op:'stopDrag'},{op:'stopHover'},{op:'tick',ms:30});
 cases.push(runCase({name:`shape${shape}-w${width}-h${height}-wheel${wheel}`,tree:shapes[shape],width,height,wheelLines:wheel,steps}));
}
// Numeric option edges and runtime bar/geometry/overlay changes while captured.
for(const wheel of [-4,0,0.9,2.9,'NaN','Infinity','-Infinity'])for(const shape of [0,4,7]){
 const steps=[{op:'frame'},{op:'wheel',x:0,y:0,direction:1,button:65},{op:'wheel',x:9,y:4,direction:1,button:73},{op:'wheel',x:-1,y:-1,direction:-1,button:72},{op:'frame'},{op:'clearFrame'},{op:'wheel',x:0,y:0,direction:-1,button:64},{op:'tick',ms:15}];
 cases.push(runCase({name:`numeric-${wheel}-${shape}`,tree:shapes[shape],width:10,height:5,wheelLines:wheel,steps}));
}
for(const shape of [0,1,6,7]){
 const steps=[{op:'frame'},{op:'hover',x:9,y:4},{op:'mouse',event:{button:0,x:9,y:4,release:false}},{op:'frame',width:12,height:4},{op:'overlay',value:true},{op:'mouse',event:{button:32,x:11,y:-10,release:false}},{op:'bar',id:'a',value:'hidden'},{op:'mouse',event:{button:32,x:11,y:30,release:false}},{op:'bar',id:'a',value:'always'},{op:'mouse',event:{button:32,x:11,y:30,release:false}},{op:'mouse',event:{button:3,x:0,y:0,release:true}},{op:'stopHover'},{op:'overlay',value:false},{op:'tick',ms:20}];
 cases.push(runCase({name:`resize-drag-${shape}`,tree:shapes[shape],width:10,height:10,wheelLines:3,steps}));
}
const fixture={parseCases,wheelLines,cases};
writeFileSync('fixtures.json',JSON.stringify(fixture,(_,v)=>typeof v==='number'&&!Number.isFinite(v)?String(v):v,2)+'\n');
console.log(JSON.stringify({parseCases:parseCases.length,wheelLines:wheelLines.length,cases:cases.length,steps:cases.reduce((n,c)=>n+c.steps.length,0)}));
