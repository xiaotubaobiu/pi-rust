// Only scenarios/host services; all reference algorithms run in copied actual modules.
import {writeFileSync} from 'node:fs';
import {Container} from './src/tui.ts';
import {TuiAltScreen} from './src/tui-alt-screen.ts';
import {ScrollView} from './src/components/scroll-view.ts';
import {MouseRegion} from './src/components/mouse-region.ts';
import {getWordSegmenter} from './src/utils.ts';
import {renderLayoutFrame} from './src/layout.ts';
const groups={highlights:[],screen:[],scroll:[],composed:[],sequences:[]}, wordSegments={};
const p=(x,y=0,button=0)=>({op:'selection',raw:{button,x,y,release:false}});
const r=(x,y=0,button=0)=>({op:'selection',raw:{button,x,y,release:true}});
const m=(x,y=0,button=32)=>p(x,y,button);
const raw=op=>({...op,op:'raw'}), click=(x,y=0)=>[p(x,y),r(x,y)];
const text={op:'text'}, clear={op:'clear'}, tick={op:'tick'};
const leaf=(id,lines=['alpha beta','second line'],responses={})=>({id,kind:'leaf',lines,responses});
const nodes=()=>[leaf('body'),leaf('other'),{id:'region',kind:'region',child:'body',responses:{click:{handled:true}}},{id:'container',kind:'container',children:['region']},{id:'scroll',kind:'scroll',child:'container'}];
const rect=(x=0,y=0,width=20,height=4)=>({x,y,width,height});
const box=(id,extra={})=>({id,rect:rect(),clip:rect(),children:[],...extra});
const frame=(boxes=[box('container')])=>({op:'frame',boxes});
const time=value=>({op:'time',value});
const add=(g,name,ops,extra={})=>groups[g].push({name,nodes:nodes(),screen:['alpha beta','second line','third row',''],ops,...extra});
const scrollFrame=(id='scroll',extra={})=>frame([box(id,{lines:['alpha beta','second line','third row','fourth line','fifth row','last line'],rect:rect(2,1,12,3),clip:rect(2,1,12,3),...extra})]);
const configure=(id='scroll',top=0,content=6,viewport=3)=>({op:'scroll',id,top,content,viewport});
async function run(spec){
 let trace=[],now=1000,nextTimer=0,savedLayout;const timers=new Map(),objects=new Map(),names=new Map(),states=new Map(),handles=new Map(),entries=new Map();
 const terminal={columns:spec.columns??20,rows:spec.rows??4,hideCursor(){trace.push({op:'hideCursor'});},write(){throw Error('OS IO forbidden');},start(){throw Error('OS start forbidden');},stop(){},showCursor(){}};
 const oldNow=Date.now,oldSet=globalThis.setInterval,oldClear=globalThis.clearInterval,oldTimeout=globalThis.setTimeout,oldClearTimeout=globalThis.clearTimeout;
 const segmenter=getWordSegmenter(),oldSegment=segmenter.segment;
 segmenter.segment=function(line){const parts=Array.from(oldSegment.call(this,line));const data=parts.map(s=>({text:s.segment,isWordLike:s.isWordLike===true}));if(wordSegments[line]&&JSON.stringify(wordSegments[line])!==JSON.stringify(data))throw Error('nonstable segment service');wordSegments[line]=data;trace.push({op:'segments',line});return parts;};
 Date.now=()=>{trace.push({op:'now',value:now});return now;};
 globalThis.setTimeout=()=>({unref(){}});globalThis.clearTimeout=()=>{};
 globalThis.setInterval=(callback,millis)=>{const token=++nextTimer;timers.set(token,callback);trace.push({op:'interval',token,millis});return {token,unref(){trace.push({op:'unref',token});}};};
 globalThis.clearInterval=timer=>{timers.delete(timer.token);trace.push({op:'cancel',token:timer.token});};
 const options={copyOnSelect:spec.copyOnSelect??true};
 if(spec.urlMode)options.openUrl=url=>{trace.push({op:'url',url});if(spec.urlMode==='error')throw Error('controlled opener failure');};
 const tui=new TuiAltScreen(terminal,undefined,undefined,options);
 const name=c=>c?names.get(c):null, point=p=>p?{row:p.row,col:p.col,scrollView:name(p.scrollView),boundary:p.boundary===true}:null;
 const range=r=>r?{start:point(r.start),end:point(r.end)}:null;
 const target=t=>t?{id:name(t.component),originX:t.originX,originY:t.originY,width:t.width,height:t.height}:null;
 const handler=(id,state)=>event=>{trace.push({op:'mouse',id,event:{...event}});return state.responses?.[event.type]??undefined;};
 try{
  for(const node of spec.nodes){
   const state=structuredClone(node);states.set(node.id,state);let object;
   if(node.kind==='leaf'){
    object={render(){return [...state.lines];},invalidate(){},handleMouse:handler(node.id,state)};
    state.focused=false;Object.defineProperty(object,'focused',{get(){return state.focused;},set(value){state.focused=value;trace.push({op:'focused',id:node.id,value});}});
   }else if(node.kind==='region')object=new MouseRegion(objects.get(node.child),handler(node.id,state));
   else if(node.kind==='container'){object=new Container();for(const id of node.children)object.addChild(objects.get(id));}
   else if(node.kind==='scroll')object=new ScrollView(objects.get(node.child),{scrollbar:'hidden',follow:node.followEnd?'end':undefined});
   else throw Error('bad node');
   objects.set(node.id,object);names.set(object,node.id);
  }
  tui.previousScreen=[...spec.screen];tui.requestRender=()=>trace.push({op:'render'});
  tui.getMountedRoots=()=>[...objects.values()];
  tui.copyTextToClipboard=text=>{trace.push({op:'copy',text});return Promise.resolve(true);};
  for(const [method,op] of [['handleSearchMouseEvent','search'],['handleScrollToEndIndicatorMouseEvent','indicator'],['handleScrollbarMouseEvent','scrollbar'],['handleRightClickPaste','paste']])tui[method]=raw=>{trace.push({op,raw:{...raw}});return false;};
  tui.updateScrollbarHover=(x,y)=>trace.push({op:'hover',x,y});tui.stopScrollbarHover=()=>trace.push({op:'stopHover'});
  const has=tui.hasOverlay.bind(tui);tui.hasOverlay=()=>{trace.push({op:'hasOverlay'});return has();};
  async function step(op){
   const object=objects.get(op.id);
   switch(op.op){
    case 'savePaintFrame':savedLayout=tui.currentLayout;break;
    case 'highlight':return tui.applySelectionHighlight(op.text);
    case 'paint':case 'paintBounds':{
     const screen=op.screen??tui.previousScreen, before=JSON.stringify(screen), state=JSON.stringify(snapshot());
     const saved=tui.getSelectionBounds;
     const point=p=>({...p,scrollView:objects.get(p.scrollView)});
     if(op.op==='paintBounds')tui.getSelectionBounds=()=>op.bounds?{start:point(op.bounds.start),end:point(op.bounds.end)}:undefined;
     let result;
     try{result=tui.applySelection(screen,op.layout==='none'?null:op.layout==='saved'?savedLayout:undefined);}
     finally{tui.getSelectionBounds=saved;}
     if(JSON.stringify(screen)!==before||JSON.stringify(snapshot())!==state)throw Error('paint mutated source or selection');
     return result;
    }
    case 'selection':tui.handleSelectionMouseEvent(op.raw);break;
    case 'raw':tui.handleMouseEvent(op.raw);break;
    case 'tick':tui.autoScrollSelection();break;
    case 'clear':tui.clearTextSelection();break;
    case 'stopAuto':tui.stopSelectionAutoScroll();break;
    case 'text':return tui.getActiveSelectionText()??null;
    case 'has':return tui.hasActiveSelection();
    case 'copy':return await tui.copyActiveSelectionToClipboard();
    case 'copyOnSelect':tui.setCopyOnSelect(op.value);return tui.getCopyOnSelect();
    case 'time':now=op.value;break;
    case 'screen':tui.previousScreen=[...op.lines];break;
    case 'size':terminal.columns=op.columns;terminal.rows=op.rows;break;
    case 'frame':{
     if(!op.boxes){tui.currentLayout=undefined;break;}
     const boxes=op.boxes.map(b=>({component:objects.get(b.id),scrollView:objects.get(b.id) instanceof ScrollView?objects.get(b.id):undefined,rect:{...b.rect},clip:{...b.clip},children:[],layer:b.layer??0,...(b.lines!==undefined?{scrollContentLines:[...b.lines]}:{})}));
     op.boxes.forEach((b,i)=>{boxes[i].children=(b.children??[]).map(j=>{boxes[j].parent=boxes[i];return boxes[j];});});
     tui.currentLayout={root:boxes[0],lines:[],width:terminal.columns,height:terminal.rows};break;
    }
    case 'renderFrame':tui.currentLayout=renderLayoutFrame(object,terminal.columns,terminal.rows,()=>trace.push({op:'layoutRender'}));if(op.screen)tui.previousScreen=[...tui.currentLayout.lines];break;
    case 'columns':return tui.getSelectionColumns(op.line,op.row,{start:op.start,end:op.end},op.min,op.max);
    case 'scroll':object.updateLayout(op.content,op.viewport,()=>trace.push({op:'scrollRender',id:op.id}));object.scrollTo(op.top);break;
    case 'point':return point(tui.getSelectionPoint(op.raw,object));
    case 'word':return range(tui.getWordSelection({row:op.row,col:op.col,scrollView:object}));
    case 'line':return range(tui.getLineSelection({row:op.row,col:op.col,scrollView:object}));
    case 'render':object.render(op.width??terminal.columns);break;
    case 'responses':states.get(op.id).responses=structuredClone(op.value);break;
    case 'lines':states.get(op.id).lines=[...op.value];break;
    case 'children':object.children=op.ids.map(id=>objects.get(id));break;
    case 'focus':tui.setFocus(object??null);break;
    case 'show':{
     const h=tui.showOverlay(object,{nonCapturing:op.nonCapturing??true});handles.set(op.key,h);entries.set(op.key,tui.overlayStack.at(-1));break;
    }
    case 'hide':handles.get(op.key).hide();break;
    case 'hidden':handles.get(op.key).setHidden(op.value);break;
    case 'overlayFrame':tui.renderedOverlayLayouts=op.layouts.map(l=>({...l,entry:entries.get(l.key)}));break;
    default:throw Error('unknown '+op.op);
   }return null;
  }
  function snapshot(){
   const c=tui.lastClick;
   return {anchor:point(tui.selectionAnchor),focus:point(tui.selectionFocus),granularity:tui.selectionGranularity,initialRange:range(tui.selectionInitialRange),lastClick:c?{timestamp:c.timestamp,count:c.count,row:c.row,scrollView:name(c.scrollView),wordStart:c.wordStart,wordEnd:c.wordEnd}:null,dragPointer:tui.selectionDragPointer??null,direction:tui.selectionAutoScrollDirection,timer:tui.selectionAutoScrollTimer?.token??null,pressActive:tui.selectionPressActive,pressedUrl:tui.pressedUrl??null,dragged:tui.selectionDragged,copyOnSelect:tui.getCopyOnSelect(),bounds:range(tui.getSelectionBounds()),text:tui.getActiveSelectionText()??null,focused:name(tui.focusedComponent),flags:Object.fromEntries([...states].filter(([,s])=>s.kind==='leaf').map(([id,s])=>[id,s.focused])),scrolls:Object.fromEntries([...objects].filter(([,c])=>c instanceof ScrollView).map(([id,c])=>[id,{top:c.scrollTop,following:c.isFollowingEnd}])),gesture:{capture:target(tui.mouseCapture),pressTarget:target(tui.mousePressTarget),point:tui.mousePressPoint??null,moved:tui.mousePressMoved,lastClick:tui.lastComponentClick?{id:name(tui.lastComponentClick.component),timestamp:tui.lastComponentClick.timestamp,count:tui.lastComponentClick.count,x:tui.lastComponentClick.x,y:tui.lastComponentClick.y}:null}};
  }
  const expected=[];trace=[];
  for(const op of spec.ops){trace=[];const value=await step(op);expected.push({value,state:snapshot(),trace});}
  return {...spec,expected};
 }finally{Date.now=oldNow;globalThis.setInterval=oldSet;globalThis.clearInterval=oldClear;globalThis.setTimeout=oldTimeout;globalThis.clearTimeout=oldClearTimeout;segmenter.segment=oldSegment;}
}

