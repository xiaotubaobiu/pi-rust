// Drives the complete copied upstream module; never computes UI output itself.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {AltScreenSearchComponent} from './src/alt-screen-search.ts';
import {KeybindingsManager,TUI_KEYBINDINGS,setKeybindings} from './src/keybindings.ts';
import {visibleWidth,stripTerminalSequences} from './src/utils.ts';
const fixture={render:[],styles:[],keys:[],editing:[],unicode:[],paste:[],sequences:[]};
const platformDescriptor=Object.getOwnPropertyDescriptor(process,'platform');
const platform=value=>Object.defineProperty(process,'platform',{...platformDescriptor,value});
const input=data=>({op:'input',data}),render=width=>({op:'render',width}),focus=value=>({op:'focus',value}),result=(index,count)=>({op:'result',index,count}),hover=direction=>({op:'hover',direction});
function run(group,name,ops,{style='identity',host='win32'}={}){
 platform(host);
 const kb=new KeybindingsManager(TUI_KEYBINDINGS);setKeybindings(kb);
 const events=[];
 const paint=(text,hovered)=>{
  events.push({type:'style',text,hovered});
  if(style==='ansi')return `${hovered?'\x1b[45m':'\x1b[44m'}${text}\x1b[49m`;
  if(style==='empty')return '';
  if(style==='expand')return `${hovered?'[':'{'}${text}${hovered?']':'}'}`;
  if(style==='osc')return `\x1b]8;;https://example.invalid/\x07${text}\x1b]8;;\x07`;
  if(style==='asymmetric')return text.startsWith('↑')?'':`\x1b[2m${text.slice(0,1)}\x1b[22m`;
  return text;
 };
 // Real default painter, not always an injected callback.
 const component=style==='default'?new AltScreenSearchComponent(q=>events.push({type:'query',query:q})):new AltScreenSearchComponent(q=>events.push({type:'query',query:q}),paint);
 const expected=[];
 for(const op of ops){
  events.length=0;let output=null;
  switch(op.op){
   case 'input':component.handleInput(op.data);break;
   case 'focus':component.focused=op.value;break;
   case 'result':component.setResult(op.index,op.count);break;
   case 'hover':output=component.setHoveredNavigationDirection(op.direction??undefined);break;
   case 'invalidate':component.invalidate();break;
   case 'keys':kb.setUserBindings(op.bindings);break;
   case 'platform':platform(op.value);break;
   case 'probe':output=op.points.map(([r,c])=>component.getNavigationDirectionAt(r,c)??null);break;
   case 'render':{
    const lines=component.render(op.width);
    output={lines,widths:lines.map(visibleWidth),hits:Array.from({length:op.width+5},(_,i)=>component.getNavigationDirectionAt(2,i-2)??null)};
    break;
   }
   default:throw Error(op.op);
  }
  expected.push({output,events:[...events],state:{value:component.input.getValue(),cursor:component.input.cursor,focused:component.focused,inputFocused:component.input.focused,rect:[component.previousButtonStart,component.previousButtonEnd,component.nextButtonStart,component.nextButtonEnd],hover:component.hoveredNavigationDirection??null}});
 }
 assert.equal(ops.length,expected.length);
 fixture[group].push({name,style,host,ops,expected});
 return expected;
}
const widths=[...Array.from({length:66},(_,i)=>i),80,120];
const variants=[['empty','',-1,0],['stale-empty','',45,99],['no-match','x',-1,0],['matches','needle',0,2],['negative-index','a',-1,4],['large-index','abc',999,10000],['space-query','  ',0,1]];
for(const w of widths)for(const [name,q,i,n]of variants)for(const f of [false,true])run('render',`${name}-${w}-${f}`,[focus(f),input(q),result(i,n),render(w)],{style:'default'});
// Named pure UI assertions; this is not execution of the native host suite.
const named=run('render','upstream-muted-placeholder-right-aligned-controls',[render(48),input('n'),result(0,2),render(48)],{style:'default'});
const first=named[0].output.lines,last=named.at(-1).output.lines;
assert.equal(first.length,3);assert(first.every(l=>visibleWidth(l)===48));
assert.match(stripTerminalSequences(first[0]),/^┌─+┐$/);
assert.match(stripTerminalSequences(first[1]),/^│ Find in transcript +│$/);
assert(first[1].includes('\x1b[2m'));
assert.match(stripTerminalSequences(first[2]),/^└─+ ↑ Shift\+Enter · ↓ Enter ─┘$/);
assert(last[1].includes('\x1b[2m 1/2 \x1b[22m'));
for(const style of ['identity','ansi','empty','expand','osc','asymmetric'])for(const w of [0,1,2,6,7,8,9,15,28,29,30,31,48,80])run('styles',`${style}-${w}`,[hover(-1),hover(-1),render(w),hover(1),render(w),hover(null),hover(null),render(w),{op:'invalidate'},render(w)],{style});
const keyPairs=[
 [[],[]],[[''],['']], [['alt+enter'],['ctrl+n']], [['ALT+left','alt+p'],['aLt+right','n']],
 [['shift++x'],['+']], [['ctrl+ß'],['ı+é']], [['ﬀ+space'],['ŉ+f2']], [['界'],['🙂']],
 [['𐐨'],['𐐩']], [['\x1b[31mleft\x1b[0m'],['\x1b]8;;url\x07right\x1b]8;;\x07']],
 [['pageUp','ctrl+up','pageUp'],['pageDown','alt+down']], [['verylong+'.repeat(8)+'x'],['z']],
 [['\u0301a'],['alt+\u0301']], [['shift+enter','s'],['enter','e']],
];
for(const host of ['win32','linux','darwin'])for(let i=0;i<keyPairs.length;i++)for(const w of [8,30,48,100]){
 const [previous,next]=keyPairs[i];run('keys',`${host}-${i}-${w}`,[{op:'keys',bindings:{'tui.altScreen.searchPrevious':previous,'tui.altScreen.searchNext':next}},render(w)],{host});
}
run('keys','dynamic-replace-keybindings-platform-and-stale-rect',[render(48),{op:'keys',bindings:{'tui.altScreen.searchPrevious':['alt+left'],'tui.altScreen.searchNext':['alt+right']}},{op:'probe',points:[[2,22],[2,24],[1,24],[-1,24]]},render(48),{op:'platform',value:'darwin'},render(48),{op:'keys',bindings:{}},render(48)]);
const edits=[
 ['basic',['','hello','\x1b[D','X','\x1b[C','\x7f','\x1b[3~','\r','\n','\x1b','\t','\x03']],
 ['words',['one two three','\x17','\x17','\x19','\x1by','\x01','\x1bd','\x19','\x05','\x15','\x19','\x0b','\x1f']],
 ['insert-delete-undo',['abc','def',' ','ghi','\x7f','\x1f','\x1f','\x1f','\x1f','\x1f','\x1f']],
 ['kitty',['\x1b[97u','\x1b[98;1u','\x1b[99;2u','\x1b[128578u','\x1b[32u','\x1b[32;3u','\x1b[97;1:3u','\x1b[A']],
 ['control-rejection',['a\x00b','a\x80b','\x7f','\x1b[31mred','\x1b[200~\x1b[31mred\x1b[0m\x1b[201~']],
 ['jumps',['alpha βeta gamma','\x1b[1;5D','\x1b[1;5D','\x1b[1;5C','\x1b[H','\x1b[F','\x1b\x7f','\x19']],
 ['whitespace',[' ','\t',' \u00a0\u2003 ','\x17','\x19','\x01','\x0b','\x19']],
];
for(const [name,items]of edits)for(const w of [3,5,8,16,48])run('editing',`${name}-${w}`,[focus(true),...items.flatMap(x=>[input(x),render(w)])]);
const texts=['A界🙂e\u0301Z','👩‍💻🇰🇷👍🏽x','\u0301\u0301','\u200b','a\u200db','नमस्ते','ก้x','𐐨𐐩Z','©️⭐️','a\r\nb','\u00a0\u2003\u2028\u2029\ufeff','\u1100\u1161\u11a8x','\u0600A','x\u2060y','e\u0301e\u0301','界'.repeat(30),'🙂'.repeat(25),'abc'.repeat(40)];
for(let i=0;i<texts.length;i++)for(const w of [0,1,2,3,4,5,6,8,13,24,48])run('unicode',`unicode-${i}-${w}`,[focus(true),input(texts[i]),result(0,12),render(w),input('\x1b[D'),render(w),input('\x7f'),render(w),input('\x1f'),render(w),input('\x01'),render(w),input('\x1b[C'),render(w)]);
const pastes=[
 ['complete',['\x1b[200~hello\r\nworld\tend\x1b[201~']],
 ['split',['\x1b[200~','hello','\r','\nworld','\x1b[20','1~','!']],
 ['tail',['x','\x1b[200~one\x1b[201~two']],
 ['two',['\x1b[200~one\x1b[201~\x1b[200~two\x1b[201~']],
 ['restart',['\x1b[200~old','\x1b[200~new\x1b[201~']],
 ['controls',['\x1b[200~a\x00b\x01c\x7f\x80\x1b[31mred\x1b[0m\x1b[201~']],
 ['unicode',['\x1b[200~界🙂e\u0301\t안녕\x1b[201~']],
 ['empty',['\x1b[200~\x1b[201~']],
];
for(const [name,chunks]of pastes)for(const w of [3,8,48])run('paste',`${name}-${w}`,[focus(true),...chunks.flatMap(x=>[input(x),render(w)]),input('\x1f'),render(w)]);
run('sequences','last-render-rect-contract',[{op:'probe',points:[[2,-1],[2,0],[2,1],[0,20]]},render(48),input('needle'),result(1,2),hover(1),{op:'invalidate'},{op:'probe',points:[[2,22],[2,30],[2,36],[2,37],[2,44],[2,45],[3,44]]},render(8),{op:'probe',points:[[2,2],[2,3],[2,4],[2,5],[1,4],[-2,4]]},render(1),{op:'probe',points:[[2,0],[2,1],[2,4]]},render(60)]);
run('sequences','signed-result-values',[input('x'),...[[-2,4],[-1,4],[5,-2],[0,1],[25,0],[9007199254740990,9007199254740991],[-9007199254740991,-1]].flatMap(([i,n])=>[result(i,n),render(80)]),input('\x15'),render(80)]);
let seed=0x739bcf01;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
const alphabet=['a',' ','界','🙂','e\u0301','\x7f','\x1b[D','\x1b[C','\x01','\x05','\x1f','\x17','\x19','\x1b[200~one\ntwo\x1b[201~','\r','\x1b'];
for(let i=0;i<48;i++){
 const ops=[];for(let j=0;j<48;j++){
  const n=random();switch(n%7){case 0:ops.push(focus(Boolean(n&8)));break;case 1:ops.push(hover([null,-1,1][(n>>>5)%3]));break;case 2:ops.push(result((n>>>4)%20-1,(n>>>10)%15));break;case 3:ops.push({op:'invalidate'});break;default:ops.push(input(alphabet[(n>>>9)%alphabet.length]));}
  if(j%3===0)ops.push(render((random()>>>7)%81));
 }ops.push(render(48));run('sequences',`seed-739bcf01-${i}`,ops,{style:'ansi'});
}
Object.defineProperty(process,'platform',platformDescriptor);
writeFileSync('fixtures.json',JSON.stringify(fixture,null,2)+'\n');
console.log(JSON.stringify({groups:Object.fromEntries(Object.entries(fixture).map(([k,v])=>[k,v.length])),cases:Object.values(fixture).flat().length,operations:Object.values(fixture).flat().reduce((n,c)=>n+c.ops.length,0)}));
