// Oracle for the D1–D6 experimental-cluster interface slice
// (coordinator server/connector, worker process main loop, real spawn face,
// pi-server RoutedSessionHandle/ServerError + chord control-call codec,
// chord FacetHost wiring).
//
// Extracted verbatim from the upstream sources (cross-package imports
// stubbed) so `node --experimental-strip-types` runs them standalone.
// Upstream authorities, hashed at capture time:
//   packages/coding-agent/src/experimental/coordinator.ts
//     c65c9b03ab980d12b4a0bf938b39af7462f40a79d4a4331f94cda9df0ea12b62
//   packages/coding-agent/src/experimental/session-worker.ts
//     f2ec55d9f48eb8ddb39f40e8681ce8424298742e7a2893db8f7d12923262b043
//   packages/coding-agent/src/experimental/session-worker-manager.ts
//     880d00516909d6bbb64a7108a2bc2e04c230c98f2b532be404ad6e3bb862a140
//   packages/coding-agent/src/experimental/process.ts
//     9f28b373093bb82fae889fda6fc2cb8c747a5112e3a27b2936cbd27c376a178c
//   packages/coding-agent/src/experimental/services/worker.ts
//     3d7f193d6d6fe3f5bd956e8f06bf4c3ba57ed4f2f941669d74f32225a01dcafd
//   packages/server/src/errors.ts (ServerError)
//   packages/chord/src/services/wire.ts (control-call codec)
import { writeFileSync } from "node:fs";

const out = {};

// ---- process.ts (verbatim) ----
const MAX_CONTROL_LINE_BYTES = 128 * 1024 * 1024;
function encodeControlLine(message) {
	const line = `${JSON.stringify(message)}\n`;
	if (Buffer.byteLength(line) > MAX_CONTROL_LINE_BYTES) throw new Error("Internal control message is too large");
	return line;
}
const COORDINATOR_PROTOCOL_VERSION = 3; // coordinator.ts

// ---- session-worker.ts connectControl: the register_peer handshake line ----
out.registerPeerLine = encodeControlLine({
	type: "register_peer",
	protocol: COORDINATOR_PROTOCOL_VERSION,
	peerId: "worker-1",
});

// ---- session-worker.ts control.send: the `{ send -> server }` wrappers ----
const workerReady = {
	type: "worker_ready",
	token: "worker-token",
	sessionKey: "/tmp/session-1.jsonl",
	sessionId: "session-1",
	pid: 123,
	metadata: {
		id: "session-1",
		createdAt: 1,
		storageVersion: 1,
		cwd: "/tmp",
		path: "/tmp/session-1.jsonl",
		modifiedAt: 1,
		parentSessionId: "parent-9",
	},
	pluginManifestPaths: ["/tmp/plugin/chord-facets.json"],
};
out.sendWorkerReady = encodeControlLine({ type: "send", to: "server", payload: workerReady });
out.sendWorkerFailed = encodeControlLine({
	type: "send",
	to: "server",
	payload: {
		type: "worker_failed",
		token: "worker-token",
		sessionKey: "/tmp/session-1.jsonl",
		message: "Session worker received invalid options",
	},
});
out.sendDemandApplied = encodeControlLine({
	type: "send",
	to: "server",
	payload: {
		type: "demand_applied",
		token: "worker-token",
		sessionKey: "/tmp/session-1.jsonl",
		requestId: "req-1",
		attachmentId: "att-1",
		attached: true,
	},
});

// ---- session-worker.ts run(): the base64url session-key decode ----
out.sessionKeyEncoded = Buffer.from("/tmp/session-1.jsonl").toString("base64url");
out.sessionKey = Buffer.from(out.sessionKeyEncoded, "base64url").toString();
// Node's base64url decoder is lenient: invalid characters are skipped and
// invalid UTF-8 decodes to replacement characters (the port is strict; the
// manager only ever sends its own base64url, so in-contract bytes agree).
out.lenientDecodeInvalidChar = Buffer.from("ab!c", "base64url").toString();

// ---- session-worker.ts readCommands/createJsonLineMessages destroy errors ----
out.readCommandsErrors = {
	invalidJson: "Session worker received invalid control JSON",
	invalidWorkerMessage: "Coordinator sent an invalid worker message",
};

