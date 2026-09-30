// Oracle capture for the agent-session lower half (W3.12, upstream
// agent-session.ts:1989-3625). Same convention as capture_oracle.mjs (W3.11):
// the pure upstream function bodies are copied VERBATIM below (each copy
// names its source file and line range; `this.`-reads become parameters) and
// everything else is executed from the real upstream files (contentText and
// retryDelayMs via file URL into the pi workspace).
//
// Run: node --experimental-strip-types capture_oracle_w312.mjs > oracle_w312.json
//
// Determinism: every input pins its ids/timestamps; the JSONL export scenario
// pins the header timestamp, so the produced bytes are stable.

import { contentText } from "../../../pi/packages/ai/src/utils/text.ts";
import { retryDelayMs } from "../../../pi/packages/ai/src/utils/retry.ts";

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/usage-totals.ts:13-33
// ---------------------------------------------------------------------------
export function createUsageTotals() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals, usage) {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/compaction/compaction.ts:161-165
// ---------------------------------------------------------------------------
export function calculateContextTokens(usage) {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/session-manager.ts
// getLatestCompactionEntry (pure scan over the branch entries)
// ---------------------------------------------------------------------------
export function getLatestCompactionEntry(entries) {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return entries[i];
	}
	return null;
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/agent-session.ts:3484-3528
// (`this.model` -> model; `this.sessionManager.getBranch()` -> branchEntries;
// `this.messages` -> messages)
// ---------------------------------------------------------------------------
export function getContextUsage(model, branchEntries, messages, estimateContextTokens) {
	if (!model) return undefined;

	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	// After compaction, the last assistant usage reflects pre-compaction context size.
	// We can only trust usage from an assistant that responded after the latest compaction.
	// If no such assistant exists, context token count is unknown until the next LLM response.
	const latestCompaction = getLatestCompactionEntry(branchEntries);

	if (latestCompaction) {
		// Check if there's a valid assistant usage after the compaction boundary
		const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
		let hasPostCompactionUsage = false;
		for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
			const entry = branchEntries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const assistant = entry.message;
				if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
					const contextTokens = calculateContextTokens(assistant.usage);
					if (contextTokens > 0) {
						hasPostCompactionUsage = true;
						break;
					}
				}
			}
		}

		if (!hasPostCompactionUsage) {
			return { tokens: null, contextWindow, percent: null };
		}
	}

	const estimate = estimateContextTokens(messages);
	const percent = (estimate.tokens / contextWindow) * 100;

	return {
		tokens: estimate.tokens,
		contextWindow,
		percent,
	};
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/agent-session.ts:3432-3482
// (`this.sessionManager.getEntries()` -> entries; `this.sessionFile` ->
// sessionFile; `this.sessionId` -> sessionId; `this.getContextUsage()` ->
// contextUsage)
// ---------------------------------------------------------------------------
export function getSessionStats(entries, sessionFile, sessionId, contextUsage) {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let totalMessages = 0;
	let toolCalls = 0;
	const usageTotals = createUsageTotals();

	for (const entry of entries) {
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsageToTotals(usageTotals, entry.usage);
		}
		if (entry.type !== "message") continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") {
			userMessages++;
		} else if (message.role === "toolResult") {
			toolResults++;
			if (message.usage) {
				addUsageToTotals(usageTotals, message.usage);
			}
		} else if (message.role === "assistant") {
			assistantMessages++;
			const assistantMsg = message;
			if (Array.isArray(assistantMsg.content)) {
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
			}
			addUsageToTotals(usageTotals, assistantMsg.usage);
		}
	}

	return {
		sessionFile,
		sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			input: usageTotals.input,
			output: usageTotals.output,
			cacheRead: usageTotals.cacheRead,
			cacheWrite: usageTotals.cacheWrite,
			total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
		},
		cost: usageTotals.cost,
		contextUsage,
	};
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/agent-session.ts:3410-3425
// (`this.sessionManager.getEntries()` -> entries)
// ---------------------------------------------------------------------------
export function getUserMessagesForForking(entries) {
	const result = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user") continue;

		const text = contentText(entry.message.content, "");
		if (text) {
			result.push({ entryId: entry.id, text });
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/agent-session.ts:3574-3596
// (`this.messages` -> messages)
// ---------------------------------------------------------------------------
export function getLastAssistantText(messages) {
	const lastAssistant = messages
		.slice()
		.reverse()
		.find((m) => {
			if (m.role !== "assistant") return false;
			const msg = m;
			// Skip aborted messages with no content
			if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
			return true;
		});

	if (!lastAssistant) return undefined;

	let text = "";
	for (const content of lastAssistant.content) {
		if (content.type === "text") {
			text += content.text;
		}
	}

	return text.trim() || undefined;
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/agent-session.ts:3336-3351
// (navigateTree's new-leaf decision; targetEntry/targetId are parameters)
// ---------------------------------------------------------------------------
export function navigateTreeTargetDecision(targetEntry, targetId) {
	let newLeafId;
	let editorText;

	if (targetEntry.type === "message" && targetEntry.message.role === "user") {
		// User message: leaf = parent (null if root), text goes to editor
		newLeafId = targetEntry.parentId;
		editorText = contentText(targetEntry.message.content, "");
	} else if (targetEntry.type === "custom_message") {
		// Custom message: leaf = parent (null if root), text goes to editor
		newLeafId = targetEntry.parentId;
		editorText = contentText(targetEntry.content, "");
	} else {
		// Non-user message: leaf = selected node
		newLeafId = targetId;
	}

	return { newLeafId, editorText };
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/utils/paths.ts:67-106
// (normalizeWindowsShellPath/normalizePath/resolvePath; the tilde/file-URL
// branches are unreachable for the scenario inputs but kept for fidelity;
// `homedir`/`fileURLToPath` imports inlined)
// ---------------------------------------------------------------------------
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve as nodeResolvePath } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function normalizeWindowsShellPath(filePath) {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

export function normalizePath(input, options = {}) {
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (process.platform === "win32") {
		normalized = normalizeWindowsShellPath(normalized);
	}

	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? homedir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
			return join(home, normalized.slice(2));
		}
	}

	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}

	return normalized;
}

export function resolvePath(input, baseDir = process.cwd(), options = {}) {
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/session-export.ts:7-42
// (process.cwd() -> baseDir parameter; fixed pinned timestamp)
// ---------------------------------------------------------------------------
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const CURRENT_SESSION_VERSION = 3;

export function exportSessionToJsonl(sessionManager, outputPath, createTrailingEntries, baseDir, pinnedTimestamp) {
	const filePath = resolvePath(
		outputPath ?? `session-${pinnedTimestamp.replace(/[:.]/g, "-")}.jsonl`,
		baseDir,
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const timestamp = pinnedTimestamp;
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	const lines = [JSON.stringify(header)];

	let parentId = null;
	for (const entry of sessionManager.getBranch()) {
		lines.push(JSON.stringify({ ...entry, parentId }));
		parentId = entry.id;
	}
	for (const entry of createTrailingEntries?.(parentId, timestamp) ?? []) {
		lines.push(JSON.stringify(entry));
	}

	writeFileSync(filePath, `${lines.join("\n")}\n`);
	return filePath;
}

// ---------------------------------------------------------------------------
// Scenario inputs (fixed ids/timestamps; mirrors the Rust test fixtures)
// ---------------------------------------------------------------------------

const usage = (input, total = input, cost = 0) => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: total,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

// The claude-sonnet-4-5 stand-in the Rust fixture uses.
const model = {
	id: "claude-4-5",
	name: "claude-4-5",
	api: "anthropic-messages",
	provider: "anthropic",
	contextWindow: 128000,
	maxTokens: 16384,
	reasoning: true,
};

const assistantMessage = (text, totalTokens, timestamp, extra = {}) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: usage(totalTokens),
	stopReason: "stop",
	timestamp,
	...extra,
});

const userMessage = (text, timestamp) => ({
	role: "user",
	content: text,
	timestamp,
});

// Scenario A: plain conversation, no compaction (stats/fork/lastText/context).
const entriesPlain = [
	{ type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: userMessage("hello", 1) },
	{ type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:01.000Z", message: assistantMessage("hi", 200, 2) },
];

// Scenario B: post-compaction without post-compaction usage (null context).
const entriesCompactedUnknown = [
	{ type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: userMessage("first", 1) },
	{ type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:01.000Z", message: assistantMessage("response1", 180000, 2) },
	{ type: "message", id: "e3", parentId: "e2", timestamp: "2026-01-01T00:00:02.000Z", message: userMessage("second", 3) },
	{ type: "message", id: "e4", parentId: "e3", timestamp: "2026-01-01T00:00:03.000Z", message: assistantMessage("response2", 195000, 4) },
	{ type: "compaction", id: "e5", parentId: "e4", timestamp: "2026-01-01T00:00:04.000Z", summary: "summary", firstKeptEntryId: "e3", tokensBefore: 195000 },
	{ type: "message", id: "e6", parentId: "e5", timestamp: "2026-01-01T00:00:05.000Z", message: userMessage("third", 5) },
];

// Scenario C: post-compaction with a post-compaction response.
const entriesCompactedKnown = [
	...entriesCompactedUnknown,
	{ type: "message", id: "e7", parentId: "e6", timestamp: "2026-01-01T00:00:06.000Z", message: assistantMessage("response3", 25000, 6) },
];

// estimateContextTokens stand-in for the context-usage scenarios: the Rust
// port runs the real estimator over the same messages (pinned by the W3.4
// compaction oracle); these scenarios pin the aggregate/decision surface, so
// the estimator result is supplied as the scenario constant the Rust fixture
// asserts against.
const estimateOf = (messages) => ({ tokens: messages.reduce((sum, m) => sum + ((m.usage && calculateContextTokens(m.usage)) || 0), 0), usageTokens: 0, trailingTokens: 0, lastUsageIndex: null });

// The context messages the session rebuilds for each scenario (kept path only,
// compaction entries replay as compactionSummary customs upstream — not needed
// for these totals because the estimator stand-in only sums message usage).
const messagesPlain = [entriesPlain[0].message, entriesPlain[1].message];
const messagesCompactedUnknown = [entriesCompactedUnknown[5].message];
const messagesCompactedKnown = [entriesCompactedUnknown[5].message, entriesCompactedKnown[6].message];

// Scenario D: usage totals across summaries and tool results.
const usageFull = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } };
const entriesSummaries = [
	{ type: "branch_summary", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", fromId: "root", summary: "branch summary", usage: usageFull },
	{ type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1 } },
	{ type: "message", id: "e3", parentId: "e2", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "tool-call-1", toolName: "test_tool", content: [{ type: "text", text: "tool result" }], usage: usageFull, isError: false, timestamp: 1 } },
	{ type: "compaction", id: "e4", parentId: "e3", timestamp: "2026-01-01T00:00:03.000Z", summary: "summary", firstKeptEntryId: "e2", tokensBefore: 100, usage: usageFull },
];

