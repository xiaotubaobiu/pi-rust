// Captures v0.99.1 utils.ts delta behavior from the REAL upstream module:
// visibleWidth fast paths, extractAnsiCode refactoring, and the autocomplete
// separator/boundary regexes (CJK punctuation).
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  visibleWidth,
  extractAnsiCode,
  wrapTextWithAnsi,
  getActiveBackgroundAnsi,
} from "./utils.ts";

const out = { visibleWidth: [], extractAnsiCode: [], wrap: [], activeBackground: [], separators: {} };

const widthInputs = [
  "\x1b[38;5;4mhello\x1b[39m world",
  "\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
  "\x1b]133;A\x1b\\prompt",
  "\x1b_pi:c\x07cursor",
  "\x1b[1ma\tb\x1b[22m",
  "\x1b[31m日本\x1b[39m ok",
  "\x1b[31m─→\x1b[39m",
  "\x1b[31",
  "a\x1b",
  "plain ascii",
  "\ta\t",
  "",
  "\x1b[38;5;4mあ\tい\x1b[39m",
  "\x1b]8;;x\x07a\tb\x1b]8;;\x07",
  "mixed é\t\x1b[1mx\x1b[22m",
  "\x1b[1;31m%%\x1b[0m\t\x1b]8;;u\x07url\x1b]8;;\x07",
];
for (const input of widthInputs) {
  out.visibleWidth.push({ input, width: visibleWidth(input) });
}

const ansiInputs = [
  ["\x1b[38;5;4mhello", 0], ["\x1b[38;5;4mhello", 14],
  ["\x1b]8;;u\x07text", 0], ["\x1b]8;;u\x07text", 7],
  ["\x1b_pi:c\x07", 0], ["\x1b_pi:c", 0],
  ["abc\x1b[1m", 3], ["abc\x1b[1m", 4], ["abc", 0],
  ["\x1b", 0], ["\x1b[1", 0], ["\x1b]8;;a\x1b\\b", 0],
];
for (const [input, pos] of ansiInputs) {
  const code = extractAnsiCode(input, pos);
  out.extractAnsiCode.push({ input, pos, code: code === null ? null : { code: code.code, length: code.length } });
}

const wrapInputs = [
  ["\x1b[1mhello world\x1b[22m and more words here", 10],
  ["日本語のテキスト と ascii words", 8],
  ["a\tb c\td", 4],
  ["\x1b[31mone two three four\x1b[39m", 8],
];
for (const [input, width] of wrapInputs) {
  out.wrap.push({ input, width, lines: wrapTextWithAnsi(input, width) });
}
out.activeBackground = [
  "a\x1b[41mb\x1b[0mc",
  "\x1b[7;41mx y",
  "no codes",
].map((input) => getActiveBackgroundAnsi(input));

// The autocomplete separator/boundary regexes exported by the delta.
const { autocompleteSeparatorRegex, autocompleteBoundaryRegex, cjkBreakRegex } =
  await import("./utils.ts");
const sepInputs = [
  " ", "\t", "\u3000", "，", "．", "：", "；", "！", "？", "（", "）", "［", "］", "｛", "｝",
  "“", "”", "‘", "’", "…", "—", "a", "日", "漢", ",", "。", "　", "​", "­",
  "(~/Dev", "app/[slug]/pa", "`src/ma", "@file with space.txt", "path/to,thing",
];
out.separators.separatorTests = sepInputs.map((value) => ({
  value,
  matches: autocompleteSeparatorRegex.test(value),
}));
const boundaryInputs = ["", " ", "a", "a ", "x，", "x.", "(","x("];
out.separators.boundaryTests = boundaryInputs.map((value) => ({
  value,
  suffixMatches: new RegExp(`${autocompleteBoundaryRegex.source}$`, "u").test(value),
}));
out.separators.cjkBreak = ["日", "a", "、"].map((value) => ({ value, matches: cjkBreakRegex.test(value) }));

const sha = (data) => createHash("sha256").update(data).digest("hex");
out.provenance = {
  utilsSha256: sha(readFileSync(fileURLToPath(new URL("./utils.ts", import.meta.url)))),
  node: process.version,
  platform: process.platform,
};
const target = process.argv[2] ?? fileURLToPath(new URL("./utils_oracle.json", import.meta.url));
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log("utils delta rows:", out.visibleWidth.length + out.extractAnsiCode.length + out.wrap.length, sha(readFileSync(target)));
