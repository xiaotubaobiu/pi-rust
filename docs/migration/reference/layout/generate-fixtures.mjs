// Inputs/probes only. All layout, stack, ScrollView, Text and Kitty behavior is
// executed by the unmodified upstream modules copied by run.mjs.
import {writeFileSync} from 'node:fs';
import {HStack} from './src/components/h-stack.ts';
import {VStack} from './src/components/v-stack.ts';
import {ScrollView} from './src/components/scroll-view.ts';
import {Text} from './src/components/text.ts';
import {renderLayoutFrame,getScrollbarGeometry,getLayoutBoxesAt,getScrollViewsAt,getScrollViewBox} from './src/layout.ts';
import {encodeKitty,registerKittyImageMetadata,cropKittyImageLine,getKittyImageMetadata} from './src/terminal-image.ts';
const marker='\x1b_pi:c\x07';
const number = v => typeof v==='string' ? ({NaN:NaN,Infinity:Infinity,'-Infinity':-Infinity}[v]) : v;
const lineSummary = lines => lines === undefined ? null : {length:lines.length,entries:Object.keys(lines).map(k=>[+k,lines[k]])};
const leaf = (id,lines,extra={})=>({kind:'leaf',id,lines,...extra});
const text = (id,value,extra={})=>({kind:'text',id,text:value,...extra});
const entry = (node,options={})=>({node,options});
const stack=(kind,id,children,options={})=>({kind,id,children:children.map(c=>c.node?c:entry(c)),options});
const scroll=(id,child,options={})=>({kind:'scroll',id,child,options});
function runCase(input) {
  let trace=[],now=0,nextTimer=0,frame;
  const timers=new Map(),objects=new Map(),names=new Map(),scrolls=new Map(),leaves=new Map();
  const originalSet=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
  globalThis.setTimeout=(callback,delay)=>{const id=++nextTimer;const ms=Number(delay);timers.set(id,{at:now+(!Number.isFinite(ms)||ms<1||ms>2147483647?1:Math.trunc(ms)),callback});return {id,unref(){}};};
  globalThis.clearTimeout=t=>{if(t)timers.delete(t.id);};
  for (const metadata of input.images??[]) registerKittyImageMetadata(metadata);
  function build(spec) {
    if(spec.kind==='alias') return objects.get(spec.target);
    let obj;
    if(spec.kind==='leaf') {
      let calls=0,current=spec.lines;
      obj={render(width){
        calls++;trace.push({op:'render',id:spec.id,width,call:calls});
        if(spec.sparse){const out=[];out.length=spec.sparse.length;for(const [i,s] of spec.sparse.entries)out[i]=s;return out;}
        const source=spec.repeat===undefined?current:Array.from({length:spec.repeat},()=>current[0]??'');
        return source.map((s,i)=>s.replaceAll('{w}',String(width)).replaceAll('{fill}','x'.repeat(Math.max(0,width-1))).replaceAll('{n}',String(i)).replaceAll('{call}',String(calls)));
      },invalidate(){trace.push({op:'invalidate',id:spec.id});},setLines(lines){current=lines;}};
      leaves.set(spec.id,obj);
    } else if(spec.kind==='text') {
      obj=new Text(spec.text,0,0,spec.background?(s)=>spec.background+s+'\x1b[49m':undefined);
      let calls=0;const render=obj.render.bind(obj);obj.render=width=>{trace.push({op:'render',id:spec.id,width,call:++calls});return render(width);};
      leaves.set(spec.id,obj);
    } else if(spec.kind==='scroll') {
      const options={...spec.options};
      for(const kind of ['Track','Thumb']) if(spec.options.style) options['scrollbar'+kind+'Style']=s=>{
        trace.push({op:'style',id:spec.id,kind:kind.toLowerCase(),text:s});
        return spec.options.style==='plain'?s:`\x1b[38;5;${kind==='Track'?2:1}m${s}\x1b[39m`;
      };
      if(options.scrollbarHideDelayMs!==undefined) options.scrollbarHideDelayMs=number(options.scrollbarHideDelayMs);
      obj=new ScrollView(build(spec.child),options);scrolls.set(spec.id,obj);
    } else {
      const children=spec.children.map(({node,options},i)=>{
        const opts={...options};
        if(opts.visible) {const v=opts.visible;opts.visible=viewport=>{trace.push({op:'visible',id:spec.id,index:i,...viewport});return v==='never'?false:v==='wide'?viewport.width>=6:v==='short'?viewport.height<=4:true;};}
        return {component:build(node),...opts};
      });
      obj=new (spec.kind==='hstack'?HStack:VStack)(children,spec.options);
    }
    objects.set(spec.id,obj);names.set(obj,spec.id);return obj;
  }
  const root=build(input.tree);
  const geometry = box => getScrollbarGeometry(box)??null;
  function dump(box) {return {
    id:names.get(box.component),rect:box.rect,clip:box.clip,parent:box.parent?names.get(box.parent.component):null,
    layer:box.layer,lines:lineSummary(box.lines),lineOffset:box.lineOffset??null,
    scroll:box.scrollView?names.get(box.scrollView):null,scrollContent:lineSummary(box.scrollContentLines),
    geometry:geometry(box),hiddenGeometry:getScrollbarGeometry(box,true)??null,children:box.children.map(dump),
  };}
  function snapshotFrame() {
    const w=frame.width,h=frame.height,points=[[-1,0],[0,-1],[w,0],[0,h],[0,0],[w-1,h-1],[Math.floor(w/2),Math.floor(h/2)]];
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(w*h<=40)points.push([x,y]);
    return {width:w,height:h,lines:frame.lines,primary:frame.primaryScrollView?names.get(frame.primaryScrollView):null,root:dump(frame.root),hits:points.map(([x,y])=>({x,y,boxes:getLayoutBoxesAt(frame,x,y).map(b=>names.get(b.component)),scrolls:getScrollViewsAt(frame,x,y).map(s=>names.get(s))})),scrollBoxes:[...scrolls].map(([id,s])=>[id,getScrollViewBox(frame,s)?names.get(getScrollViewBox(frame,s).component):null])};
  }
  const outputs=[];
  for(const step of input.steps) {
    let result=null, rendered=null;
    const s=scrolls.get(step.id);
    switch(step.op){
      case 'render':frame=renderLayoutFrame(root,step.width??input.width,step.height??input.height,()=>trace.push({op:'requestRender'}));rendered=snapshotFrame();break;
      case 'by':result=s.scrollBy(number(step.value));break;
      case 'to':s.scrollTo(number(step.value),{disableFollow:step.disableFollow??false});break;
      case 'start':s.scrollToStart();break;
      case 'end':s.scrollToEnd();break;
      case 'active':s.setScrollbarActive(step.value);break;
      case 'bar':s.setScrollbar(step.value);break;
      case 'lines':leaves.get(step.id).setLines(step.value);break;
      case 'text':leaves.get(step.id).setText(step.value);break;
      case 'invalidate':root.invalidate();break;
      case 'advance':{
        const until=now+step.value;
        while(true){const pending=[...timers].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!pending)break;now=pending[1].at;timers.delete(pending[0]);pending[1].callback();}now=until;break;
      }
      default:throw Error(step.op);
    }
    outputs.push({result,frame:rendered,states:[...scrolls].map(([id,s])=>({id,top:s.scrollTop,following:s.isFollowingEnd,viewport:s.viewportHeight,scrollbar:s.scrollbar,visible:s.isScrollbarVisible,active:s.isScrollbarActive,primary:s.primary,overscroll:s.overscroll})),liveGeometry:frame?[...scrolls].map(([id,s])=>{const box=getScrollViewBox(frame,s);return [id,box?geometry(box):null,box?getScrollbarGeometry(box,true)??null:null];}):[],trace});trace=[];
  }
  globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;
  return {...input,outputs};
}
const cases=[];
const add=(id,tree,width,height,steps=[{op:'render'},{op:'render'}],images=[])=>cases.push(runCase({id,tree,width,height,steps,images}));
const shapes=[
 leaf('root',['overwide0123456789','',`last${marker}`]),
 leaf('root',['\x1b]133;A\x07\x1b]133;B\x1b\\\x1b]133;C\x07hello','\x1b]133;D\x07stay','x\x1b]133;A\x07stay']),
 stack('vstack','root',[entry(text('top','top'),{basis:1,shrink:0}),entry(text('body','body'),{basis:0,grow:1})]),
 stack('vstack','root',[entry(text('a','a1\na2\na3'),{minSize:1,shrink:1}),entry(text('b','b1\nb2\nb3'),{shrink:0})]),
 stack('vstack','root',[entry(leaf('a',['{w}:{call}','two']),{visible:'wide'}),entry(leaf('b',['hidden']),{visible:'never'}),entry(leaf('c',['C']),{visible:'short'})],{gap:1}),
 stack('vstack','root',[entry(leaf('body',['body']),{basis:0,grow:1,minSize:1}),entry(stack('vstack','dock',[leaf('head',['h1','h2','h3']),entry(leaf('selector',['selector']),{minSize:3}),leaf('below',['below']),entry(leaf('foot',['footer']),{minSize:1})]),{basis:'auto',minSize:1})]),
 stack('vstack','root',[entry(scroll('s',leaf('content',['one','two','three'])),{basis:0,grow:1}),text('dock','dock')]),
 stack('hstack','root',[entry(leaf('zero',['hidden:{call}']),{basis:0,shrink:0}),entry(leaf('shown',['shown:{call}']),{basis:0,grow:1})]),
 stack('hstack','root',[entry(leaf('left',['\x1b[42m中é👩‍💻\x1b[49m','\x1b]8;;https://test\x07Link\x1b]8;;\x07']),{basis:6,shrink:0}),entry(leaf('right',['right','r2']),{basis:6,shrink:0})],{gap:1}),
 scroll('root',stack('vstack','stack',[entry(scroll('inner',text('numbers','1\n2\n3\n4\n5\n6'),{primary:true}),{basis:2}),text('tail','tail')]),{follow:'end',primary:true}),
 stack('hstack','root',[scroll('first',leaf('one',['1','2','3']),{primary:true}),scroll('second',leaf('two',['a','b','c']),{primary:true})]),
 stack('hstack','root',[leaf('shared',['S{call}']),{kind:'alias',target:'shared'}]),
];
for(let s=0;s<shapes.length;s++)for(const width of [0,1,5,12])for(const height of [0,3,9])add(`shape-${s}-${width}-${height}`,shapes[s],width,height);
for(const align of ['stretch','start','center','end'])for(const height of [1,4,7])add(`align-${align}-${height}`,stack('hstack','root',[entry(leaf('a',['a1','a2']),{basis:2,shrink:0}),entry(leaf('b',['b1','b2','b3','b4']),{basis:3}),entry(leaf('c',['C']),{basis:0,shrink:0})],{align,gap:1}),8,height);
for(const scrollbar of ['hidden','auto','always'])for(const follow of ['none','end'])for(const style of [undefined,'plain','indexed']){
 const tree=scroll('s',text('content','abcd界\nabcde2\nabcde3\nabcde4\nabcde5\nabcde6\nabcde7\nabcde8',{background:'\x1b[42m'}),{scrollbar,follow,style,scrollbarHideDelayMs:10,primary:true,overscroll:'contain'});
 const steps=[{op:'render'},{op:'by',id:'s',value:2},{op:'render'},{op:'active',id:'s',value:true},{op:'advance',value:50},{op:'render'},{op:'bar',id:'s',value:'hidden'},{op:'bar',id:'s',value:'auto'},{op:'render'},{op:'active',id:'s',value:false},{op:'advance',value:9},{op:'render'},{op:'advance',value:1},{op:'render'},{op:'to',id:'s',value:99,disableFollow:true},{op:'text',id:'content',value:'1\n2\n3\n4\n5\n6\n7\n8\n9'},{op:'render'},{op:'to',id:'s',value:'Infinity'},{op:'by',id:'s',value:'NaN'},{op:'by',id:'s',value:-2.9},{op:'render'},{op:'end',id:'s'},{op:'end',id:'s'},{op:'render'},{op:'start',id:'s'},{op:'render'},{op:'bar',id:'s',value:'always'},{op:'render'},{op:'text',id:'content',value:'x'},{op:'render'},{op:'bar',id:'s',value:'auto'},{op:'advance',value:100},{op:'render'}];
 add(`lifecycle-${scrollbar}-${follow}-${style??'default'}`,tree,6,4,steps);
}
add('background-only',scroll('s',leaf('content',['\x1b[42m{fill}\x1b[31m│\x1b[39m\x1b[49m'],{repeat:8}),{scrollbar:'auto',style:'plain'}),6,4,[{op:'render'},{op:'by',id:'s',value:1},{op:'render'}]);
add('resize-runtime',stack('hstack','root',[scroll('s',text('content','123456'),{scrollbar:'always'})],{align:'start'}),6,2,[{op:'render'},{op:'bar',id:'s',value:'hidden'},{op:'render'},{op:'text',id:'content',value:'one\ntwo\nthree'},{op:'render',width:3,height:5},{op:'invalidate'},{op:'render'}]);
add('billion-sparse',scroll('s',leaf('content',[],{sparse:{length:1_000_000_000,entries:[[999999996,'before'],[999999997,'visible 1'],[999999998,'visible 2'],[999999999,'visible 3']]}}),{follow:'end'}),10,3);
add('billion-empty-backscan',scroll('s',leaf('content',[],{sparse:{length:1_000_000_000,entries:[[999999999,'last']]}}),{follow:'end'}),10,1);
for(const delay of [0,-3,1.9,'NaN','Infinity'])add(`timer-${delay}`,scroll('s',leaf('content',['{n}'],{repeat:8}),{scrollbar:'auto',scrollbarHideDelayMs:delay}),4,3,[{op:'render'},{op:'by',id:'s',value:1},{op:'advance',value:0},{op:'render'},{op:'advance',value:1},{op:'render'}]);
for(const count of [0,1,2,21,40,100,400])add(`thumb-${count}`,scroll('s',leaf('content',['x'],{repeat:count}),{scrollbar:'always'}),6,20,[{op:'render'}]);
// Deterministic mixed nested trees. Visibility sees full viewport, not local boxes.
let seed=0x1a907b31;const rnd=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
for(let i=0;i<128;i++){
 let id=0;const build=depth=>{const name='n'+id++;if(depth===0||rnd(4)===0)return leaf(name,['{w}:{call}','界é',`cursor${rnd(5)===0?marker:''}`].slice(0,rnd(4)));
 if(rnd(4)===0)return scroll(name,build(depth-1),{scrollbar:['auto','always','hidden'][rnd(3)],follow:rnd(2)?'end':'none',primary:rnd(3)===0});
 return stack(rnd(2)?'vstack':'hstack',name,Array.from({length:rnd(4)},()=>entry(build(depth-1),{basis:rnd(2)?rnd(7):'auto',grow:rnd(3),shrink:rnd(2),minSize:rnd(3),maxSize:3+rnd(7),visible:['always','wide','short','never'][rnd(4)]})),{gap:rnd(3),align:['stretch','start','center','end'][rnd(4)]});};
 add(`seeded-${i}`,build(3),1+rnd(13),1+rnd(9));
}
// Images: preserve prefix/payload/chunks; top and bottom clipping and non-full-width guards.
for(const rows of [2,3,7])for(const top of [0,1,2,4])for(const horizontal of [false,true]){
 const imageId=5000+cases.length,metadata={imageId,columns:2,rows,widthPx:100,heightPx:101};
 const line=encodeKitty('AAAA',{columns:2,rows,imageId,moveCursor:false});
 const s=scroll('s',leaf('content',['before',line,...Array(rows-1).fill(''),'tail','last']),{scrollbar:'always'});
 const tree=horizontal?stack('hstack','root',[entry(leaf('left',['L']),{basis:2,shrink:0}),entry(s,{basis:0,grow:1})]):stack('vstack','root',[entry(s,{basis:0,grow:1}),entry(leaf('dock',['dock']),{basis:1,shrink:0})]);
 add(`image-${rows}-${top}-${horizontal}`,tree,10,4,[{op:'render'},{op:'to',id:'s',value:top},{op:'render'}],[metadata]);
}
// Actual paintBox writes a carried image at scroll.rect.y even below the
// clipped viewport. The returned array can grow and contain sparse holes.
for (const y of [3,6]) for (const scrollbar of ['hidden','always']) {
 const imageId=9000+cases.length,metadata={imageId,columns:2,rows:5,widthPx:100,heightPx:101};
 const line=encodeKitty('AAAA',{columns:2,rows:5,imageId,moveCursor:false});
 const content=scroll('s',leaf('content',[line,'','','','','tail']),{follow:'end',scrollbar});
 add(`offscreen-image-${y}-${scrollbar}`,stack('vstack','root',[entry(leaf('head',['head']),{basis:y,shrink:0}),entry(content,{basis:3,shrink:0})]),10,3,[{op:'render'}],[metadata]);
}
const kitty=[];
for(const length of [0,4,4096,4097,8192,8201])for(const options of [{},{columns:0,rows:0,imageId:0},{columns:3,rows:7,imageId:12000+length,moveCursor:false}])kitty.push({op:'encode',data:'A'.repeat(length),options,expected:encodeKitty('A'.repeat(length),options)});
for(const rows of [1,3,7])for(const hidden of [-1,0,1,2,6,7])for(const visible of [0,1,2,5,20]){
 const metadata={imageId:13000+kitty.length,columns:2,rows,widthPx:100,heightPx:101};registerKittyImageMetadata(metadata);
 const line='prefix\x1b[42m'+encodeKitty('AAAA',{columns:2,rows,imageId:metadata.imageId,moveCursor:false})+'suffix';
 kitty.push({op:'crop',metadata,line,hidden,visible,expected:cropKittyImageLine(line,hidden,visible),found:getKittyImageMetadata(line)});
}
writeFileSync('fixtures.json',JSON.stringify({cases,kitty},null,2)+'\n');
console.log(JSON.stringify({cases:cases.length,steps:cases.reduce((n,c)=>n+c.steps.length,0),kitty:kitty.length}));
