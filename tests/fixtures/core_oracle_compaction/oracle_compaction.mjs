// Oracle capture: upstream coding-agent src/core/compaction/ under node
// (--experimental-strip-types). The captured sources are verbatim copies;
// `@earendil-works/pi-ai` re-exports the real upstream implementations of
// contentText/normalizeContext/retryAssistantCall/uuidv7 (see
// node_modules/@earendil-works/pi-ai/), and the LLM transport is a scripted
// fake StreamFn capturing every (context, options) pair.
//
// Structured values are captured as canonical JSON (recursively key-sorted,
// JSON.stringify defaults) so the Rust port can compare byte-for-byte against
// serde_json's sorted-key output. Timestamps and abort signals are scrubbed
// (they are wall-clock/transport values, not algorithm output).

const mod = await import(new URL("./src/core/compaction/index.ts", import.meta.url));
const {
  DEFAULT_COMPACTION_SETTINGS,
  calculateContextTokens,
  getLastAssistantUsage,
  estimateContextTokens,
  estimateTokens,
  shouldCompact,
  findCutPoint,
  findTurnStartIndex,
  prepareCompaction,
  compact,
  generateSummary,
  generateSummaryWithUsage,
  completeSummarization,
  getSummarizationFailure,
  generateBranchSummary,
  prepareBranchEntries,
  serializeConversation,
  computeFileLists,
  formatFileOperations,
  extractFileOpsFromMessage,
  createFileOps,
  SUMMARIZATION_SYSTEM_PROMPT,
} = mod;

// ---- canonicalization helpers ------------------------------------------

const canon = (value) => {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canon(value[key]);
    return out;
  }
  return value;
};
const j = (value) => JSON.stringify(canon(value));

const scrubContext = (context) =>
  JSON.parse(
    JSON.stringify({ messages: context.messages }, (key, value) =>
      key === "timestamp" ? "<ts>" : value,
    ),
  );
// Fresh routing ids come from uuidv7() (nondeterministic): keep caller-set
// session ids verbatim, normalize fresh ones to a shape marker.
const DETERMINISTIC_SESSION_IDS = new Set(["route-1", "current-routing-session"]);
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const scrubOptions = (options) => {
  const { signal, ...rest } = options;
  void signal;
  if (typeof rest.sessionId === "string" && !DETERMINISTIC_SESSION_IDS.has(rest.sessionId)) {
    rest.sessionId = UUID_V7_RE.test(rest.sessionId) ? "<uuid-v7>" : "<unexpected-session-id>";
  }
  return JSON.parse(JSON.stringify(rest));
};

// ---- fixtures -----------------------------------------------------------

const model = {
  id: "test-model",
  name: "Test Model",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const USAGE_ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const TS = 1767337445678;

function mockUsage(input, output, cacheRead = 0, cacheWrite = 0) {
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { ...USAGE_ZERO_COST } };
}
function userMessage(text, timestamp = TS) {
  return { role: "user", content: text, timestamp };
}
function assistantMessage(text, usage) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: usage ?? mockUsage(100, 50),
    stopReason: "stop",
    timestamp: TS,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  };
}
function textResponse(text, overrides = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: mockUsage(10, 10),
    stopReason: "stop",
    timestamp: TS,
    ...overrides,
  };
}

// ---- session entry builders (fixed ids + ISO timestamps) ---------------

let entryCounter = 0;
let lastId = null;
function resetEntries() {
  entryCounter = 0;
  lastId = null;
}
const STAMP = "2026-01-02T03:04:05.000Z";
function baseEntry() {
  const id = `t-${entryCounter++}`;
  const entry = { id, parentId: lastId, timestamp: STAMP };
  lastId = id;
  return entry;
}
function messageEntry(message) {
  return { type: "message", ...baseEntry(), message };
}
function compactionEntry(summary, firstKeptEntryId, extra = {}) {
  return {
    type: "compaction",
    ...baseEntry(),
    summary,
    firstKeptEntryId,
    tokensBefore: 10000,
    ...extra,
  };
}
function customMessageEntry(content) {
  return { type: "custom_message", ...baseEntry(), customType: "test", content, display: true };
}
function labelEntry(targetId, label) {
  return { type: "label", ...baseEntry(), targetId, label };
}
function modelChangeEntry(provider, modelId) {
  return { type: "model_change", ...baseEntry(), provider, modelId };
}
function thinkingLevelEntry(thinkingLevel) {
  return { type: "thinking_level_change", ...baseEntry(), thinkingLevel };
}

// ---- scripted LLM transport ---------------------------------------------

function makeStreamFn(responses, calls) {
  return (_m, context, options) => {
    calls.push({ context: scrubContext(context), options: scrubOptions(options) });
    const response = responses[calls.length - 1];
    if (!response) throw new Error(`oracle: no scripted response for call ${calls.length}`);
    return { result: async () => (typeof response === "function" ? response(calls.length) : response) };
  };
}
const NO_STREAM = undefined;

// =========================================================================
// Captures
// =========================================================================

const out = {};

// ---- constants ----------------------------------------------------------

out.constants = {
  summarizationSystemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
  defaultSettings: DEFAULT_COMPACTION_SETTINGS,
};

// ---- utils: file ops ----------------------------------------------------

