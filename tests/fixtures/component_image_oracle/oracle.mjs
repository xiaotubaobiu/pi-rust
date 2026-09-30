// Oracle runner for the components/image.ts slice: executes the REAL upstream
// `Image` component (plus its real `terminal-image.ts` and `utils.ts`
// dependencies) under node and captures exact render outputs per scenario.
// Copies are sha256-verified against the read-only upstream originals (see
// out.meta and the slice report). Output: oracle_output.json (canonical JSON,
// keys sorted by canonicalize.mjs before embedding into Rust).
//
// Determinism notes:
// - `allocateImageId` draws from Math.random and is NOT deterministic. For
//   component scenarios where the Image allocates its own Kitty id, every
//   rendered line has /,i=\d+/ masked to ",i=<ID>" (rows carry
//   "masked": true); the Rust replay masks its own line identically and
//   additionally checks the allocated id is an integer in [1, 0xffffffff]
//   (the only contractual property, same as the terminal-image slice).
// - All other scenarios pass an explicit options.imageId, so output is fully
//   deterministic and compared byte-for-byte.
// - The tmux hyperlink probe never runs: scenarios pin capabilities via
//   setCapabilities (no detection from the live environment).
// - The fallback scenarios pin USERPROFILE to a fake home; os.homedir()
//   re-reads it per call, and the Rust replay sets the same value.
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Image } from "./components/image.ts";
import {
	allocateImageId,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "./terminal-image.ts";
import { visibleWidth } from "./utils.ts";

const ORACLE_HOME = "C:/Users/oracle-user";
const REAL_USERPROFILE = process.env.USERPROFILE;

const out = {};
out.meta = {
	node: process.version,
	platform: process.platform,
	upstreamImageSha256: createHash("sha256").update(readFileSync(new URL("./components/image.ts", import.meta.url))).digest("hex"),
	upstreamTerminalImageSha256: createHash("sha256").update(readFileSync(new URL("./terminal-image.ts", import.meta.url))).digest("hex"),
	upstreamUtilsSha256: createHash("sha256").update(readFileSync(new URL("./utils.ts", import.meta.url))).digest("hex"),
};

const KITTY_CAPS = { images: "kitty", trueColor: true, hyperlinks: true };
const ITERM_CAPS = { images: "iterm2", trueColor: true, hyperlinks: true };
const NULL_CAPS = { images: null, trueColor: false, hyperlinks: false };
const IDENTITY_THEME = { fallbackColor: (value) => value };
const YELLOW_THEME = { fallbackColor: (value) => `\x1b[33m${value}\x1b[0m` };

function pngBytes(w, h) {
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	const dv = new DataView(new ArrayBuffer(8));
	dv.setUint32(0, w);
	dv.setUint32(4, h);
	return Buffer.from([...sig, 0, 0, 0, 13, ...Buffer.from("IHDR", "ascii"), ...new Uint8Array(dv.buffer), 0, 0, 0, 0]).toString("base64");
}

function maskIds(line) {
	return line.replace(/,i=\d+/, ",i=<ID>");
}

// One scenario = one Image instance + an ordered list of render/step probes.
// `fallback` captures the raw imageFallback string for the same inputs (the
// Rust replay recomposes theme+truncation from it for the home-pinned row).
const scenarios = [];
function scenario(group, name, caps, cell, theme, ctorOptions, ctorDimensions, steps) {
	runScenario(group, name, caps, cell, theme, "AAAA", "image/png", ctorOptions, ctorDimensions, steps);
}
function runScenario(group, name, caps, cell, theme, base64, mimeType, ctorOptions, ctorDimensions, steps) {
	setCapabilities(caps);
	setCellDimensions(cell);
	const fallback = imageFallback(mimeType, ctorDimensions ?? undefined, ctorOptions.filename);
	const image = new Image(base64, mimeType, theme, ctorOptions, ctorDimensions);
	const renders = [];
	for (const step of steps) {
		if (step.op === "invalidate") {
			image.invalidate();
			renders.push({ op: "invalidate" });
			continue;
		}
		const width = step.width;
		const lines = image.render(width);
		const imageId = image.getImageId();
		const masked = imageId !== undefined && imageId !== null && ctorOptions.imageId === undefined;
		renders.push({
			op: "render",
			width,
			masked,
			lines: masked ? lines.map(maskIds) : lines,
			imageId: masked ? "<allocated>" : imageId ?? null,
			visibleWidths: lines.map((line) => visibleWidth(line)),
		});
	}
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	scenarios.push({ group, name, caps, cell, theme: theme === IDENTITY_THEME ? "identity" : "yellow", base64, mimeType, ctorOptions, ctorDimensions: ctorDimensions ?? null, fallback, homePinned: false, renders });
}

// ---------------------------------------------------------------- kitty
// Upstream "caps Image component height to a square pixel box by default":
// allocated id (masked), render(12) twice (second must be a cache hit), then
// a wider render that must recompute with the same id.
scenario("kitty", "caps height square pixel box", KITTY_CAPS, { widthPx: 10, heightPx: 20 }, IDENTITY_THEME,
	{ maxWidthCells: 10 }, { widthPx: 10, heightPx: 100 },
	[{ width: 12 }, { width: 12 }, { width: 20 }]);

// Upstream "places image sequence on first line with empty padding rows".
scenario("kitty", "first line placement padding rows", KITTY_CAPS, { widthPx: 10, heightPx: 10 }, IDENTITY_THEME,
	{ maxWidthCells: 2 }, { widthPx: 20, heightPx: 20 },
	[{ width: 4 }]);

// Explicit id: no allocation, stable across widths, cache semantics, and an
// invalidate-triggered recompute (resize re-render path).
scenario("kitty", "explicit id reuse across widths", KITTY_CAPS, { widthPx: 10, heightPx: 10 }, IDENTITY_THEME,
	{ maxWidthCells: 2, imageId: 42307 }, { widthPx: 20, heightPx: 20 },
	[{ width: 4 }, { width: 4 }, { width: 8 }, { op: "invalidate" }, { width: 6 }]);

// imageId 0: the component must NOT reallocate (0 !== undefined) and the
// truthy `if (result.imageId)` check must not overwrite it either.
scenario("kitty", "image id zero preserved", KITTY_CAPS, { widthPx: 10, heightPx: 10 }, IDENTITY_THEME,
	{ maxWidthCells: 2, imageId: 0 }, { widthPx: 20, heightPx: 20 },
	[{ width: 4 }]);

// Explicit maxHeightCells wins over the square-pixel default.
scenario("kitty", "explicit maxHeightCells", KITTY_CAPS, { widthPx: 10, heightPx: 10 }, IDENTITY_THEME,
	{ maxWidthCells: 10, maxHeightCells: 5, imageId: 42308 }, { widthPx: 10, heightPx: 100 },
	[{ width: 40 }]);

// Fractional maxWidthCells stays a JS number through Math.min.
scenario("kitty", "fractional maxWidthCells", KITTY_CAPS, { widthPx: 9, heightPx: 18 }, IDENTITY_THEME,
	{ maxWidthCells: 7.9, imageId: 42309 }, { widthPx: 800, heightPx: 600 },
	[{ width: 30 }]);

// Default 800x600 dimensions when detection fails (non-image base64).
scenario("kitty", "default dimensions on failed detection", KITTY_CAPS, { widthPx: 9, heightPx: 18 }, IDENTITY_THEME,
	{ imageId: 42310 }, undefined,
	[{ width: 30 }]);

// Real PNG header detection feeds the cell-size negotiation.
{
	setCapabilities(KITTY_CAPS);
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	const png = pngBytes(1280, 720);
	const image = new Image(png, "image/png", IDENTITY_THEME, { imageId: 42311 }, undefined);
	const renders = [];
	for (const width of [30, 80]) {
		const lines = image.render(width);
		renders.push({ op: "render", width, masked: false, lines, imageId: image.getImageId(), visibleWidths: lines.map((l) => visibleWidth(l)) });
	}
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	scenarios.push({ group: "kitty", name: "detected png dimensions", caps: KITTY_CAPS, cell: { widthPx: 9, heightPx: 18 }, theme: "identity", base64: png, mimeType: "image/png", ctorOptions: { imageId: 42311 }, ctorDimensions: null, fallback: null, homePinned: false, renders });
}

// GIF mime with PNG payload: detection fails per-mime, defaults kick in.
{
	setCapabilities(KITTY_CAPS);
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	const png = pngBytes(640, 480);
	const image = new Image(png, "image/gif", IDENTITY_THEME, { imageId: 42312 }, undefined);
	const renders = [];
	for (const width of [12]) {
		const lines = image.render(width);
		renders.push({ op: "render", width, masked: false, lines, imageId: image.getImageId(), visibleWidths: lines.map((l) => visibleWidth(l)) });
	}
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	scenarios.push({ group: "kitty", name: "mime mismatch falls back to defaults", caps: KITTY_CAPS, cell: { widthPx: 9, heightPx: 18 }, theme: "identity", base64: png, mimeType: "image/gif", ctorOptions: { imageId: 42312 }, ctorDimensions: null, fallback: null, homePinned: false, renders });
}

// ---------------------------------------------------------------- iterm2
scenario("iterm2", "placement with move up prefix", ITERM_CAPS, { widthPx: 10, heightPx: 10 }, IDENTITY_THEME,
	{}, { widthPx: 10, heightPx: 10 },
	[{ width: 20 }, { width: 1 }]);

scenario("iterm2", "constructor id untouched", ITERM_CAPS, { widthPx: 10, heightPx: 10 }, IDENTITY_THEME,
	{ imageId: 42442 }, { widthPx: 20, heightPx: 20 },
	[{ width: 4 }]);

scenario("iterm2", "default dimensions rows", ITERM_CAPS, { widthPx: 9, heightPx: 18 }, IDENTITY_THEME,
	{}, undefined,
	[{ width: 30 }]);

// ---------------------------------------------------------------- fallback
// Home-free scenarios exercise the REAL component fallback path byte-exactly
// on both sides. The one home-shortening scenario pins USERPROFILE around its
// capture; the Rust replay recomposes theme+truncation from the captured
// raw `fallback` string (dirs 7 on Windows reads the profile via
// SHGetKnownFolderPath, so no env var can redirect its home) — same
// home-injection substitution as the terminal-image slice.
scenario("fallback", "long absolute path truncated to width", NULL_CAPS, { widthPx: 9, heightPx: 18 }, YELLOW_THEME,
	{ filename: join("C:/images", `${"generated-image-with-a-very-long-absolute-path".repeat(4)}.png`) }, { widthPx: 1280, heightPx: 720 },
	[{ width: 40 }]);

scenario("fallback", "hyperlinks wrap absolute path", { images: null, trueColor: false, hyperlinks: true }, { widthPx: 9, heightPx: 18 }, IDENTITY_THEME,
	{ filename: "C:/images/pics/shot.png" }, { widthPx: 10, heightPx: 10 },
	[{ width: 200 }]);

scenario("fallback", "basename not hyperlinked", { images: null, trueColor: false, hyperlinks: true }, { widthPx: 9, heightPx: 18 }, IDENTITY_THEME,
	{ filename: "clankolas.png" }, { widthPx: 1, heightPx: 1 },
	[{ width: 200 }]);

scenario("fallback", "no filename segment", NULL_CAPS, { widthPx: 9, heightPx: 18 }, IDENTITY_THEME,
	{}, { widthPx: 8, heightPx: 6 },
	[{ width: 200 }]);

scenario("fallback", "relative path kept as-is", { images: null, trueColor: false, hyperlinks: true }, { widthPx: 9, heightPx: 18 }, IDENTITY_THEME,
	{ filename: "sub/dir/pic.jpg" }, { widthPx: 3, heightPx: 4 },
	[{ width: 200 }]);

scenario("fallback", "wide render keeps fallback intact", NULL_CAPS, { widthPx: 9, heightPx: 18 }, YELLOW_THEME,
	{ filename: "C:/media/photo album.png" }, { widthPx: 1920, heightPx: 1080 },
	[{ width: 120 }]);

scenario("fallback", "narrow render truncates colored fallback", NULL_CAPS, { widthPx: 9, heightPx: 18 }, YELLOW_THEME,
	{ filename: "C:/media/photo album.png" }, { widthPx: 1920, heightPx: 1080 },
	[{ width: 24 }]);

process.env.USERPROFILE = ORACLE_HOME;
{
	setCapabilities({ images: null, trueColor: false, hyperlinks: true });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	const ctorOptions = { filename: "C:/Users/oracle-user/pics/shot.png" };
	const ctorDimensions = { widthPx: 10, heightPx: 10 };
	const fallback = imageFallback("image/png", ctorDimensions, ctorOptions.filename);
	const image = new Image("AAAA", "image/png", IDENTITY_THEME, ctorOptions, ctorDimensions);
	const width = 200;
	const lines = image.render(width);
	const renders = [{ op: "render", width, masked: false, lines, imageId: image.getImageId(), visibleWidths: lines.map((line) => visibleWidth(line)) }];
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	scenarios.push({ group: "fallback", name: "home path shortened and hyperlinked", caps: { images: null, trueColor: false, hyperlinks: true }, cell: { widthPx: 9, heightPx: 18 }, theme: "identity", base64: "AAAA", mimeType: "image/png", ctorOptions, ctorDimensions, fallback, homePinned: true, renders });
}
process.env.USERPROFILE = REAL_USERPROFILE;

out.scenarios = scenarios;

// Contract facts about allocated ids (the only properties upstream relies on:
// typeof number via Math.floor(Math.random() * 0xfffffffe) + 1).
const ids = [];
for (let i = 0; i < 10000; i++) ids.push(allocateImageId());
out.allocatedIdFacts = {
	allInteger: ids.every((n) => Number.isInteger(n)),
	inRange: ids.every((n) => n >= 1 && n <= 0xffffffff),
};
out.renderImageSmoke = (() => {
	setCapabilities(KITTY_CAPS);
	setCellDimensions({ widthPx: 10, heightPx: 10 });
	const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	return result;
})();

writeFileSync(new URL("./oracle_output.json", import.meta.url), JSON.stringify(out));
console.log("oracle scenarios:", scenarios.length, "groups:", [...new Set(scenarios.map((s) => s.group))].join(","));
