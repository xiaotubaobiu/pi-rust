/**
 * Byte oracle for `modes/print-mode.ts` (verbatim copy, stubbed output
 * guard/shell): the three upstream `print-mode.test.ts` scenarios plus
 * multi-block text output, aborted fallback and json header cases. Prints one
 * JSON line per scenario with the exit code, captured raw stdout writes,
 * console.error calls, prompt calls and extension `session_shutdown`
 * emissions.
 */
import { runPrintMode } from "./upstream/print-mode.ts";

const capturedWrites = () => globalThis.__oracleStdout;

const emitCalls = [];

function createAssistantMessage(options = {}) {
	return {
		role: "assistant",
		content: options.content ?? (options.text ? [{ type: "text", text: options.text }] : []),
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? "stop",
		errorMessage: options.errorMessage,
		timestamp: 1700000000000,
	};
}

function createRuntimeHost(assistantMessage) {
	const state = { messages: [assistantMessage] };
	const promptCalls = [];
	const session = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: () => () => {} },
		state,
		extensionRunner: {
			hasHandlers: (eventType) => eventType === "session_shutdown",
			emit: async (event) => {
				emitCalls.push(event);
			},
		},
		bindExtensions: async () => {},
		subscribe: () => () => {},
		prompt: async (message, options) => {
			promptCalls.push({ message, options });
		},
		reload: async () => {},
	};
	return {
		session,
		promptCalls,
		newSession: async () => undefined,
		fork: async () => ({ selectedText: "" }),
		switchSession: async () => undefined,
		dispose: async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		},
		setRebindSession: () => {},
	};
}

const errors = [];
const originalConsoleError = console.error;
console.error = (...args) => errors.push(args.map(String).join(" "));

const scenarios = [];

async function runScenario(name, host, options, mutate) {
	emitCalls.length = 0;
	errors.length = 0;
	const writeStart = capturedWrites().length;
	if (mutate) mutate(host);
	const exitCode = await runPrintMode(host, options);
	scenarios.push({
		name,
		exitCode,
		promptCalls: host.promptCalls,
		emitCalls: [...emitCalls],
		errors: [...errors],
		writes: capturedWrites().slice(writeStart),
	});
}

// 1. emits session_shutdown in text mode
await runScenario(
	"text_mode_shutdown",
	createRuntimeHost(createAssistantMessage({ text: "done" })),
	{ mode: "text", initialMessage: "Say done", initialImages: [{ type: "image", mimeType: "image/png", data: "abc" }] },
);

// 2. emits session_shutdown in json mode
await runScenario("json_mode_shutdown", createRuntimeHost(createAssistantMessage({ text: "done" })), {
	mode: "json",
	messages: ["hello"],
});

// 3. emits session_shutdown and returns non-zero on assistant error
await runScenario(
	"error_stop_reason",
	createRuntimeHost(createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" })),
	{ mode: "text" },
);

// 4. text mode writes each text content block followed by a newline
await runScenario(
	"text_mode_multi_block",
	createRuntimeHost(
		createAssistantMessage({ content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }),
	),
	{ mode: "text" },
);

// 5. aborted stop reason errors with the `Request aborted` fallback
await runScenario(
	"aborted_stop_reason",
	createRuntimeHost(createAssistantMessage({ stopReason: "aborted" })),
	{ mode: "text" },
);

// 6. json mode writes the session header when present
await runScenario(
	"json_mode_header",
	createRuntimeHost(createAssistantMessage({ text: "done" })),
	{ mode: "json", initialMessage: "go" },
	(host) => {
		host.session.sessionManager.getHeader = () => ({
			type: "session",
			id: "sess-123",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/work",
		});
	},
);

// 7. last message not assistant -> no text output, exit 0
{
	const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
	host.session.state = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
	await runScenario("last_message_not_assistant", host, { mode: "text", initialMessage: "hi" });
}

// 8. no messages at all -> no output, exit 0
{
	emitCalls.length = 0;
	errors.length = 0;
	const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
	host.session.state = { messages: [] };
	const writeStart = capturedWrites().length;
	const exitCode = await runPrintMode(host, { mode: "text" });
	scenarios.push({
		name: "no_messages",
		exitCode,
		promptCalls: host.promptCalls,
		emitCalls: [...emitCalls],
		errors: [...errors],
		writes: capturedWrites().slice(writeStart),
	});
}

console.error = originalConsoleError;
process.stdout.write(scenarios.map((s) => JSON.stringify(s)).join("\n") + "\n");