{
  const ops = createFileOps();
  extractFileOpsFromMessage(assistantMessage("x"), ops); // text-only: nothing
  extractFileOpsFromMessage(userMessage("y"), ops); // non-assistant: nothing
  extractFileOpsFromMessage(
    {
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
        { type: "toolCall", id: "c2", name: "write", arguments: { path: "src/b.ts" } },
        { type: "toolCall", id: "c3", name: "edit", arguments: { path: "src/c.ts" } },
        { type: "toolCall", id: "c4", name: "grep", arguments: { path: "src/d.ts" } }, // unknown tool
        { type: "toolCall", id: "c5", name: "read", arguments: {} }, // no path
        { type: "toolCall", id: "c6", name: "read" }, // no arguments
        { type: "toolCall", id: "c7", name: "read", arguments: { path: 42 } }, // non-string path
      ],
      usage: mockUsage(1, 1),
      stopReason: "toolUse",
      timestamp: TS,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
    },
    ops,
  );
  extractFileOpsFromMessage(
    { role: "assistant", content: [{ type: "toolCall", id: "c8", name: "read", arguments: { path: "src/e.ts" } }], usage: mockUsage(1, 1), stopReason: "toolUse", timestamp: TS, api: "a", provider: "p", model: "m" },
    ops,
  );
  out.fileOps = {
    opsJson: j({ read: [...ops.read].sort(), written: [...ops.written].sort(), edited: [...ops.edited].sort() }),
    lists: computeFileLists(ops),
    listsJson: j(computeFileLists(ops)),
    formattedBoth: formatFileOperations(["README.md", "src/a.ts"], ["src/b.ts", "src/c.ts"]),
    formattedRead: formatFileOperations(["only-read.txt"], []),
    formattedModified: formatFileOperations([], ["changed.txt"]),
    formattedNone: formatFileOperations([], []),
  };
}

// ---- utils: serializeConversation ---------------------------------------

{
  const toolResult = (text) => ({
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: TS,
  });
  const long = "x".repeat(5000);
  const longY = "y".repeat(5000);
  out.serialize = {
    longToolResult: serializeConversation([toolResult(long)]),
    shortToolResult: serializeConversation([toolResult("x".repeat(1500))]),
    exactBoundary: serializeConversation([toolResult("x".repeat(2000))]),
    overBoundary: serializeConversation([toolResult("x".repeat(2001))]),
    userAndAssistantLong: serializeConversation([
      { role: "user", content: [{ type: "text", text: longY }], timestamp: TS },
      {
        role: "assistant",
        content: [{ type: "text", text: longY }],
        api: "anthropic",
        provider: "anthropic",
        model: "test",
        usage: mockUsage(0, 0),
        stopReason: "stop",
        timestamp: TS,
      },
    ]),
    assistantThinkingToolCalls: serializeConversation([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Thought A" },
          { type: "text", text: "Answer" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
          { type: "toolCall", id: "t2", name: "edit", arguments: { a: 1, b: "x" } },
        ],
        api: "anthropic",
        provider: "anthropic",
        model: "test",
        usage: mockUsage(0, 0),
        stopReason: "stop",
        timestamp: TS,
      },
    ]),
    emptyUserContentSkipped: serializeConversation([
      { role: "user", content: "", timestamp: TS },
      { role: "user", content: [{ type: "text", text: "visible" }], timestamp: TS },
    ]),
    joinedWithBlankLines: serializeConversation([
      { role: "user", content: "one", timestamp: TS },
      toolResult("out"),
      { role: "user", content: "two", timestamp: TS },
    ]),
    empty: serializeConversation([]),
  };
}

// ---- token calculation ---------------------------------------------------

out.tokenCalc = {
  calculate: [
    calculateContextTokens(mockUsage(1000, 500, 200, 100)),
    calculateContextTokens(mockUsage(0, 0, 0, 0)),
    calculateContextTokens({ ...mockUsage(100, 10), totalTokens: 555 }),
  ],
};

// ---- getLastAssistantUsage ------------------------------------------------

function usageScenarios() {
  const scenarios = {};
  resetEntries();
  scenarios.last_non_aborted = [
    messageEntry(userMessage("Hello")),
    messageEntry(assistantMessage("Hi", mockUsage(100, 50))),
    messageEntry(userMessage("How are you?")),
    messageEntry(assistantMessage("Good", mockUsage(200, 100))),
  ];
  resetEntries();
  scenarios.skips_aborted = [
    messageEntry(userMessage("Hello")),
    messageEntry(assistantMessage("Hi", mockUsage(100, 50))),
    messageEntry(userMessage("How are you?")),
    messageEntry(assistantMessage("Aborted", mockUsage(300, 150))),
  ];
  scenarios.skips_aborted[3].message = { ...scenarios.skips_aborted[3].message, stopReason: "aborted" };
  resetEntries();
  scenarios.skips_all_zero = [
    messageEntry(userMessage("Hello")),
    messageEntry(assistantMessage("Hi", mockUsage(100, 50))),
    messageEntry(userMessage("continue")),
    messageEntry(assistantMessage("Partial", mockUsage(0, 0))),
  ];
  resetEntries();
  scenarios.error_stop_skipped = [
    messageEntry(assistantMessage("Bad", mockUsage(400, 40))),
    messageEntry(assistantMessage("Err", mockUsage(500, 50))),
  ];
  scenarios.error_stop_skipped[1].message = { ...scenarios.error_stop_skipped[1].message, stopReason: "error", errorMessage: "boom" };
  resetEntries();
  scenarios.no_assistant = [messageEntry(userMessage("Hello"))];
  resetEntries();
  scenarios.includes_non_message_entries = [
    messageEntry(assistantMessage("A", mockUsage(111, 11))),
    labelEntry("t-0", "mark"),
    messageEntry(userMessage("q")),
  ];
  return scenarios;
}
{
  const scenarios = usageScenarios();
  const captured = {};
  for (const [name, entries] of Object.entries(scenarios)) {
    const usage = getLastAssistantUsage(entries);
    captured[name] = usage === undefined ? null : usage;
  }
  out.lastAssistantUsage = captured;
}

