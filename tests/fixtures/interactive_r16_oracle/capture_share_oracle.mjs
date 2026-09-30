// Oracle capture for the interactive r16 slice (modes/interactive:
// model-search.ts, session-export.ts + session-share.ts deterministic core).
// Convention as scratch/agent_session_oracle (W3.11/W3.12): the pure upstream
// function bodies are copied VERBATIM below (each copy names its source file
// and line range; the only mutation is injecting the export timestamp, which
// upstream reads from `new Date().toISOString()` — non-injectable). Direct
// module imports would pull npm dependencies that are not installed in this
// checkout. The Rust test must byte-match these outputs given the same
// fixture, timestamp, share id, and presentation payload.
//
// Run: node --experimental-strip-types capture_share_oracle.mjs > share_oracle.json

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// Injected fixed clock (upstream: `new Date().toISOString()` at
// session-export.ts:25 and :23; shared by header and trailing entries).
const FIXED_NOW = "2026-02-03T04:05:06.789Z";

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/session-export.ts:15-41
// (mutation: `nowIso` parameter replaces both `new Date().toISOString()` reads;
// `outputPath` is always provided so the default-name branch is dead here)
// ---------------------------------------------------------------------------
function exportSessionToJsonl(
	sessionManager,
	outputPath,
	createTrailingEntries,
	nowIso = () => new Date().toISOString(),
) {
	const filePath = outputPath;
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const timestamp = nowIso();
	const header = {
		type: "session",
		version: 3,
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
// VERBATIM COPY: pi/packages/coding-agent/src/modes/interactive/session-share.ts:25-43
// (mutation: `crypto.randomUUID().slice(0, 8)` becomes the `shareId`
// parameter, and the presentation payload is passed in instead of being read
// off a live AgentSession; the exportSessionToJsonl call forwards `nowIso`)
// ---------------------------------------------------------------------------
function exportSessionForShare(filePath, presentation, shareId, nowIso) {
	exportSessionToJsonl(
		presentation.sessionManager,
		filePath,
		(parentId, timestamp) => [
			{
				type: "custom",
				customType: "pi.share",
				id: shareId,
				parentId,
				timestamp,
				data: {
					systemPrompt: presentation.systemPrompt,
					tools: presentation.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})),
				},
			},
		],
		nowIso,
	);
}

// ---------------------------------------------------------------------------
// Fixture: a session document whose entry lines are shaped exactly as the
// pi session-manager writes them (header + 3 chained message entries). The
// Rust test writes the same fixture bytes and opens them with the ported
// SessionManager before exporting.
// ---------------------------------------------------------------------------
const FIXTURE_SESSION_ID = "sess-oracle-16";
const FIXTURE_CWD = 'C:\\pi-oracle-cwd';
const fixtureLines = [
	`{"type":"session","version":3,"id":"${FIXTURE_SESSION_ID}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${FIXTURE_CWD}"}`,
	`{"type":"message","id":"e-user-1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello","timestamp":1767225601000}}`,
	`{"type":"message","id":"e-asst-1","parentId":"e-user-1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"calling tool"}],"api":"anthropic-messages","provider":"anthropic","model":"test","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1767225602000}}`,
	`{"type":"message","id":"e-tool-1","parentId":"e-asst-1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"call-1","toolName":"share_tool","content":[{"type":"text","text":"done"}],"details":{},"isError":false,"timestamp":1767225603000}}`,
];
const fixtureBranch = fixtureLines.slice(1).map((line) => JSON.parse(line));
const fakeManager = {
	getSessionId: () => FIXTURE_SESSION_ID,
	getCwd: () => FIXTURE_CWD,
	getBranch: () => fixtureBranch,
};

const presentation = {
	sessionManager: fakeManager,
	systemPrompt: "You are pi.",
	tools: [
		{
			name: "share_tool",
			description: "Render a value for sharing",
			parameters: {
				type: "object",
				properties: { value: { type: "string", description: "Value to render" } },
				required: ["value"],
			},
		},
	],
};

// 1. Plain export (AgentSession.exportToJsonl path: no trailing entries).
const normalPath = "tmp/oracle-normal.jsonl";
exportSessionToJsonl(fakeManager, normalPath, undefined, () => FIXED_NOW);

// 2. Share export (exportSessionForShare path with a fixed 8-char share id).
const sharePath = "tmp/oracle-share.jsonl";
exportSessionForShare(sharePath, presentation, "abcd1234", () => FIXED_NOW);

import { readFileSync } from "node:fs";
console.log(
	JSON.stringify(
		{
			fixture: fixtureLines.join("\n") + "\n",
			normal: readFileSync(normalPath, "utf8"),
			share: readFileSync(sharePath, "utf8"),
		},
		null,
		2,
	),
);
