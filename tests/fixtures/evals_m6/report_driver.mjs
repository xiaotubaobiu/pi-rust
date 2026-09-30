import { summarizeEvalObservations, formatEvalComparisonReport, classifyCaseStatus, erroredObservation } from "./report_copy.ts";
import { writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
function scored(variant, runNumber, score, metrics = {}) {
  return { evalSet: "tool access", caseId: "create", variant, model: "fixture/model", runNumber,
    outcome: "scored", score, totalTokens: 100, toolCalls: 2, totalMs: 1000, estimatedCostUsd: 0.01, ...metrics };
}
function errored(variant, runNumber, totalTokens) {
  return { evalSet: "tool access", caseId: "create", variant, model: "fixture/model", runNumber, outcome: "errored", ...(totalTokens !== undefined ? { totalTokens } : {}) };
}
function expectedFor(runNumbers) {
  return runNumbers.flatMap((runNumber) => ["without_docs", "with_docs"].map((variant) => ({
    evalSet: "tool access", caseId: "create", variant, model: "fixture/model", runNumber })));
}
const out = {};
const r1 = summarizeEvalObservations("digest", expectedFor([1, 2]), [
  scored("without_docs", 1, 0, { totalTokens: 100, toolCalls: 3, totalMs: 1000 }),
  scored("with_docs", 1, 1, { totalTokens: 120, toolCalls: 2, totalMs: 800 }),
  scored("without_docs", 2, 1, { totalTokens: 200 }),
  scored("with_docs", 2, 1, { totalTokens: 180 }),
]);
out.report1 = r1;
out.formatted1 = formatEvalComparisonReport(r1);
const r2 = summarizeEvalObservations("digest", expectedFor([1, 2]), [
  scored("without_docs", 1, 0), errored("with_docs", 1, 120), scored("without_docs", 2, 1, { totalTokens: 200 }),
]);
out.report2 = r2;
out.formatted2 = formatEvalComparisonReport(r2);
const withoutTokens = scored("without_docs", 1, 1); delete withoutTokens.totalTokens;
const r3 = summarizeEvalObservations("digest", expectedFor([1]), [
  withoutTokens, structuredClone(withoutTokens), scored("with_docs", 1, 1, { totalTokens: 0 })]);
out.report3 = r3;
out.formatted3 = formatEvalComparisonReport(r3);
const r4 = summarizeEvalObservations("digest", expectedFor([1, 2]), [scored("without_docs", 1, 1), scored("with_docs", 1, 1)]);
out.report4 = r4;
out.formatted4 = stripVTControlCharacters(formatEvalComparisonReport(r4));
// empty report formats to ""
out.formattedEmpty = JSON.stringify(formatEvalComparisonReport(summarizeEvalObservations("d", [], [])));
// number formatting extremes through the public surface
const r5 = summarizeEvalObservations("digest", expectedFor([1]), [
  scored("without_docs", 1, 0.1234567890123456, { totalTokens: 1, toolCalls: 0, totalMs: 333.3, estimatedCostUsd: 0.00015 }),
  scored("with_docs", 1, 1, { totalTokens: 2, toolCalls: 1, totalMs: 666.7, estimatedCostUsd: 0.00025 }),
]);
out.report5 = r5;
out.formatted5 = formatEvalComparisonReport(r5);
out.classify = ["failed", "skipped", "todo", "disabled", "pending", "passed"].map(classifyCaseStatus);
out.erroredObs = erroredObservation({ file: "f", fullName: "A > b", evalSet: "A", caseId: "b", variant: "with_docs", model: "m/n", runNumber: 7 });
writeFileSync("oracle/report.json", JSON.stringify(out, null, 2) + "\n");
writeFileSync("oracle/report_formatted.txt", out.formatted1 + "\n---\n" + out.formatted2 + "\n---\n" + out.formatted3 + "\n---\n" + out.formatted5);
