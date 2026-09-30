// Captures v0.99.1 terminal-image.ts delta behavior from the REAL upstream
// module: calculateImageCellSize with optimizeAspectRatio, the `-direct` TERM
// truecolor hint, and getTerminalColorMode. Environment-driven detection uses
// injected process.env values; sources are hash-verified by the Rust test.
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const moduleUrl = new URL("./terminal-image.ts", import.meta.url);
const {
  calculateImageCellSize,
  getTerminalColorMode,
  resetCapabilitiesCache,
} = await import(moduleUrl.href);

const out = { cellSize: [], detection: [], colorMode: [], provenance: {} };

const dims = (widthPx, heightPx) => ({ widthPx, heightPx });
const cell = (widthPx, heightPx) => ({ widthPx, heightPx });
const aspectCases = [
  [dims(600, 400), 40, undefined, cell(9, 18), false],
  [dims(600, 400), 40, undefined, cell(9, 18), true],
  [dims(600, 400), 40, 10, cell(9, 18), true],
  [dims(400, 600), 40, 30, cell(9, 18), true],
  [dims(400, 600), 40, 30, cell(9, 18), false],
  [dims(100, 100), 12, 12, cell(9, 18), true],
  [dims(9, 18), 10, 10, cell(9, 18), true],
  [dims(1920, 1080), 80, 24, cell(9, 18), true],
  [dims(1920, 1080), 80, 24, cell(9, 18), false],
  [dims(50, 2000), 20, 8, cell(9, 18), true],
  [dims(2000, 50), 20, 8, cell(9, 18), true],
  [dims(3, 3), 2, undefined, cell(9, 18), true],
  [dims(600, 400), 1, undefined, cell(9, 18), true],
  [dims(600, 400), 40, undefined, cell(7, 14), true],
  [dims(333, 333), 30, 30, cell(10, 20), true],
];
for (const [image, maxWidth, maxHeight, cellDims, optimize] of aspectCases) {
  out.cellSize.push({
    input: { image, maxWidth, maxHeight, cell: cellDims, optimizeAspectRatio: optimize },
    size: calculateImageCellSize(image, maxWidth, maxHeight, cellDims, optimize),
  });
}

// Environment detection deltas: the TERM `-direct` suffix.
const detectionCases = [
  { TERM: "xterm-direct" },
  { TERM: "xterm-256color" },
  { TERM: "xterm-direct", COLORTERM: undefined },
  { COLORTERM: "truecolor" },
  { COLORTERM: "24bit" },
  { TERM: "xterm-direct", KITTY_WINDOW_ID: "1" },
  { TERM: "linux-direct" },
];
for (const env of detectionCases) {
  for (const key of ["TERM", "COLORTERM", "KITTY_WINDOW_ID", "TERM_PROGRAM", "COLORTERM", "WT_SESSION", "WEZTERM_PANE", "ITERM_SESSION_ID", "TMUX", "GHOSTTY_RESOURCES_DIR", "WARP_SESSION_ID", "WARP_TERMINAL_SESSION_UUID", "TERMINAL_EMULATOR"]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  resetCapabilitiesCache();
  const mod = await import(`${moduleUrl.href}?case=${encodeURIComponent(JSON.stringify(env))}`);
  const caps = mod.getCapabilities();
  out.detection.push({
    env,
    trueColor: caps.trueColor,
    images: caps.images ?? null,
    hyperlinks: caps.hyperlinks,
    colorMode: getTerminalColorMode(caps),
    defaultColorMode: getTerminalColorMode(),
  });
}
resetCapabilitiesCache();

const sha = (data) => createHash("sha256").update(data).digest("hex");
out.provenance = {
  terminalImageSha256: sha(readFileSync(fileURLToPath(moduleUrl))),
  node: process.version,
  platform: process.platform,
};
const target = process.argv[2] ?? fileURLToPath(new URL("./terminal_image_oracle.json", import.meta.url));
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log("terminal-image delta rows:", out.cellSize.length + out.detection.length, sha(readFileSync(target)));
