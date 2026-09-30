import { SCENARIOS } from "./scenarios.ts";
const name = process.argv[2];
console.log("start", name);
const r = await SCENARIOS[name]();
console.log("done", name, JSON.stringify(r).slice(0, 120));
process.exit(0);