// ---- estimateContextTokens / estimateTokens --------------------------------

{
  const messages = [
    userMessage("Hello"),
    assistantMessage("Hi", mockUsage(100, 50)),
    userMessage("continue"),
    assistantMessage("Partial thinking", mockUsage(0, 0)),
  ];
  const estimate = estimateContextTokens(messages);
  out.estimateContextTokens = {
    anchored: estimate,
    anchoredJson: j(estimate),
    noUsage: estimateContextTokens([userMessage("only"), assistantMessage("zero", mockUsage(0, 0))]),
    empty: estimateContextTokens([]),
  };
  out.estimateTokens = {
    userString: estimateTokens(userMessage("12345678")),
    userBlocks: estimateTokens({ role: "user", content: [{ type: "text", text: "12345678" }, { type: "image", data: "aaaa", mimeType: "image/png" }], timestamp: TS }),
    assistantBlocks: estimateTokens(
      {
        role: "assistant",
        content: [
          { type: "text", text: "12345678" },
          { type: "thinking", thinking: "1234" },
          { type: "toolCall", id: "t", name: "read", arguments: { path: "a.txt" } },
        ],
        usage: mockUsage(0, 0),
        stopReason: "stop",
        timestamp: TS,
        api: "a",
        provider: "p",
        model: "m",
      },
    ),
    toolResult: estimateTokens({
      role: "toolResult",
      toolCallId: "t",
      toolName: "read",
      content: [{ type: "text", text: "12345678" }, { type: "image", data: "bbbb", mimeType: "image/png" }],
      isError: false,
      timestamp: TS,
    }),
    bashExecution: estimateTokens({ role: "bashExecution", command: "ls -la", output: "total 0", exitCode: 0, cancelled: false, truncated: false, timestamp: TS }),
    branchSummary: estimateTokens({ role: "branchSummary", summary: "12345678", fromId: null, timestamp: TS }),
    compactionSummary: estimateTokens({ role: "compactionSummary", summary: "1234", tokensBefore: 5, timestamp: TS }),
    custom: estimateTokens({ role: "custom", customType: "x", content: "12345678", display: true, timestamp: TS }),
    system: estimateTokens({ role: "system", content: "12345678", timestamp: TS }),
  };
}

// ---- shouldCompact ----------------------------------------------------------

out.shouldCompact = [
  shouldCompact(95000, 100000, { enabled: true, reserveTokens: 10000, keepRecentTokens: 20000 }),
  shouldCompact(89000, 100000, { enabled: true, reserveTokens: 10000, keepRecentTokens: 20000 }),
  shouldCompact(95000, 100000, { enabled: false, reserveTokens: 10000, keepRecentTokens: 20000 }),
  shouldCompact(89999, 100000, { enabled: true, reserveTokens: 10000, keepRecentTokens: 20000 }),
  shouldCompact(90000, 100000, { enabled: true, reserveTokens: 10000, keepRecentTokens: 20000 }),
  shouldCompact(90001, 100000, { enabled: true, reserveTokens: 10000, keepRecentTokens: 20000 }),
];

// ---- findCutPoint / findTurnStartIndex --------------------------------------

