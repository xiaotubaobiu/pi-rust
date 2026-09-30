// Run the Markdown oracle first; all expected widths come from actual upstream.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const scratch = process.argv[2] ?? fileURLToPath(new URL('../../../../target/markdown-oracle/', import.meta.url));
const { visibleWidth } = await import(pathToFileURL(resolve(scratch, 'src/utils.ts')).href);
const cases=[];
for(const pair of [[0xd83d,0xde00],[0xd835,0xdc9c]])for(const sep of ["","\u001b[0m","\u001b[1G","\u001b[2K","\u001b[3H","\u001b[4J","\u001b]8;;x\u0007","\u001b]8;;x\u001b\\","\u001b_marker\u0007","\u001b_marker\u001b\\","\u001b[\tm","\u001b]\ud800\u0007","\t"," "]){
const source=[pair[0],...Array.from({length:sep.length},(_,i)=>sep.charCodeAt(i)),pair[1]];
cases.push({source,width:visibleWidth(String.fromCharCode(...source))});
}
for (const source of [
  [0xd83d, 0x1b, 0x1b, 0x5d, 0x78, 7, 0x5b, 0x30, 0x6d, 0xde00],
  [0xd800, 0x1b, 0x1b, 0x5d, 0x78, 7, 0x5b, 0x30, 0x6d, 0x41]
]) cases.push({source, width:visibleWidth(String.fromCharCode(...source))});
console.log(JSON.stringify({node:process.version,cases},null,2));
