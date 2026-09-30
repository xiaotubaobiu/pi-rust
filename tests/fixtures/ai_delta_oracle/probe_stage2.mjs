import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const aiSrc = 'C:/Users/13063/Desktop/code/agent work/pi/packages/ai/src';
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
const root = path.join(staging, 'src');
const seen = new Set();
function copy(rel) {
  rel = rel.split(path.sep).join('/');
  if (seen.has(rel)) return;
  seen.add(rel);
  const abs = path.join(aiSrc, ...rel.split('/'));
  const src = fs.readFileSync(abs, 'utf8');
  const target = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, src);
  for (const [, spec] of src.matchAll(/froms+"(.[^"]+)"/g)) {
    if (spec.endsWith('.ts')) copy(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
  }
}
copy('model-catalog.ts');
console.log(fs.readdirSync(root, { recursive: true }).join(','));
const m = await import(pathToFileURL(path.join(root, 'model-catalog.ts')).href);
console.log(JSON.stringify(m.flattenChatModelCatalog('p', { api1: { v1: { id: 'v1', type: 'chat' } } })));
