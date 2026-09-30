import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {AltScreenSearchIndex,findAltScreenSearchMatches,getAltScreenSearchMatchKey} from './src/alt-screen-search.ts';
import {getGraphemeSegmenter} from './src/utils.ts';
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const text=u=>String.fromCharCode(...u);
const value=m=>m.map(x=>({segments:x.segments.map(s=>({...s})),key:getAltScreenSearchMatchKey(x)}));
const corpus=i=>i.corpus?{text:units(i.corpus.text),spans:i.corpus.spans}:null;
const fixture={basic:[],whitespace:[],literals:[],unicode:[],folding:[],graphemes:[],raw:[],fuzz:[],cache:[],keys:[]};
function add(group,name,lines,query,extra={}){
 const i=new AltScreenSearchIndex(),res=i.search(lines,query),direct=findAltScreenSearchMatches(lines,query);
 assert.equal(res.changed,true);assert.deepEqual(direct,res.matches);
 fixture[group].push({name,lines:lines.map(units),query:units(query),...extra,expected:{matches:value(res.matches),corpus:corpus(i),normalizedQuery:units(i.normalizedQuery)}});
}
const basics=[
 ['cross-line',['alpha QUICK','brown fox'],'quick brown'],
 ['ansi-unicode',['\x1b[31mfoo  bar\x1b[0m','A界🙂e\u0301Z'],'bar A界🙂e\u0301'],
 ['empty-lines',[], 'a'],['empty-query',['alpha'],''],['all-space',['  ','\t',''],' \n '],
 ['nonoverlap',['aaaaa'],'aa'],['nonoverlap-alt',['ababa'],'aba'],['adjacent',['ababab'],'ab'],
 ['run-slice',['prefix foobar suffix'],'oba'],['blank-middle',['a','',' ','b'],'a b'],
 ['leading-empty',['','  a','b  ',''],'  a\n b  '],['empty-non-ascii',['\u200d'],'\u200d'],
 ['trailing-separator',['a',' '],'a '],['query-not-ansi-stripped',['hello'],'\x1b[31mhello'],
 ['nul',['a\x00b'],'\x00'],['multiline-query',['a\nb'],'a\r\n\tb'],
 ['space-mark',['a \u0301b'],' \u0301'],['tab-mark',['a\t\u0301b'],'\u0301'],
 ['emoji-part',['x👩‍💻y👩‍💻'],'💻'],['combining-part',['e\u0301e\u0301'],'\u0301'],
 ['crlf',['a\r\nb'],'a b'],['unicode-no-normalization',['é e\u0301'],'é'],
 ['unicode-no-normalization-reverse',['é e\u0301'],'e\u0301'],
 ['repeated-grapheme-pieces',['x\u0301\u0301y'],'\u0301'],
 ['tab-columns',['a\tb'],'b'],['zero-width',['a\u200bb'],'\u200b'],
];
for(const c of basics)add('basic',...c);
const ws=[9,10,11,12,13,32,160,5760,...Array.from({length:11},(_,i)=>8192+i),8232,8233,8239,8287,12288,65279];
assert.equal(ws.length,25);
for(const cp of [...ws,0x85,0x180e,0x200b,0x2060]){
 const s=String.fromCodePoint(cp),name=cp.toString(16);
 add('whitespace','source-'+name,['a'+s+s+'b'],'a b');
 add('whitespace','query-'+name,['a b'],s+'a'+s+s+'b'+s);
 add('whitespace','mark-'+name,['a'+s+'\u0301b'],s+'\u0301');
}
for(const [n,l,q] of [
 ['kelvin',['KKk'],'k'],['long-s',['ſsS'],'s'],['sigma',['Σςσ'],'σ'],
 ['turkish',['Iıİi'],'i'],['turkish-dot',['Iıİi'],'İ'],['eszett',['ßẞssSS'],'ß'],
 ['eszett-ss',['ßẞssSS'],'ss'],['ligature',['ﬀffFF'],'ff'],['deseret',['𐐀𐐨'],'𐐀'],
 ['adlam',['𞤀𞤢'],'𞤢'],['cherokee',['Ꭰꭰ'],'Ꭰ'],['ohm',['ΩΩω'],'ω'],
 ['iota',['Ιιͅ'],'ͅ'],['full-fold-not-simple',['ΐΐ'],'ΐ'],
 ['indic',['क्‍ष क्ष'],'ष'],['hangul',['각각'],'ᅡ'],['flag',['🇦🇧🇨🇩'],'🇧'],
 ['keycap',['1️⃣1⃣'],'1'],['prepend',['\u0600a'],'a'],['spacing',['\u0903\u093e'],'\u093e'],
 ])add('unicode',n,l,q);
