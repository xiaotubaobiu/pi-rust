// Probe round 2: device/UNC/cwd interactions in win32 resolve, plus misc.
const pathMod = (await import("node:path")).default;

const RESOLVE2 = [
  ["x:"], ["x:", "y", "z"], ["C:\\a", "C:b"], ["C:\\a\\b", "C:c", ".."],
  ["C:\\a", "b", "C:c"], ["\\\\s\\s\\a", "b"], ["\\\\s\\s\\a", "C:b"],
  ["\\\\s\\s\\a", "D:b"], ["C:\\a", "\\\\", "b"], ["\\\\", "C:\\b"],
  ["C:\\a", "b", "D:\\c"], ["D:\\a", "b", "C:\\c"], ["C:\\a", "C:.\\b"],
  ["C:x", "C:y"], ["C:x", "\\\\s\\s\\y"], ["C:\\", "C:x"], ["C:\\", "C:x", "y"],
  ["\\\\?\\C:\\a", "\\\\?\\C:\\a\\b"], ["\\\\s\\s\\a\\b", "\\\\s\\s\\c"],
  ["C:\\a", "/b"], ["/a", "C:\\b"], ["", "a", ""], ["C:\\a\\b", "", "\\c"],
  ["C:\\a\\b", "..", "\\..\\..\\c"],
];
const RELATIVE2 = [
  ["\\\\?\\C:\\a", "\\\\?\\C:\\a\\b"], ["C:\\a\\b\\", "C:\\a\\b\\c\\"],
  ["C:\\a", "C:\\a\\b"], ["\\\\s\\s\\a\\b", "\\\\s\\s\\a"],
  ["C:\\a\\b", "C:\\a\\b"], ["C:\\.\\a", "C:\\a"],
];
const JOIN2 = [["C:", "x", "y"], ["C:\\a", "", "b"], ["", ""], ["a", ""], ["C:\\a\\", "b\\"], ["C:\\", "..", "a"]];
const NORM2 = ["C:.\\x", "C:x\\", "\\\\s\\s\\a\\", "C:\\a\\b\\\\", "x\\", "C:\\x\\..\\y\\"];

const dump = (fn, grid) => grid.map((args) => fn(...args));
const out = {
  win32: {
    resolve: dump(pathMod.win32.resolve, RESOLVE2),
    relative: dump(pathMod.win32.relative, RELATIVE2),
    join: dump(pathMod.win32.join, JOIN2),
    normalize: NORM2.map((p) => pathMod.win32.normalize(p)),
  },
};
import fs from "node:fs";
fs.writeFileSync(new URL("./probe2_output.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
