// Offline generator. Reads (never modifies) the pinned sibling pi snapshot.
// Usage: node docs/migration/reference/generate-tools-oracles.mjs [diff package dir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../..');
const diffDir=process.argv[2] || path.resolve(root,'../.migration-handoff/reference-deps/diff-8.0.4/package');
const sourcePath=path.resolve(root,'../pi/packages/agent/src/harness/tools/edit-diff.ts');
const source=await fs.readFile(sourcePath,'utf8');
const diffPackage=JSON.parse(await fs.readFile(path.join(diffDir,'package.json'),'utf8'));
if(diffPackage.version!=='8.0.4') throw Error('Reference must be diff 8.0.4, got '+diffPackage.version);
const moduleSource=stripTypeScriptTypes(source.replace('from "diff";', 'from '+JSON.stringify(pathToFileURL(path.join(diffDir,'libesm/index.js')).href)+';'), {mode:'strip'});
const oracle=await import('data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64'));
let seed=0x391723;
function random(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;}
const tokens=['alpha\n','beta\n','same\n','same\n','\n','界🙂\n',' trailing  \n','quote’\r\n'];
const diffs=[];
function diff(oldText,newText,context){diffs.push({oldText,newText,context,...oracle.generateDiffString(oldText,newText,context),patch:oracle.generateUnifiedPatch('fixture.txt',oldText,newText,context)});}
for(const oldText of ['', 'a','a\n','a\nb','a\nb\n','\n','\n\n','界\n🙂'])for(const newText of ['', 'a','a\n','b\na','a\nb\n','\n','🙂\n界'])for(const context of [0,1,4])diff(oldText,newText,context);
for(let i=0;i<220;i++){
  let oldText=Array.from({length:random(60)},()=>tokens[random(tokens.length)]).join('');
  let lines=oldText.split(/(?<=\n)/);
  for(let j=0;j<1+random(7);j++){const at=random(lines.length+1);lines.splice(at,random(3),...Array.from({length:random(4)},()=>tokens[random(tokens.length)]));}
  let newText=lines.join('');if(random(2))oldText=oldText.replace(/\n$/,'');if(random(2))newText=newText.replace(/\n$/,'');diff(oldText,newText,random(6));
}
const edits=[];
function edit(content,replacements){let result;try{result=oracle.applyEditsToNormalizedContent(content,replacements,'fixture.txt')}catch(error){result={error:error.message}}edits.push({content,edits:replacements,...result});}
const cases=[
 ['a\nb\nc\n',[['a','A'],['c','C']]], ['one\ntwo\nthree\n',[['one\ntwo','X'],['two\nthree','Y']]],
 ['foo foo foo',[['foo','bar']]], ['foo',[['missing','x']]], ['foo',[['','x']]], ['foo',[['foo','foo']]],
 ['prefix  \n“hello”\nunchanged\u00a0\n',[['"hello"','world']]],
 ['x’  \nx’  \n',[['x\'','z']]], ['\uFEFFhello\r\n',[['hello','changed']]],
 ['ＡＢＣ\nnext\n',[['ABC','replacement']]], ['Ⅳ\nkeep  \n',[['IV','four']]],
 ['quoted “first”\n\nkeep —    \nlast\n',[['"first"','new'],['last','LAST']]],
 ['same\nfirst “value”\nsame  \nlast\n',[['first "value"','changed']]],
 ['a\nb\n',[['a','b'],['b','c']]], ['a\nb\n',[['a','a'],['b','b']]],
 ['abc',[['missing','x'],['abc','y']]], ['aaa',[['a','x'],['a','y']]], ['foo',[['','x'],['foo','y']]],
 ['e\u0301 “x”\nkeep\n',[['é "x"','done']]], ['x\n   \ny\n',[['   ','Q']]],
 ['x\u0085\n',[['x','z']]], ['\uFEFFx\n',[['x','z']]],
];
for(const [content,replacements]of cases)edit(content,replacements.map(([oldText,newText])=>({oldText,newText})));
for(let i=0;i<75;i++){const content=Array.from({length:10},(_,k)=>'line'+k+' “value”  \n').join('');const at=random(10);edit(content,[{oldText:'line'+at+(i%2?' "value"':' “value”'),newText:'new'+i+'\nextra'}]);}
const output={upstream:'590144609',sourceSha256:createHash('sha256').update(source).digest('hex'),diffVersion:diffPackage.version,diffs,edits};
const destination=path.resolve(root,'src/agent_core/harness/tools/fixtures/edit-oracles.json');
await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({destination,diffs:diffs.length,edits:edits.length,sourceSha256:output.sourceSha256}));