{
  // Char-heavy messages so the keepRecentTokens budget actually crosses
  // (estimateTokens is a chars/4 heuristic; provider usage is irrelevant here).
  const filler = (text, size) => text + " ".repeat(Math.max(0, size - text.length));
  resetEntries();
  const tokenDiff = [];
  for (let i = 0; i < 10; i++) {
    tokenDiff.push(messageEntry(userMessage(filler(`User ${i}`, 800))));
    tokenDiff.push(messageEntry(assistantMessage(filler(`Assistant ${i}`, 800), mockUsage(0, 100, (i + 1) * 1000, 0))));
  }
  resetEntries();
  const singleAssistant = [messageEntry(assistantMessage("a"))];
  resetEntries();
  const allFit = [
    messageEntry(userMessage(filler("1", 400))),
    messageEntry(assistantMessage(filler("a", 400), mockUsage(0, 50, 500, 0))),
    messageEntry(userMessage(filler("2", 400))),
    messageEntry(assistantMessage(filler("b", 400), mockUsage(0, 50, 1000, 0))),
  ];
  resetEntries();
  const splitTurn = [
    messageEntry(userMessage(filler("Turn 1", 400))),
    messageEntry(assistantMessage(filler("A1", 400), mockUsage(0, 100, 1000, 0))),
    messageEntry(userMessage(filler("Turn 2", 400))),
    messageEntry(assistantMessage(filler("A2-1", 400), mockUsage(0, 100, 5000, 0))),
    messageEntry(assistantMessage(filler("A2-2", 400), mockUsage(0, 100, 8000, 0))),
    messageEntry(assistantMessage(filler("A2-3", 400), mockUsage(0, 100, 10000, 0))),
  ];
  resetEntries();
  const customBudget = [
    messageEntry(userMessage("hi")),
    messageEntry(assistantMessage("hello")),
    customMessageEntry("x".repeat(4000)),
    messageEntry(assistantMessage("ok")),
  ];
  // Cut lands at the entry after a metadata run; the back-scan must slide the
  // cut index back over the metadata (no context messages) and stop at the
  // tool result.
  resetEntries();
  const metadataScan = [
    messageEntry(userMessage(filler("u1", 1000))),
    messageEntry({ role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: filler("r", 1000) }], isError: false, timestamp: TS }),
    modelChangeEntry("openai", "gpt-4"),
    labelEntry("t-0", "bookmark"),
    messageEntry(userMessage(filler("u2", 1000))),
    messageEntry(assistantMessage(filler("a2", 1000), mockUsage(0, 100, 6000, 0))),
  ];
  resetEntries();
  const toolResultsNeverCut = [
    messageEntry(userMessage(filler("u1", 1000))),
    messageEntry(assistantMessage(filler("a1", 1000), mockUsage(0, 50, 4000, 0))),
    messageEntry({
      role: "toolResult",
      toolCallId: "t",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(9000) }],
      isError: false,
      timestamp: TS,
    }),
    messageEntry(userMessage(filler("u2", 1000))),
  ];

  const cut = (entries, start, end, keep) => findCutPoint(entries, start, end, keep);
  out.findCutPoint = {
    token_diff: cut(tokenDiff, 0, tokenDiff.length, 2500),
    no_valid_cut_points: cut(singleAssistant, 0, singleAssistant.length, 1000),
    all_fit: cut(allFit, 0, allFit.length, 50000),
    split_turn: cut(splitTurn, 0, splitTurn.length, 250),
    tiny_budget_custom: cut(customBudget, 0, customBudget.length, 1),
    custom_fits: cut(customBudget, 0, customBudget.length, 2),
    metadata_back_scan: cut(metadataScan, 0, metadataScan.length, 640),
    tool_results_never_cut: cut(toolResultsNeverCut, 0, toolResultsNeverCut.length, 100),
    zero_keep_budget: cut(allFit, 0, allFit.length, 0),
    range_limited: cut(tokenDiff, 10, tokenDiff.length, 2500),
  };

  out.findTurnStartIndex = {
    mid_turn: findTurnStartIndex(splitTurn, 5, 0),
    at_user: findTurnStartIndex(splitTurn, 2, 0),
    before_start: findTurnStartIndex(splitTurn, 1, 2),
    first_entry: findTurnStartIndex(allFit, 0, 0),
    custom_entry_is_turn_start: findTurnStartIndex(customBudget, 3, 0),
  };
}

// ---- prepareCompaction --------------------------------------------------------

