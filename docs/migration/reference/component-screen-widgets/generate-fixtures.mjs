// Inputs and traced host services only; algorithms execute from complete upstream modules.
import {writeFileSync} from 'node:fs';
import {TuiAltScreen} from './src/tui-alt-screen.ts';
import {ScrollView} from './src/components/scroll-view.ts';
import {VStack} from './src/components/v-stack.ts';
import {renderLayoutFrame,getScrollViewBox,getScrollbarGeometry} from './src/layout.ts';
const groups={flashes:[],indicator:[],clicks:[],composed:[],routing:[],signed:[]};
const lines=Array.from({length:12},(_,i)=>`line ${i+1}`);
const rect=(x=0,y=0,width=20,height=4)=>({x,y,width,height});
const frame=(extra={})=>({op:'frame',id:'primary',rect:rect(),clip:rect(),...extra});
const scroll=(id='primary',top=0,content=12,viewport=4,disableFollow=false)=>({op:'scroll',id,top,content,viewport,disableFollow});
const draw={op:'indicator'}, flashDraw={op:'flashes'}, label=text=>({op:'label',text});
const flash=(message,duration=1000)=>({op:'flash',message,duration});
const click=(x,y=3,button=0,release=false)=>({op:'click',raw:{x,y,button,release}});
const add=(group,name,ops,extra={})=>groups[group].push({name,columns:20,rows:4,screen:['alpha beta','second line','third row','last row'],label:' Jump ',bar:'hidden',follow:true,lines,ops,...extra});
function run(spec){
 let trace=[],nextTimer=0,flashScheduling=false,labelValue=spec.label,negative={},screen=[...spec.screen];
 const timers=new Map();const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
 globalThis.setTimeout=(callback,duration)=>{
  if(!flashScheduling)return {unref(){}}; // Scroll auto-hide scheduling is an explicit non-delivered host seam.
  const token=++nextTimer,timer={token,callback,unref(){trace.push({op:'unref',timer:token});}};
  timers.set(token,timer);trace.push({op:'timeout',timer:token,duration});return timer;
 };
 globalThis.clearTimeout=timer=>{if(timer.token!==undefined){trace.push({op:'cancel',timer:timer.token});timers.delete(timer.token);}};
 const terminal={columns:spec.columns,rows:spec.rows,hideCursor(){},showCursor(){},write(){throw Error('OS IO forbidden');},start(){throw Error('OS start forbidden');},stop(){}};
 try{
  const tui=new TuiAltScreen(terminal,undefined,undefined,{copyOnSelect:false});
  tui.requestRender=()=>trace.push({op:'render'});
  const leaf={render:()=>[...spec.lines],invalidate(){}},dock={render:()=>['editor','footer'],invalidate(){}};
  const primary=new ScrollView(leaf,{follow:spec.follow?'end':undefined,primary:true,scrollbar:spec.bar});
  const other=new ScrollView(leaf,{follow:'end',primary:true,scrollbar:'hidden'});
  const objects={primary,other,implicit:tui.implicitScrollView};tui.implicitScrollView.setScrollbar('hidden');
  const root=new VStack([{component:primary,basis:0,grow:1,minSize:1},{component:dock,basis:'auto',minSize:1}]);
  const name=s=>Object.entries(objects).find(([,v])=>v===s)?.[0]??null;
  const installLabel=()=>tui.scrollToEndIndicator=labelValue===null?undefined:()=>{trace.push({op:'label',text:labelValue});if(labelValue==='THROW')throw Error('label rejected');return labelValue;};
  installLabel();
  // Actual gesture routing; unrelated services are deliberately explicit seams.
  tui.handleSearchMouseEvent=()=>{trace.push({op:'search'});return false;};
  tui.dispatchMouseToOverlay=()=>{trace.push({op:'overlay'});return {hit:false};};
  tui.handleScrollbarMouseEvent=e=>{trace.push({op:'scrollbar'});const b=tui.currentLayout&&getScrollViewBox(tui.currentLayout,tui.getPrimaryScrollView());const g=b&&getScrollbarGeometry(b);return !!g&&!e.release&&e.button===0&&e.x===g.column&&e.y>=g.trackTop&&e.y<g.trackTop+g.trackHeight;};
  tui.updateScrollbarHover=()=>trace.push({op:'hover'});
  tui.dispatchMouseToLayout=()=>{trace.push({op:'layout'});return undefined;};
  tui.handleRightClickPaste=()=>{trace.push({op:'paste'});return false;};
  tui.handleSelectionMouseEvent=()=>trace.push({op:'selection'});
  function layoutSummary(){const f=tui.currentLayout;if(!f)return null;const boxes=[];function visit(b){boxes.push({rect:b.rect,clip:b.clip,scroll:name(b.scrollView)});for(const c of b.children)visit(c);}visit(f.root);return {primary:name(f.primaryScrollView),boxes};}
  function snapshot(){return {screen:[...screen],negative,rect:tui.scrollToEndIndicatorRect??null,scrolls:Object.fromEntries(Object.entries(objects).map(([id,s])=>[id,{top:s.scrollTop,following:s.isFollowingEnd,visible:s.isScrollbarVisible,content:s.contentHeight,viewport:s.viewportHeight}])),flashes:tui.flashes.entries.map(e=>({id:e.id,message:e.message,timer:e.timer.token})),nextId:tui.flashes.nextId,layout:layoutSummary()};}
  function step(op){
   switch(op.op){
    case 'frame':{const s=objects[op.id],b={component:s,rect:op.rect,clip:op.clip,children:[],parent:undefined,layer:0,scrollView:s,scrollContentLines:spec.lines};if(op.missing)delete b.scrollView;tui.currentLayout={root:b,width:terminal.columns,height:terminal.rows,lines:[],primaryScrollView:op.implicit?undefined:s};break;}
    case 'clearFrame':tui.currentLayout=undefined;break;
    case 'layout':{const f=renderLayoutFrame(op.root==='implicit'?tui.implicitScrollView:op.root==='primary'?primary:root,op.width??terminal.columns,op.height??terminal.rows,()=>trace.push({op:'render'}));tui.currentLayout=f;screen=[...f.lines];negative={};break;}
    case 'scroll':{const s=objects[op.id];s.updateLayout(op.content,op.viewport,()=>trace.push({op:'render'}));s.scrollTo(op.top,{disableFollow:op.disableFollow});break;}
    case 'bar':objects[op.id??'primary'].setScrollbar(op.value);break;
    case 'end':objects[op.id??'primary'].scrollToEnd();break;
    case 'label':labelValue=op.text;installLabel();break;
    case 'screen':screen=[...op.lines];negative={};break;
    case 'indicator':{const next=tui.compositeScrollToEndIndicator(screen,tui.currentLayout,op.width??terminal.columns);negative=Object.fromEntries(Object.keys(next).filter(k=>Number(k)<0).map(k=>[k,next[k]]));screen=[...next];break;}
    case 'flashes':screen=tui.compositeFlashes(screen,op.width??terminal.columns,op.height??terminal.rows);negative={};break;
    case 'flash':flashScheduling=true;try{tui.flash(op.message,op.duration);}finally{flashScheduling=false;}break;
    case 'expire':{const t=timers.get(op.timer);if(t){timers.delete(op.timer);t.callback();}break;}
    case 'dispose':tui.flashes.dispose();break;
    case 'click':return tui.handleScrollToEndIndicatorMouseEvent(op.raw);
    case 'raw':tui.handleMouseEvent(op.raw);break;
    case 'paint':{const p=(row,col,boundary=false)=>({row,col,boundary});tui.selectionAnchor=p(op.start[0],op.start[1]);tui.selectionFocus=p(op.end[0],op.end[1],op.boundary??false);screen=tui.applySelection(screen);negative={};break;}
    default:throw Error('Unknown op '+op.op);
   }return null;
  }
  const expected=[];trace=[];
  for(const op of spec.ops){trace=[];let value;try{value=step(op);}catch(e){value={error:e.message};}expected.push({value,state:snapshot(),trace});}
  return {...spec,expected};
 }finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
}
const samples=[['plain','hello'],['empty',''],['ansi','\x1b[31mred\x1b[0m'],['wide','界🙂é'],['osc8','\x1b]8;;https://example.test\x07link\x1b]8;;\x07'],['zero','\u0301\u200b'],['tab','a\tb'],['kitty','\x1b_Ga=T;AA\x1b\\'],['iterm','\x1b]1337;File=inline=1:AA\x07']];
for(const [tag,message]of samples)for(const width of [0,1,2,5,20])for(const height of [0,1,3])add('flashes',`${tag}-${width}-${height}`,[flash(message),{op:'flashes',width,height}],{screen:['\x1b[32mbase\x1b[0m','tail']});
for(const [tag,screen]of [['empty',[]],['short',['one']],['long',['one','two','three','four','five','six']],['images',['\x1b_Ga=T;AA\x1b\\','\x1b]1337;File=inline=1:AA\x07','three']],['links',['\x1b]8;;https://base.test\x07abcdef\x1b]8;;\x07']]])add('flashes','stack-'+tag,[flash('First',80),flash('Second',500),flash('Third',10),{op:'flashes',height:2},{op:'expire',timer:2},flashDraw,{op:'expire',timer:1},flashDraw,{op:'dispose'},flashDraw,{op:'expire',timer:3},flash('After'),{op:'flashes',height:0}],{screen});
add('flashes','no-entry-does-not-pad',[{op:'flashes',height:10}],{screen:['a']});
for(const [tag,text]of samples)for(const bar of ['hidden','always','auto'])add('indicator',`${tag}-${bar}`,[scroll(),frame(),draw,label(text),draw],{bar});
for(const width of [0,1,2,3,8,20,30])for(const x of [0,2])add('indicator',`clip-${x}-${width}`,[scroll(),frame({rect:rect(x,0,width,3),clip:rect(x,0,width,3)}),draw],{label:'↓'.repeat(30),bar:'always'});
for(const [tag,ops,extra]of [
 ['no-callback',[scroll(),frame(),draw],{label:null}],['no-follow',[scroll(),frame(),draw],{follow:false}],['following',[scroll('primary',8),frame(),draw],{}],['suppressed-end',[scroll('primary',8,12,4,true),frame(),draw],{}],
 ['missing-box',[scroll(),frame({missing:true}),draw],{}],['empty-height',[scroll(),frame({clip:rect(0,0,20,0)}),draw],{}],['past-screen',[scroll(),frame({clip:rect(0,5,20,4)}),draw],{}],['short-screen',[scroll(),frame(),draw],{screen:['a']}],['empty-screen',[scroll(),frame(),draw],{screen:[]}],
 ['image-row',[scroll(),frame(),draw],{screen:['a','b','c','\x1b_Ga=T;AA\x1b\\']}],['implicit',[scroll('implicit'),frame({id:'implicit',implicit:true}),draw],{}],['different-primary',[scroll('other'),frame({id:'other'}),draw],{}],
 ['clear-published',[scroll(),frame(),draw,label(null),draw,click(9)],{}],['callback-error-clears',[scroll(),frame(),draw,label('THROW'),draw,click(9)],{}],['callback-empty-clears',[scroll(),frame(),draw,label(''),draw,click(9)],{}],
 ['auto-visible-reserve',[scroll(),frame(),draw,{op:'bar',value:'auto'},scroll('primary',1),draw],{}]
])add('indicator',tag,ops,extra);
for(const x of [6,7,8,12,13,14,19])for(const y of [2,3,4])add('clicks',`bounds-${x}-${y}`,[scroll(),frame(),draw,click(x,y),draw]);
for(const button of [0,1,2,3,4,8,16,28,32,33,64,65,128,-1])for(const release of [false,true])add('clicks',`button-${button}-${release}`,[scroll(),frame(),draw,click(9,3,button,release)]);
add('clicks','stale-rect-current-primary',[scroll(),scroll('other'),frame(),draw,frame({id:'other',clip:rect(0,1,5,1)}),label(null),click(9),click(9),draw,click(9)]);
add('clicks','stale-rect-implicit-after-clear',[scroll(),scroll('implicit'),frame(),draw,{op:'clearFrame'},click(9),click(9)]);
for(const bar of ['hidden','always','auto'])for(const [w,h]of [[30,6],[8,4],[1,3],[20,2]])add('composed',`dock-${bar}-${w}-${h}`,[{op:'layout',width:w,height:h},scroll('primary',0,12,Math.max(1,h-2)),{op:'layout',width:w,height:h},{op:'indicator',width:w},flash('Notice'),{op:'flashes',width:w,height:h},{op:'paint',start:[0,0],end:[2,8]},{op:'flashes',width:w,height:h},click(Math.floor((w-1)/2),Math.max(1,h-2)-1),{op:'layout',width:w,height:h},{op:'indicator',width:w}],{bar,columns:w,rows:h,label:'↓'.repeat(30)});
add('composed','resize-expiry',[{op:'layout'},scroll(),{op:'layout'},draw,flash('First'),flash('Second'),{op:'paint',start:[0,1],end:[3,10]},flashDraw,{op:'expire',timer:1},{op:'layout',width:8,height:3},{op:'indicator',width:8},{op:'flashes',width:8,height:3},{op:'dispose'},{op:'layout'},{op:'indicator'}]);
for(const [tag,e]of [['label',click(8)],['bar',click(19)],['outside',click(0,1)],['release',click(8,3,0,true)],['motion',click(8,3,32)]])add('routing',tag,[scroll(),frame(),draw,{...e,op:'raw'}],{label:'↓'.repeat(30),bar:'always'});
for(const x of [-20,-5,-1,0,19,22])for(const y of [-5,-3,-1,0,3])add('signed',`origin-${x}-${y}`,[scroll(),frame({rect:rect(x,y,8,3),clip:rect(x,y,8,3)}),draw,click(x+2,y+2)],{label:'123456'});
for(const [group,cases]of Object.entries(groups))groups[group]=cases.map(run);
writeFileSync('fixtures.json',JSON.stringify(groups,null,2)+'\n');
console.log('COUNTS',Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,{cases:v.length,steps:v.reduce((n,c)=>n+c.ops.length,0)}])));