// ---- session-worker.ts runSessionWorkerWithHarness option validation ----
function optionsError(args) {
	try {
		if (args.length !== 1) throw new Error("Session worker requires one options argument");
		let options;
		try {
			options = JSON.parse(args[0]);
		} catch (error) {
			throw new Error("Session worker received invalid options", { cause: error });
		}
		const isAbsolute = (path) => path.startsWith("/");
		const metadata = options.metadata ?? {};
		if (
			typeof options.sessionDir !== "string" ||
			typeof metadata.cwd !== "string" ||
			typeof metadata.path !== "string" ||
			!isAbsolute(options.sessionDir) ||
			!isAbsolute(metadata.cwd) ||
			!isAbsolute(metadata.path) ||
			(options.provider !== undefined && options.model === undefined)
		) {
			throw new Error("Session worker received invalid options");
		}
		return null;
	} catch (error) {
		return error.message;
	}
}
const goodOptions = JSON.stringify({
	sessionDir: "/tmp/sessions",
	metadata: {
		id: "session-1",
		createdAt: 1,
		storageVersion: 1,
		cwd: "/tmp",
		path: "/tmp/session-1.jsonl",
		modifiedAt: 1,
	},
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	pluginManifestPaths: ["/tmp/plugin/chord-facets.json"],
});
out.optionsValidation = {
	none: optionsError([]),
	two: optionsError(["a", "b"]),
	invalidJson: optionsError(["{"]),
	relativePaths: optionsError([JSON.stringify({ sessionDir: "rel", metadata: { cwd: "rel", path: "rel" } })]),
	providerWithoutModel: optionsError([
		JSON.stringify({ sessionDir: "/tmp", metadata: { cwd: "/tmp", path: "/x" }, provider: "anthropic" }),
	]),
	accepts: optionsError([goodOptions]),
};

// ---- session-worker.ts closeResources / services dispose aggregation ----
out.aggregateMessages = {
	cleanup: "Session worker cleanup failed",
	disposeFacets: "Failed to dispose Session facets",
	reloadCleanup: "Session plugin reload and cleanup failed",
	startupCleanup: "Session facets failed to start and clean up",
};

// ---- pi-server ServerError (packages/server/src/errors.ts, verbatim) ----
class ServerError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "ServerError";
		this.code = code;
	}
}
const coded = new ServerError("service_not_found", "boom");
out.serverError = { name: coded.name, code: coded.code, message: coded.message };
// session-worker-manager.ts #handleOperationResponse fallback (verbatim):
out.plainOperationError = `Session worker operation failed: boom`;

// ---- chord control-call codec (packages/chord/src/services/wire.ts) ----
const SERVICE_CONTROL_ID = "$chord.service";
function createServiceUnsubscribeCall(subscriptionId) {
	return { serviceId: SERVICE_CONTROL_ID, instance: undefined, member: "unsubscribe", args: [subscriptionId] };
}
function createServiceSubscribeCall(subscriptionId, serviceId, mode) {
	return { serviceId: SERVICE_CONTROL_ID, instance: undefined, member: "subscribe", args: [subscriptionId, serviceId, mode] };
}
function isId(value) {
	return typeof value === "string" && value.length > 0;
}
function decodeServiceControlCall(call) {
	if (call.serviceId !== SERVICE_CONTROL_ID || call.instance != null) return undefined;
	if (call.member === "catalogue" && call.args.length === 0) return { type: "catalogue" };
	if (
		call.member === "subscribe" &&
		call.args.length === 3 &&
		isId(call.args[0]) &&
		isId(call.args[1]) &&
		(call.args[2] === "singleton" || call.args[2] === "keyed")
	) {
		return { type: "subscribe", subscriptionId: call.args[0], serviceId: call.args[1], mode: call.args[2] };
	}
	if (call.member === "unsubscribe" && call.args.length === 1 && isId(call.args[0])) {
		return { type: "unsubscribe", subscriptionId: call.args[0] };
	}
	return undefined;
}
out.controlCalls = {
	unsubscribeCall: JSON.parse(JSON.stringify(createServiceUnsubscribeCall("sub-9"))),
	unsubscribeWire: encodeControlLine(createServiceUnsubscribeCall("sub-9")),
	subscribeCall: JSON.parse(JSON.stringify(createServiceSubscribeCall("sub-1", "test.session", "singleton"))),
	decodeSubscribe: decodeServiceControlCall(createServiceSubscribeCall("sub-1", "test.session", "singleton")),
	decodeUnsubscribe: decodeServiceControlCall(createServiceUnsubscribeCall("sub-9")),
	decodeCatalogue: decodeServiceControlCall({ serviceId: SERVICE_CONTROL_ID, member: "catalogue", args: [] }),
	decodeNonControl: decodeServiceControlCall({ serviceId: "test.session", member: "run", args: [] }),
	decodeInstanceControl: decodeServiceControlCall({
		serviceId: SERVICE_CONTROL_ID,
		instance: { key: "k", generation: 2 },
		member: "unsubscribe",
		args: ["s"],
	}),
};

writeFileSync(new URL("./oracle_output.json", import.meta.url), `${JSON.stringify(out, null, "\t")}\n`);
console.log("captured", Object.keys(out).length, "scenarios");
