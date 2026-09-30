// Captures the v0.99.1 editor.ts trigger/debounce regex behavior. The two
// build functions are copied VERBATIM from upstream components/editor.ts
// (v0.99.1, SHA recorded below); the imported utils.ts regexes are the real
// upstream module. The Rust port mirrors these with a hand matcher, so the
// fixture pins the upstream regex semantics it must reproduce.
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { autocompleteBoundaryRegex, autocompleteSeparatorRegex } from "./utils.ts";

const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;
const DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS = ["@", "#"];
// Unquoted completions end at whitespace or CJK punctuation; quoted paths may contain either.
const unquotedAutocompleteSuffixRegex = new RegExp(`(?:(?!${autocompleteSeparatorRegex.source}).)*`, "u");
// Trigger tokens may be wrapped in prose, e.g. "(@src/foo" or "`@src/foo".
const autocompleteTokenStartSource = `${autocompleteBoundaryRegex.source}[([{<\`]*`;

function escapeCharacterClass(value) {
	return value.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

function buildTriggerPattern(triggerCharacters) {
	return new RegExp(
		`${autocompleteTokenStartSource}(?:@"[^"]*|[${triggerCharacters.map(escapeCharacterClass).join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
		"u",
	);
}

function buildDebouncePattern(triggerCharacters) {
	const escapedWithoutAt = triggerCharacters.filter((character) => character !== "@").map(escapeCharacterClass);
	return new RegExp(
		`${autocompleteTokenStartSource}(?:@(?:"[^"]*|${unquotedAutocompleteSuffixRegex.source})|[${escapedWithoutAt.join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
		"u",
	);
}

const out = { trigger: [], debounce: [], provenance: {} };
const triggerPattern = buildTriggerPattern(DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS);
const debouncePattern = buildDebouncePattern(DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS);

const texts = [
  "",
  "@",
  "@src",
  "hello @src/foo.ts",
  "(@src/foo",
  "`@src/foo",
  "{@a",
  "[@a",
  "<@a",
  "hello @\"quoted path with space",
  "@\"unterminated quote \" here",
  "a @b c",
  "@b c",
  "x @",
  "email a@b",
  "a@@b",
  "run `@script arg",
  "日本語@ファイル",
  "日本語，@ファイル",
  "@ファイル 説明",
  "#tag",
  "#日本語タグ",
  "a #tag here",
  "@path,more",
  "@path，more",
  "@path,more",
  "text @path ",
  "@path ",
  "\t@tabbed",
  "@a\tb",
  "((@nested",
  "@((weird",
  "chat @文件名.txt。",
  "@x=y",
  "@x=y ",
];
for (const text of texts) {
  out.trigger.push({ text, matches: triggerPattern.test(text) });
  out.debounce.push({ text, matches: debouncePattern.test(text) });
}
// Custom trigger characters (upstream rebuilds the patterns per provider).
for (const characters of [["/", "%"], ["/"], ["@"]]) {
  const pattern = buildTriggerPattern(characters);
  for (const text of ["/help", "%x", "a /help b", "/%x", "@path", "run /cmd now"]) {
    out.trigger.push({ text, characters: characters.join(""), matches: pattern.test(text) });
  }
}

const editorSource = readFileSync(process.argv[3], "utf8");
out.provenance = {
  utilsSha256: createHash("sha256").update(readFileSync(fileURLToPath(new URL("./utils.ts", import.meta.url)))).digest("hex"),
  editorSha256: createHash("sha256").update(editorSource).digest("hex"),
  node: process.version,
  platform: process.platform,
};
const target = process.argv[2] ?? fileURLToPath(new URL("./editor_patterns_oracle.json", import.meta.url));
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log("editor pattern rows:", out.trigger.length + out.debounce.length, createHash("sha256").update(readFileSync(target)).digest("hex"));
