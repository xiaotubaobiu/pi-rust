import { readFile } from "node:fs/promises";
import { MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
console.log("MAX_STACK_SIZE:", MAX_STACK_SIZE);
// Probe evalCode strictness: sloppy-mode assignment to undeclared var.
const wasm = await WebAssembly.compile(await readFile("node_modules/quickjs-wasi/quickjs.wasm"));
const vm = await QuickJS.create({ wasm, maxStackSize: MAX_STACK_SIZE });
try {
  vm.evalCode("(x = 5)", "probe.js");
  console.log("sloppy eval OK (not strict)");
} catch (e) {
  console.log("strict eval error:", e.name, e.message);
}
// Stack format probe
try {
  vm.evalCode("(function f() { throw new Error('boom'); })()", "codemode.js");
} catch (e) {
  console.log("stack:", JSON.stringify(e.stack));
  console.log("name:", e.name, "message:", e.message);
}
// Number formatting / JSON parity probes
const checks = [
  "JSON.stringify({b:1,a:[1,2,null,'x\u0000']})",
  "(0.1+0.2).toString()",
  "JSON.stringify({u:undefined,f:()=>'y'})",
  "[NaN, Infinity, -0].map(String).join(',')",
  "new Date(0).toISOString()",
  "JSON.stringify(new Error('e'))",
  "(1e21).toString()",
  "(2**53).toString()",
  "'\u00e9'.length",
  "String.fromCodePoint(128512).length",
  "(255).toString(16)",
  "encodeURIComponent('\u00e9\u4f60')",
  "JSON.parse('{\"a\":1}').a",
  "(1000000000000000000000n).toString()",
  "new Intl.NumberFormat('en').format(1234.5)",
];
for (const c of checks) {
  try {
    const r = vm.evalCode(c, "probe.js");
    console.log(`${c} =>`, JSON.stringify(typeof r === "object" ? r?.toString?.() : r));
  } catch (e) { console.log(`${c} !!`, e.name, e.message); }
}
