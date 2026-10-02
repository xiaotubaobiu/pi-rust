import { readFile } from "node:fs/promises";
import { MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
const wasm = await WebAssembly.compile(await readFile("node_modules/quickjs-wasi/quickjs.wasm"));
const vm = await QuickJS.create({ wasm, maxStackSize: MAX_STACK_SIZE });
try { vm.evalCode("(function f(){ f(); })()", "codemode.js"); } catch (e) {
  console.log("recursion:", e.name, "|", e.message, "|", JSON.stringify(e.stack?.slice(0, 80)));
}
// job exception: promise chain with throwing then
try {
  const fn = vm.evalCode("(async () => { await Promise.resolve(); throw new Error('job boom'); })", "s.js");
  vm.executePendingJobs();
  console.log("jobs ok");
} catch (e) {
  console.log("job exception:", e.name, "|", e.message);
}
// uncaught promise rejection
try {
  const fn2 = vm.evalCode("(async () => { Promise.reject(new Error('unhandled')); return 1; })", "s.js");
  vm.executePendingJobs();
  console.log("unhandled rejection: no throw");
} catch (e) {
  console.log("unhandled rejection threw:", e.name, "|", e.message);
}
// typeof globalThis keys order check
console.log(vm.evalCode("JSON.stringify(Object.keys(globalThis).slice(0,3))"));
