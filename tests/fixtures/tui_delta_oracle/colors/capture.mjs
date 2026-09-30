// Captures byte-exact outputs of the REAL upstream oklab.ts + colors.ts
// (v0.99.1) under node --experimental-strip-types. Floats are serialized as
// raw f64 bit patterns so the Rust port can be compared bit-for-bit.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  backgroundAnsi,
  colorToHex,
  colorToOkhsl,
  colorToOklch,
  colorToRgb,
  foregroundAnsi,
  indexedColor,
  mixColors,
  okhslColor,
  oklchColor,
  parseColor,
  rgbColor,
  styleText,
  styleTextWithAnsi,
} from "./colors.ts";
import { oklabToOkhslLightness, oklabToLinearSrgb, rgbToOkhsl } from "./oklab.ts";

const bits = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return [...new Uint8Array(view.buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const bits3 = (values) => values.map(bits);
const rgbJson = (color) => ({ ...color });
const errorOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return String(error.message);
  }
};

// Deterministic pseudo-random grid over [0,1).
let seed = 0x2f6e2b1;
const nextUnit = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const result = { provenance: { oklabSha256: createHash("sha256").update("oklab").digest("hex") } };

// --- oklab primitives over a dense grid -------------------------------------
result.oklabToLinearSrgb = [];
for (let i = 0; i < 400; i++) {
  const l = nextUnit();
  const a = nextUnit() * 0.8 - 0.4;
  const b = nextUnit() * 0.8 - 0.4;
  result.oklabToLinearSrgb.push({ in: [bits(l), bits(a), bits(b)], out: bits3(oklabToLinearSrgb([l, a, b])) });
}
result.okhslLightness = [];
for (let i = 0; i < 200; i++) {
  const x = nextUnit() * 2 - 0.5;
  result.okhslLightness.push({ in: bits(x), out: bits(oklabToOkhslLightness(x)) });
}
result.okhslToRgb = [];
for (let h = 0; h < 360; h += 7) {
  for (const s of [0, 0.05, 0.3, 0.62, 0.79, 0.8, 0.81, 0.95, 1]) {
    for (const l of [0, 0.02, 0.25, 0.5, 0.568, 0.77, 0.98, 1]) {
      const rgb = okhslToRgbSafe(h, s, l);
      result.okhslToRgb.push({ h, s: bits(s), l: bits(l), rgb: rgbJson(rgb) });
    }
  }
}
function okhslToRgbSafe(h, s, l) {
  return okhslColor(h, s, l);
}
result.rgbToOkhsl = [];
const rgbGrid = [];
for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 23) for (let b = 0; b < 256; b += 29) rgbGrid.push([r, g, b]);
for (const [r, g, b] of rgbGrid) {
  const channels = rgbToOkhsl({ r, g, b });
  result.rgbToOkhsl.push({ rgb: [r, g, b], h: bits(channels.h), s: bits(channels.s), l: bits(channels.l) });
}

// --- colors.ts API -----------------------------------------------------------
result.parseColor = [
  "#abc", "#0af01c", "#A B C".replace(/ /g, ""), "oklch(62% 0.1 200)", "oklch(0.62 0.1 200)",
  "oklch(62% 0.1 200deg)", "OKLCH(62% 0.1 200)", "okhsl(29.23 100% 56.8%)", "OKHSL(250deg 60% 55%)",
  "okhsl(250 60% 55%)", "", "red", "oklch()", "oklch(62 0.1)", "#ab", "#abcd", "oklch(50% 0.1 200 extra)",
].map((value) => ({
  value,
  parsed: (() => { try { return JSON.stringify(parseColor(value)); } catch { return null; } })(),
  error: errorOf(() => parseColor(value)),
}));
result.constructors = [
  () => indexedColor(255), () => indexedColor(0), () => indexedColor(-1), () => indexedColor(256),
  () => indexedColor(1.5), () => indexedColor(NaN), () => rgbColor(0, 128, 255), () => rgbColor(1.5, 0, 0),
  () => rgbColor(-1, 0, 0), () => rgbColor(256, 0, 0), () => rgbColor(NaN, 0, 0), () => rgbColor(Infinity, 0, 0),
  () => oklchColor(0.5, 0.2, 400), () => oklchColor(1.2, 0.2, 0), () => oklchColor(0.5, -0.1, 0),
  () => oklchColor(0.5, 0.2, -30), () => oklchColor(0.5, 0, NaN),
  () => okhslColor(250, 1.6, 0.55), () => okhslColor(250, 0.6, 1.2), () => okhslColor(NaN, 0.5, 0.5),
].map((fn) => {
  try {
    return { value: JSON.stringify(fn()), error: null };
  } catch (error) {
    return { value: null, error: String(error.message) };
  }
});

result.colorToRgb = [];
for (const color of [
  indexedColor(0), indexedColor(7), indexedColor(15), indexedColor(16), indexedColor(59),
  indexedColor(231), indexedColor(232), indexedColor(255),
  rgbColor(18, 52, 86), rgbColor(250.5, 0.25, 254.75),
  oklchColor(0.627955, 0.257683, 29.2339), oklchColor(1, 0.3, 150), oklchColor(0, 0.3, 150),
  oklchColor(0.8, 0.15, 130), oklchColor(0.35, 0.09, 250), oklchColor(0.97, 0.02, 90),
]) {
  result.colorToRgb.push({ color: JSON.stringify(color), rgb: rgbJson(colorToRgb(color)) });
}

