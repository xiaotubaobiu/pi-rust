// The `@earendil-works/pi-tui` barrel for the capture harness: the SHA-pinned
// tui color sources (copied from the theme delta oracle) plus the text/utils
// verbatim copies the delta components need.
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

export { Text } from "./text_verbatim.ts";
export {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "./utils_verbatim.ts";

export function getTerminalColorMode(): "truecolor" | "256color" {
	// Pinned through the same global the theme oracle uses; the real probe
	// (terminal capabilities) is presentation.
	return (globalThis).__piColorMode === "256color" ? "256color" : "truecolor";
}
