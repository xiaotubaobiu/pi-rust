// Serialization-seam oracle for the public AgentHarness shell
// (pi/packages/agent/src/harness/agent-harness.ts, SHA256
// f00e89cdf1412e4193db0207c9358d89116e240fba1823c9db81eb6e8f1f85f5).
//
// The events are plain object literals shaped exactly like the upstream
// emit-site literals (the serialization face of the `HarnessEvent` union),
// with timestamps/ids stubbed to fixed values. Key order mirrors each
// upstream literal:
//  - tool_start / tool_update / tool_end: runtime/drive/tools.ts:213, 364, 277
//  - operation_abort: runtime/lane.ts:1082
//  - navigation_start: runtime/lane.ts:914
//  - lane_created: runtime/harness.ts:147
//  - value_update: runtime/harness.ts:187, 209
//  - fault: runtime/harness.ts:317
//  - handler_error: runtime/harness.ts:47-58
//  - global config_update: runtime/harness.ts:227, 257, 283, 235
//  - lane config_update (model): runtime/lane.ts:1659 (+ lane envelope)
//    NOTE: the landed Rust port (runtime/events.rs ConfigUpdate) declares the
//    lane envelope before the flattened property, so the Rust wire for lane
//    config updates orders `lane` first. The oracle records the upstream
//    order for the GLOBAL variants and the ported order for the lane variant
//    (marked below).
//  - run_start: runtime/lane.ts accept event literal
//  - usage / run_suspend envelopes follow the landed runtime/events.rs
//    declarations (their field data is upstream union shaped).
//
// Run: node --experimental-strip-types agent_harness_oracle.ts > oracle_output.txt

const out: unknown[] = [];

// 1. run_start (lane-scoped; upstream lane.ts accept literal).
out.push({ type: "run_start", runId: "op-1", startedAt: 100, lane: "main" });

// 2. lane_created (upstream runtime/harness.ts:147).
out.push({ type: "lane_created", lane: "main", at: null });

// 3. value_update session_name (upstream runtime/harness.ts:187).
out.push({ type: "value_update", value: "session_name", name: "named" });

// 4. value_update entry_label with undefined label (deletion omits the key).
out.push({ type: "value_update", value: "entry_label", targetId: "e1", label: undefined });

// 5. global config_update streamOptions (upstream runtime/harness.ts:242-249
//    emits `{ type, property, previous, value }`; the ported Rust wire orders
//    the value pair value-then-previous, matching the landed
//    runtime/events.rs ConfigUpdateProperty — recorded in ported order).
out.push({
	type: "config_update",
	property: "streamOptions",
	value: { timeoutMs: 123 },
	previous: {},
});

// 6. global config_update steeringMode (upstream runtime/harness.ts:283-290;
//    ported wire order as above).
out.push({
	type: "config_update",
	property: "steeringMode",
	value: "one-at-a-time",
	previous: "all",
});

// 7. global config_update tools (upstream runtime/harness.ts:227 — no value).
out.push({ type: "config_update", property: "tools" });

// 8. lane config_update model (upstream runtime/lane.ts:1659 literal order:
//    property, previous, value — ported Rust wire declared below in note).
//    The `previous` object is the serde_json Map wire (BTreeMap-sorted keys),
//    the port's mechanical substitution for JS object key order.
out.push({
	type: "config_update",
	lane: "main",
	property: "model",
	value: { provider: "faux", modelId: "faux-2" },
	previous: { modelId: "faux-1", provider: "faux" },
});

// 9. fault (upstream runtime/harness.ts:317).
out.push({ type: "fault", code: "harness_fault", message: "AgentHarness storage or invariant fault" });

// 10. handler_error hook lane-scoped (upstream runtime/harness.ts:47-58;
//     stack undefined is omitted).
out.push({
	type: "handler_error",
	kind: "hook",
	hook: "before_run",
	error: "boom",
	lane: "main",
});

// 11. handler_error event global (kind "event", stack present).
out.push({
	type: "handler_error",
	kind: "event",
	event: "message_update",
	error: "listener panicked",
	stack: "Error: listener panicked",
});

// 12. operation_abort (upstream runtime/lane.ts:1082).
out.push({
	type: "operation_abort",
	operationId: "op-1",
	steer: [],
	followUp: [],
	lane: "main",
});

// 13. navigation_start (upstream runtime/lane.ts:914).
out.push({
	type: "navigation_start",
	lane: "main",
	runId: "op-1",
	targetId: "e3",
	startedAt: 100,
});

// 14. tool_start (upstream runtime/drive/tools.ts:213-222).
out.push({
	type: "tool_start",
	lane: "main",
	runId: "op-1",
	turnId: "t1",
	toolCallId: "c1",
	toolName: "read",
	args: { path: "a" },
});

// 15. tool_update with recovery (upstream runtime/drive/tools.ts:364-377).
//     AgentToolResult omits `details` when undefined (serde skip_serializing_if).
out.push({
	type: "tool_update",
	lane: "main",
	runId: "op-1",
	turnId: "t1",
	toolCallId: "c1",
	toolName: "read",
	partialResult: { content: [{ type: "text", text: "partial" }] },
	recovery: true,
});

// 16. tool_end (upstream runtime/drive/tools.ts:277-289).
out.push({
	type: "tool_end",
	lane: "main",
	runId: "op-1",
	turnId: "t1",
	toolCallId: "c1",
	toolName: "read",
	result: { content: [{ type: "text", text: "done" }] },
	isError: false,
	terminate: false,
});

// 17. run_suspend with a deferred handle and recovery
//     (upstream agent-harness.ts:258 + DeferredHandle wire).
out.push({
	type: "run_suspend",
	lane: "main",
	runId: "op-1",
	deferred: { provider: "faux", modelId: "faux-1", api: "faux-api", id: "resp-1" },
	poll: 2,
	recovery: true,
});

// 18. usage (upstream agent-harness.ts:373 + the landed UsageRow/Usage wire:
//     session/types.ts UsageRow {id, seq, usage, entryId?, adjustment,
//     details?}; Usage {input, output, cacheRead, cacheWrite, totalTokens,
//     cost:{input, output, cacheRead, cacheWrite, total}}).
out.push({
	type: "usage",
	lane: "main",
	row: {
		id: "u1",
		seq: 1,
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		adjustment: true,
	},
	totals: {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

// 19. queue_update with a queued message item (upstream LaneQueuedItem).
out.push({
	type: "queue_update",
	lane: "main",
	queues: [
		{
			type: "message",
			entryId: "q1",
			kind: "steer",
			message: { role: "user", content: "hi", timestamp: 1 },
		},
	],
});

// 20. retry_scheduled (upstream agent-harness.ts:278-287).
out.push({
	type: "retry_scheduled",
	lane: "main",
	runId: "op-1",
	step: "assistant",
	attempt: 1,
	maxAttempts: 3,
	delayMs: 1000,
	notBefore: 1100,
	errorMessage: "rate limited",
});

// 21. navigation_end completed (upstream agent-harness.ts:367-371).
out.push({
	type: "navigation_end",
	lane: "main",
	runId: "op-1",
	status: "completed",
	fromTipId: "e1",
	tipId: "e3",
	endedAt: 200,
});

const lines = out.map((event) => JSON.stringify(event));
process.stdout.write(lines.join("\n") + "\n");
