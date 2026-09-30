// Offline oracle bootstrap. Reads pi and dependency cache, writes scratch only.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const workspace = dirname(root);
const pi = realpathSync(resolve(process.argv[2] ?? join(workspace, 'pi')));
const upstreamHead = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:pi, encoding:'utf8'}).trim();
if (upstreamHead !== '5901446094988aa5cd8e11efdaa131c3949106f1') throw Error('Unexpected upstream revision; audit before regenerating');
const deps = resolve(process.argv[3] ?? join(workspace, '.migration-handoff/reference-deps'));
const scratch = resolve(process.argv[4] ?? join(root, 'target/markdown-oracle'));
const inside = (parent, child) => { const r = relative(parent, child); return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); };
let ancestor = scratch;
while (!existsSync(ancestor)) ancestor = dirname(ancestor);
if (inside(pi, scratch) || inside(pi, realpathSync(ancestor))) throw Error('Scratch must not be inside pi');
mkdirSync(scratch, {recursive:true});
const sources = ['components/markdown.ts', 'latex.ts', 'terminal-image.ts', 'utils.ts'];
const hashes = {};
for (const name of sources) {
  const source = join(pi, 'packages/tui/src', name), target = join(scratch, 'src', name);
  mkdirSync(dirname(target), {recursive:true});
  cpSync(source, target);
  hashes[name] = createHash('sha256').update(readFileSync(source)).digest('hex');
}
for (const [name, version] of [['marked','18.0.5'], ['chalk','5.6.2'], ['get-east-asian-width','1.6.0']]) {
  let source = join(deps, name + '-' + version);
  if (!existsSync(join(source, 'package.json'))) source = join(source, 'package');
  const pkg = JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
  if (pkg.version !== version) throw Error('Unexpected reference dependency version: '+name);
  cpSync(source, join(scratch, 'node_modules', name), {recursive:true});
}
writeFileSync(join(scratch, 'package.json'), JSON.stringify({type:'module'}));
cpSync(join(here, 'generate-fixtures.mjs'), join(scratch, 'gen.mjs'));
execFileSync(process.execPath, ['--experimental-strip-types', 'gen.mjs'], {cwd:scratch,stdio:'inherit'});
const sha = data => createHash('sha256').update(data).digest('hex');
const artifacts = {};
for (const name of ['fixtures.json', 'utf16-fixtures.json', 'utf16-wrap-fixtures.json', 'source-fixtures.json', 'source-utf16-fixtures.json', 'inline-tail-fixtures.json']) {
  const data = readFileSync(join(scratch, name));
  artifacts[name] = {sha256:sha(data), bytes:data.length, cases:JSON.parse(data).cases.length};
}
writeFileSync(join(scratch,'source-manifest.json'), JSON.stringify({
  upstream:'590144609', upstreamHead, node:process.version, sources:hashes,
  dependencies: {marked:'18.0.5', chalk:'5.6.2', 'get-east-asian-width':'1.6.0'},
  deviation: 'upstream marked 18.0.11 unavailable offline; 18.0.5 is not exact-version parity',
  generatorSha256:sha(readFileSync(join(here, 'generate-fixtures.mjs'))), artifacts,
},null,2)+'\n');
console.log('Generated: '+join(scratch,'fixtures.json'));
