// Oracle capture: upstream coding-agent src/core/messages.ts under node.
const mod = await import(new URL("./src/core/messages.ts", import.meta.url));
const {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  bashExecutionToText,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
  convertToLlm,
} = mod;

const bashCases = [
  { name: "no_output", msg: { role: "bashExecution", command: "ls", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } },
  { name: "with_output", msg: { role: "bashExecution", command: "echo hi", output: "hi", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } },
  { name: "multiline_output", msg: { role: "bashExecution", command: "cat f", output: "a\nb", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } },
  { name: "cancelled", msg: { role: "bashExecution", command: "sleep 100", output: "partial", exitCode: undefined, cancelled: true, truncated: false, timestamp: 1 } },
  { name: "nonzero_exit", msg: { role: "bashExecution", command: "false", output: "", exitCode: 1, cancelled: false, truncated: false, timestamp: 1 } },
  { name: "zero_exit_code_explicit", msg: { role: "bashExecution", command: "true", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } },
  { name: "null_exit_code", msg: { role: "bashExecution", command: "x", output: "", exitCode: null, cancelled: false, truncated: false, timestamp: 1 } },
  { name: "truncated_with_path", msg: { role: "bashExecution", command: "big", output: "lots", exitCode: 0, cancelled: false, truncated: true, fullOutputPath: "/tmp/out.txt", timestamp: 1 } },
  { name: "truncated_without_path", msg: { role: "bashExecution", command: "big", output: "lots", exitCode: 0, cancelled: false, truncated: true, timestamp: 1 } },
  { name: "cancelled_and_nonzero", msg: { role: "bashExecution", command: "y", output: "", exitCode: 130, cancelled: true, truncated: false, timestamp: 1 } },
];
const bashTexts = bashCases.map(({ name, msg }) => ({ name, msg, text: bashExecutionToText(msg) }));

const branchMessage = createBranchSummaryMessage("We came back.", "node-42", "2026-01-02T03:04:05.678Z");
const compactionMessage = createCompactionSummaryMessage("Earlier stuff.", 12345, "2026-01-02T03:04:05.678Z");
const customString = createCustomMessage("my-plugin/status", "hello custom", true, undefined, "2026-01-02T03:04:05.678Z");
const customBlocks = createCustomMessage(
  "my-plugin/rich",
  [{ type: "text", text: "rich" }],
  false,
  { attempt: 2 },
  "2026-01-02T03:04:05.678Z",
);

const assistantFixture = {
  role: "assistant",
  content: [],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude",
  usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
  stopReason: "stop",
  timestamp: 1767337445678,
};
const userFixture = { role: "user", content: "plain question", timestamp: 1767337445000 };
const systemFixture = { role: "system", content: "be helpful", timestamp: 1767337444000 };
const toolResultFixture = { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "out" }], isError: false, timestamp: 1767337446000 };

const mixedInput = [
  { role: "bashExecution", command: "hidden", output: "x", exitCode: 0, cancelled: false, truncated: false, timestamp: 11, excludeFromContext: true },
  { role: "bashExecution", command: "shown", output: "", exitCode: 2, cancelled: false, truncated: false, timestamp: 12 },
  customString,
  customBlocks,
  branchMessage,
  compactionMessage,
  userFixture,
  assistantFixture,
  systemFixture,
  toolResultFixture,
  { role: "custom", customType: "unknown-kind", content: "mystery", display: true, timestamp: 13 },
];
const converted = convertToLlm(mixedInput);

const out = {
  constants: {
    COMPACTION_SUMMARY_PREFIX,
    COMPACTION_SUMMARY_SUFFIX,
    BRANCH_SUMMARY_PREFIX,
    BRANCH_SUMMARY_SUFFIX,
  },
  bashTexts,
  created: { branchMessage, compactionMessage, customString, customBlocks },
  convertedJson: JSON.stringify(converted),
  convertedRoles: converted.map((m) => m.role),
};
const target = new URL("./messages.oracle.json", import.meta.url);
const { writeFileSync } = await import("node:fs");
writeFileSync(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
console.log("wrote", target, "converted:", converted.length);