// getLastAssistantText cases (last-aborted-empty skipped, whitespace-only -> undefined).
const messagesLastText = [
	userMessage("q", 1),
	assistantMessage("  \n  ", 5, 2),
	assistantMessage("first answer", 5, 3, { stopReason: "aborted" }),
	assistantMessage("final answer", 5, 4),
	{ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: usage(0), stopReason: "aborted", timestamp: 5 },
	userMessage("later", 6),
];

// navigateTree target decisions.
const targetDecision = {
	rootUser: navigateTreeTargetDecision(entriesPlain[0], "e1"),
	nestedUser: navigateTreeTargetDecision(entriesCompactedUnknown[2], "e3"),
	customMessage: navigateTreeTargetDecision({ type: "custom_message", id: "c1", parentId: "e2", timestamp: "2026-01-01T00:00:09.000Z", customType: "note", content: [{ type: "text", text: "custom text" }], display: true }, "c1"),
	assistant: navigateTreeTargetDecision(entriesPlain[1], "e2"),
};

// retryDelayMs policy table (agent-session-retry.test.ts "caps agent retry
// delay": baseDelayMs 1, maxAgentDelayMs 5, attempts 1..4 -> [1, 2, 4, 5]).
const retryDelays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelayMs({ baseDelayMs: 1, maxAgentDelayMs: 5 }, attempt));
const retryDelaysDefaultCap = [1, 8, 64, 4096, 65536].map((attempt) => retryDelayMs({ baseDelayMs: 1 }, attempt));

