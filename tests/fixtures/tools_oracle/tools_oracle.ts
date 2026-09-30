// Node oracle: pure serialization seams copied verbatim from
// pi/packages/agent/src/harness/runtime/drive/tools.ts (SHA256
// 0dbfd29f893bd01a296cf243523db1e0fedf5b2ff7f1ce828588f33a7b16d7a3).
// syntheticMessage/abortedOutcome/interruptedOutcome/truncatedOutcome and the
// publishToolIntent/publishToolOutcome event literals, with Date.now stubbed.
// Run: node --experimental-strip-types tools_oracle.ts

Date.now = () => 1234;

const INTERRUPTION_MARKER =
	"[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]";

// tools.ts:133-148 (verbatim; AgentToolCall narrowed to the fields used)
function syntheticMessage(
	toolCall: { id: string; name: string },
	content: unknown,
	options: { details?: unknown; usage?: unknown } = {},
): unknown {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content,
		...(options.details === undefined ? {} : { details: options.details as unknown }),
		...(options.usage === undefined ? {} : { usage: options.usage }),
		isError: true,
		timestamp: Date.now(),
	};
}

// tools.ts:150-156
function abortedOutcome(toolCall: { id: string; name: string }): unknown {
	return {
		toolCall,
		message: syntheticMessage(toolCall, [{ type: "text", text: "Tool execution was cancelled before completion." }]),
		terminate: false,
	};
}

// tools.ts:158-168
function interruptedOutcome(
	toolCall: { id: string; name: string },
	checkpoint: { content: unknown[]; details?: unknown; usage?: unknown } | undefined,
): unknown {
	return {
		toolCall,
		message: syntheticMessage(
			toolCall,
			[...(checkpoint?.content ?? []), { type: "text", text: INTERRUPTION_MARKER }],
			checkpoint === undefined ? {} : { details: checkpoint.details, usage: checkpoint.usage },
		),
		terminate: false,
	};
}

// tools.ts:170-181
function truncatedOutcome(toolCall: { id: string; name: string }): unknown {
	return {
		toolCall,
		message: syntheticMessage(toolCall, [
			{
				type: "text",
				text: `Tool call ${JSON.stringify(toolCall.name)} was not executed because the assistant response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			},
		]),
		terminate: false,
	};
}

// tools.ts:211-222 (publishToolIntent commit events literal)
function intentEvents(
	lane: string,
	runId: string,
	turnId: string,
	toolCall: { id: string; name: string },
	args: unknown,
	recovery: boolean,
): unknown {
	return [
		{
			type: "tool_start",
			lane,
			runId,
			turnId,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args,
			...(recovery ? { recovery: true as const } : {}),
		},
	];
}

// tools.ts:261-288 (publishToolOutcome commit events literal)
function outcomeEvents(
	lane: string,
	runId: string,
	turnId: string,
	wasPlanned: boolean,
	toolCall: { id: string; name: string },
	args: unknown,
	result: unknown,
	isError: boolean,
	durableTerminate: boolean,
	recovery: boolean,
): unknown {
	return [
		...(wasPlanned
			? [
					{
						type: "tool_start" as const,
						lane,
						runId,
						turnId,
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args,
						...(recovery ? { recovery: true as const } : {}),
					},
				]
			: []),
		{
			type: "tool_end",
			lane,
			runId,
			turnId,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
			terminate: durableTerminate,
			...(recovery ? { recovery: true as const } : {}),
		},
	];
}

const call = { id: "call-0", name: "bash" };
const checkpoint = {
	content: [{ type: "text", text: "durable partial" }] as unknown[],
	details: { progress: "kept" },
	usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

console.log("ABORTED:", JSON.stringify(abortedOutcome(call)));
console.log("INTERRUPTED_NOCHECKPOINT:", JSON.stringify(interruptedOutcome(call, undefined)));
console.log("INTERRUPTED_CHECKPOINT:", JSON.stringify(interruptedOutcome(call, checkpoint)));
console.log("TRUNCATED:", JSON.stringify(truncatedOutcome({ id: "call-1", name: 'quo"ted' })));
console.log("INTENT_EVENTS_RECOVERY:", JSON.stringify(intentEvents("main", "op1", "turn-1", call, { value: "x" }, true)));
console.log("INTENT_EVENTS_PLAIN:", JSON.stringify(intentEvents("main", "op1", "turn-1", call, { value: "x" }, false)));
console.log(
	"OUTCOME_EVENTS_PLANNED:",
	JSON.stringify(outcomeEvents("main", "op1", "turn-1", true, call, { value: "x" }, { content: [{ type: "text", text: "done" }] }, false, false, true)),
);
console.log(
	"OUTCOME_EVENTS_PENDING:",
	JSON.stringify(outcomeEvents("main", "op1", "turn-1", false, call, { value: "x" }, { content: [], details: undefined }, true, true, false)),
);
