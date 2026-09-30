/**
 * Byte oracle for `modes/json-event.ts` `toJsonEvent`.
 *
 * Runs the verbatim upstream copy (imports are type-only, so
 * `--experimental-strip-types` loads it standalone). Prints one JSON line per
 * case: `{"name":..., "ok":true, "out":"<serialized>"}` or
 * `{"name":..., "ok":false, "error":"..."}`. The Rust port test compares these
 * bytes against its own serialization for equivalent inputs.
 */
import { toJsonEvent } from "./upstream/json-event.ts";

// Ported `Usage` serialization (identical shape/order upstream).
const usage = {
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 16,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

const assistantMessage = (role = "assistant") => ({ role, usage });


// Port-faithful `AgentMessage::Assistant` wire fixture (serde field order).
const assistantFull = (overrides = {}) => ({
	role: "assistant",
	content: [],
	// The ported faux provider stamps these defaults; toJsonEvent is
	// content-agnostic, the fixture just mirrors the port's message type.
	api: "faux",
	provider: "faux",
	model: "faux-1",
	usage,
	stopReason: "stop",
	timestamp: 1700000000000,
	...overrides,
});

const toolCallBlock = {
	type: "toolCall",
	id: "toolu_01",
	name: "bash",
	arguments: { command: "ls" },
};

// Upstream assistantMessageEvent shapes (with the live `partial` the port
// removes at the pi-ai seam). Key order mirrors upstream event construction.
const deltaEvents = {
	start: { type: "start", partial: { role: "assistant", content: [], usage } },
	text_start: { type: "text_start", contentIndex: 0, partial: { role: "assistant", content: [{ type: "text", text: "" }] } },
	text_delta: { type: "text_delta", contentIndex: 0, delta: "he", partial: { role: "assistant", content: [{ type: "text", text: "he" }] } },
	text_end: { type: "text_end", contentIndex: 0, content: "hello", partial: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
	thinking_start: { type: "thinking_start", contentIndex: 0, partial: { role: "assistant", content: [{ type: "thinking", thinking: "" }] } },
	thinking_delta: { type: "thinking_delta", contentIndex: 0, delta: "hm", partial: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }] } },
	thinking_end: { type: "thinking_end", contentIndex: 0, content: "hmm", partial: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } },
	toolcall_start: {
		type: "toolcall_start",
		contentIndex: 1,
		partial: { role: "assistant", content: [{ type: "text", text: "running" }, toolCallBlock] },
	},
	toolcall_delta: { type: "toolcall_delta", contentIndex: 1, delta: '{"comm', partial: { role: "assistant", content: [toolCallBlock] } },
	toolcall_end: {
		type: "toolcall_end",
		contentIndex: 1,
		toolCall: toolCallBlock,
		partial: { role: "assistant", content: [toolCallBlock] },
	},
	done: {
		type: "done",
		reason: "stop",
		message: { ...assistantFull(), content: [{ type: "text", text: "hello" }] },
		partial: { ...assistantFull(), content: [{ type: "text", text: "hello" }] },
	},
	error: {
		type: "error",
		reason: "error",
		error: { ...assistantFull(), stopReason: "error", errorMessage: "boom" },
		partial: { ...assistantFull(), stopReason: "error", errorMessage: "boom" },
	},
};

// Upstream AgentSessionEvent passthrough shapes. Key order mirrors the ported
// `AgentSessionEvent` serde wire (tag first, then camelCase fields).
const passthrough = {
	agent_start: { type: "agent_start" },
	agent_end: { type: "agent_end", messages: [], willRetry: false },
	agent_settled: { type: "agent_settled" },
	queue_update: { type: "queue_update", steering: ["a"], followUp: [] },
	turn_start: { type: "turn_start" },
	message_start: { type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1700000000000 } },
	message_end: { type: "message_end", message: { ...assistantFull(), content: [{ type: "text", text: "hello" }] } },
	tool_execution_start: { type: "tool_execution_start", toolCallId: "toolu_01", toolName: "bash", args: { command: "ls" } },
	tool_execution_update: {
		type: "tool_execution_update",
		toolCallId: "toolu_01",
		toolName: "bash",
		args: { command: "ls" },
		partialResult: { output: "x" },
	},
	tool_execution_end: {
		type: "tool_execution_end",
		toolCallId: "toolu_01",
		toolName: "bash",
		result: { output: "done", exitCode: 0 },
		isError: false,
	},
	compaction_start: { type: "compaction_start", reason: "manual" },
	compaction_end: { type: "compaction_end", reason: "threshold", result: { summary: "s" }, aborted: false, willRetry: false, errorMessage: null },
	entry_appended: { type: "entry_appended", entry: { type: "session_info", id: "e1", parentId: null, timestamp: "t", name: "n" } },
	session_info_changed: { type: "session_info_changed", name: "named" },
	thinking_level_changed: { type: "thinking_level_changed", level: "high" },
	auto_retry_start: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "boom" },
	auto_retry_end: { type: "auto_retry_end", success: true, attempt: 2, finalError: null },
	summarization_retry_scheduled: { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 500, errorMessage: "boom" },
	summarization_retry_attempt_start: { type: "summarization_retry_attempt_start", source: "branchSummary" },
	summarization_retry_attempt_start_compaction: {
		type: "summarization_retry_attempt_start",
		source: { compaction: { reason: "overflow" } },
	},
	summarization_retry_finished: { type: "summarization_retry_finished" },
	bash_execution_update: { type: "bash_execution_update", id: "b1", delta: "chunk" },
};

const lines = [];
const record = (name, fn) => {
	const input = fn();
	try {
		const out = toJsonEvent(input);
		lines.push(JSON.stringify({ name, input: JSON.stringify(input), ok: true, out: JSON.stringify(out) }));
	} catch (error) {
		lines.push(JSON.stringify({ name, input: JSON.stringify(input), ok: false, error: error.message }));
	}
};

for (const [name, event] of Object.entries(passthrough)) {
	record(`passthrough_${name}`, () => event);
}

// `start` is excluded from byte parity: the ported pi-ai seam carries
// `message` on the start event where upstream carries only `partial`
// (documented ai-slice deviation); upstream's toJsonEvent therefore emits
// `{"type":"start"}` while the port passes its start event through with the
// message. Disclosed divergence in the port module docs.
for (const name of [
	"text_start",
	"text_delta",
	"text_end",
	"thinking_start",
	"thinking_delta",
	"thinking_end",
	"toolcall_delta",
	"toolcall_end",
	"done",
	"error",
]) {
	record(`message_update_${name}`, () => ({
		type: "message_update",
		message: assistantMessage(),
		assistantMessageEvent: deltaEvents[name],
	}));
}

record("message_update_toolcall_start", () => ({
	type: "message_update",
	message: assistantMessage(),
	assistantMessageEvent: deltaEvents.toolcall_start,
}));

// Error paths.
record("error_non_assistant_message", () => ({
	type: "message_update",
	message: assistantMessage("user"),
	assistantMessageEvent: deltaEvents.text_start,
}));
record("error_toolcall_start_not_tool_call", () => ({
	type: "message_update",
	message: assistantMessage(),
	assistantMessageEvent: {
		type: "toolcall_start",
		contentIndex: 1,
		partial: { role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
	},
}));
record("error_toolcall_start_missing_index", () => ({
	type: "message_update",
	message: assistantMessage(),
	assistantMessageEvent: {
		type: "toolcall_start",
		contentIndex: 5,
		partial: { role: "assistant", content: [toolCallBlock] },
	},
}));

process.stdout.write(lines.join("\n") + "\n");
