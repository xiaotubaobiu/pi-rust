/**
 * Byte oracle for `modes/rpc/rpc-mode.ts` (verbatim copy with stubbed output
 * guard / shell / theme / jsonl stdin attachment): drives `runRpcMode` with a
 * stub session + runtime host and records the exact stdout frames for every
 * deterministic command, the extension UI request frames (UUID ids
 * normalized to "<uuid>"), event passthrough, extension errors and the
 * shutdown flow (process.exit recorded, not called).
 */
import { runRpcMode } from "./upstream/rpc/rpc-mode.ts";

const capturedWrites = () => globalThis.__oracleStdout;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Stub session / runtime host
// ---------------------------------------------------------------------------

const userMessage = {
	role: "user",
	content: [{ type: "text", text: "hi" }],
	timestamp: 1700000000000,
};

const entry1 = { type: "message", id: "m1", message: userMessage, timestamp: "t1" };

const sessionStub = {
	// state read by get_state
	model: { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200000, reasoning: true },
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	sessionFile: "/tmp/sess.jsonl",
	sessionId: "sess-123",
	sessionName: "my session",
	autoCompactionEnabled: true,
	messages: [userMessage],
	pendingMessageCount: 2,

	// collaborators
	sessionManager: { getHeader: () => undefined, getCwd: () => "/work", getEntries: () => [entry1], getLeafId: () => "m1", getTree: () => [{ entry: entry1, children: [] }] },
	modelRuntime: { getAvailableSnapshot: () => [] },
	extensionRunner: {
		emitUserBash: async (event) => {
			userBashEvents.push(event);
			if (event.command === "echo hi") {
				return { result: { output: "hi\n", exitCode: 0, cancelled: false, truncated: false } };
			}
			return null;
		},
		getRegisteredCommands: () => [
			{ invocationName: "extcmd", description: "ext desc", sourceInfo: { path: "/p/ext.ts", source: "extension", scope: "project", origin: "top-level" } },
		],
	},
	promptTemplates: [
		{ name: "greet", description: "say hi", sourceInfo: { path: "/p/greet.md", source: "prompt", scope: "user", origin: "top-level" } },
	],
	resourceLoader: {
		getSkills: () => ({
			skills: [{ name: "commit", description: "commit msg", sourceInfo: { path: "/s/SKILL.md", source: "skill", scope: "project", origin: "top-level" } }],
		}),
	},

	// recorded calls
	promptCalls: [],
	recordedBashResults: [],
	recordedSessionName: undefined,
	recordedThinkingLevels: [],
	recordedModes: [],
	recordedFlags: {},

	// methods
	subscribe: (listener) => {
		(globalThis).__oracleSessionListener = listener;
		return () => {
			(globalThis).__oracleSessionListener = undefined;
		};
	},
	agent: {
		subscribe: (cb) => {
			(globalThis).__oracleAgentListener = cb;
			return () => {};
		},
	},
	bindExtensions: async (bindings) => {
		(globalThis).__oracleBindings = bindings;
	},
	prompt: async (message, options) => {
		sessionStub.promptCalls.push({ message, options });
		if (options?.preflightResult) options.preflightResult(message !== "Bad");
		if (message === "Bad") throw new Error("auth exploded");
	},
	steer: async () => {},
	followUp: async () => {},
	abort: async () => {},
	clearQueue: () => ({ steering: ["Change direction"], followUp: ["Summarize when finished"] }),
	setThinkingLevel: (level) => sessionStub.recordedThinkingLevels.push(level),
	cycleThinkingLevel: () => null,
	cycleModel: async () => null,
	getAvailableThinkingLevels: () => ["off", "medium", "high"],
	setSteeringMode: (mode) => sessionStub.recordedModes.push(["steering", mode]),
	setFollowUpMode: (mode) => sessionStub.recordedModes.push(["followUp", mode]),
	compact: async () => ({ summary: "sum", tokensBefore: 100, tokensAfter: 20 }),
	setAutoCompactionEnabled: (enabled) => {
		sessionStub.recordedFlags.autoCompaction = enabled;
	},
	setAutoRetryEnabled: (enabled) => {
		sessionStub.recordedFlags.autoRetry = enabled;
	},
	abortRetry: () => {
		sessionStub.recordedFlags.abortRetry = true;
	},
	abortBash: () => {
		sessionStub.recordedFlags.abortBash = true;
	},
	recordBashResult: (command, result, options) => {
		sessionStub.recordedBashResults.push({ command, result, options });
	},
	executeBash: async () => ({ output: "ho\n", exitCode: 0, cancelled: false, truncated: false }),
	getSessionStats: () => ({
		sessionFile: "/tmp/sess.jsonl",
		sessionId: "sess-123",
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 2,
		tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
		cost: 0.5,
		contextUsage: { tokens: 10, contextWindow: 200000, percent: 0.005 },
	}),
	exportToHtml: async () => "/x/out.html",
	getUserMessagesForForking: () => [{ entryId: "m1", text: "hi" }],
	getLastAssistantText: () => "done",
	setSessionName: (name) => {
		sessionStub.recordedSessionName = name;
	},
	reload: async () => {},
};

