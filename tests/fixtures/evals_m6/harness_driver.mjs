import { resolveModelSelection, verifySystemPrompt, DOCUMENTATION_EVAL_TOOLS, resolveDocumentationVariant, excludePiDocumentation } from "./harness_copy.ts";
import { writeFileSync } from "node:fs";
const out = {};
out.tools = DOCUMENTATION_EVAL_TOOLS;
out.sel1 = resolveModelSelection({ provider: "anthropic", id: "claude-opus-4-6" }, { PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-sol" });
out.sel2 = resolveModelSelection(undefined, { PI_PROVIDER: " openai-codex ", PI_MODEL: " gpt-5.6-sol " });
for (const env of [{}, { PI_PROVIDER: "openai-codex" }, { PI_MODEL: "gpt-5.6-sol" }]) {
  try { resolveModelSelection(undefined, env); out.selErrs = out.selErrs ?? []; out.selErrs.push(null); }
  catch (e) { (out.selErrs ??= []).push(String(e.message)); }
}
out.variants = ["without_docs", "with_docs"].map((v) => resolveDocumentationVariant(v));
for (const v of [undefined, "", "other"]) {
  try { resolveDocumentationVariant(v); (out.variantErrs ??= []).push(null); }
  catch (e) { (out.variantErrs ??= []).push(String(e.message)); }
}
const prompt = "Preamble\n<rules>\nrule one\n</rules>\n<docs>\nPi documentation (read only)\ndocs/models.md\nmore docs lines\n</docs>\n<cwd>\n/workspace\n</cwd>\n";
out.stripped = excludePiDocumentation(prompt);
out.verifyOk = verifySystemPrompt(out.stripped, { name: "without_docs", expectedPiDocumentation: false });
out.verifyWith = verifySystemPrompt(prompt, { name: "with_docs", expectedPiDocumentation: true });
try { verifySystemPrompt(prompt, { name: "without_docs", expectedPiDocumentation: false }); out.verifyErr1 = null; }
catch (e) { out.verifyErr1 = String(e.message); }
try { verifySystemPrompt(out.stripped, { name: "with_docs", expectedPiDocumentation: true }); out.verifyErr2 = null; }
catch (e) { out.verifyErr2 = String(e.message); }
try { verifySystemPrompt("no rules", { name: "n", expectedPiDocumentation: false }); out.verifyErr3 = null; }
catch (e) { out.verifyErr3 = String(e.message); }
try { excludePiDocumentation("Instructions"); out.excludeErr1 = null; }
catch (e) { out.excludeErr1 = String(e.message); }
try { excludePiDocumentation("\n<docs>\nPi documentation\n</docs>"); out.excludeErr2 = null; }
catch (e) { out.excludeErr2 = String(e.message); }
// passthrough when expectedPiDocumentation is undefined
out.verifyPassthrough = verifySystemPrompt("anything", { name: "n" });
writeFileSync("oracle/harness.json", JSON.stringify(out, null, 2) + "\n");
