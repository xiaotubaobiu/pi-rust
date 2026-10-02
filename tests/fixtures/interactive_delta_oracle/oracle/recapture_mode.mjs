// Focused re-capture of the cli_mode_diagnostics scenario against the
// verbatim upstream parseArgs (args.ts, SHA in manifest). The lost original
// driver accumulated diagnostics across runs into one shared result object
// (artifact); this driver isolates each case.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Stub the config/config-deps that args.ts imports but the scenario ignores.
const chalkStub = { default: { yellow: (s) => s, bold: (s) => s, red: (s) => s } };
const configStub = {
  APP_NAME: "pi",
  CONFIG_DIR_NAME: ".pi",
  ENV_AGENT_DIR: "PI_CODING_AGENT_DIR",
  ENV_SESSION_DIR: "PI_SESSION_DIR",
};
const loadWith = (source) => {
  const patched = source
    .replaceAll('"chalk"', JSON.stringify("./chalk-stub.ts"))
    .replaceAll('"../config.ts"', JSON.stringify("./config-stub.ts"))
    .replaceAll('"@earendil-works/pi-agent-core"', JSON.stringify("./types-stub.ts"))
    .replaceAll('"../core/extensions/types.ts"', JSON.stringify("./types-stub.ts"))
    .replaceAll('"../core/settings-manager.ts"', JSON.stringify("./types-stub.ts"));
  return patched;
};
writeFileSync("cli-copy/chalk-stub.ts", "const chalk = { yellow: (s) => s, bold: (s) => s, red: (s) => s, blue: (s) => s, green: (s) => s, gray: (s) => s, dim: (s) => s, cyan: (s) => s };\nexport default chalk;\n");
writeFileSync("cli-copy/config-stub.ts", "export const APP_NAME = \"pi\";\nexport const CONFIG_DIR_NAME = \".pi\";\nexport const ENV_AGENT_DIR = \"PI_CODING_AGENT_DIR\";\nexport const ENV_SESSION_DIR = \"PI_SESSION_DIR\";\n");
writeFileSync("cli-copy/types-stub.ts", "export type ThinkingLevel = \"off\" | \"minimal\" | \"low\" | \"medium\" | \"high\" | \"xhigh\" | \"max\";\nexport type ExtensionFlag = { name: string };\nexport type TuiMode = \"interactive\" | \"print\";\n");

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = readFileSync("cli-copy/args.ts", "utf8");
writeFileSync("cli-copy/args-patched.ts", loadWith(source));

const { parseArgs } = await import("./cli-copy/args-patched.ts");

const CASES = [
  { name: "missing value", argv: ["--mode"] },
  { name: "flag-like value", argv: ["--mode", "-x"] },
  { name: "invalid value", argv: ["--mode", "bogus"] },
  { name: "rpc", argv: ["--mode", "rpc"] },
  { name: "text then extra", argv: ["--mode", "text", "extra"] },
];
const cases = CASES.map((c) => {
  const result = parseArgs([...c.argv]);
  return { name: c.name, argv: c.argv, result };
});
const out = {
  scenario: "cli_mode_diagnostics",
  cases,
  manifest: { "cli/args.ts": sha(readFileSync("cli-copy/args.ts")) },
};
writeFileSync("cli_mode_recapture.json", JSON.stringify(out, null, "\t") + "\n");
console.log("captured", cases.length, "mode cases");
for (const c of cases) {
  console.log(c.name, JSON.stringify(c.result.diagnostics?.map((d) => d.message)));
}