// JSONL export: fixed entries; the trailing entry callback mirrors the
// share-extension hook shape (export-only label entry).
const pinnedTimestamp = "2026-01-01T00:00:00.000Z";
const exportEntries = entriesPlain;
const fakeSessionManager = {
	getSessionId: () => "fixed-session-id",
	getCwd: () => "/fixed/cwd",
	getBranch: () => exportEntries,
};
const tmpOut = join(process.env.PI_ORACLE_TMPDIR ?? ".", "pi-oracle-export.jsonl");
const exportedPath = exportSessionToJsonl(
	fakeSessionManager,
	tmpOut,
	undefined,
	"/fixed/cwd",
	pinnedTimestamp,
);
const { readFileSync } = await import("node:fs");
const exportedBytes = readFileSync(exportedPath, "utf8");

// Canonical JSON so serde_json comparisons are shape-equal (the JSONL byte
// string is compared verbatim, not canonicalized).
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

const oracle = {
	stats_plain: j(getSessionStats(entriesPlain, "/s/session.jsonl", "fixed-session-id", getContextUsage(model, entriesPlain, messagesPlain, estimateOf))),
	stats_compacted_unknown: j(getSessionStats(entriesCompactedUnknown, "/s/session.jsonl", "fixed-session-id", getContextUsage(model, entriesCompactedUnknown, messagesCompactedUnknown, estimateOf))),
	stats_compacted_known: j(getSessionStats(entriesCompactedKnown, "/s/session.jsonl", "fixed-session-id", getContextUsage(model, entriesCompactedKnown, messagesCompactedKnown, estimateOf))),
	stats_summaries: j(getSessionStats(entriesSummaries, "/s/session.jsonl", "fixed-session-id", getContextUsage(model, entriesSummaries, [], estimateOf))),
	context_usage_no_model: j(getContextUsage(null, entriesPlain, [], estimateOf)),
	fork_plain: j(getUserMessagesForForking(entriesPlain)),
	fork_compacted: j(getUserMessagesForForking(entriesCompactedUnknown)),
	last_assistant_text: j(getLastAssistantText(messagesLastText)),
	last_assistant_text_empty: j(getLastAssistantText([])),
	target_decision: j(targetDecision),
	retry_delays: j(retryDelays),
	retry_delays_default_cap: j(retryDelaysDefaultCap),
	jsonl_bytes: exportedBytes,
	jsonl_path: exportedPath.split(/[\\/]/).pop(),
};

process.stdout.write(JSON.stringify(oracle, null, 2) + "\n");