const atoms=['界','🙂','👩‍💻','e\u0301','🇨🇳','1️⃣','\u200d','\u0301','\u0600a','क्‍ष','각','\u0903\u093e'];
for(let i=0;i<atoms.length;i++)for(const q of [...new Set([...atoms[i]])])add('unicode',`piece-${i}-${q.codePointAt(0).toString(16)}`,['A'+atoms[i]+'Z',atoms[i]+atoms[i]],q);
for(const q of ['.','*','+','?','^','$','{','}','(',')','|','[',']','\\','.*+?^${}()|[]\\','a.b','[a-z]','\\u{61}','^a$'])add('literals','literal-'+units(q).join('-'),['before '+q+' after '+q.toUpperCase()],q);
const escapes=['\x1b[31m','\x1b[0m','\x1b[12G','\x1b[2K','\x1b[1H','\x1b[2J','\x1b]8;;https://invalid.test\x07','\x1b]8;;\x1b\\','\x1b_payload\x1b\\','\x1b_payload\x07','\x1b[31','\x1b[2q','\x1b]unterminated','\x1b_unterminated','\x1bX','\x1b','\x1b[\x1b[31m'];
for(let i=0;i<escapes.length;i++){
 add('literals','ansi-'+i,['ab'+escapes[i]+'cd'],'bc');
 add('literals','ansi-unicode-'+i,['界'+escapes[i]+'🙂e\u0301'],'🙂e');
 add('raw','ansi-surrogate-'+i,['\ud83d'+escapes[i]+'\ude42'],'🙂');
}
const folds=[];
for(const l of readFileSync('unicode/CaseFolding-17.0.0.txt','utf8').split('\n')){
 const part=l.split('#')[0].trim();if(!part)continue;
 const [code,status,mapping]=part.split(';').map(x=>x.trim());
 if(status!=='C'&&status!=='S')continue;
 const from=parseInt(code,16),to=parseInt(mapping,16);folds.push([from,to]);
 const a=String.fromCodePoint(from),b=String.fromCodePoint(to);
 assert(new RegExp(a,'iu').test(b),`Node disagrees with Unicode17 simple fold ${code}`);
 add('folding',code,[a+b+' '+a+'x'+b],b,{pair:[from,to]});
}
const gb=readFileSync('unicode/GraphemeBreakTest-17.0.0.txt','utf8').split('\n');let gi=0;
for(const l of gb){
 const part=l.split('#')[0].trim();if(!part)continue;
 const tokens=part.split(/\s+/),expected=[];let run='';
 for(const token of tokens){if(token==='÷'){if(run){expected.push(run);run='';}}else if(token!=='×')run+=String.fromCodePoint(parseInt(token,16));}
 if(run)expected.push(run);const line=expected.join('');
 const actual=[...getGraphemeSegmenter().segment(line)].map(s=>s.segment);
 assert.deepEqual(actual,expected,`Intl vs Unicode17 GraphemeBreakTest ${gi}`);
 const query=[...line].find(c=>!/^\s$/u.test(c))??'a';
 add('graphemes',String(gi++),[line],query,{graphemes:actual.map(units)});
}
const raws=['\ud800','\udc00','\ud800\ud800','\udc00\udc00','\udc00\ud800','\ud83d\ude42','\ud800\u0301','\udc00\u0301','\u0600\ud800','\ufffd','\ud800\ufffd','\ud800\u200d🙂'];
for(let i=0;i<raws.length;i++){
 for(const [j,q]of raws.entries())add('raw',`raw-${i}-${j}`,['A'+raws[i]+'B',raws[i]],q);
 add('raw',`split-high-${i}`,[raws[i]],'\ud83d');add('raw',`split-low-${i}`,[raws[i]],'\ude42');
}
let seed=0x6ab93f21;const rand=n=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)%n;};
const pool=['a','A','b','x',' ','\t','\n','K','ſ','ß','ẞ','İ','ı','Σ','ς','🙂','\u0301','\u200d','界','\ud800','\udc00','\ufffd','\u0600','\u0903','\r','\u0085','\x1b[31m','\x1b]x\x07','\u200b','.','['];
for(let i=0;i<384;i++){
 const lines=Array.from({length:rand(5)},()=>Array.from({length:rand(18)},()=>pool[rand(pool.length)]).join(''));
 let q=Array.from({length:1+rand(4)},()=>pool[rand(pool.length)]).join('');
 if(lines.length&&rand(2)){const line=lines[rand(lines.length)];const start=rand(line.length+1);q=line.slice(start,start+1+rand(8));}
 add('fuzz',String(i),lines,q);
}
function cache(name,ops){
 const index=new AltScreenSearchIndex();let lines=[],current=index.matches,ids=new WeakMap(),idCounter=0;
 const saved={},nested={};
 const id=o=>{if(!ids.has(o))ids.set(o,++idCounter);return ids.get(o);};
 const ss=s=>({id:id(s),...s});const sg=a=>({id:id(a),items:a.map(ss)});
 const sm=m=>({id:id(m),segments:sg(m.segments),key:getAltScreenSearchMatchKey(m)});
 const sa=a=>({id:id(a),items:a.map(sm)});
 const expected=[];
 for(const op of ops){let changed=null;
  switch(op.op){
   case 'lines':lines=op.lines.map(text);break;
   case 'line':lines[op.index]=text(op.text);break;
   case 'search':{const r=index.search(lines,text(op.query));changed=r.changed;current=r.matches;break;}
   case 'save':saved[op.label]=current;break;
   case 'pop':(op.label?saved[op.label]:current).pop();break;
   case 'reverse':(op.label?saved[op.label]:current).reverse();break;
   case 'push':(op.label?saved[op.label]:current).push({segments:op.segments.map(s=>({...s}))});break;
   case 'set':Object.assign((op.label?saved[op.label]:current)[op.match].segments[op.segment],op.value);break;
   case 'saveNested':{const m=current[op.match];nested[op.label]={match:m,segments:m.segments,segment:m.segments[op.segment]};break;}
   case 'setNested':Object.assign(nested[op.label].segment,op.value);break;
   case 'replaceSegments':nested[op.label].match.segments=op.segments.map(s=>({...s}));break;
   case 'pushNested':nested[op.label].segments.push(nested[op.label].segment);break;
   default:throw Error(op.op);
  }
  expected.push({changed,current:sa(current),saved:Object.fromEntries(Object.entries(saved).map(([k,v])=>[k,sa(v)])),nested:Object.fromEntries(Object.entries(nested).map(([k,v])=>[k,{match:sm(v.match),segments:sg(v.segments),segment:ss(v.segment)}])),sourceLines:index.sourceLines?.map(units)??null,normalizedQuery:index.normalizedQuery===undefined?null:units(index.normalizedQuery),corpus:corpus(index)});
 }
 fixture.cache.push({name,ops,expected});
}
const ls=lines=>({op:'lines',lines:lines.map(units)}),search=q=>({op:'search',query:units(q)}),save=label=>({op:'save',label});
cache('upstream-cache',[ls(['alpha beta']),search('alpha'),save('first'),ls(['alpha beta']),search('alpha'),search('beta'),save('beta'),ls(['alpha beta gamma']),search('gamma')]);
cache('normalized-query',[ls(['a  b','A B']),search('a b'),save('first'),search('\t a \n b \ufeff'),search('A B'),search('a b'),search(''),search(' \t '),ls([]),search(''),ls([]),search('')]);
cache('raw-source-change',[ls(['a']),search('a'),save('a'),ls(['\x1b[31ma']),search('a'),ls(['a','']),search('a'),{op:'line',index:0,text:units('b')},search('a'),ls(['a','']),search('a')]);
cache('array-alias',[ls(['a a a']),search('a'),save('old'),{op:'pop'},search('a'),{op:'push',segments:[{row:9,startCol:7,endCol:8}]},search('a'),{op:'reverse'},search('a'),search('A'),{op:'set',label:'old',match:0,segment:0,value:{row:6}},search('A')]);
cache('deep-alias',[ls(['a a']),search('a'),{op:'saveNested',label:'n',match:0,segment:0},save('old'),{op:'setNested',label:'n',value:{startCol:9,endCol:12}},search('a'),{op:'replaceSegments',label:'n',segments:[{row:4,startCol:2,endCol:8}]},search('a'),{op:'setNested',label:'n',value:{row:7}},{op:'pushNested',label:'n'},search('A'),{op:'replaceSegments',label:'n',segments:[]},search('A')]);
cache('empty-alias',[ls([]),search(''),save('empty'),{op:'push',segments:[]},search(' '),ls(['']),search(''),save('new'),search('x'),search('x')]);
cache('raw-cache',[ls(['\ud800a\udc00']),search('\ud800'),save('old'),ls(['\ufffda\udc00']),search('\ud800'),ls(['\ud800a\udc00']),search('\ud800'),search('\udc00'),search('A')]);
for(const [i,segments]of [[],[{row:0,startCol:0,endCol:0}],[{row:2,startCol:8,endCol:3},{row:0,startCol:4,endCol:1}],[{row:9,startCol:3,endCol:5},{row:4,startCol:2,endCol:7},{row:6,startCol:1,endCol:2}]].entries())fixture.keys.push({name:String(i),segments,expected:getAltScreenSearchMatchKey({segments})});
for(const [g,cs]of Object.entries(fixture))assert.equal(new Set(cs.map(c=>c.name)).size,cs.length,g+' duplicate names');
writeFileSync('fixtures.json',JSON.stringify(fixture,null,2)+'\n');
console.log(JSON.stringify({counts:Object.fromEntries(Object.entries(fixture).map(([k,v])=>[k,v.length])),cacheSteps:fixture.cache.reduce((n,c)=>n+c.ops.length,0),simpleFoldPairs:folds.length,graphemeConformance:gi}));
