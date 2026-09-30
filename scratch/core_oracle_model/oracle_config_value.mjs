// Oracle capture: upstream coding-agent src/core/resolve-config-value.ts
// under node (--experimental-strip-types). The captured source is a verbatim
// copy; it only depends on node builtins + utils/shell.ts (copied verbatim).
//
// Live shell-command *execution* is platform/shell dependent and is not
// byte-pinned; the failing-command error text (deterministic regardless of
// which failure channel fires) and all template parsing/resolution are.
//
// Structured values are captured as canonical JSON (recursively key-sorted)
// so the Rust port can compare byte-for-byte against serde_json's sorted-key
// output.
import { writeFileSync } from "node:fs";
import * as mod from "./src/core/resolve-config-value.ts";

const canonical = (value) => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

const results = {};

// --- env var name extraction ------------------------------------------------
const values = [
  "sk-literal",
  "$MY_VAR",
  "${MY_VAR}",
  "$MY_VAR suffix",
  "prefix-$A1-b-$C",
  "${A}${B}",
  "$$escaped $!bang",
  "${not valid}",
  "$1invalid",
  "${A",
  "$",
  "",
  "!command --flag",
  "!$CMD_VAR",
];
results.envVarNames = values.map((value) => ({
  value,
  single: mod.getConfigValueEnvVarName(value),
  names: mod.getConfigValueEnvVarNames(value),
  isCommand: mod.isCommandConfigValue(value),
}));
results.missingEnv = [
  { value: "$A:$B", env: { A: "a" }, missing: mod.getMissingConfigValueEnvVarNames("$A:$B", { A: "a" }) },
  { value: "$A:$B", env: undefined, missing: mod.getMissingConfigValueEnvVarNames("$A:$B") },
  { value: "lit", env: {}, missing: mod.getMissingConfigValueEnvVarNames("lit") },
];
results.isConfigured = [
  { value: "$A", env: { A: "x" }, configured: mod.isConfigValueConfigured("$A", { A: "x" }) },
  { value: "$A", env: {}, configured: mod.isConfigValueConfigured("$A", {}) },
  // Empty-string env value: `env?.[name] || process.env[name]` treats "" as unset
  // unless the process env also has it; with a process value present the empty
  // explicit entry falls through to it.
  { value: "$A", env: { A: "" }, configured: mod.isConfigValueConfigured("$A", { A: "" }) },
];

// --- resolution -------------------------------------------------------------
const env = { A: "alpha", B: "beta", EMPTY: "" };
results.resolve = [
  { value: "literal", env, resolved: mod.resolveConfigValue("literal", env) },
  { value: "$A-$B", env, resolved: mod.resolveConfigValue("$A-$B", env) },
  { value: "${A}_${B}", env, resolved: mod.resolveConfigValue("${A}_${B}", env) },
  { value: "$$A $!B", env, resolved: mod.resolveConfigValue("$$A $!B", env) },
  { value: "$MISSING", env, resolved: mod.resolveConfigValue("$MISSING", env) },
  { value: "$EMPTY", env, resolved: mod.resolveConfigValue("$EMPTY", env) },
  { value: "$A", env: undefined, resolved: mod.resolveConfigValue("$A", undefined) },
  { value: "${bad name}", env, resolved: mod.resolveConfigValue("${bad name}", env) },
  { value: "$1x", env, resolved: mod.resolveConfigValue("$1x", env) },
  { value: "${A", env, resolved: mod.resolveConfigValue("${A", env) },
  { value: "a$b$c", env: { b: "B", c: "C" }, resolved: mod.resolveConfigValue("a$b$c", { b: "B", c: "C" }) },
];

// env overlay wins over process env (only when non-empty).
process.env.ORACLE_PENV = "process-value";
results.resolve.push({ value: "$ORACLE_PENV", env: { ORACLE_PENV: "overlay" }, resolved: mod.resolveConfigValue("$ORACLE_PENV", { ORACLE_PENV: "overlay" }) });
results.resolve.push({ value: "$ORACLE_PENV", env: undefined, resolved: mod.resolveConfigValue("$ORACLE_PENV", undefined) });
delete process.env.ORACLE_PENV;

// --- orThrow error texts ----------------------------------------------------
function orThrow(value, description, envOverlay) {
  try {
    return { ok: true, value: mod.resolveConfigValueOrThrow(value, description, envOverlay) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
results.orThrow = [
  { value: "$MISSING", description: "API key for provider \"p\"", env: {} },
  { value: "$M1:$M2", description: "API key for provider \"p\"", env: {} },
  { value: "literal", description: "API key for provider \"p\"", env: {} },
  { value: "!oracle-missing-command-xyz", description: "API key for provider \"p\"", env: {} },
  { value: "$MISSING", description: "provider \"p\" header \"x-a\"", env: {} },
].map(({ value, description, env: envOverlay }) => ({ value, description, ...orThrow(value, description, envOverlay) }));

// --- headers ----------------------------------------------------------------
const headers = { "x-a": "$A", "x-lit": "lit", "x-b": "$B" };
results.resolveHeaders = [
  { headers, env: { A: "1", B: "2" }, resolved: mod.resolveHeaders(headers, { A: "1", B: "2" }) },
  { headers: { "x-a": "$MISSING" }, env: {}, resolved: mod.resolveHeaders({ "x-a": "$MISSING" }, {}) },
  { headers: { "x-empty": "" }, env: {}, resolved: mod.resolveHeaders({ "x-empty": "" }, {}) },
  { headers: undefined, env: {}, resolved: mod.resolveHeaders(undefined, {}) },
];
results.resolveHeadersOrThrow = [
  { headers, env: { A: "1", B: "2" }, ...orThrowHeaders(headers, "model \"p/m\"", { A: "1", B: "2" }) },
  { headers: { "x-a": "$MISSING" }, env: {}, ...orThrowHeaders({ "x-a": "$MISSING" }, "model \"p/m\"", {}) },
];
function orThrowHeaders(input, description, envOverlay) {
  try {
    return { ok: true, value: mod.resolveHeadersOrThrow(input, description, envOverlay) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Failing-command error text is deterministic across the two failure channels
// (configured shell vs fallback exec): both yield undefined -> throw.
results.commandError = orThrow("!oracle-definitely-missing-binary", "header \"x-c\"", {});

writeFileSync(new URL("./resolve_config_value.oracle.json", import.meta.url), canonical(results) + "\n");
console.log("resolve_config_value oracle written:", Object.keys(results).join(","));
