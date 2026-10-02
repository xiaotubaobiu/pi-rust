// Oracle stub for the coding-agent session-manager module: compaction.ts
// imports `buildSessionProjection`/`sessionEntryToContextMessages` for its
// own compaction flows, which the bug-report scenarios never reach (they
// exercise estimateTokens / getSummarizationFailure / completeSummarization
// with a stub streamFn). bug-report.ts itself imports only types from the
// session manager, which --experimental-strip-types erases. The stubs throw
// so any accidental reach fails loudly.
export function buildSessionProjection() {
  throw new Error("oracle stub: session-manager.buildSessionProjection is unreachable");
}
export function sessionEntryToContextMessages() {
  throw new Error("oracle stub: session-manager.sessionEntryToContextMessages is unreachable");
}
