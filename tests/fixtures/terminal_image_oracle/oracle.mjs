// Oracle runner for the terminal-image.ts slice: executes the REAL upstream
// `terminal-image.ts` under node and captures exact outputs per scenario. The
// copy in this directory is sha256-verified against the read-only upstream
// original; see the slice report. Output: oracle_output.json (canonical JSON,
// keys sorted by gen_consts.mjs before embedding into Rust).
//
// Determinism notes:
// - Every `detectCapabilities` call injects the tmux probe (never shells out).
// - imageFallback scenarios pin USERPROFILE to a fake home (os.homedir()
//   re-reads it per call) and avoid cwd-dependent posix-style absolute paths
//   (pathToFileURL resolves those against the current drive on win32).
// - registryFlow is replayed against a fresh registry by the Rust side, so
//   gen_consts.mjs rewrites transmissionGeneration values relative to the
//   first generation observed inside the flow.
// - `empty`/`colorterm 24bit alone` detect scenarios depend on
//   process.platform === "win32"; the Rust replay passes cfg!(windows).
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import os from "node:os";
import {
	allocateImageId,
	calculateImageCellSize,
	calculateImageRows,
	cropKittyImageLine,
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getKittyImageMetadata,
	getKittyImagePlacement,
	getPngDimensions,
	getWebpDimensions,
	hyperlink,
	imageFallback,
	isImageLine,
	registerKittyImageMetadata,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	setCapabilityOverrides,
} from "./terminal-image.ts";

const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"TERMINAL_EMULATOR",
	"COLORTERM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"CMUX_WORKSPACE_ID",
	"WARP_SESSION_ID",
	"WARP_TERMINAL_SESSION_UUID",
	"PI_HYPERLINKS",
	"PI_IMAGE_PROTOCOL",
	"PI_TRUE_COLOR",
];

