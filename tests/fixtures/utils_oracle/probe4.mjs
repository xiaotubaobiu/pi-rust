// Probe round 4: win32/posix relative edge cases.
const pathMod = (await import("node:path")).default;
const WIN = [
  ["\\\\s1\\s\\a", "\\\\s2\\s\\b"], ["\\\\s\\s\\a", "\\\\s\\s\\bbbb"],
  ["\\\\s\\s\\a", "\\\\s\\s\\"], ["C:\\x", "C:"], ["C:", "C:\\x"],
  ["C:\\a\\b", "C:\\a\\b\\"], ["C:\\", "C:\\a"], ["\\\\?\\C:\\a\\b", "\\\\?\\C:\\a"],
  ["\\a", "\\a\\b"], ["/a\\b", "/a\\c"], ["C:\\a", "C:\\a\\b\\c\\d"],
  ["C:\\a\\b\\c", "C:\\a\\b\\c\\"], ["C:\\a\\b", "C:\\A\\B"],
];
const POSIX = [
  ["/a/b/", "/a/b/c/"], ["/a", "/ab"], ["/ab", "/a"], ["/a/b/c", "/a"],
  ["/a", "/a/b/c/d"], ["/", "/a/b"], ["/a/b//", "/a/c"],
];
import fs from "node:fs";
const out = {
  win32_relative: WIN.map(([f, t]) => [`${f}|${t}`, pathMod.win32.relative(f, t)]),
  posix_relative: POSIX.map(([f, t]) => [`${f}|${t}`, pathMod.posix.relative(f, t)]),
};
fs.writeFileSync(new URL("./probe4_output.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