const userBashEvents = [];

const hostStub = {
	session: sessionStub,
	newSessionCalls: [],
	switchSessionCalls: [],
	forkCalls: [],
	disposed: 0,
	newSession: async (options) => {
		hostStub.newSessionCalls.push(options);
		return { cancelled: true };
	},
	switchSession: async (sessionPath, options) => {
		hostStub.switchSessionCalls.push({ sessionPath, options });
		return { cancelled: true };
	},
	fork: async (entryId, options) => {
		hostStub.forkCalls.push({ entryId, options });
		return { cancelled: true, selectedText: "picked text" };
	},
	dispose: async () => {
		hostStub.disposed += 1;
	},
	setRebindSession: () => {},
};

// ---------------------------------------------------------------------------
// Drive the mode
// ---------------------------------------------------------------------------

const exits = [];
const realExit = process.exit;
process.exit = (code) => {
	exits.push(code);
};

void runRpcMode(hostStub);
for (let i = 0; i < 500 && !(globalThis).__oracleLineHandler; i++) await sleep(2);
const feed = async (line) => {
	capturedWrites().__oracleMarker = undefined;
	const start = capturedWrites().length;
	(globalThis).__oracleLineHandler(line);
	await sleep(10);
	return capturedWrites().slice(start);
};

const records = [];