result.colorToOklch = [];
for (const color of [indexedColor(9), rgbColor(18, 52, 86), rgbColor(79, 142, 179), oklchColor(0.5, 0.1, 300)]) {
  const channels = colorToOklch(color);
  result.colorToOklch.push({ color: JSON.stringify(color), l: bits(channels.l), c: bits(channels.c), h: bits(channels.h) });
}
result.colorToOkhsl = [];
for (const hex of ["#4f8eb3", "#20242a", "#f8f9fa", "#000000", "#ffffff", "#ff0000"]) {
  const color = parseColor(hex);
  const channels = colorToOkhsl(color);
  const roundTrip = colorToHex(okhslColor(channels.h, channels.s, channels.l));
  result.colorToOkhsl.push({ hex, h: bits(channels.h), s: bits(channels.s), l: bits(channels.l), roundTrip });
}
result.colorToHex = [
  indexedColor(9), rgbColor(18, 52, 86), rgbColor(10.5, 0.4, 254.6), oklchColor(0.8, 0.1, 30),
].map((color) => ({ color: JSON.stringify(color), hex: colorToHex(color) }));

result.mixColors = [];
const mixInputs = [
  [indexedColor(9), indexedColor(12), 0.5, "oklch"],
  [rgbColor(255, 0, 0), rgbColor(0, 0, 255), 0.25, "oklch"],
  [rgbColor(255, 0, 0), rgbColor(0, 0, 255), 0.25, "srgb"],
  [oklchColor(0.6, 0.2, 40), oklchColor(0.4, 0.1, 320), 0.75, "oklch"],
  [rgbColor(255, 0, 0), rgbColor(0, 0, 255), 0, "oklch"],
  [rgbColor(255, 0, 0), rgbColor(0, 0, 255), 1, "oklch"],
  [indexedColor(0), indexedColor(15), 0.5, "srgb"],
  [rgbColor(255, 0, 0), indexedColor(4), 0.5, "oklch"],
  [oklchColor(0.5, 0, 10), oklchColor(0.7, 0.05, 200), 0.4, "oklch"],
  [rgbColor(1, 2, 3), rgbColor(4, 5, 6), 1.5, "oklch"],
  [rgbColor(1, 2, 3), rgbColor(4, 5, 6), NaN, "oklch"],
];
for (const [first, second, amount, space] of mixInputs) {
  result.mixColors.push({
    args: [JSON.stringify(first), JSON.stringify(second), amount === NaN ? "NaN" : amount, space],
    mixed: (() => { try { return JSON.stringify(mixColors(first, second, amount, space)); } catch { return null; } })(),
    error: errorOf(() => mixColors(first, second, amount, space)),
  });
}

result.ansi = [];
const ansiModes = ["truecolor", "256color"];
for (const color of [
  indexedColor(9), rgbColor(18, 52, 86), oklchColor(0.9, 0.05, 200), rgbColor(1.5, 254.5, 127.5),
  oklchColor(0.35, 0.17, 20),
]) {
  for (const mode of ansiModes) {
    result.ansi.push({
      color: JSON.stringify(color), mode,
      fg: foregroundAnsi(color, mode),
      bg: backgroundAnsi(color, mode),
    });
  }
}

result.styleText = [
  [{ fg: rgbColor(18, 52, 86), bg: indexedColor(9), bold: true, italic: true }, "truecolor"],
  [{ fg: rgbColor(18, 52, 86) }, "256color"],
  [{ bg: indexedColor(3), underline: true, inverse: true, strikethrough: true }, "256color"],
  [{ bold: true, dim: true }, "256color"],
  [{ dim: true }, "truecolor"],
  [{}, "truecolor"],
].map(([options, mode]) => ({
  mode,
  options: JSON.stringify(options),
  styled: styleText("Ready", options, mode),
  viaAnsi: styleTextWithAnsi(
    "Ready",
    options.fg ? foregroundAnsi(options.fg, mode) : undefined,
    options.bg ? backgroundAnsi(options.bg, mode) : undefined,
    options,
  ),
}));

const sha = (data) => createHash("sha256").update(data).digest("hex");
import { readFileSync } from "node:fs";
result.provenance = {
  oklabSha256: sha(readFileSync(new URL("./oklab.ts", import.meta.url))),
  colorsSha256: sha(readFileSync(new URL("./colors.ts", import.meta.url))),
  node: process.version,
  platform: process.platform,
};

import { fileURLToPath } from "node:url";
const target = process.argv[2] ?? fileURLToPath(new URL("./colors_oracle.json", import.meta.url));
writeFileSync(target, JSON.stringify(result, null, 1) + "\n");
console.log({
  oklab: result.oklabToLinearSrgb.length + result.okhslToRgb.length + result.rgbToOkhsl.length,
  colors: result.parseColor.length + result.constructors.length + result.colorToRgb.length,
  sha256: sha(readFileSync(target)),
});
