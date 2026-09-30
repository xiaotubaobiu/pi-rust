// Re-captures the checked-in latex fixtures against upstream HEAD
// (2bbfcca43, v0.99.1). Every row of src/tui/latex/fixtures.json and
// utf16-fixtures.json is re-rendered with the REAL upstream module (copied
// here and SHA-verified) and the expected values are refreshed where the
// v0.99.1 latex delta (script layout nodes, font switches, cases rewrite)
// changed the output.
//
// String-corpus rows whose render now contains lone surrogates (possible
// after the script-layout delta) cannot be transported as JSON strings
// (serde_json rejects lone \uXXXX escapes), so those rows carry the expected
// value as numeric UTF-16 units in `expectedUtf16` instead; the Rust fixture
// struct accepts both.
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderLatex } from "./latex.ts";

const EXPECTED_LATEX_SHA = "c4ef99bef1d3a54c73006912c9a7fa67ef99412b4f6cd28d608cf0e07b38cece";
const actualLatexSha = createHash("sha256")
  .update(readFileSync(fileURLToPath(new URL("./latex.ts", import.meta.url))))
  .digest("hex");
if (actualLatexSha !== EXPECTED_LATEX_SHA) {
  throw new Error(`latex.ts copy is ${actualLatexSha}, expected ${EXPECTED_LATEX_SHA}`);
}

const repoRoot = fileURLToPath(new URL("./../../../../", import.meta.url));
const units = (value) => Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));

// Baseline fixtures from git (the working-tree copy may hold a prior partial
// regeneration); read-only git access.
const fixtures = JSON.parse(
  execFileSync("git", ["show", "HEAD:src/tui/latex/fixtures.json"], {
    cwd: repoRoot,
    maxBuffer: 1 << 28,
  }).toString("utf8"),
);

let updatedCases = 0;
let numericCases = 0;
for (const row of fixtures.cases) {
  const previous = row.expected ?? null;
  const rendered = renderLatex(row.source, { display: row.display });
  delete row.expectedUtf16;
  if (rendered === undefined) {
    if (previous !== null) updatedCases += 1;
    row.expected = null;
    continue;
  }
  if (rendered.isWellFormed()) {
    if (previous !== rendered) updatedCases += 1;
    row.expected = rendered;
  } else {
    // Lone surrogates: transport as numeric UTF-16 units.
    const nextUnits = units(rendered);
    updatedCases += 1;
    row.expectedUtf16 = nextUnits;
    delete row.expected;
    numericCases += 1;
  }
}
const fixturesPath = repoRoot + "src/tui/latex/fixtures.json";
writeFileSync(fixturesPath, JSON.stringify(fixtures, null, 2) + "\n");

// ---- utf16-fixtures.json ----------------------------------------------------
const rawPath = repoRoot + "src/tui/latex/utf16-fixtures.json";
const raw = JSON.parse(readFileSync(rawPath, "utf8"));
let updatedRaw = 0;
for (const row of raw.rawCases) {
  const source = String.fromCodePoint(...row.sourceUtf16);
  const rendered = renderLatex(source, { display: row.display });
  const expectedUnits = rendered === undefined ? null : units(rendered);
  if (JSON.stringify(row.expectedUtf16 ?? null) !== JSON.stringify(expectedUnits)) {
    row.expectedUtf16 = expectedUnits;
    updatedRaw += 1;
  }
  const terminal = rendered === undefined ? null : Buffer.from(rendered, "utf8").toString("utf8");
  if ((row.expectedTerminalUtf8 ?? null) !== terminal) {
    row.expectedTerminalUtf8 = terminal;
  }
}
writeFileSync(rawPath, JSON.stringify(raw, null, 2) + "\n");

console.log(
  JSON.stringify(
    {
      updatedCases,
      numericCases,
      updatedRaw,
      fixturesSha256: createHash("sha256").update(readFileSync(fixturesPath)).digest("hex"),
      rawFixturesSha256: createHash("sha256").update(readFileSync(rawPath)).digest("hex"),
      latexSha256: actualLatexSha,
      node: process.version,
    },
    null,
    1,
  ),
);