records.push({ cmd: "not json", out: await feed("not json") });
records.push({ cmd: '{"id":"u1","type":"bogus"}', out: await feed('{"id":"u1","type":"bogus"}') });
records.push({ cmd: '{"id":"s1","type":"set_session_name","name":"   "}', out: await feed('{"id":"s1","type":"set_session_name","name":"   "}'), sessionName: sessionStub.recordedSessionName });
sessionStub.recordedSessionName = undefined;
records.push({ cmd: '{"id":"s2","type":"set_session_name","name":"  my session  "}', out: await feed('{"id":"s2","type":"set_session_name","name":"  my session  "}'), sessionName: sessionStub.recordedSessionName });
records.push({ cmd: '{"id":"e1","type":"get_entries","since":"nope"}', out: await feed('{"id":"e1","type":"get_entries","since":"nope"}') });
records.push({ cmd: '{"id":"e2","type":"get_entries"}', out: await feed('{"id":"e2","type":"get_entries"}') });
records.push({ cmd: '{"id":"tr1","type":"get_tree"}', out: await feed('{"id":"tr1","type":"get_tree"}') });
records.push({ cmd: '{"id":"c1","type":"clear_queue"}', out: await feed('{"id":"c1","type":"clear_queue"}') });
records.push({ cmd: '{"id":"g1","type":"get_state"}', out: await feed('{"id":"g1","type":"get_state"}') });
records.push({ cmd: '{"id":"p1","type":"prompt","message":"Hello"}', out: await feed('{"id":"p1","type":"prompt","message":"Hello"}'), promptCalls: sessionStub.promptCalls.length });
records.push({ cmd: '{"id":"p2","type":"prompt","message":"Bad"}', out: await feed('{"id":"p2","type":"prompt","message":"Bad"}') });
records.push({ cmd: '{"id":"p3","type":"prompt","message":"Queue","streamingBehavior":"followUp"}', out: await feed('{"id":"p3","type":"prompt","message":"Queue","streamingBehavior":"followUp"}') });
records.push({ cmd: '{"id":"t1","type":"set_thinking_level","level":"high"}', out: await feed('{"id":"t1","type":"set_thinking_level","level":"high"}'), levels: [...sessionStub.recordedThinkingLevels] });
records.push({ cmd: '{"id":"t2","type":"cycle_thinking_level"}', out: await feed('{"id":"t2","type":"cycle_thinking_level"}') });
records.push({ cmd: '{"id":"t3","type":"get_available_thinking_levels"}', out: await feed('{"id":"t3","type":"get_available_thinking_levels"}') });
records.push({ cmd: '{"id":"sm2","type":"set_steering_mode","mode":"one-at-a-time"}', out: await feed('{"id":"sm2","type":"set_steering_mode","mode":"one-at-a-time"}') });
records.push({ cmd: '{"id":"fu1","type":"set_follow_up_mode","mode":"all"}', out: await feed('{"id":"fu1","type":"set_follow_up_mode","mode":"all"}') });
records.push({ cmd: '{"id":"ac1","type":"set_auto_compaction","enabled":false}', out: await feed('{"id":"ac1","type":"set_auto_compaction","enabled":false}') });
records.push({ cmd: '{"id":"ar1","type":"set_auto_retry","enabled":true}', out: await feed('{"id":"ar1","type":"set_auto_retry","enabled":true}') });
records.push({ cmd: '{"id":"ar2","type":"abort_retry"}', out: await feed('{"id":"ar2","type":"abort_retry"}') });
records.push({ cmd: '{"id":"ab1","type":"abort_bash"}', out: await feed('{"id":"ab1","type":"abort_bash"}') });
records.push({ cmd: '{"id":"st1","type":"get_session_stats"}', out: await feed('{"id":"st1","type":"get_session_stats"}') });
records.push({ cmd: '{"id":"ex1","type":"export_html","outputPath":"/x/out.html"}', out: await feed('{"id":"ex1","type":"export_html","outputPath":"/x/out.html"}') });
records.push({ cmd: '{"id":"cp1","type":"compact"}', out: await feed('{"id":"cp1","type":"compact"}') });
records.push({ cmd: '{"id":"ss1","type":"switch_session","sessionPath":"/x"}', out: await feed('{"id":"ss1","type":"switch_session","sessionPath":"/x"}'), switchCalls: hostStub.switchSessionCalls.length });
records.push({ cmd: '{"id":"ns1","type":"new_session"}', out: await feed('{"id":"ns1","type":"new_session"}'), newSessionCalls: hostStub.newSessionCalls.length });
records.push({ cmd: '{"id":"fk1","type":"fork","entryId":"e9"}', out: await feed('{"id":"fk1","type":"fork","entryId":"e9"}'), forkCalls: hostStub.forkCalls.length });
records.push({ cmd: '{"id":"f1","type":"get_fork_messages"}', out: await feed('{"id":"f1","type":"get_fork_messages"}') });
records.push({ cmd: '{"id":"z1","type":"get_last_assistant_text"}', out: await feed('{"id":"z1","type":"get_last_assistant_text"}') });
records.push({ cmd: '{"id":"m1","type":"get_messages"}', out: await feed('{"id":"m1","type":"get_messages"}') });
records.push({ cmd: '{"id":"k1","type":"get_commands"}', out: await feed('{"id":"k1","type":"get_commands"}') });
records.push({ cmd: '{"id":"sm1","type":"set_model","provider":"anthropic","modelId":"claude-sonnet-4-5"}', out: await feed('{"id":"sm1","type":"set_model","provider":"anthropic","modelId":"claude-sonnet-4-5"}') });
records.push({ cmd: '{"id":"cm1","type":"cycle_model"}', out: await feed('{"id":"cm1","type":"cycle_model"}') });
records.push({ cmd: '{"id":"cl1","type":"clone"}', out: await feed('{"id":"cl1","type":"clone"}'), forkCalls: hostStub.forkCalls.length });
records.push({ cmd: '{"id":"av1","type":"get_available_models"}', out: await feed('{"id":"av1","type":"get_available_models"}') });
records.push({ cmd: '{"id":"b1","type":"bash","command":"echo hi"}', out: await feed('{"id":"b1","type":"bash","command":"echo hi"}'), userBashEvents: [...userBashEvents], recordedBashResults: [...sessionStub.recordedBashResults] });
records.push({ cmd: '{"id":"b2","type":"bash","command":"echo ho"}', out: await feed('{"id":"b2","type":"bash","command":"echo ho"}') });

// Event passthrough through the session subscription.
{
	const start = capturedWrites().length;
	(globalThis).__oracleSessionListener({ type: "agent_start" });
	records.push({ cmd: "<session event agent_start>", out: capturedWrites().slice(start) });
}

// Extension error path.
{
	const start = capturedWrites().length;
	(globalThis).__oracleBindings.onError({ extensionPath: "/x.ts", event: "session_start", error: "kaputt" });
	records.push({ cmd: "<extension error>", out: capturedWrites().slice(start) });
}

