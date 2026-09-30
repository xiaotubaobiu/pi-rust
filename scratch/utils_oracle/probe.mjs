// Edge-behaviour probes for node:path used while converging the Rust port.
const pathMod = (await import("node:path")).default;

const RESOLVE_PROBES = [
  ["\\", "x"], ["x\\.."], ["C:\\", "x", "..", "\\"], ["C:\\a\\b", "\\c"],
  ["C:\\a\\b", "C:c"], ["C:\\a\\b", "C:"], ["\\\\s\\s\\a\\b", "..\\c"],
  ["\\a\\b", ".."], ["a", "\\b"], ["C:\\a", "b", "\\c"], ["", ""],
  ["C:\\.", "b"], ["C:\\a\\b\\c\\..\\..\\..\\d"], ["\\\\", "x"], ["\\\\s", "x"],
  ["/x"], ["C:/a/./b"], ["C:\\a\\..", ".."],
];
const RELATIVE_PROBES = [
  ["C:\\a\\b\\c", "C:\\a\\b"], ["C:\\a\\b", "C:\\a\\b\\c"], ["\\\\s\\s\\a", "C:\\b"],
  ["C:\\a\\b", "\\a\\c"], ["C:\\", "D:\\"], ["c:\\a\\B", "C:\\a\\b"],
  ["C:\\a", "c:\\a"], ["\\a\\b", "\\a\\b\\c"], ["C:\\a\\b", "C:\\a\\c\\"],
  ["C:\\", "\\\\"],
];
const JOIN_PROBES = [
  ["C:", "x"], ["C:", "x", ".."], ["\\a", "b"], ["a", "\\b"], ["C:\\a", "\\b"],
  ["C:\\a", "C:b"], ["\\\\s\\s\\a", ".."], ["", ""], ["", "a"],
];
const NORM_PROBES = [
  "C:", "C:.", "C:/", "C:\\", "\\\\?\\C:\\a\\b", "C:\\a\\b\\..\\", "/a\\b\\c",
  "\\\\s\\s\\", "a\\", "C:\\..", "\\\\", "/..", "a\\b\\c", "C:\\a\\\\b",
];
const POSIX_RESOLVE_PROBES = [
  ["a", "..", "a"], ["a\\b"], ["/a/", "..", "b"], ["/"], ["", ""], ["", "a"],
  ["/a", "/b"], ["a", "/b"], ["/a/b", "../c"],
];
const POSIX_RELATIVE_PROBES = [
  ["/a/b/c", "/a/b"], ["", "a"], ["/a/b", "/a/b"], ["a", "a"], ["/", "/"],
  ["/a/b", "a"], ["a/b", "a/c"], ["/a/b/../c", "/a/d"],
];
const POSIX_JOIN_PROBES = [["/a", ".."], ["a", ".."], ["", "a"], ["a", "", "b"], ["/", "a"]];
const POSIX_NORM_PROBES = ["/a/b/", "a/..", "..//a", "/", "", "..", "a\\b", "/../a", "a/./b"];

const dump = (fn, grid) => grid.map((args) => fn(...args));

const out = {
  win32: {
    resolve: dump(pathMod.win32.resolve, RESOLVE_PROBES),
    relative: dump(pathMod.win32.relative, RELATIVE_PROBES),
    join: dump(pathMod.win32.join, JOIN_PROBES),
    normalize: NORM_PROBES.map((p) => pathMod.win32.normalize(p)),
  },
  posix: {
    resolve: dump(pathMod.posix.resolve, POSIX_RESOLVE_PROBES),
    relative: dump(pathMod.posix.relative, POSIX_RELATIVE_PROBES),
    join: dump(pathMod.posix.join, POSIX_JOIN_PROBES),
    normalize: POSIX_NORM_PROBES.map((p) => pathMod.posix.normalize(p)),
  },
};

import fs from "node:fs";
fs.writeFileSync(new URL("./probe_output.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
