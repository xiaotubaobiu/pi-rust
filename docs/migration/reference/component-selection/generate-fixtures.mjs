// Only scenarios/host services; all reference algorithms run in copied actual modules.
import {writeFileSync} from 'node:fs';
import {Container} from './src/tui.ts';
import {TuiAltScreen} from './src/tui-alt-screen.ts';
import {ScrollView} from './src/components/scroll-view.ts';
import {MouseRegion} from './src/components/mouse-region.ts';
import {getWordSegmenter} from './src/utils.ts';
import {renderLayoutFrame} from './src/layout.ts';
const groups={basic:[],ranges:[],scroll:[],urls:[],composed:[],sequences:[]}, wordSegments={};
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
 let trace=[],now=1000,nextTimer=0;const timers=new Map(),objects=new Map(),names=new Map(),states=new Map(),handles=new Map(),entries=new Map();
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
for(const [name,ops] of [
 ['release-without-press',[r(2),r(2,0,3),m(3)]],['click-empty-selection',[...click(2),text,{op:'has'},{op:'copy'}]],
 ['forward-drag',[p(1),m(5),r(5),text,{op:'copy'}]],['reverse-drag',[p(7),m(1),r(1),text]],
 ['same-cell-motion-is-sticky',[p(2),m(2),r(2)]],['move-away-and-back',[p(2),m(6),m(2),r(2)]],
 ['release-different-without-motion',[p(1),r(5),text]],['multiline-forward',[p(2),m(4,2),r(4,2),text]],
 ['multiline-reverse',[p(4,2),m(2),r(2),text]],['clamped-pointer',[p(-5,-8),m(99,99),r(99,99),text]],
 ['clear-preserves-click-history',[...click(2),clear,...click(2),clear,...click(2)]],
 ['copy-toggle',[{op:'copyOnSelect',value:false},p(0),m(3),r(3),{op:'copy'}, {op:'copyOnSelect',value:true},p(0),r(2)]],
 ['screen-changes-before-release',[p(1),{op:'screen',lines:['changed words']},r(5),text]],
 ['resize-during-selection',[p(2),{op:'size',columns:2,rows:1},r(99,99)]],
 ['press-restarts-drag',[p(2),m(7),p(5),r(5)]],['clear-during-active-press',[p(2),clear,r(2),m(3),text]],
])add('basic',name,ops);
for(const button of [1,2,3,33,34,35,4,8,16,20,64])add('basic','button-'+button,[p(1,0,button),m(4,0,button|32),r(4,0,button),r(1,0,3)]);
add('basic','zero-dimensions',[p(4,5),r(4,5),text],{columns:0,rows:0});
for(const line of ['alpha beta','/home/user-name/file.txt','--foo//bar--','a.b,c!?   ','😀 e\u0301 界 🧑‍💻','한국어 선택 테스트','你好世界 再见','a\u00a0 b\ufeff','\x1b[31mred\x1b[0m blue','\x1b]8;;https://example.invalid\x07linked\x1b]8;;\x07','', '   ']){
 add('ranges','word-cycle-'+line,[...click(1),...click(1),text,...click(1),text,...click(1),text],{screen:[line]});
 for(const col of [0,1,3,7,30])add('ranges','word-query-'+line+'-'+col,[{op:'word',row:0,col},{op:'line',row:0,col}],{screen:[line]});
}
for(const delta of [0,499,500,501,-1000])add('ranges','click-interval-'+delta,[...click(1),time(1000+delta),...click(3),text]);
add('ranges','double-click-drag-forward-reverse',[...click(7),p(7),m(2),text,m(3,1),text,r(3,1)]);
add('ranges','triple-line-drag',[...click(2),...click(2),p(2),m(3,2),text,m(1),r(1)]);
add('ranges','word-focus-outside-range-keeps-old',[...click(1),p(1),m(18),text,r(18)]);
add('ranges','unicode-grapheme-copy',[p(1),m(8),r(8),text],{screen:['A界 e\u0301🧑‍💻Z']});
add('ranges','js-trimend-bom-not-next-line',[p(0),m(19,1),r(19,1),text],{screen:[' a \ufeff',' b \u0085']});
for(const top of [0,2,3])for(const direction of ['up','down','middle']){
 const y=direction==='up'?1:direction==='down'?3:2;
 add('scroll',`scroll-${top}-${direction}`,[configure('scroll',top),scrollFrame(),p(3,2),m(6,y),tick,tick,tick,tick,text,r(6,y),tick]);
}
add('scroll','pointer-scroll-clamping',[configure(),scrollFrame(),...[[-3,-9],[999,999],[4,2]].map(([x,y])=>({op:'point',id:'scroll',raw:{x,y,button:0,release:false}}))]);
for(const patch of [{rect:rect(2,1,0,3)},{rect:rect(2,1,12,0)},{clip:rect(2,2,12,0)},{clip:rect(2,8,12,2)},{rect:rect(2,-2,12,5),clip:rect(2,0,12,2)},{lines:[]}])add('scroll','degenerate-'+JSON.stringify(patch),[configure(),scrollFrame('scroll',patch),{op:'point',id:'scroll',raw:{x:4,y:2,button:0,release:false}},p(3,2),m(4,3),tick,r(4,3),text]);
add('scroll','lost-frame-falls-back-and-mismatches-identity',[configure(),scrollFrame(),p(3,2),m(4,3),{op:'frame'},tick,r(5,2),text]);
add('scroll','frame-replaced-with-other-scroll',[configure(),scrollFrame(),p(3,2),frame([box('other')]),r(3,2),text]);
add('scroll','clear-cancels-unreferenced-timer',[configure(),scrollFrame(),p(3,2),m(5,3),clear,tick,r(5,3)]);
add('scroll','middle-cancels-bottom-timer',[configure(),scrollFrame(),p(3,2),m(5,3),m(5,2),tick,r(5,2)]);
add('scroll','new-press-cancels-timer',[configure(),scrollFrame(),p(3,2),m(5,3),p(6,2),r(6,2)]);
add('scroll','nested-identity',[configure(),configure('inner',0),frame([box('scroll',{children:[1],lines:['outer line'],rect:rect(),clip:rect()}),box('inner',{lines:['inner alpha','inner beta','last'],rect:rect(2,1,12,3),clip:rect(2,1,12,3)})]),p(3,2),m(7,2),r(7,2),text],{nodes:[...nodes(),{id:'inner',kind:'scroll',child:'body'}]});
const link='\x1b]8;id=x;https://example.invalid/path\x1b\\alpha\x1b]8;;\x1b\\ beta';
for(const mode of [undefined,'ok','error']){
 add('urls','url-click-'+mode,[frame(),...click(2).map(raw),text],{screen:[link],urlMode:mode});
 add('urls','url-drag-'+mode,[frame(),raw(p(1)),raw(m(5)),raw(r(5)),text],{screen:[link],urlMode:mode});
}
add('urls','motion-clears-url-even-returned',[p(2),m(3),m(2),r(2)],{screen:[link],urlMode:'ok'});
add('urls','url-snapshot-survives-screen-change',[p(1),{op:'screen',lines:['no link']},r(1)],{screen:[link],urlMode:'ok'});
add('urls','word-selection-suppresses-url',[...click(1),...click(1),...click(1),text],{screen:[link],urlMode:'ok'});
add('urls','url-press-must-be-active',[r(1),...click(1),r(1)],{screen:[link],urlMode:'ok'});
add('urls','scroll-url-from-screen-not-content',[configure(),scrollFrame(),p(3,2),r(3,2)],{screen:['','',link],urlMode:'ok'});
for(const response of [{handled:true},{handled:true,render:false},{focus:true,render:false},{capture:true},{handled:true,focus:true,capture:true,render:false},{}]){
 const ns=nodes();ns.find(n=>n.id==='region').responses={click:response};
 add('composed','click-only-flags-'+JSON.stringify(response),[frame(),{op:'render',id:'container'},...click(2).map(raw),raw(m(8)),raw(r(8)),text],{nodes:ns});
}
add('composed','nested-mouse-region-drag-vs-click',[frame(),...click(2).map(raw),raw(p(0)),raw(m(3,1)),raw(r(3,1)),text,...click(2).map(raw)]);
add('composed','consecutive-component-vs-selection-counts',[frame(),...click(1).map(raw),...click(1).map(raw),...click(1).map(raw),...click(1).map(raw),text]);
add('composed','stale-container-render-keeps-original-child',[frame(),{op:'render',id:'container'},{op:'children',id:'container',ids:['other']},...click(2).map(raw),{op:'render',id:'container'},...click(2).map(raw)]);
add('composed','response-mutates-between-press-release',[frame(),raw(p(2)),{op:'responses',id:'region',value:{click:{handled:true,focus:true,render:false}}},raw(r(2))]);
for(const stale of ['none','hidden','removed']){
 const ops=[frame(),{op:'show',key:'o',id:'other'},{op:'overlayFrame',layouts:[{key:'o',row:0,col:0,width:10,height:2}]},...(stale==='hidden'?[{op:'hidden',key:'o',value:true}]:stale==='removed'?[{op:'hide',key:'o'}]:[]),...click(2).map(raw),text];
 add('composed','overlay-hit-decline-no-layout-'+stale,ops);
}
add('composed','overlay-click-focus-and-capture',[frame(),{op:'show',key:'o',id:'region'},{op:'overlayFrame',layouts:[{key:'o',row:0,col:0,width:10,height:2}]},...click(2).map(raw),raw(m(12)),raw(r(12))],{nodes:[leaf('body'),leaf('other'),{id:'region',kind:'region',child:'body',responses:{click:{focus:true,capture:true,render:false}}},{id:'container',kind:'container',children:['region']},{id:'scroll',kind:'scroll',child:'container'}]});
add('composed','component-press-clears-existing-selection',[p(0),m(4),frame(),{op:'responses',id:'body',value:{press:{handled:true,focus:true,capture:true},release:{handled:true,render:false},click:{handled:true}}},...click(2).map(raw),text]);
add('composed','overlay-forces-screen-not-scroll-selection',[configure(),scrollFrame(),{op:'show',key:'o',id:'other'},p(3,2),m(7,2),r(7,2),text]);
for(let seed=1;seed<=16;seed++){
 let n=seed;const next=()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n;};const ops=[configure(),scrollFrame()];
 for(let i=0;i<48;i++){
  const k=next()%11,x=next()%22-2,y=next()%6-1;
  ops.push(k<3?p(x,y):k<5?m(x,y):k<7?r(x,y,k===6?3:0):k===7?tick:k===8?time(next()%2500):k===9?clear:{op:'copyOnSelect',value:!!(next()%2)});
 }ops.push(text,clear);add('sequences','seed-'+seed,ops);
}
// Append-only expansion after all initial175 cases/1619 steps passed.
add('composed','selection-click-count-two-three-at-word-start',[frame(),...click(0).map(raw),...click(0).map(raw),...click(0).map(raw),...click(0).map(raw)]);
add('composed','actual-renderer-nested-mouse-region-click-drag',[{op:'renderFrame',id:'scroll',screen:true},...click(1).map(raw),raw(p(0)),raw(m(3,1)),raw(r(3,1)),text]);
add('composed','actual-renderer-owning-capture-after-fallback',[{op:'responses',id:'region',value:{click:{focus:true,capture:true,render:false},drag:{handled:true,render:false},release:{handled:true,render:false}}},{op:'renderFrame',id:'container',screen:true},...click(1).map(raw),{op:'children',id:'container',ids:['other']},raw(m(8,3)),raw(r(8,3))]);
add('composed','blocked-focus-restore-with-release-click',[frame(),{op:'focus',id:'other'},{op:'show',key:'o',id:'other',nonCapturing:false},{op:'responses',id:'body',value:{click:{focus:true,render:false}}},...click(2).map(raw)]);
add('scroll','actual-renderer-autoscroll-and-republish',[{op:'renderFrame',id:'scroll',screen:true},p(1,1),m(4,2),tick,{op:'renderFrame',id:'scroll',screen:true},tick,r(4,2),text],{rows:3,nodes:[leaf('body',['one line','two line','three line','four line','five line','six line']),leaf('other'),{id:'region',kind:'region',child:'body',responses:{}},{id:'container',kind:'container',children:['region']},{id:'scroll',kind:'scroll',child:'container'}]});
add('scroll','same-coordinates-different-scroll-identity-reset-count',[configure(),configure('inner'),scrollFrame(),...click(3,2),scrollFrame('inner'),...click(3,2),text],{nodes:[...nodes(),{id:'inner',kind:'scroll',child:'body'}]});
add('scroll','selection-source-missing-content',[configure(),frame([box('scroll')]),p(1),m(4),r(4),text]);
add('scroll','clipped-box-no-visible-rows-falls-back',[configure(),scrollFrame('scroll',{rect:rect(2,10,12,3),clip:rect(2,10,12,3)}),{op:'point',id:'scroll',raw:{x:3,y:10,button:0,release:false}}]);
add('urls','url-with-release-button-none',[p(1),r(1,0,3)],{screen:[link],urlMode:'ok'});
add('urls','url-error-does-not-dispatch-component-click',[frame(),raw(p(1)),raw(r(1)),raw(r(1))],{screen:[link],urlMode:'error'});
for(const boundary of [false,true])for(const [min,max]of [[0,20],[2,5],[4,4]])add('ranges',`columns-grapheme-clip-${boundary}-${min}-${max}`,[{op:'columns',line:'A界e\u0301👩‍💻Z',row:0,start:{row:0,col:2},end:{row:0,col:5,boundary},min,max}]);
add('ranges','different-click-word-resets-count',[...click(1),...click(7),...click(8),text]);
add('basic','empty-screen-multiline-is-newlines',[p(0),r(0,2),text,{op:'has'},{op:'copy'}],{screen:[]});

// The earlier owning-capture case intentionally remains unchanged as evidence:
// handled release short-circuits selection fallback. This click-only case reaches it.
add('composed','actual-renderer-click-only-fallback-capture-survives-frame-replacement',[{op:'responses',id:'region',value:{click:{focus:true,capture:true,render:false}}},{op:'renderFrame',id:'container',screen:true},...click(1).map(raw),{op:'responses',id:'region',value:{drag:{handled:true,render:false},release:{handled:true,render:false}}},{op:'children',id:'container',ids:['other']},{op:'renderFrame',id:'container',screen:true},raw(m(8,3)),raw(r(8,3))]);

const output={wordSegments};
for(const [key,specs]of Object.entries(groups)){output[key]=[];for(const spec of specs)output[key].push(await run(spec));}
writeFileSync('fixtures.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,{cases:v.length,steps:v.reduce((n,c)=>n+c.ops.length,0)}]))));
