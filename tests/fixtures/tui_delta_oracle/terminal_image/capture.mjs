// Captures v1.0.0 terminal-image.ts delta behavior from the REAL upstream
// module: calculateImageCellSize with optimizeAspectRatio, the `-direct` TERM
// truecolor hint, getTerminalColorMode, and the v1.0.0 Kitty placement-row
// helpers (getKittyImagePlacementRows, placement `rows`, cropKittyImageLine
// with explicit r=/y=/h= controls). Environment-driven detection uses
// injected process.env values; sources are hash-verified by the Rust test.
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const moduleUrl = new URL("./terminal-image.ts", import.meta.url);
const {
  calculateImageCellSize,
  getTerminalColorMode,
  resetCapabilitiesCache,
  registerKittyImageMetadata,
  getKittyImagePlacementRows,
  getKittyImagePlacement,
  cropKittyImageLine,
  encodeKitty,
} = await import(moduleUrl.href);

const out = { cellSize: [], detection: [], colorMode: [], kittyPlacement: [], provenance: {} };

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

// v1.0.0 Kitty placement-row helpers over deterministic transmissions. The
// registry state (imageId -> metadata) is explicit; crop carries the explicit
// r=/y=/h= controls the alt-screen scroller writes.
const kittyPayload = Buffer.from("kitty-placement-probe-payload-0123456789").toString("base64");
const kittyCases = [
  { imageId: 7, columns: 10, rows: 6, widthPx: 90, heightPx: 108, crop: [[0, 6], [2, 2], [4, 0], [0, 3], [5, 5]] },
  { imageId: 9, columns: 4, rows: 1, widthPx: 36, heightPx: 18, crop: [[0, 1], [1, 1], [0, 2]] },
];
out.kittyPlacement = kittyCases.map((kase) => {
  registerKittyImageMetadata({
    imageId: kase.imageId,
    columns: kase.columns,
    rows: kase.rows,
    widthPx: kase.widthPx,
    heightPx: kase.heightPx,
  });
  const line = encodeKitty(kittyPayload, { columns: kase.columns, rows: kase.rows, imageId: kase.imageId });
  const cropped = cropKittyImageLine(line, 1, kase.rows - 1);
  const placement = getKittyImagePlacement(line);
  const croppedPlacement = getKittyImagePlacement(cropped);
  const entry = {
    imageId: kase.imageId,
    register: {
      imageId: kase.imageId,
      columns: kase.columns,
      rows: kase.rows,
      widthPx: kase.widthPx,
      heightPx: kase.heightPx,
    },
    line,
    placementRows: getKittyImagePlacementRows(line),
    unknownLine: `\x1b_Ga=T,f=100,i=424242,q=2;${kittyPayload}\x1b\\`,
    unknownLinePlacementRows: getKittyImagePlacementRows(`\x1b_Ga=T,f=100,i=424242,q=2;${kittyPayload}\x1b\\`),
    placement: placement && {
      imageId: placement.imageId,
      transmissionGeneration: placement.transmissionGeneration,
      transmissionBytes: placement.transmissionBytes,
      estimatedDecodedBytes: placement.estimatedDecodedBytes,
      rows: placement.rows,
      sequence: placement.sequence,
      replacementLine: placement.replacementLine,
    },
    croppedLine: cropped,
    croppedPlacementRows: getKittyImagePlacementRows(cropped),
    croppedPlacementRowsField: croppedPlacement && croppedPlacement.rows,
    cropGrid: kase.crop,
    crops: kase.crop.map(([hidden, visible]) => cropKittyImageLine(line, hidden, visible)),
  };
  return entry;
});

const sha = (data) => createHash("sha256").update(data).digest("hex");
out.provenance = {
  terminalImageSha256: sha(readFileSync(fileURLToPath(moduleUrl))),
  node: process.version,
  platform: process.platform,
};
const target = process.argv[2] ?? fileURLToPath(new URL("./terminal_image_oracle.json", import.meta.url));
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log("terminal-image delta rows:", out.cellSize.length + out.detection.length, sha(readFileSync(target)));