// Extension UI request/response flows (UUID ids normalized at print time).
const ui = (globalThis).__oracleBindings.uiContext;
const lastFrameId = () => {
	const frame = JSON.parse(capturedWrites()[capturedWrites().length - 1]);
	return frame.id;
};

{
	const start = capturedWrites().length;
	let resolved;
	const promise = ui.select("Pick one", ["a", "b"], {}).then((value) => {
		resolved = value;
	});
	await sleep(5);
	const requestFrames = capturedWrites().slice(start);
	records.push({ ui: "select", out: requestFrames });
	await feed(JSON.stringify({ type: "extension_ui_response", id: lastFrameId(), value: "a" }));
	await promise;
	records.push({ ui: "select resolved", value: resolved });
}
{
	const start = capturedWrites().length;
	let resolved;
	const promise = ui.confirm("Sure?", "really", { timeout: 1000 }).then((value) => {
		resolved = value;
	});
	await sleep(5);
	records.push({ ui: "confirm", out: capturedWrites().slice(start) });
	await feed(JSON.stringify({ type: "extension_ui_response", id: lastFrameId(), confirmed: true }));
	await promise;
	records.push({ ui: "confirm resolved", value: resolved });
}
{
	const start = capturedWrites().length;
	let resolved;
	const promise = ui.input("Name", "your name", {}).then((value) => {
		resolved = value;
	});
	await sleep(5);
	records.push({ ui: "input", out: capturedWrites().slice(start) });
	await feed(JSON.stringify({ type: "extension_ui_response", id: lastFrameId(), value: "bob" }));
	await promise;
	records.push({ ui: "input resolved", value: resolved });
}
{
	const start = capturedWrites().length;
	let resolved;
	const promise = ui.editor("Edit", "prefill text").then((value) => {
		resolved = value;
	});
	await sleep(5);
	records.push({ ui: "editor", out: capturedWrites().slice(start) });
	await feed(JSON.stringify({ type: "extension_ui_response", id: lastFrameId(), cancelled: true }));
	await promise;
	records.push({ ui: "editor resolved", value: resolved });
}
{
	const start = capturedWrites().length;
	ui.notify("heads up", "warning");
	await sleep(5);
	records.push({ ui: "notify", out: capturedWrites().slice(start) });
}
{
	const start = capturedWrites().length;
	ui.setStatus("k", "v");
	await sleep(5);
	records.push({ ui: "setStatus", out: capturedWrites().slice(start) });
}
{
	const start = capturedWrites().length;
	ui.setWidget("w", ["l1", "l2"], { placement: "aboveEditor" });
	await sleep(5);
	records.push({ ui: "setWidget", out: capturedWrites().slice(start) });
}
{
	const start = capturedWrites().length;
	ui.setWidget("w2", undefined, {});
	await sleep(5);
	records.push({ ui: "setWidget undefined", out: capturedWrites().slice(start) });
}
{
	const start = capturedWrites().length;
	ui.setWidget("w3", () => "component factory", {});
	await sleep(5);
	records.push({ ui: "setWidget factory (ignored)", out: capturedWrites().slice(start) });
}
{
	const start = capturedWrites().length;
	ui.setTitle("T");
	await sleep(5);
	records.push({ ui: "setTitle", out: capturedWrites().slice(start) });
}
{
	const start = capturedWrites().length;
	ui.setEditorText("abc");
	await sleep(5);
	records.push({ ui: "setEditorText", out: capturedWrites().slice(start) });
}
{
	const start = capturedWrites().length;
	ui.pasteToEditor("xyz");
	await sleep(5);
	records.push({ ui: "pasteToEditor", out: capturedWrites().slice(start) });
}
records.push({ ui: "getEditorText", value: ui.getEditorText() });
records.push({ ui: "setTheme", value: ui.setTheme("dark") });
records.push({ ui: "getAllThemes", value: ui.getAllThemes() });
records.push({ ui: "getTheme", value: ui.getTheme("dark") });
records.push({ ui: "getToolsExpanded", value: ui.getToolsExpanded() });

// Shutdown flow: shutdown request then a command triggers shutdown after the
// response; process.exit is recorded instead of killing the driver.
(globalThis).__oracleBindings.shutdownHandler();
records.push({ cmd: '{"id":"fin","type":"get_state"}', out: await feed('{"id":"fin","type":"get_state"}'), exits: [...exits], disposed: hostStub.disposed });

process.exit = realExit;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const normalized = JSON.stringify(records).replaceAll(UUID, "<uuid>");
process.stdout.write(normalized + "\n");