// Direct normalized bounds are an explicit input seam; bounds normalization is
// tested by the unchanged Selection oracle and the real-event scenarios below.
const paint={op:'paint'}, pt=(row,col,boundary=false,scrollView)=>({row,col,boundary,...(scrollView?{scrollView}:{})});
const bounds=(sr,sc,er,ec,boundary=false,scrollView)=>({start:pt(sr,sc,false,scrollView),end:pt(er,ec,boundary,scrollView)});
const direct=(range,extra={})=>({op:'paintBounds',bounds:range,...extra});
const samples=[
 ['', 'empty'],['plain text','plain'],['\x1b[1mal\x1b[0mpha','reset'],['a\x1b[27mb\x1b[7mc\x1b[mZ','inverse-off'],
 ['\x1b[38;2;1;2;3mRGB\x1b[39m tail','rgb'],['\x1b]8;;https://example.com/m\x1b\\A界🙂\x1b]8;;\x1b\\Z','osc8-st'],
 ['\x1b]8;;https://example.com\x07éZ\x1b]8;;\x07!','osc8-bel'],['\x1b[2Kfoo\x1b[1Gbar','non-sgr-csi'],
 ['\x1b_Ga=T,i=1;AAAA\x1b\\','kitty'],['pre\x1b_Ga=T;AA\x1b\\post','embedded-kitty'],
 ['\x1b]1337;File=inline=1:AA\x07','iterm'],['pre\x1b]1337;File=inline=1:AA\x07post','embedded-iterm'],
 ['\x1bP1;2|abc\x1b\\XYZ','dcs-not-normalized'],['\x1b[31','incomplete-csi'],['x\x1b]8;;bad','incomplete-osc'],
 ['\x1b[31m\x1b[0m','ansi-only'],['\u0301\u200b','zero-width'],['A界🙂éZ','graphemes'],
 ['A👨‍👩‍👧‍👦B🇺🇸C✈️D','zwj-rgi'],['a\tb','tab'],[' \u00a0\u3000x  ','space'],
 ['\x1b]0;titlem\x07x','osc-ending-payload-m'],['\x1b_ABCm\x1b\\x','apc'],['\x1b[?25h text mZ','permissive-csi'],
 ['a\x1b[0m\x1b[0m\x1b[0mb','consecutive-resets'],['\x1b[H\x1b[J\x1b[Kabc','cursor'],
 ['\x1b[31m界\x1b[0m🙂é\x1b[27mZ','colored-graphemes'],['\r\n\x00\x07','controls'],
 ['𝒜𝔅𝕮','astral-non-emoji'],['\x1b\\end','standalone-st']
];
for(const [text,name] of samples)add('highlights','highlight-'+name,[{op:'highlight',text}]);
for(const [line,name]of samples){
 for(const [tag,range]of [['leading',bounds(0,0,0,3)],['trailing',bounds(0,1,0,99,true)],['boundary',bounds(0,0,0,2,true)],['multiline',bounds(0,1,2,2)]])
  add('screen',name+'-'+tag,[direct(range)],{screen:[line,'middle',line],columns:20,rows:1});
}
for(const [name,ops,extra]of [
 ['no-bounds',[direct(null)],{}],['zero-terminal-columns',[direct(bounds(0,0,3,99))],{columns:0}],
 ['short-screen',[direct(bounds(0,0,5,99))],{screen:['abc']}],['empty-screen',[direct(bounds(0,0,5,99))],{screen:[]}],
 ['range-after-screen',[direct(bounds(10,0,12,9))],{}],['endpoint-after-width',[direct(bounds(0,50,0,99))],{}],
 ['screen-not-terminal-height',[direct(bounds(0,0,3,99))],{rows:1}],['paint-twice-no-accumulation',[direct(bounds(0,1,0,4)),direct(bounds(0,1,0,4))],{}],
 ['explicit-screen-not-previous',[direct(bounds(0,1,0,4),{screen:['\x1b[31mXYZ\x1b[0mnew']})],{}],
 ['column-one-cuts-wide',[direct(bounds(0,0,1,5))],{columns:1,screen:['界X','🙂Z']}],
 ['no-layout-needed-for-screen',[direct(bounds(0,0,1,3),{layout:'none'})],{}]
])add('screen',name,ops,extra);
const clipScreens=['HEADER', '0123456789ABCDEFGHIJK', 'a界🙂éZ             ', '\x1b[1mal\x1b[0mpha beta gamma', 'tail'];
const geometry=[
 ['ordinary',rect(2,1,12,3),rect(2,1,12,3)], ['clip-inset',rect(1,0,15,5),rect(4,1,6,3)],
 ['negative-origin',rect(-3,-2,18,7),rect(-2,-1,17,6)],['start-above',rect(2,1,12,3),rect(2,1,12,3)],
 ['clip-disjoint-x',rect(2,1,4,3),rect(10,1,5,3)],['clip-disjoint-y',rect(2,0,12,1),rect(2,2,12,3)],
 ['negative-right',rect(-12,0,4,4),rect(-10,0,3,4)],['bottom-offscreen',rect(2,4,12,5),rect(2,4,12,5)],
 ['zero-rect-width',rect(2,1,0,3),rect(0,0,20,5)],['zero-rect-height',rect(2,1,12,0),rect(0,0,20,5)],
 ['zero-clip-width',rect(2,1,12,3),rect(4,1,0,3)],['zero-clip-height',rect(2,1,12,3),rect(2,1,12,0)],
 ['column-wide-edge',rect(1,0,3,5),rect(2,0,2,5)], ['row-negative-end',rect(0,-8,20,9),rect(0,-8,20,9)],
 ['negative-col-end',rect(-9,0,14,5),rect(-9,0,14,5)],['clip-outside-terminal',rect(17,0,9,5),rect(18,0,8,5)]
];
for(const [name,r,c]of geometry)for(const top of [0,2,7])for(const boundary of [false,true]){
 add('scroll',`${name}-top${top}-boundary${boundary}`,[configure('scroll',top,30,3),frame([box('scroll',{rect:r,clip:c})]),direct(bounds(0,1,7,5,boundary,'scroll'))],{screen:clipScreens,rows:2});
}
for(const [name,ops] of [
 ['missing-frame',[configure(),direct(bounds(0,0,2,6,false,'scroll'))]],
 ['missing-box',[configure(),frame([box('container')]),direct(bounds(0,0,2,6,false,'scroll'))]],
 ['explicit-no-frame',[configure(),scrollFrame(),direct(bounds(0,0,2,6,false,'scroll'),{layout:'none'})]],
 ['missing-content-lines-still-paints',[configure(),frame([box('scroll')]),direct(bounds(0,0,2,6,false,'scroll'))]],
 ['negative-end-column-inclusive',[configure('scroll',0),frame([box('scroll',{rect:rect(-5,0,20,4),clip:rect(-5,0,20,4)})]),direct(bounds(0,0,0,4,false,'scroll')),direct(bounds(0,0,0,5,false,'scroll'))]],
 ['negative-end-column-boundary',[configure('scroll',0),frame([box('scroll',{rect:rect(-5,0,20,4),clip:rect(-5,0,20,4)})]),direct(bounds(0,0,0,5,true,'scroll')),direct(bounds(0,0,0,6,true,'scroll'))]],
 ['negative-start-row-not-clamped',[configure('scroll',2),frame([box('scroll')]),direct(bounds(0,15,2,3,false,'scroll'))]],
 ['correct-identity-not-shape',[configure(),frame([box('otherScroll')]),direct(bounds(0,0,2,6,false,'scroll'))]],
 ['saved-layout-not-current',[configure(),scrollFrame(),{op:'savePaintFrame'},frame([box('container')]),direct(bounds(0,0,2,6,false,'scroll'),{layout:'saved'}),direct(bounds(0,0,2,6,false,'scroll'))]],
 ['image-lines-inside-scroll',[configure(),frame([box('scroll')]),direct(bounds(0,0,3,99,false,'scroll'))]]
])add('scroll',name,ops,{nodes:[...nodes(),{id:'otherScroll',kind:'scroll',child:'body'}],screen:name==='image-lines-inside-scroll'?['a\x1b_Ga=T;AA\x1b\\b','\x1b]1337;File=inline=1:AA\x07','ordinary','last']:clipScreens});
// These bounds are not injected: real mouse events operate on real owning
// components and real renderLayoutFrame output. Paint itself must have no effects.
const content=['\x1b[1mal\x1b[0mpha','A界🙂éZ','third row  ','fourth row','fifth row','last row'];
const render={op:'renderFrame',id:'scroll',screen:true};
const composedNodes=()=>[leaf('body',content),{id:'container',kind:'container',children:['body']},{id:'scroll',kind:'scroll',child:'container'}];
for(const [name,ops]of [
 ['no-selection',[render,paint]],['equal-endpoints',[render,p(2,1),paint,r(2,1),paint]],
 ['forward-reset',[render,p(0),m(4,1),paint,r(4,1),paint]],['reverse-graphemes',[render,p(4,1),m(1),paint,r(1),paint]],
 ['word-boundary',[render,...click(2),...click(2),paint]],['line-boundary',[render,...click(2),...click(2),...click(2),paint]],
 ['clear-stops-paint',[render,p(0),m(5,1),paint,clear,paint]],
 ['scroll-projection-live-top',[render,p(2),m(5,1),paint,{op:'scroll',id:'scroll',content:6,viewport:3,top:2},render,paint]],
 ['scroll-offscreen-start',[render,p(4),m(2,1),{op:'scroll',id:'scroll',content:6,viewport:3,top:2},render,m(3,1),paint]],
 ['autoscroll-then-paint',[render,p(1,1),m(8,2),tick,render,paint,r(8,2),paint]],
 ['frame-lost',[render,p(0),m(5,1),frame(null),paint]],
 ['saved-frame-after-replacement',[render,p(0),m(5,1),{op:'savePaintFrame'},frame([box('container')]),{op:'paint',layout:'saved'},paint]],
 ['stale-screen-new-content',[render,p(0),m(5,1),{op:'lines',id:'body',value:['changed screen','replacement','tail']},render,paint]],
 ['explicit-screen',[render,p(0),m(5,1),{op:'paint',screen:['NEW \x1b[0mLINE','🙂界tail','image\x1b_Gabc\x1b\\']}]],
 ['terminal-column-resize',[render,p(0),m(5,1),{op:'size',columns:4,rows:3},paint,render,paint]],
 ['raw-gesture-fallback',[render,raw(p(0)),raw(m(5,1)),paint,raw(r(5,1,3)),paint]],
 ['overlay-present-during-paint',[render,p(0),m(5,1),{op:'show',key:'overlay',id:'body'},paint]],
 ['content-scroll-not-selection-scroll',[render,p(0),m(5,1),{op:'renderFrame',id:'otherScroll',screen:true},paint]],
 ['saved-frame-live-scroll-handle',[render,p(0),m(5,1),{op:'savePaintFrame'},{op:'scroll',id:'scroll',content:6,viewport:3,top:1},{op:'paint',layout:'saved'}]],
 ['copy-disabled-still-visible',[{op:'copyOnSelect',value:false},render,p(0),m(5,1),r(5,1),paint]],
])add('composed',name,ops,{nodes:[...composedNodes(),{id:'otherScroll',kind:'scroll',child:'container'}],columns:16,rows:3});
// Deterministic interleavings, not wall-clock/randomized expected values.
for(let seed=0;seed<8;seed++){
 const ops=[render];
 for(let round=0;round<10;round++){
  const x=(seed+round*3)%9,y=(seed+round)%2;
  ops.push(time(1000+round*600),p(x,y),m((x+3)%10,1-y),paint);
  if(round%3===0)ops.push(tick,render,paint);
  ops.push(r((x+3)%10,1-y),paint);
  if(round%2===0)ops.push(clear,paint);
 }
 add('sequences','renderer-event-paint-'+seed,ops,{nodes:composedNodes(),columns:16,rows:3});
}
const output={wordSegments};
for(const [key,specs]of Object.entries(groups)){output[key]=[];for(const spec of specs)output[key].push(await run(spec));}
writeFileSync('fixtures.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,{cases:v.length,steps:v.reduce((n,c)=>n+c.ops.length,0)}]))));
