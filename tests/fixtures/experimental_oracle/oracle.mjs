// Oracle for M5 W3.16 experimental deterministic core.
// Extracted verbatim from upstream sources (imports stubbed) so
// `node --experimental-strip-types` can run them standalone.
// Upstream authorities:
//   pi/packages/coding-agent/src/experimental/process.ts
//     (sha256 9f28b373093bb82fae889fda6fc2cb8c747a5112e3a27b2936cbd27c376a178c)
//   pi/packages/coding-agent/src/experimental/source-resolver.ts
//     (sha256 c584d52fb68860c0c6ae5dfbbcb6052fa104d6e34c7ef231b9e6eb7e0ec5b2a6)
import { writeFileSync } from "node:fs";

// ---- process.ts (verbatim functions) ----
export const INTERNAL_PROCESS_ENV = "__PI_INTERNAL_SPAWN";
export const MAX_CONTROL_LINE_BYTES = 128 * 1024 * 1024;
export function encodeControlLine(message) {
	const line = `${JSON.stringify(message)}\n`;
	if (Buffer.byteLength(line) > MAX_CONTROL_LINE_BYTES) throw new Error("Internal control message is too large");
	return line;
}

const out = {};

out.encodeControlLine = [
	encodeControlLine({ type: "shutdown" }),
	encodeControlLine({ type: "session_demand", serverConnectionId: "server-generation-1", requestId: "req-1", attachmentId: "att-1", attached: true }),
	encodeControlLine({
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
	}),
	encodeControlLine({
		type: "operation_response",
		token: "worker-token",
		sessionKey: "/tmp/session-1.jsonl",
		response: { type: "operation_result", requestId: "req-2", scope: { serverConnectionId: "server-generation-1", attachmentId: "att-1" }, result: { accepted: true } },
	}),
	encodeControlLine({
		type: "operation",
		requestId: "req-3",
		scope: { serverConnectionId: "server-generation-1", attachmentId: "att-2" },
		call: { serviceId: "test.session", instance: { key: "k", generation: 2 }, member: "run", args: ["Hello", 3, null, { nested: true }] },
	}),
	encodeControlLine({ type: "peer_registered", peerId: "worker-abc", serverConnectionId: "srv-1" }),
	encodeControlLine({ type: "peer_registered", peerId: "worker-abc" }),
	encodeControlLine({ type: "server_registered", serverConnectionId: "srv-1", peers: ["a", "b"] }),
];
try {
	encodeControlLine({ big: "x".repeat(128 * 1024 * 1024) });
	out.tooLarge = null;
} catch (error) {
	out.tooLarge = error.message;
}

// role validation (process.ts getInternalProcessRole error text)
function getInternalProcessRole(role) {
	if (role === undefined) return undefined;
	if (role === "coordinator" || role === "server" || role === "session-worker") return role;
	throw new Error(`Unsupported internal process role: ${role}`);
}
out.roles = [getInternalProcessRole("coordinator"), getInternalProcessRole("server"), getInternalProcessRole("session-worker")];
try {
	getInternalProcessRole("bogus");
	out.roleError = null;
} catch (error) {
	out.roleError = error.message;
}

// lifecycleDelay error text (session-worker.ts)
function lifecycleDelay(value, name, fallback) {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative safe integer`);
	return parsed;
}
out.lifecycleDelay = [
	lifecycleDelay(undefined, "ENV", 42),
	lifecycleDelay("7", "ENV", 42),
	lifecycleDelay("0", "ENV", 42),
];
try {
	lifecycleDelay("-1", "__ENV_X", 42);
} catch (error) {
	out.lifecycleDelayError = error.message;
}
try {
	lifecycleDelay("1.5", "__ENV_X", 42);
} catch (error) {
	out.lifecycleDelayError2 = error.message;
}

// demandKey / scoped keys (session-worker.ts, session-worker-manager.ts)
out.keys = [
	`${"server-generation-1"}\0${"attachment-1"}`,
	`${"srv"}\0${"att"}\0${"sub"}`,
];

// ---- source-resolver.ts (verbatim pure functions over injected fs) ----
function matchAlias(alias, specifier) {
	if (!alias.pattern.includes("*")) return specifier === alias.pattern ? "" : undefined;
	if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) return undefined;
	return specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
}

const paths = {
	"@earendil-works/chord": ["packages/chord/src/index.ts"],
	"@earendil-works/pi-agent-core": ["packages/agent-core/src/index.ts"],
	"@earendil-works/pi-agent-core/node": ["packages/agent-core/src/node.ts"],
	"@earendil-works/pi-*": ["packages/pi-*/src/index.ts"],
	"@earendil-works/legacy.js": ["packages/legacy/src/legacy.js"],
	"@earendil-works/dir": ["packages/dir/src/missing-file"],
};
const aliases = Object.entries(paths)
	.map(([pattern, replacements]) => {
		const wildcard = pattern.indexOf("*");
		if (wildcard !== -1 && pattern.indexOf("*", wildcard + 1) !== -1) {
			throw new Error(`Source runtime does not support multiple wildcards in ${pattern}`);
		}
		return {
			pattern,
			prefix: wildcard === -1 ? pattern : pattern.slice(0, wildcard),
			suffix: wildcard === -1 ? "" : pattern.slice(wildcard + 1),
			replacements,
		};
	})
	.sort((left, right) => right.pattern.length - left.pattern.length);

out.aliasOrder = aliases.map((alias) => alias.pattern);
out.matches = [
	matchAlias(aliases.find((a) => a.pattern === "@earendil-works/chord"), "@earendil-works/chord"),
	matchAlias(aliases.find((a) => a.pattern === "@earendil-works/chord"), "@earendil-works/chordx"),
	matchAlias(aliases.find((a) => a.pattern === "@earendil-works/pi-*"), "@earendil-works/pi-server"),
	matchAlias(aliases.find((a) => a.pattern === "@earendil-works/pi-*"), "@earendil-works/px-server"),
	matchAlias(aliases.find((a) => a.pattern === "@earendil-works/pi-agent-core/node"), "@earendil-works/pi-agent-core/node"),
];

function resolveSourcePath(replacement) {
	return replacement;
}
out.aliasResolution = [
	aliases
		.map((alias) => {
			const wildcard = matchAlias(alias, "@earendil-works/pi-server");
			if (wildcard === undefined) return null;
			return alias.replacements.map((r) => r.replace("*", wildcard));
		})
		.filter((entry) => entry !== null)
		.flat(),
];

writeFileSync(new URL("./oracle_output.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("oracle ok");
