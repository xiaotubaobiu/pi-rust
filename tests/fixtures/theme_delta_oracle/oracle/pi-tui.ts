// The `@earendil-works/pi-tui` barrel for the capture harness: re-exports of
// the SHA-pinned tui sources copied next to this file, plus the one
// presentation seam (`getTerminalColorMode`) whose real implementation probes
// terminal capabilities. The capture pins the color mode through
// `globalThis.__piColorMode` so upstream `createTheme`'s
// `mode ?? getTerminalColorMode()` default is exercised verbatim; the probe
// body itself is never run.
export {
	backgroundAnsi,
	colorToHex,
	colorToOkhsl,
	colorToOklch,
	colorToRgb,
	foregroundAnsi,
	indexedColor,
	mixColors,
	okhslColor,
	parseColor,
	rgbColor,
	styleText,
	styleTextWithAnsi,
} from "./colors.ts";
export { oklabToOkhslLightness } from "./oklab.ts";
export type {
	RgbColor,
	TerminalColorScheme,
	TerminalColors,
} from "./terminal-colors.ts";

export function getTerminalColorMode(): "truecolor" | "256color" {
	const pinned = (globalThis as Record<string, unknown>).__piColorMode;
	return pinned === "256color" ? "256color" : "truecolor";
}
