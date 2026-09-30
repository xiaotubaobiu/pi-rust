// Offline bootstrap: actual full modules, never edits the sibling pi checkout.
import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync,realpathSync} from 'node:fs';
import {resolve,dirname,join,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../../..'),workspace=dirname(root);
const pi=realpathSync(resolve(process.argv[2]??join(workspace,'pi')));
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:pi,encoding:'utf8'}).trim();
if(head!=='5901446094988aa5cd8e11efdaa131c3949106f1')throw Error('Unexpected upstream HEAD');
const deps=resolve(process.argv[3]??join(workspace,'.migration-handoff/reference-deps'));
const scratch=resolve(process.argv[4]??join(root,'target/component-gesture-oracle'));
const inside=(a,b)=>{const r=relative(a,b);return !r||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
let ancestor=scratch;while(!existsSync(ancestor))ancestor=dirname(ancestor);
if(inside(pi,scratch)||inside(pi,realpathSync(ancestor)))throw Error('Scratch must not be inside pi');
mkdirSync(scratch,{recursive:true});
const sources=['components/stack.ts','components/h-stack.ts','components/v-stack.ts','layout-node.ts','layout.ts','components/scroll-view.ts','components/text.ts','tui.ts','keys.ts','terminal-colors.ts','terminal-image.ts','utils.ts','tui-alt-screen.ts','alt-screen-search.ts','components/alt-screen-flash.ts','keybindings.ts','components/input.ts','kill-ring.ts','undo-stack.ts','word-navigation.ts','components/select-list.ts','components/mouse-region.ts'];
const sha=data=>createHash('sha256').update(data).digest('hex'),hashes={};
for(const name of sources){const file=join(pi,'packages/tui/src',name),to=join(scratch,'src',name);mkdirSync(dirname(to),{recursive:true});cpSync(file,to);hashes[name]=sha(readFileSync(file));}
let dependency=join(deps,'get-east-asian-width-1.6.0');if(!existsSync(join(dependency,'package.json')))dependency=join(dependency,'package');
if(JSON.parse(readFileSync(join(dependency,'package.json'),'utf8')).version!=='1.6.0')throw Error('Wrong dependency version');
cpSync(dependency,join(scratch,'node_modules/get-east-asian-width'),{recursive:true});
writeFileSync(join(scratch,'package.json'),JSON.stringify({type:'module'}));
cpSync(join(here,'generate-fixtures.mjs'),join(scratch,'gen.mjs'));
execFileSync(process.execPath,['--experimental-strip-types','gen.mjs'],{cwd:scratch,stdio:'inherit'});
const data=readFileSync(join(scratch,'fixtures.json')),fixture=JSON.parse(data);
writeFileSync(join(scratch,'source-manifest.json'),JSON.stringify({upstreamHead:head,node:process.version,sources:hashes,referenceTests:Object.fromEntries(['tui-alt-screen.test.ts','mouse-components.test.ts','virtual-terminal.ts'].map(name=>[name,sha(readFileSync(join(pi,'packages/tui/test',name)))])),nativeTestsExecuted:false,dependencies:{'get-east-asian-width':'1.6.0'},generatorSha256:sha(readFileSync(join(here,'generate-fixtures.mjs'))),artifacts:{'fixtures.json':{bytes:data.length,sha256:sha(data),counts:Object.fromEntries(Object.entries(fixture).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,v.length]))}},scope:'Actual complete TuiAltScreen.handleMouseEvent/applyMouseDispatchResult/target dispatch/click counter, real Container/layout routing. Leaf responses and host search/overlay/focus/scrollbar/paste/selection are explicit controlled seams. Lifecycle compares only component-gesture state after actual focus-out/before-start/before-stop. No full host/OS integration or native alt-screen test execution.'},null,2)+'\n');
console.log('Generated '+join(scratch,'fixtures.json'));
