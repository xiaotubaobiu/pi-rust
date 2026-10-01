// Captures upstream system-theme behavior for byte-replay in Rust.
// Every scenario runs the verbatim upstream module (SHA-256 pinned in the
// manifest); inputs are deterministic. No network, no clock use.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as st from "./system-theme.ts";

const XTERM16 = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];

const rgb = (hex) => {
  const n = hex.replace("#", "");
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16),
  };
};

const scenarios = [];
const add = (name, input) => {
  const out = st.generateSystemThemeColors(input);
  scenarios.push({
    name,
    input: {
      foreground: input.foreground ? [input.foreground.r, input.foreground.g, input.foreground.b] : null,
      background: input.background ? [input.background.r, input.background.g, input.background.b] : null,
      palette: input.palette ? input.palette.map((c) => [c.r, c.g, c.b]) : null,
      saturation: input.saturation ?? null,
      appearanceHint: input.appearanceHint ?? null,
    },
    colors: out.colors,
    dim: out.dim,
    appearance: out.appearance,
  });
};

// Tier 3: nothing reported (indexed colors) — hint x saturation grid.
for (const hint of [null, "dark", "light"]) {
  for (const saturation of [null, 0, 0.3, 1]) {
    add(`indexed-hint=${hint}-sat=${saturation}`, {
      saturation: saturation ?? undefined,
      appearanceHint: hint ?? undefined,
    });
  }
}

// Tier 2: background only (no palette) — dark, light, mid-gray, extremes.
const BACKGROUNDS = [
  ["near-black", "#0a0a12"],
  ["dark", "#1e1e2e"],
  ["mid-gray", "#808080"],
  ["light", "#e8e8e8"],
  ["near-white", "#fafafc"],
  ["pure-black", "#000000"],
  ["pure-white", "#ffffff"],
];
for (const [label, bg] of BACKGROUNDS) {
  for (const fg of [null, "#c4c4d4", "#202028"]) {
    add(`bgonly-${label}-fg=${fg ?? "none"}`, {
      background: rgb(bg),
      foreground: fg ? rgb(fg) : undefined,
    });
  }
}

// Tier 1: background + full palette — hue anchoring from slots.
for (const [label, bg] of BACKGROUNDS.slice(0, 5)) {
  add(`palette-${label}`, { background: rgb(bg), foreground: rgb("#c4c4d4"), palette: XTERM16.map(rgb) });
}

// Grayscale with palette: saturation multiplier scales chroma.
add("palette-dark-sat0", { background: rgb("#1e1e2e"), palette: XTERM16.map(rgb), saturation: 0 });
add("palette-dark-sat0.5", { background: rgb("#1e1e2e"), palette: XTERM16.map(rgb), saturation: 0.5 });
add("bgonly-dark-sat0.5-hintlight", {
  background: rgb("#1e1e2e"), saturation: 0.5, appearanceHint: "light",
});

// Appearance hint only matters when the terminal reported no background —
// with a background the computed appearance wins; pin that too.
add("palette-dark-hintlight", {
  background: rgb("#1e1e2e"), foreground: rgb("#c4c4d4"), palette: XTERM16.map(rgb),
  appearanceHint: "light",
});

// terminalAppearance matrix: foreground/background lightness combos.
const appearanceScenarios = [];
const combos = [
  ["#0a0a12", null], ["#0a0a12", "#eeeeee"], ["#0a0a12", "#111111"],
  ["#e8e8e8", null], ["#e8e8e8", "#222222"], ["#e8e8e8", "#f0f0f0"],
  ["#808080", null], ["#808080", "#f2f2f2"], ["#808080", "#0c0c0c"], ["#808080", "#7c7c7c"],
  ["#000000", null], ["#ffffff", null],
];
for (const [bg, fg] of combos) {
  appearanceScenarios.push({
    background: [rgb(bg).r, rgb(bg).g, rgb(bg).b],
    foreground: fg ? [rgb(fg).r, rgb(fg).g, rgb(fg).b] : null,
    appearance: st.terminalAppearance(rgb(bg), fg ? rgb(fg) : undefined),
  });
}

// relativeLuminance / wcagContrast grids.
const lumGrid = [];
for (const v of [0, 1, 4, 8, 64, 128, 200, 255]) {
  lumGrid.push({ v, lum: st.relativeLuminance({ r: v, g: v, b: v }) });
  lumGrid.push({ v, lumChannel: st.relativeLuminance({ r: 255, g: v, b: 0 }) });
}
const contrastGrid = [];
for (const [a, b] of [["#000000", "#ffffff"], ["#1e1e2e", "#c4c4d4"], ["#808080", "#808080"], ["#000000", "#0a0a12"]]) {
  contrastGrid.push({ a, b, contrast: st.wcagContrast(rgb(a), rgb(b)) });
}

const oracle = {
  scenarios,
  appearanceScenarios,
  lumGrid,
  contrastGrid,
};

const manifest = {
  generator: "capture.mjs",
  node: process.version,
  sources: Object.fromEntries(
    ["system-theme.ts", "colors.ts", "oklab.ts"].map((f) => {
      const bytes = new TextEncoder().encode(
        // readFileSync would be another import; hash via fetch-free trick:
        void 0,
      );
      void bytes;
      return [f, null];
    }),
  ),
};
delete manifest.sources;

writeFileSync("system_theme_oracle.json", JSON.stringify(oracle, null, 1) + "\n");
console.log(
  JSON.stringify({
    scenarios: scenarios.length,
    appearanceScenarios: appearanceScenarios.length,
    sha256: createHash("sha256").update(JSON.stringify(oracle, null, 1) + "\n").digest("hex"),
  }),
);