{
  // system-message entries are prompt state, not conversation history
  resetEntries();
  const systemEntry = messageEntry({ role: "system", content: "", sections: { preamble: "current prompt" }, timestamp: TS });
  const userEntry = messageEntry(userMessage("one long turn"));
  const assistantEntry = messageEntry(assistantMessage("assistant suffix"));
  const prep1 = prepareCompaction([systemEntry, userEntry, assistantEntry], { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 });
  out.prepareCompaction = {};
  out.prepareCompaction.system_messages_skipped =
    prep1 === undefined
      ? null
      : {
          firstKeptEntryId: prep1.firstKeptEntryId,
          isSplitTurn: prep1.isSplitTurn,
          tokensBefore: prep1.tokensBefore,
          previousSummary: prep1.previousSummary ?? null,
          summarizeRoles: prep1.messagesToSummarize.map((m) => m.role),
          summarizeJson: j(prep1.messagesToSummarize),
          turnPrefixRoles: prep1.turnPrefixMessages.map((m) => m.role),
          turnPrefixJson: j(prep1.turnPrefixMessages),
          fileOpsJson: j({ read: [...prep1.fileOps.read].sort(), written: [...prep1.fileOps.written].sort(), edited: [...prep1.fileOps.edited].sort() }),
          settings: prep1.settings,
        };
  out.prepareCompaction.system_entry_ids = { system: systemEntry.id, user: userEntry.id, assistant: assistantEntry.id };

  // repeated compaction skipped when kept messages still fit
  resetEntries();
  const r1u1 = messageEntry(userMessage("user msg 1 (summarized by compaction1)"));
  const r1a1 = messageEntry(assistantMessage("assistant msg 1"));
  const r1u2 = messageEntry(userMessage("user msg 2 - kept by compaction1"));
  const r1a2 = messageEntry(assistantMessage("assistant msg 2"));
  const r1u3 = messageEntry(userMessage("user msg 3 - kept by compaction1"));
  const r1a3 = messageEntry(assistantMessage("assistant msg 3", mockUsage(5000, 1000)));
  const compaction1 = compactionEntry("First summary", r1u2.id);
  const r1u4 = messageEntry(userMessage("user msg 4 (new after compaction1)"));
  const r1a4 = messageEntry(assistantMessage("assistant msg 4", mockUsage(8000, 2000)));
  const stillFits = prepareCompaction([r1u1, r1a1, r1u2, r1a2, r1u3, r1a3, compaction1, r1u4, r1a4], DEFAULT_COMPACTION_SETTINGS);
  out.prepareCompaction.fits_returns_undefined = stillFits === undefined ? null : stillFits;

  // re-summarize previously kept messages when the window moves past them
  resetEntries();
  const r2u1 = messageEntry(userMessage("user msg 1 (summarized by compaction1)".repeat(4)));
  const r2a1 = messageEntry(assistantMessage("assistant msg 1".repeat(4)));
  const r2u2 = messageEntry(userMessage("user msg 2 - kept by compaction1 ".repeat(12)));
  const r2a2 = messageEntry(assistantMessage("assistant msg 2 ".repeat(12)));
  const r2u3 = messageEntry(userMessage("user msg 3 - kept by compaction1 ".repeat(12)));
  const r2a3 = messageEntry(assistantMessage("assistant msg 3 ".repeat(12), mockUsage(5000, 1000)));
  const compaction2 = compactionEntry("First summary", r2u2.id);
  const r2u4 = messageEntry(userMessage("user msg 4 (new after compaction1) ".repeat(12)));
  const r2a4 = messageEntry(assistantMessage("assistant msg 4 ".repeat(12), mockUsage(8000, 2000)));
  const moves = prepareCompaction([r2u1, r2a1, r2u2, r2a2, r2u3, r2a3, compaction2, r2u4, r2a4], {
    ...DEFAULT_COMPACTION_SETTINGS,
    keepRecentTokens: 100,
  });
  const extractText = (messages) =>
    messages
      .map((message) => {
        if (message.role === "user") return typeof message.content === "string" ? message.content : "";
        if (message.role === "assistant") return message.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
        if (message.role === "branchSummary" || message.role === "compactionSummary") return message.summary;
        if (message.role === "bashExecution") return `${message.command}\n${message.output}`;
        if (message.role === "custom" || message.role === "toolResult")
          return typeof message.content === "string" ? message.content : "";
        return "";
      })
      .join("\n");
  out.prepareCompaction.window_moves =
    moves === undefined
      ? null
      : {
          firstKeptEntryId: moves.firstKeptEntryId,
          isSplitTurn: moves.isSplitTurn,
          tokensBefore: moves.tokensBefore,
          previousSummary: moves.previousSummary ?? null,
          summarizedText: extractText(moves.messagesToSummarize),
          turnPrefixText: extractText(moves.turnPrefixMessages),
          summarizeRoles: moves.messagesToSummarize.map((m) => m.role),
          fileOpsJson: j({ read: [...moves.fileOps.read].sort(), written: [...moves.fileOps.written].sort(), edited: [...moves.fileOps.edited].sort() }),
        };
  out.prepareCompaction.window_moves_entry_ids = {
    u1: r2u1.id, a1: r2a1.id, u2: r2u2.id, a2: r2a2.id, u3: r2u3.id, a3: r2a3.id,
    compaction: compaction2.id, u4: r2u4.id, a4: r2a4.id,
  };

  // trailing compaction → undefined
  resetEntries();
  const tU1 = messageEntry(userMessage("only"));
  const tCompaction = compactionEntry("Fresh summary", tU1.id);
  out.prepareCompaction.trailing_compaction_undefined =
    prepareCompaction([tU1, tCompaction], DEFAULT_COMPACTION_SETTINGS) === undefined ? null : "unexpected";

  // empty session → undefined
  out.prepareCompaction.empty_session_undefined = prepareCompaction([], DEFAULT_COMPACTION_SETTINGS) === undefined ? null : "unexpected";

  // previous compaction file details accumulate into the new preparation
  resetEntries();
  const fU1 = messageEntry(userMessage("history question"));
  const fA1 = messageEntry({
    role: "assistant",
    content: [
      { type: "text", text: "working" },
      { type: "toolCall", id: "f1", name: "read", arguments: { path: "from-calls.txt" } },
    ],
    usage: mockUsage(50, 20, 900, 0),
    stopReason: "stop",
    timestamp: TS,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  });
  const fCompaction = compactionEntry("History summary", fU1.id, {
    details: { readFiles: ["prev-read-1.txt", "prev-read-2.txt", "both.txt"], modifiedFiles: ["prev-modified.txt", "both.txt"] },
  });
  const fU2 = messageEntry(userMessage("recent question ".repeat(8)));
  const fA2 = messageEntry({
    role: "assistant",
    content: [
      { type: "text", text: "more work ".repeat(6) },
      { type: "toolCall", id: "f2", name: "write", arguments: { path: "written-now.txt" } },
    ],
    usage: mockUsage(8000, 2000),
    stopReason: "stop",
    timestamp: TS,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  });
  const withFiles = prepareCompaction([fU1, fA1, fCompaction, fU2, fA2], {
    ...DEFAULT_COMPACTION_SETTINGS,
    keepRecentTokens: 40,
  });
  out.prepareCompaction.file_details_accumulate =
    withFiles === undefined
      ? null
      : {
          firstKeptEntryId: withFiles.firstKeptEntryId,
          isSplitTurn: withFiles.isSplitTurn,
          tokensBefore: withFiles.tokensBefore,
          previousSummary: withFiles.previousSummary ?? null,
          summarizeRoles: withFiles.messagesToSummarize.map((m) => m.role),
          fileOpsJson: j({ read: [...withFiles.fileOps.read].sort(), written: [...withFiles.fileOps.written].sort(), edited: [...withFiles.fileOps.edited].sort() }),
        };
  out.prepareCompaction.file_details_entry_ids = {
    u1: fU1.id, a1: fA1.id, compaction: fCompaction.id, u2: fU2.id, a2: fA2.id,
  };
}

// ---- summarization prompt construction ---------------------------------------