function withEnv(overrides, fn) {
	const saved = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		for (const [k, v] of Object.entries(overrides)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		return fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

const out = {};
out.meta = {
	node: process.version,
	platform: process.platform,
	upstreamSha256: createHash("sha256").update(readFileSync(new URL("./terminal-image.ts", import.meta.url))).digest("hex"),
};

// ---------------------------------------------------------------- base64
// Empirical probe of node Buffer base64 decode/byteLength semantics; the Rust
// base64 module must reproduce every row (drives the forgiving decoder).
const B64_INPUTS = [
	"QQ==", "Q", "QQ", "QQQ", "QQ==QQ==", "QQ QQ", "Q@Q=", "--__", "!!!!",
	"iVBORw0KGgo=", "AAAA", "AA==", "A=", "=AAA", "QQ=Q", "A==", "A===",
	"AB=", "AB==", "AB===", "=", "==", "===", "ABC", "ABCD", "AB=CD",
	"A B==", "AB==CD", "R0lGOHcAAAA=",
];
out.base64Decode = B64_INPUTS.map((s) => {
	const b = Buffer.from(s, "base64");
	return { input: s, len: b.length, hex: b.toString("hex") };
});
out.base64ByteLength = B64_INPUTS.map((s) => ({ input: s, n: Buffer.byteLength(s, "base64") }));

// ---------------------------------------------------------------- detect
// {name, env, probe:true|false} -> detected caps + whether the probe ran.
const DETECT_CASES = [
	{ name: "empty", env: {}, probe: false },
	{ name: "pi overrides on", env: { PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty", PI_TRUE_COLOR: "1" }, probe: false },
	{
		name: "pi overrides off with iterm detected",
		env: { TERM_PROGRAM: "iterm.app", PI_HYPERLINKS: "0", PI_IMAGE_PROTOCOL: "none", PI_TRUE_COLOR: "0" },
		probe: false,
	},
	{
		name: "auto overrides preserve detection",
		env: { TERM_PROGRAM: "ghostty", PI_HYPERLINKS: "auto", PI_IMAGE_PROTOCOL: "auto", PI_TRUE_COLOR: "auto" },
		probe: false,
	},
	{
		name: "hyperlink override bypasses tmux probe",
		env: { TMUX: "/tmp/tmux-1000/default,1234,0", PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty" },
		probe: false,
	},
	{ name: "tmux forwards hyperlinks", env: { TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, probe: true },
	{ name: "tmux without hyperlinks", env: { TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, probe: false },
	{ name: "TERM tmux prefix forwards", env: { TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" }, probe: true },
	{ name: "TERM tmux prefix no forwards", env: { TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" }, probe: false },
	{ name: "screen forces hyperlinks off", env: { TERM: "screen-256color" }, probe: false },
	{ name: "ghostty term program", env: { TERM_PROGRAM: "ghostty" }, probe: false },
	{ name: "ghostty keeps images with cmux", env: { TERM_PROGRAM: "ghostty", CMUX_WORKSPACE_ID: "workspace" }, probe: false },
	{ name: "kitty window id", env: { KITTY_WINDOW_ID: "1" }, probe: false },
	{ name: "wezterm pane", env: { WEZTERM_PANE: "0" }, probe: false },
	{ name: "warp term program", env: { TERM_PROGRAM: "WarpTerminal" }, probe: false },
	{ name: "warp session id", env: { WARP_SESSION_ID: "some-session-id" }, probe: false },
	{
		name: "warp terminal session uuid",
		env: { WARP_TERMINAL_SESSION_UUID: "d0e1a2e5-7ca7-44cd-9037-ac7222011161" },
		probe: false,
	},
	{
		name: "warp inside tmux",
		env: { TERM_PROGRAM: "WarpTerminal", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" },
		probe: true,
	},
	{ name: "iterm term program", env: { TERM_PROGRAM: "iterm.app" }, probe: false },
	{ name: "vscode term program", env: { TERM_PROGRAM: "vscode" }, probe: false },
	{ name: "zed term program", env: { TERM_PROGRAM: "zed" }, probe: false },
	{ name: "alacritty term program", env: { TERM_PROGRAM: "alacritty" }, probe: false },
	{ name: "wt session", env: { WT_SESSION: "session", TERM: "xterm-256color" }, probe: false },
	{ name: "jetbrains jediterm", env: { TERMINAL_EMULATOR: "JetBrains-JediTerm", TERM: "xterm-256color" }, probe: false },
	{
		name: "wt session through tmux",
		env: { WT_SESSION: "session", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" },
		probe: false,
	},
	{
		name: "truecolor hint through tmux",
		env: { COLORTERM: "truecolor", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" },
		probe: false,
	},
	{ name: "term contains ghostty", env: { TERM: "xterm-ghostty" }, probe: false },
	{ name: "ghostty resources dir", env: { GHOSTTY_RESOURCES_DIR: "/x" }, probe: false },
	{ name: "term program case insensitive", env: { TERM_PROGRAM: "Ghostty" }, probe: false },
	{ name: "colorterm 24bit alone", env: { COLORTERM: "24bit" }, probe: false },
	{
		name: "kitty window id inside tmux",
		env: { KITTY_WINDOW_ID: "1", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" },
		probe: true,
	},
];
out.detect = DETECT_CASES.map((c) =>
	withEnv(c.env, () => {
		let probeCalled = false;
		const caps = detectCapabilities(() => {
			probeCalled = true;
			return c.probe;
		});
		return {
			name: c.name,
			env: c.env,
			probe: c.probe,
			probeCalled,
			images: caps.images,
			trueColor: caps.trueColor,
			hyperlinks: caps.hyperlinks,
		};
	})
);

// Programmatic override flow: the equality short-circuit must keep the cache
// alive; a different override must drop it.
function getCapabilitiesSnapshot() {
	const caps = getCapabilities();
	return { images: caps.images, trueColor: caps.trueColor, hyperlinks: caps.hyperlinks };
}
out.overrideFlow = withEnv({ PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty", PI_TRUE_COLOR: "1" }, () => {
	const steps = [];
	setCapabilityOverrides({ images: null, trueColor: false, hyperlinks: false });
	steps.push({ step: "after override all-off", caps: getCapabilitiesSnapshot() });
	setCapabilityOverrides({ images: null, trueColor: false, hyperlinks: false });
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
	steps.push({ step: "equal override kept cache (pinned caps survive)", caps: getCapabilitiesSnapshot() });
	setCapabilityOverrides({ images: "kitty", trueColor: true, hyperlinks: true });
	steps.push({ step: "different override cleared pinned caps", caps: getCapabilitiesSnapshot() });
	setCapabilityOverrides({});
	steps.push({ step: "overrides cleared back to detection", caps: getCapabilitiesSnapshot() });
	setCapabilityOverrides({});
	resetCapabilitiesCache();
	return steps;
});

// ---------------------------------------------------------------- encodeKitty
// Chunk-boundary matrix: every option shape at the 4096 boundary, plus two
// long payloads covering middle+last chunk controls (kept out of the matrix
// to bound the embedded oracle size).
const ENCODE_KITTY_CASES = [];
for (const len of [4095, 4096, 4097, 3]) {
	for (const opts of [
		{},
		{ columns: 2, rows: 3 },
		{ columns: 2, rows: 3, imageId: 7, moveCursor: false },
		{ imageId: 0 },
		{ columns: 0, rows: 0 },
		{ moveCursor: false },
	]) {
		ENCODE_KITTY_CASES.push({
			data: "A".repeat(len),
			options: opts,
			sequence: encodeKitty("A".repeat(len), opts),
		});
	}
}
ENCODE_KITTY_CASES.push({
	data: "A".repeat(8192),
	options: {},
	sequence: encodeKitty("A".repeat(8192), {}),
});
ENCODE_KITTY_CASES.push({
	data: "A".repeat(8193),
	options: { columns: 2, rows: 3, imageId: 7, moveCursor: false },
	sequence: encodeKitty("A".repeat(8193), { columns: 2, rows: 3, imageId: 7, moveCursor: false }),
});
ENCODE_KITTY_CASES.push({ data: "", options: {}, sequence: encodeKitty("", {}) });
out.encodeKitty = ENCODE_KITTY_CASES;

// ---------------------------------------------------------------- delete cmds
out.deleteCommands = {
	delete42: deleteKittyImage(42),
	delete1: deleteKittyImage(1),
	delete0: deleteKittyImage(0),
	deleteBig: deleteKittyImage(4294967295),
	deleteAllImages: deleteAllKittyImages(),
	deleteAllPlacements: deleteAllKittyPlacements(),
};

// ---------------------------------------------------------------- encodeITerm2
out.encodeITerm2 = [
	{ data: "AAAA", options: {}, sequence: encodeITerm2("AAAA") },
	{ data: "AAAA", options: { width: 2, height: "auto" }, sequence: encodeITerm2("AAAA", { width: 2, height: "auto" }) },
	{ data: "AA==", options: {}, sequence: encodeITerm2("AA==") },
	{ data: "", options: {}, sequence: encodeITerm2("") },
	{
		data: "QQQQ",
		options: { width: 4, height: 5, name: "shot.png", preserveAspectRatio: false, inline: true },
		sequence: encodeITerm2("QQQQ", { width: 4, height: 5, name: "shot.png", preserveAspectRatio: false, inline: true }),
	},
	{ data: "QQQQ", options: { inline: false }, sequence: encodeITerm2("QQQQ", { inline: false }) },
	{
		data: "QQQQ",
		options: { name: "照片.png", width: 0, height: "" },
		sequence: encodeITerm2("QQQQ", { name: "照片.png", width: 0, height: "" }),
	},
];

// ---------------------------------------------------------------- cell size
const CELL_CASES = [
	{ dims: { widthPx: 1280, heightPx: 720 }, maxWidth: 80, maxHeight: undefined, cell: undefined },
	{ dims: { widthPx: 20, heightPx: 20 }, maxWidth: 2, maxHeight: undefined, cell: { widthPx: 10, heightPx: 10 } },
	{ dims: { widthPx: 100, heightPx: 100 }, maxWidth: 3, maxHeight: undefined, cell: { widthPx: 10, heightPx: 10 } },
	{ dims: { widthPx: 10, heightPx: 100 }, maxWidth: 10, maxHeight: 5, cell: { widthPx: 10, heightPx: 10 } },
	{ dims: { widthPx: 10, heightPx: 100 }, maxWidth: 10, maxHeight: undefined, cell: { widthPx: 10, heightPx: 20 } },
	{ dims: { widthPx: 100.5, heightPx: 33.3 }, maxWidth: 7.9, maxHeight: 3.2, cell: { widthPx: 9, heightPx: 18 } },
	{ dims: { widthPx: 1, heightPx: 1 }, maxWidth: 1, maxHeight: 1, cell: { widthPx: 9, heightPx: 18 } },
	{ dims: { widthPx: 0, heightPx: 0 }, maxWidth: 0, maxHeight: 0, cell: { widthPx: 9, heightPx: 18 } },
	{ dims: { widthPx: -5, heightPx: -7 }, maxWidth: -3, maxHeight: undefined, cell: { widthPx: 9, heightPx: 18 } },
	{ dims: { widthPx: 1920, heightPx: 1080 }, maxWidth: 80, maxHeight: 24, cell: { widthPx: 9, heightPx: 18 } },
	{ dims: { widthPx: 640, heightPx: 480 }, maxWidth: 40, maxHeight: 10, cell: { widthPx: 7, heightPx: 13 } },
	{ dims: { widthPx: 3, heightPx: 1000 }, maxWidth: 5, maxHeight: 2, cell: { widthPx: 10, heightPx: 10 } },
];
out.cellSize = CELL_CASES.map((c) => ({
	input: c,
	cellSize: calculateImageCellSize(c.dims, c.maxWidth, c.maxHeight, c.cell),
}));
out.calculateRows = [
	{ dims: { widthPx: 1280, heightPx: 720 }, width: 80, rows: calculateImageRows({ widthPx: 1280, heightPx: 720 }, 80) },
	{ dims: { widthPx: 100, heightPx: 300 }, width: 10, rows: calculateImageRows({ widthPx: 100, heightPx: 300 }, 10) },
	{ dims: { widthPx: 640, heightPx: 480 }, width: 0, rows: calculateImageRows({ widthPx: 640, heightPx: 480 }, 0) },
];

// ---------------------------------------------------------------- registry flow
// Linear global-registry script; the Rust side replays it against a fresh
// registry in registration order. transmissionGeneration is normalized
// (relative to the first register inside the flow) by gen_consts.mjs.
const registryFlow = [];
function flowRegister(metadata) {
	registerKittyImageMetadata(metadata);
	registryFlow.push({ op: "register", metadata });
}
function flowPlacement(line) {
	registryFlow.push({ op: "placement", line, placement: getKittyImagePlacement(line) ?? null });
}
function flowCrop(line, hiddenRows, visibleRows) {
	registryFlow.push({
		op: "crop",
		line,
		hiddenRows,
		visibleRows,
		result: cropKittyImageLine(line, hiddenRows, visibleRows),
	});
}
function flowMetadata(line) {
	registryFlow.push({ op: "metadata", line, metadata: getKittyImageMetadata(line) ?? null });
}

const flowData = "A".repeat(8192);
flowRegister({ imageId: 42101, columns: 3, rows: 3, widthPx: 100, heightPx: 100 });
const flowTransmission = encodeKitty(flowData, { columns: 3, rows: 3, imageId: 42101, moveCursor: false });
const flowCropped = cropKittyImageLine(flowTransmission, 2, 1);
const flowLine = `left ${flowCropped} right`;
flowMetadata(flowLine);
flowPlacement(flowLine);
flowPlacement(flowCropped);
flowPlacement("no registry hit \x1b_Ga=T,f=100,i=99999;AAAA\x1b\\");
flowPlacement("plain text");
flowRegister({ imageId: 42102, columns: 2, rows: 2, widthPx: 64, heightPx: 64 });
const flowTransmission2 = encodeKitty("B".repeat(8192), { columns: 2, rows: 2, imageId: 42102, moveCursor: false });
const flowLine2 = `pre${cropKittyImageLine(flowTransmission2, 1, 1)}post`;
flowMetadata(flowLine2);
flowPlacement(flowLine2);
flowCrop(flowTransmission, 2, 1);
flowCrop(flowTransmission, 0, 3);
flowCrop(flowTransmission, 3, 1);
flowCrop(flowTransmission, 0, 0);
flowCrop(flowTransmission, -1, 2);
flowCrop(flowTransmission, 1, 10);
flowCrop("unregistered \x1b_Ga=T,i=42999;AAAA\x1b\\", 1, 1);
flowMetadata("\x1b_Ga=T,i=42102;AAAA\x1b\\");
flowMetadata("\x1b_G;AAAA\x1b\\");
flowMetadata("no sequence at all");
flowRegister({ imageId: 42101, columns: 5, rows: 4, widthPx: 500, heightPx: 400 });
flowMetadata(flowLine);
flowPlacement(flowLine);
out.registryFlow = registryFlow;

// ---------------------------------------------------------------- dimensions
function bytesToB64(bytes) {
	return Buffer.from(bytes).toString("base64");
}
function pngBytes(w, h, extra) {
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	const dv = new DataView(new ArrayBuffer(8));
	dv.setUint32(0, w);
	dv.setUint32(4, h);
	return [...sig, 0, 0, 0, 13, ...Buffer.from("IHDR", "ascii"), ...new Uint8Array(dv.buffer), ...(extra ?? [0, 0, 0, 0])];
}
function jpegSof0(h, w) {
	const dv = new DataView(new ArrayBuffer(4));
	dv.setUint16(0, h);
	dv.setUint16(2, w);
	return [0xff, 0xc0, 0x00, 0x11, 0x08, ...new Uint8Array(dv.buffer), 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01];
}
function app1Segment(payloadLen) {
	return [0xff, 0xe1, (payloadLen >> 8) & 0xff, payloadLen & 0xff, ...new Array(payloadLen - 2).fill(0x11)];
}
function gifBytes(sig, w, h) {
	const dv = new DataView(new ArrayBuffer(4));
	dv.setUint16(0, w, true);
	dv.setUint16(2, h, true);
	return [...Buffer.from(sig, "ascii"), ...new Uint8Array(dv.buffer), 0x00, 0x2c];
}
function webpVp8Bytes(w, h) {
	const dv = new DataView(new ArrayBuffer(4));
	dv.setUint16(0, w & 0x3fff, true);
	dv.setUint16(2, h & 0x3fff, true);
	return [
		...Buffer.from("RIFF", "ascii"), 0x24, 0x00, 0x00, 0x00,
		...Buffer.from("WEBP", "ascii"),
		...Buffer.from("VP8 ", "ascii"), 0x00, 0x00, 0x00, 0x00,
		0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a,
		...new Uint8Array(dv.buffer),
	];
}
function webpVp8lBytes(w, h) {
	// bits (upstream reads readUInt32LE(21)): (h-1) << 14 | (w-1), 14 bits each
	const bits = ((h - 1) << 14) | (w - 1);
	const dv = new DataView(new ArrayBuffer(4));
	dv.setUint32(0, bits, true);
	return [
		...Buffer.from("RIFF", "ascii"), 0x1c, 0x00, 0x00, 0x00,
		...Buffer.from("WEBP", "ascii"),
		...Buffer.from("VP8L", "ascii"), 0x0a, 0x00, 0x00, 0x00,
		0x2f,
		...new Uint8Array(dv.buffer),
		...new Uint8Array(30 - 25),
	];
}
function webpVp8xBytes(w, h) {
	// canvas size minus one as 3-byte LE fields at 24 and 27
	return [
		...Buffer.from("RIFF", "ascii"), 0x2a, 0x00, 0x00, 0x00,
		...Buffer.from("WEBP", "ascii"),
		...Buffer.from("VP8X", "ascii"), 0x0a, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00,
		(w - 1) & 0xff, ((w - 1) >> 8) & 0xff, ((w - 1) >> 16) & 0xff,
		(h - 1) & 0xff, ((h - 1) >> 8) & 0xff, ((h - 1) >> 16) & 0xff,
	];
}

const DIM_CASES = [];
function dimCase(name, input, fn) {
	DIM_CASES.push({ name, input, result: fn() });
}
const PNG_OK = bytesToB64(pngBytes(1280, 720));
dimCase("png ok", PNG_OK, () => getPngDimensions(PNG_OK));
dimCase("png via mime", PNG_OK, () => getImageDimensions(PNG_OK, "image/png"));
dimCase("png truncated", bytesToB64(pngBytes(1280, 720).slice(0, 20)), () =>
	getPngDimensions(bytesToB64(pngBytes(1280, 720).slice(0, 20))));
dimCase("png wrong sig", bytesToB64([0x88, 0x50, 0x4e, 0x47, ...new Array(20).fill(0)]), () =>
	getPngDimensions(bytesToB64([0x88, 0x50, 0x4e, 0x47, ...new Array(20).fill(0)])));
dimCase("png not base64", "!!!!", () => getPngDimensions("!!!!"));

const JPEG_OK = bytesToB64([0xff, 0xd8, ...jpegSof0(480, 640)]);
dimCase("jpeg sof0", JPEG_OK, () => getJpegDimensions(JPEG_OK));
dimCase("jpeg via mime", JPEG_OK, () => getImageDimensions(JPEG_OK, "image/jpeg"));
const JPEG_PROG = bytesToB64([0xff, 0xd8, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80, 0x03]);
dimCase("jpeg sof2", JPEG_PROG, () => getJpegDimensions(JPEG_PROG));
const JPEG_APP1 = bytesToB64([0xff, 0xd8, ...app1Segment(16), ...jpegSof0(200, 320)]);
dimCase("jpeg with app1", JPEG_APP1, () => getJpegDimensions(JPEG_APP1));
const JPEG_JUNK = bytesToB64([0xff, 0xd8, 0x00, ...jpegSof0(50, 100)]);
dimCase("jpeg junk byte then sof", JPEG_JUNK, () => getJpegDimensions(JPEG_JUNK));
dimCase("jpeg too short", bytesToB64([0xff, 0xd8]), () => getJpegDimensions(bytesToB64([0xff, 0xd8])));
dimCase("jpeg one byte", bytesToB64([0xff]), () => getJpegDimensions(bytesToB64([0xff])));
dimCase("jpeg wrong sig", bytesToB64([0xff, 0xd9, 0xff, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0]), () =>
	getJpegDimensions(bytesToB64([0xff, 0xd9, 0xff, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0])));
dimCase(
	"jpeg segment length below two",
	bytesToB64([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0]),
	() => getJpegDimensions(bytesToB64([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0])),
);

const GIF89 = bytesToB64(gifBytes("GIF89a", 100, 50));
dimCase("gif89a", GIF89, () => getGifDimensions(GIF89));
dimCase("gif via mime", GIF89, () => getImageDimensions(GIF89, "image/gif"));
dimCase("gif87a 65535x1", bytesToB64(gifBytes("GIF87a", 65535, 1)), () =>
	getGifDimensions(bytesToB64(gifBytes("GIF87a", 65535, 1))));
dimCase("gif wrong sig", bytesToB64(gifBytes("GIF88a", 10, 10)), () =>
	getGifDimensions(bytesToB64(gifBytes("GIF88a", 10, 10))));
dimCase("gif short", bytesToB64([...Buffer.from("GIF89a", "ascii"), 0x01, 0x00]), () =>
	getGifDimensions(bytesToB64([...Buffer.from("GIF89a", "ascii"), 0x01, 0x00])));

const WEBP_VP8 = bytesToB64(webpVp8Bytes(320, 240));
dimCase("webp vp8", WEBP_VP8, () => getWebpDimensions(WEBP_VP8));
dimCase("webp vp8 via mime", WEBP_VP8, () => getImageDimensions(WEBP_VP8, "image/webp"));
dimCase("webp vp8l", bytesToB64(webpVp8lBytes(100, 80)), () => getWebpDimensions(bytesToB64(webpVp8lBytes(100, 80))));
dimCase("webp vp8x", bytesToB64(webpVp8xBytes(1000, 500)), () =>
	getWebpDimensions(bytesToB64(webpVp8xBytes(1000, 500))));
dimCase("webp wrong chunk", bytesToB64(webpVp8Bytes(320, 240).with(12, 0x51)), () => {
	const b = webpVp8Bytes(320, 240);
	b[12] = 0x51;
	return getWebpDimensions(bytesToB64(b));
});
dimCase("webp not riff", bytesToB64(webpVp8Bytes(320, 240).with(0, 0x58)), () => {
	const b = webpVp8Bytes(320, 240);
	b[0] = 0x58;
	return getWebpDimensions(bytesToB64(b));
});
dimCase(
	"webp short",
	bytesToB64([...Buffer.from("RIFF", "ascii"), ...Buffer.from("WEBP", "ascii"), 0x00]),
	() => getWebpDimensions(bytesToB64([...Buffer.from("RIFF", "ascii"), ...Buffer.from("WEBP", "ascii"), 0x00])),
);
dimCase("unknown mime", PNG_OK, () => getImageDimensions(PNG_OK, "image/x-png"));
dimCase("jpeg data under png mime", JPEG_OK, () => getImageDimensions(JPEG_OK, "image/png"));
out.dimensions = DIM_CASES;

// ---------------------------------------------------------------- renderImage
const RENDER_CASES = [];
function renderCase(name, caps, cell, data, dims, options) {
	setCapabilities(caps);
	setCellDimensions(cell);
	RENDER_CASES.push({ name, caps, cell, data, dims, options, result: renderImage(data, dims, options) });
}
const KITTY_CAPS = { images: "kitty", trueColor: true, hyperlinks: true };
const ITERM_CAPS = { images: "iterm2", trueColor: true, hyperlinks: true };
const NULL_CAPS = { images: null, trueColor: false, hyperlinks: false };
renderCase("kitty square", KITTY_CAPS, { widthPx: 10, heightPx: 10 }, "AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
renderCase(
	"kitty with id no move",
	KITTY_CAPS,
	{ widthPx: 10, heightPx: 10 },
	"AAAA",
	{ widthPx: 20, heightPx: 20 },
	{ maxWidthCells: 2, imageId: 42201, moveCursor: false },
);
renderCase(
	"kitty maxHeight reduces width",
	KITTY_CAPS,
	{ widthPx: 10, heightPx: 10 },
	"AAAA",
	{ widthPx: 10, heightPx: 100 },
	{ maxWidthCells: 10, maxHeightCells: 5 },
);
renderCase(
	"kitty default max width and default cell",
	KITTY_CAPS,
	{ widthPx: 9, heightPx: 18 },
	"AAAA",
	{ widthPx: 1600, heightPx: 900 },
	{},
);
renderCase("iterm2 default aspect", ITERM_CAPS, { widthPx: 10, heightPx: 10 }, "AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
renderCase(
	"iterm2 keep aspect false",
	ITERM_CAPS,
	{ widthPx: 10, heightPx: 10 },
	"AAAA",
	{ widthPx: 20, heightPx: 20 },
	{ maxWidthCells: 2, preserveAspectRatio: false },
);
renderCase("no images", NULL_CAPS, { widthPx: 10, heightPx: 10 }, "AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
renderCase("kitty zero id", KITTY_CAPS, { widthPx: 10, heightPx: 10 }, "AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2, imageId: 0 });
const renderMetadataAfter = getKittyImageMetadata(
	RENDER_CASES.find((c) => c.name === "kitty with id no move").result.sequence,
);
setCellDimensions({ widthPx: 9, heightPx: 18 });
resetCapabilitiesCache();
out.renderCases = RENDER_CASES;
out.renderMetadataAfter = renderMetadataAfter;

// ---------------------------------------------------------------- fallback
const REAL_USERPROFILE = process.env.USERPROFILE;
process.env.USERPROFILE = "C:/Users/oracle-user";
out.fallbackHome = os.homedir();
const FALLBACK_CASES = [
	{
		name: "shortens home path without hyperlinks",
		caps: { images: null, trueColor: false, hyperlinks: false },
		mime: "image/png",
		dims: { widthPx: 1280, heightPx: 720 },
		filename: "C:/Users/oracle-user/.pi/agent/shot.png",
	},
	{
		name: "hyperlinks wrap shortened path",
		caps: { images: null, trueColor: false, hyperlinks: true },
		mime: "image/png",
		dims: { widthPx: 10, heightPx: 10 },
		filename: "C:/Users/oracle-user/.pi/agent/shot.png",
	},
	{
		name: "basename not hyperlinked",
		caps: { images: null, trueColor: false, hyperlinks: true },
		mime: "image/png",
		dims: { widthPx: 1, heightPx: 1 },
		filename: "clankolas.png",
	},
	{
		name: "no filename",
		caps: { images: null, trueColor: false, hyperlinks: false },
		mime: "image/png",
		dims: { widthPx: 8, heightPx: 6 },
		filename: undefined,
	},
	{
		name: "relative path not hyperlinked",
		caps: { images: null, trueColor: false, hyperlinks: true },
		mime: "image/jpeg",
		dims: { widthPx: 3, heightPx: 4 },
		filename: "sub/dir/pic.jpg",
	},
	{
		name: "home path exactly",
		caps: { images: null, trueColor: false, hyperlinks: false },
		mime: "image/webp",
		dims: undefined,
		filename: "C:/Users/oracle-user",
	},
	{
		name: "no dimensions",
		caps: { images: null, trueColor: false, hyperlinks: false },
		mime: "image/gif",
		dims: undefined,
		filename: "C:/Users/oracle-user/pics/anim.gif",
	},
];
out.fallback = FALLBACK_CASES.map((c) => {
	setCapabilities(c.caps);
	const result = imageFallback(c.mime, c.dims, c.filename);
	resetCapabilitiesCache();
	return {
		name: c.name,
		caps: c.caps,
		mime: c.mime,
		dims: c.dims,
		filename: c.filename,
		result,
	};
});
process.env.USERPROFILE = REAL_USERPROFILE;
resetCapabilitiesCache();

// ---------------------------------------------------------------- hyperlink
out.hyperlink = [
	{ text: "click me", url: "https://example.com", result: hyperlink("click me", "https://example.com") },
	{
		text: "\x1b[4m\x1b[34mclick me\x1b[0m",
		url: "https://example.com",
		result: hyperlink("\x1b[4m\x1b[34mclick me\x1b[0m", "https://example.com"),
	},
	{ text: "", url: "https://example.com", result: hyperlink("", "https://example.com") },
	{
		text: "README.md",
		url: "file:///home/user/README.md",
		result: hyperlink("README.md", "file:///home/user/README.md"),
	},
];

// ---------------------------------------------------------------- isImageLine
const IS_LINE_CASES = [
	"\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07",
	"Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text",
	"Text before image...\x1b]1337;File=inline=1:verylongbase64data==...text after",
	"Regular text ending with \x1b]1337;File=inline=1:base64data==\x07",
	"\x1b]1337;File=:\x07",
	"\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\",
	"Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\",
	"  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  ",
	`Text prefix \x1b]1337;File=size=800,600;inline=1:${"A".repeat(100).repeat(3000)} suffix`,
	"Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07",
	"\x1b[31mError output \x1b]1337;File=inline=1:image==\x07",
	"\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset",
	"This is just a regular text line without any escape sequences",
	"\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m",
	"\x1b[1A\x1b[2KLine cleared and moved up",
	"Some text with ]1337;File but missing ESC at start",
	"Some text with _G but missing ESC at start",
	"",
	"\n",
	"\n\n",
	"Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07",
	"Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end",
	"/path/to/File_1337_backup/image.jpg",
	"At start: \x1b_Ga=T,f=100,data...\x1b\\",
	"Suffix text \x1b_Ga=T,data...\x1b\\ suffix",
	"Middle \x1b_Ga=T,data...\x1b\\ more text",
	`Text before \x1b_Ga=T,f=100${"A".repeat(300000)} text after`,
	"At start: \x1b]1337;File=size=100,100:base64...\x07",
	"Prefix \x1b]1337;File=inline=1:data==\x07",
	"Suffix text \x1b]1337;File=inline=1:data==\x07 suffix",
	"Middle \x1b]1337;File=inline=1:data==\x07 more text",
	`Text before \x1b]1337;File=size=800,600;inline=1:${"B".repeat(300000)} text after`,
	"Read image file [image/jpeg]\x1b]1337;File=size=800,600;inline=1:base64data...\x07",
	"\x1b[31mError\x1b[0m: \x1b]1337;File=inline=1:base64==\x07",
	"\x1b[33mWarning\x1b[0m: \x1b_Ga=T,data...\x1b\\",
	"\x1b[1mBold\x1b[0m \x1b]1337;File=:base64==\x07\x1b[0m",
	`Output: \x1b]1337;File=size=800,600;inline=1:${"A".repeat(100).repeat(3040)} end of output`,
	`Text\x1b_Ga=T,f=100${"A".repeat(58649 - 4 - "\x1b_Ga=T,f=100".length - 3)}End`,
	"A".repeat(100000),
	"/path/to/1337/image.jpg",
	"/usr/local/bin/File_converter",
	"~/Documents/1337File_backup.png",
	"./_G_test_file.txt",
];
out.isImageLine = IS_LINE_CASES.map((line) => ({ line, result: isImageLine(line) }));

// ---------------------------------------------------------------- allocate
const ids = [];
for (let i = 0; i < 10000; i++) ids.push(allocateImageId());
out.allocateImageId = {
	min: Math.min(...ids),
	max: Math.max(...ids),
	allInteger: ids.every((n) => Number.isInteger(n)),
};

writeFileSync(new URL("./oracle_output.json", import.meta.url), JSON.stringify(out));
console.log("oracle sections:", Object.keys(out).join(", "));
