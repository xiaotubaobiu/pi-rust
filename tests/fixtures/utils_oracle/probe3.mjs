// Probe round 3: per-drive cwd env entries in path.win32.resolve.
process.env["=C:"] = "D:\\elsewhere";
process.env["=x:"] = "C:\\custom";
process.env["=y:"] = "relative\\junk";
const pathMod = (await import("node:path")).default;
const cases = [
  ["C:"], ["C:x"], ["x:"], ["x:sub"], ["y:z"], ["C:\\a", "C:"], ["C:", "q"],
  ["C:\\a\\b", "C:x"], ["C:\\a", "C:x", ".."],
];
const out = cases.map((args) => [args.join("|"), pathMod.win32.resolve(...args)]);
console.log(JSON.stringify(out, null, 1));
console.log("cwd:", process.cwd());
import fs from "node:fs";
fs.writeFileSync(new URL("./probe3_output.json", import.meta.url), JSON.stringify({ out, cwd: process.cwd() }, null, 1));