{
  const scenarios = {};
  const run = async (name, responses, invoke, overrides = {}) => {
    const calls = [];
    const streamFn = makeStreamFn(responses, calls);
    await invoke(streamFn);
    scenarios[name] = {
      calls: calls.map((call) => ({ context: call.context, options: call.options })),
      freshRouting: overrides.freshRouting || null,
    };
  };

  await run("base", [textResponse("## Goal\nTest summary")], async (streamFn) => {
    await generateSummaryWithUsage([userMessage("Summarize this.")], model, 2000, "test-key", undefined, undefined, undefined, undefined, undefined, streamFn, undefined, undefined, undefined, "route-1");
  });
  await run("custom_instructions", [textResponse("ok")], async (streamFn) => {
    await generateSummaryWithUsage([userMessage("Summarize this.")], model, 2000, "test-key", undefined, undefined, "Focus on tests", undefined, undefined, streamFn);
  });
  await run("previous_summary", [textResponse("merged")], async (streamFn) => {
    await generateSummaryWithUsage([userMessage("Summarize this.")], model, 2000, "test-key", undefined, undefined, undefined, "previous checkpoint", undefined, streamFn);
  });
  await run("thinking_medium_reasoning_model", [textResponse("ok")], async (streamFn) => {
    await generateSummaryWithUsage([userMessage("Summarize this.")], { ...model, id: "reasoning-model", reasoning: true }, 2000, "test-key", undefined, undefined, undefined, undefined, "medium", streamFn);
  });
  await run("thinking_off_reasoning_model", [textResponse("ok")], async (streamFn) => {
    await generateSummaryWithUsage([userMessage("Summarize this.")], { ...model, id: "reasoning-model", reasoning: true }, 2000, "test-key", undefined, undefined, undefined, undefined, "off", streamFn);
  });
  await run("thinking_medium_non_reasoning_model", [textResponse("ok")], async (streamFn) => {
    await generateSummaryWithUsage([userMessage("Summarize this.")], model, 2000, "test-key", undefined, undefined, undefined, undefined, "medium", streamFn);
  });
  await run("max_tokens_clamped_to_model", [textResponse("ok")], async (streamFn) => {
    await generateSummaryWithUsage([userMessage("Summarize this.")], { ...model, maxTokens: 128000 }, 500000, "test-key", undefined, undefined, undefined, undefined, undefined, streamFn);
  });
  {
    const rawSessionIds = [];
    const streamFn = (_m, _c, opts) => {
      rawSessionIds.push(typeof opts.sessionId === "string" ? opts.sessionId : null);
      return { result: async () => textResponse(rawSessionIds.length === 1 ? "a" : "b") };
    };
    await generateSummary([userMessage("Summarize this.")], model, 2000, "test-key", undefined, undefined, undefined, undefined, undefined, streamFn);
    await generateSummary([userMessage("Summarize this.")], model, 2000, "test-key", undefined, undefined, undefined, undefined, undefined, streamFn);
    const v7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    scenarios.fresh_routing_session = {
      calls: [],
      freshRouting: {
        count: rawSessionIds.length,
        distinct: new Set(rawSessionIds).size === rawSessionIds.length,
        allV7: rawSessionIds.every((id) => id !== null && v7.test(id)),
      },
    };
  }
  await run("headers_and_env", [textResponse("ok")], async (streamFn) => {
    await generateSummaryWithUsage([userMessage("Summarize this.")], model, 2000, "test-key", { "x-trace": "t1" }, undefined, undefined, undefined, undefined, streamFn, { REGION: "eu" });
  });
  out.summarizationPrompts = scenarios;
}

// ---- completeSummarization option preservation ----------------------------------

{
  const calls = [];
  const streamFn = makeStreamFn([textResponse("ok")], calls);
  // The real pi-ai re-export (same implementation the port calls).
  const piAi = await import(new URL("./node_modules/@earendil-works/pi-ai/index.js", import.meta.url));
  const normalized = piAi.normalizeContext({ systemPrompt: "Summarize", messages: [] });
  await completeSummarization(model, normalized, { sessionId: "current-routing-session", cacheRetention: "long", toolChoice: "auto", maxTokens: 999 }, streamFn);
  out.completeSummarizationOptionPreservation = { call: calls[0] };
}

// ---- summarization failures -------------------------------------------------------

{
  const withError = textResponse("x", { stopReason: "error", errorMessage: "socket closed" });
  const withErrorNoMessage = textResponse("x", { stopReason: "error", errorMessage: undefined });
  const withLength = textResponse("partial", { stopReason: "length" });
  const ok = textResponse("fine");
  const toolCall = textResponse("x", {
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "tc", name: "read", arguments: { path: "README.md" } }],
  });

  out.summarizationFailures = {
    direct: {
      error: getSummarizationFailure(withError, "Summarization") ?? null,
      errorNoMessage: getSummarizationFailure(withErrorNoMessage, "Summarization") ?? null,
      length: getSummarizationFailure(withLength, "Summarization") ?? null,
      ok: getSummarizationFailure(ok, "Summarization") ?? null,
      branchLabel: getSummarizationFailure(withError, "Branch summarization") ?? null,
      turnPrefixLabel: getSummarizationFailure(withLength, "Turn prefix summarization") ?? null,
    },
    thrown: {},
  };

  const captureThrow = async (name, promise) => {
    try {
      await promise;
      out.summarizationFailures.thrown[name] = null;
    } catch (error) {
      out.summarizationFailures.thrown[name] = String(error.message ?? error);
    }
  };

  const calls = [];
  const streamFn = makeStreamFn([toolCall], calls);
  await captureThrow("tool_call", generateSummaryWithUsage([userMessage("Summarize this.")], model, 2000, "k", undefined, undefined, undefined, undefined, undefined, streamFn));

  const calls2 = [];
  const streamFn2 = makeStreamFn([withLength], calls2);
  await captureThrow("length", generateSummaryWithUsage([userMessage("Summarize this.")], model, 2000, "k", undefined, undefined, undefined, undefined, undefined, streamFn2));

  const calls3 = [];
  const streamFn3 = makeStreamFn([textResponse("## Goal\nhistory"), toolCall], calls3);
  await captureThrow(
    "split_turn_tool_call",
    compact(
      {
        firstKeptEntryId: "entry-keep",
        messagesToSummarize: [userMessage("history")],
        turnPrefixMessages: [userMessage("prefix")],
        isSplitTurn: true,
        tokensBefore: 100,
        previousSummary: undefined,
        fileOps: createFileOps(),
        settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
      },
      model,
      "test-key",
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn3,
    ),
  );

  const calls4 = [];
  const streamFn4 = makeStreamFn([withLength], calls4);
  await captureThrow(
    "split_turn_length",
    compact(
      {
        firstKeptEntryId: "entry-keep",
        messagesToSummarize: [],
        turnPrefixMessages: [userMessage("prefix")],
        isSplitTurn: true,
        tokensBefore: 100,
        previousSummary: undefined,
        fileOps: createFileOps(),
        settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
      },
      model,
      "test-key",
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn4,
    ),
  );
}

