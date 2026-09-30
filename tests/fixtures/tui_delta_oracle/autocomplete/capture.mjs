// Captures v0.99.1 autocomplete.ts delta behavior from the REAL upstream
// module: token extraction (wrappers/CJK separators), completion quoting,
// skill: bare-name command matching, and directory sorting by label. File
// suggestions run against a hermetic temp tree created here.
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CombinedAutocompleteProvider } from "./autocomplete.ts";

const work = fileURLToPath(new URL("./hermetic-fs", import.meta.url));
rmSync(work, { recursive: true, force: true });
for (const dir of ["", "/sub", "/sub/inner", "/Folder Names", "/z-last"]) {
  mkdirSync(work + dir, { recursive: true });
}
for (const file of [
  "/readme.md", "/sub/file-one.ts", "/sub/file-two.ts", "/sub/inner/deep.py",
  "/Folder Names/interesting file.txt", "/z-last/zebra.txt", "/app.js",
]) {
  writeFileSync(work + file, "x");
}

const provider = new CombinedAutocompleteProvider([], work, undefined);

// The private token extraction is exercised through the public provider API.
// getSuggestions is async upstream; each call gets a fresh AbortSignal.
const signal = () => new AbortController().signal;
const out = { pathPrefix: [], atPrefix: [], commands: [], suggestions: [], provenance: {} };

const prefixInputs = [
  // extractPathPrefix via shouldTriggerFileCompletion + getSuggestions(force).
  ["", true], ["", false], ["hello ", false], ["hello ", true],
  ["look at (~/Dev", false], ["look at (~/Dev", true],
  ["see `src/ma", false], ["see `src/ma", true],
  ["run app/[slug]/pa", false], ["run app/[slug]/pa", true],
  ["read (group)/pa", false], ["path with space/tex", false],
  ["open \"quoted file", false], ["check <output>.txt", false],
  ["value=con{fig}/x", false], ["日本語のファイル", true],
  ["日本語,ファイル", true], ["file。テキスト", true],
  ["plain", false], ["a/b c", false], ["x, y", false],
];
for (const [text, force] of prefixInputs) {
  const suggestions = await provider.getSuggestions([text], 0, [...text].length, { signal: signal(), force });
  out.pathPrefix.push({
    text,
    force,
    prefix: suggestions?.prefix ?? null,
    items: suggestions?.items?.map((item) => ({ value: item.value, label: item.label })) ?? null,
  });
}

// extractAtPrefix: reachable when a @ token starts a suggestion query.
for (const text of ["see @sub/fi", "see (@sub/fi", "see `@sub/fi", "@\"sub/fi", "email a@b", "see @sub", "see @Folder Na"]) {
  const suggestions = await provider.getSuggestions([text], 0, [...text].length, { signal: signal(), force: false });
  out.atPrefix.push({
    text,
    prefix: suggestions?.prefix ?? null,
    items: suggestions?.items?.map((item) => ({ value: item.value, label: item.label })) ?? null,
  });
}

// skill: bare-name matching on slash commands.
const skillProvider = new CombinedAutocompleteProvider(
  [
    { name: "skill:deploy", description: "deploy the service" },
    { name: "skill:diagnose", description: "diagnose failures" },
    { name: "build", argumentHint: "[target]" },
    { name: "review" },
    { name: "skill:other", description: "unrelated" },
  ],
  work,
  undefined,
);
for (const text of ["/", "/d", "/de", "/skill", "/skill:", "/skill:d", "/b", "/z"]) {
  const suggestions = await skillProvider.getSuggestions([text], 0, text.length, { signal: signal(), force: false });
  out.commands.push({
    text,
    prefix: suggestions?.prefix ?? null,
    items: suggestions?.items?.map((item) => ({ value: item.value, label: item.label, description: item.description ?? null })) ?? null,
  });
}

// Directory-first sorting keys off the LABEL, with quoted completion values.
for (const text of ["open sub/", "open sub/in", "open \"Folder Na", "open folder-weights"]) {
  const suggestions = await provider.getSuggestions([text], 0, [...text].length, { signal: signal(), force: false });
  out.suggestions.push({
    text,
    prefix: suggestions?.prefix ?? null,
    items: suggestions?.items?.map((item) => ({ value: item.value, label: item.label })) ?? null,
  });
}

rmSync(work, { recursive: true, force: true });
const sha = (data) => createHash("sha256").update(data).digest("hex");
out.provenance = {
  autocompleteSha256: sha(readFileSync(fileURLToPath(new URL("./autocomplete.ts", import.meta.url)))),
  utilsSha256: sha(readFileSync(fileURLToPath(new URL("./utils.ts", import.meta.url)))),
  fuzzySha256: sha(readFileSync(fileURLToPath(new URL("./fuzzy.ts", import.meta.url)))),
  node: process.version,
  platform: process.platform,
};
const target = process.argv[2] ?? fileURLToPath(new URL("./autocomplete_oracle.json", import.meta.url));
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log(
  "autocomplete delta rows:",
  out.pathPrefix.length + out.atPrefix.length + out.commands.length + out.suggestions.length,
  sha(readFileSync(target)),
);