// ---- compact() ---------------------------------------------------------------------

{
  // plain (non-split) compaction with file ops
  const calls = [];
  const streamFn = makeStreamFn([textResponse("## Goal\nPlain summary")], calls);
  const plain = await compact(
    {
      firstKeptEntryId: "entry-keep",
      messagesToSummarize: [userMessage("history"), assistantMessage("reply")],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 4321,
      previousSummary: undefined,
      fileOps: (() => {
        const ops = createFileOps();
        extractFileOpsFromMessage(
          { role: "assistant", content: [{ type: "toolCall", id: "x", name: "read", arguments: { path: "b.txt" } }, { type: "toolCall", id: "y", name: "edit", arguments: { path: "a.txt" } }], usage: mockUsage(1, 1), stopReason: "toolUse", timestamp: TS, api: "a", provider: "p", model: "m" },
          ops,
        );
        return ops;
      })(),
      settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
    },
    model,
    "test-key",
    undefined,
    undefined,
    undefined,
    undefined,
    streamFn,
  );
  out.compactPlain = {
    calls: calls.map((call) => ({ context: call.context, options: call.options })),
    resultJson: j(plain),
  };

  // split turn: history + turn prefix merged; usage combined
  const splitCalls = [];
  const historyUsage = { ...mockUsage(100, 40), cacheWrite1h: 12 };
  const prefixUsage = { ...mockUsage(30, 25), reasoning: 7 };
  const splitStreamFn = (m, c, o) => {
    const response = splitCalls.length === 0 ? textResponse("## Goal\nHistory summary") : textResponse("## Goal\nPrefix summary");
    const usage = splitCalls.length === 0 ? historyUsage : prefixUsage;
    splitCalls.push({ context: scrubContext(c), options: scrubOptions(o) });
    return { result: async () => ({ ...response, usage }) };
  };
  const split = await compact(
    {
      firstKeptEntryId: "entry-keep",
      messagesToSummarize: [userMessage("history")],
      turnPrefixMessages: [userMessage("prefix question")],
      isSplitTurn: true,
      tokensBefore: 777,
      previousSummary: "prior checkpoint",
      fileOps: createFileOps(),
      settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
    },
    model,
    "test-key",
    undefined,
    undefined,
    undefined,
    undefined,
    splitStreamFn,
  );
  out.compactSplitTurn = {
    calls: splitCalls.map((call) => ({ context: call.context, options: call.options })),
    resultJson: j(split),
  };

  // split turn with empty history: previousSummary carried, single call
  const emptyHistoryCalls = [];
  const emptyHistoryStreamFn = makeStreamFn([textResponse("## Goal\nPrefix only")], emptyHistoryCalls);
  const emptyHistory = await compact(
    {
      firstKeptEntryId: "entry-keep",
      messagesToSummarize: [],
      turnPrefixMessages: [userMessage("prefix question")],
      isSplitTurn: true,
      tokensBefore: 100,
      previousSummary: "previous checkpoint",
      fileOps: createFileOps(),
      settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
    },
    model,
    "test-key",
    undefined,
    undefined,
    undefined,
    undefined,
    emptyHistoryStreamFn,
  );
  out.compactSplitTurnEmptyHistory = {
    calls: emptyHistoryCalls.map((call) => ({ context: call.context, options: call.options })),
    resultJson: j(emptyHistory),
  };

  // turn prefix maxTokens floor(0.5 * reserve)
  const prefixCalls = [];
  const prefixStreamFn = makeStreamFn([textResponse("prefix out")], prefixCalls);
  // generateTurnPrefixSummary is private; reach it through compact with only a
  // turn prefix and no previous summary.
  await compact(
    {
      firstKeptEntryId: "entry-keep",
      messagesToSummarize: [],
      turnPrefixMessages: [userMessage("prefix question")],
      isSplitTurn: true,
      tokensBefore: 100,
      previousSummary: undefined,
      fileOps: createFileOps(),
      settings: { enabled: true, reserveTokens: 2001, keepRecentTokens: 20 },
    },
    model,
    "test-key",
    undefined,
    undefined,
    undefined,
    undefined,
    prefixStreamFn,
  );
  out.turnPrefixOptions = { options: prefixCalls[0].options };
}

// ---- branch summarization -------------------------------------------------------------

{
  const branchEntries = [
    {
      type: "message",
      id: "branch-user",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "Abandoned request", timestamp: 1 },
    },
  ];

  const scenarios = {};

  const runBranch = async (name, entries, responses, options = {}) => {
    const calls = [];
    const streamFn = makeStreamFn(responses, calls);
    const result = await generateBranchSummary(entries, {
      model: options.model ?? model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      customInstructions: options.customInstructions,
      replaceInstructions: options.replaceInstructions,
      reserveTokens: options.reserveTokens,
      streamFn,
      ...options.extra,
    });
    scenarios[name] = {
      calls: calls.map((call) => ({ context: call.context, options: call.options })),
      resultJson: j(result),
    };
  };

  await runBranch("default", branchEntries, [textResponse("summary body")]);
  await runBranch("clamped", branchEntries, [textResponse("summary body")], { model: { ...model, maxTokens: 1024 } });
  await runBranch("tool_call", branchEntries, [
    textResponse("x", {
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tc", name: "read", arguments: { path: "README.md" } }],
    }),
  ]);
  await runBranch("length", branchEntries, [textResponse("partial", { stopReason: "length" })]);
  {
    const calls = [];
    const streamFn = (_m, context, opts) => {
      calls.push({ context: scrubContext(context), options: scrubOptions(opts) });
      return {
        result: async () => ({ ...textResponse("ignored"), stopReason: "aborted", content: [] }),
      };
    };
    const result = await generateBranchSummary(branchEntries, { model, signal: new AbortController().signal, streamFn });
    scenarios.aborted = { calls: calls.map((c) => ({ context: c.context, options: c.options })), resultJson: j(result) };
  }
  await runBranch("empty", [
    {
      type: "label",
      id: "l0",
      parentId: null,
      timestamp: STAMP,
      targetId: "x",
      label: "bookmark",
    },
  ], [textResponse("never called")]);
  await runBranch("custom_instructions", branchEntries, [textResponse("focused")], { customInstructions: "Talk about the API" });
  await runBranch("replace_instructions", branchEntries, [textResponse("replaced")], { customInstructions: "Only list files", replaceInstructions: true });

  // branch summary entries carry cumulative file details into the summary
  const withDetails = [
    branchEntries[0],
    {
      type: "branch_summary",
      id: "branch-1",
      parentId: null,
      timestamp: STAMP,
      fromId: "older",
      summary: "Earlier exploration notes",
      details: { readFiles: ["kept-read.txt", "shared.txt"], modifiedFiles: ["kept-modified.txt", "shared.txt"] },
    },
    {
      type: "message",
      id: "branch-2",
      parentId: "branch-1",
      timestamp: STAMP,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "b1", name: "edit", arguments: { path: "edited-now.txt" } }],
        usage: mockUsage(1, 1),
        stopReason: "toolUse",
        timestamp: 5,
        api: "a",
        provider: "p",
        model: "m",
      },
    },
  ];
  await runBranch("file_details", withDetails, [textResponse("branch summary text")]);

  out.branchSummary = scenarios;

  // prepareBranchEntries token budget behavior (chars/4 heuristic: 400-char
  // messages carry ~100 estimated tokens each)
  resetEntries();
  const budgetEntries = [
    messageEntry(userMessage("x".repeat(400))),
    messageEntry(assistantMessage("y".repeat(400), mockUsage(0, 900))),
    messageEntry(userMessage("x".repeat(400))),
    messageEntry(assistantMessage("y".repeat(400), mockUsage(0, 100))),
  ];
  const roles = (preparation) => preparation.messages.map((m) => m.role);
  out.prepareBranchEntries = {
    unlimited: { roles: roles(prepareBranchEntries(budgetEntries, 0)), totalTokens: prepareBranchEntries(budgetEntries, 0).totalTokens },
    keeps_recent: (() => {
      const preparation = prepareBranchEntries(budgetEntries, 250);
      return { roles: roles(preparation), totalTokens: preparation.totalTokens };
    })(),
    summary_squeeze: (() => {
      resetEntries();
      const squeezed = [
        messageEntry(userMessage("x".repeat(400))),
        compactionEntry("s".repeat(300), "t-0"),
      ];
      const preparation = prepareBranchEntries(squeezed, 50);
      return { roles: roles(preparation), totalTokens: preparation.totalTokens };
    })(),
    file_ops_collected: (() => {
      resetEntries();
      const withToolCalls = [
        messageEntry({
          role: "assistant",
          content: [
            { type: "toolCall", id: "p1", name: "read", arguments: { path: "budget-read.txt" } },
            { type: "toolCall", id: "p2", name: "write", arguments: { path: "budget-write.txt" } },
          ],
          usage: mockUsage(1, 1),
          stopReason: "toolUse",
          timestamp: TS,
          api: "a",
          provider: "p",
          model: "m",
        }),
        compactionEntry("c".repeat(300), "t-0", {
          details: { readFiles: ["detail-read.txt"], modifiedFiles: ["detail-modified.txt"] },
        }),
      ];
      const preparation = prepareBranchEntries(withToolCalls, 0);
      return {
        roles: roles(preparation),
        fileOpsJson: j({ read: [...preparation.fileOps.read].sort(), written: [...preparation.fileOps.written].sort(), edited: [...preparation.fileOps.edited].sort() }),
      };
    })(),
  };
}

// ---- write ---------------------------------------------------------------

const target = new URL("./compaction.oracle.json", import.meta.url);
const { writeFileSync } = await import("node:fs");
writeFileSync(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
console.log("wrote", target.pathname);
