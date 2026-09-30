// r20 components oracle deps layer (tree-selector + session-selector).
// Follows the r19 oracle conventions:
//   - theme: the r17-verified machinery over the byte-identical dark.json
//     (sha256 103a5aec…) at truecolor, with correct bgAnsi (48;2) codes.
//   - tui utils (truncateToWidth/visibleWidth/wrapTextWithAnsi/sliceByColumn)
//     come from utils_verbatim.ts (verbatim packages/tui/src/utils.ts over the
//     node_modules/get-east-asian-width narrow-only stub).
//   - tui keybindings/keys are REAL (file:// import of packages/tui/src).
//   - tui fuzzyMatch is REAL (fuzzy.ts is import-free).
//   - Input is the r19 stub (printable append / backspace / Enter fires
//     onSubmit; the full input widget is the separately-verified tui slice).
//   - Container/Spacer are the trivial real implementations; Text is the real
//     text_verbatim.ts render.
// Clock stub: globalThis.Date is replaced by FakeDate — `new Date()`/Date.now()
// return FIXED_NOW so ages/status flows are deterministic; the local-time
// getters (getFullYear/getMonth/getDate/getHours/getMinutes) resolve to the UTC
// fields so label timestamps are timezone-independent (the Rust port renders
// label timestamps in UTC; disclosed as seam S20.5 in tree_selector.rs).
import { getKeybindings as realGetKeybindings } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/tui/src/keybindings.ts";
import { matchesKey as realMatchesKey } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/tui/src/keys.ts";
import { fuzzyMatch as realFuzzyMatch } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/tui/src/fuzzy.ts";
import {
	truncateToWidth as realTruncateToWidth,
	visibleWidth as realVisibleWidth,
	wrapTextWithAnsi as realWrapTextWithAnsi,
	sliceByColumn as realSliceByColumn,
} from "./utils_verbatim.ts";
import { Text as RealText } from "./text_verbatim.ts";
import { readFileSync } from "node:fs";

// ---- fake clock --------------------------------------------------------------
export const FIXED_NOW = 1780000000000; // 2026-05-28T21:46:40.000Z

class FakeDate extends Date {
	constructor(...args: unknown[]) {
		if (args.length === 0) {
			super(FIXED_NOW);
		} else {
			super(...(args as ConstructorParameters<typeof Date>));
		}
	}
	static now(): number {
		return FIXED_NOW;
	}
	getFullYear(): number {
		return super.getUTCFullYear();
	}
	getMonth(): number {
		return super.getUTCMonth();
	}
	getDate(): number {
		return super.getUTCDate();
	}
	getHours(): number {
		return super.getUTCHours();
	}
	getMinutes(): number {
		return super.getUTCMinutes();
	}
}
(globalThis as Record<string, unknown>).Date = FakeDate;

// ---- theme (r17-verified machinery over dark.json, truecolor) ----------------
function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) throw new Error(`Invalid hex color: ${hex}`);
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);
function findClosestCubeIndex(value: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - CUBE_VALUES[i]);
		if (dist < minDist) { minDist = dist; minIdx = i; }
	}
	return minIdx;
}
function findClosestGrayIndex(gray: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - GRAY_VALUES[i]);
		if (dist < minDist) { minDist = dist; minIdx = i; }
	}
	return minIdx;
}
function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}
function rgbTo256(r: number, g: number, b: number): number {
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	const cubeR = CUBE_VALUES[rIdx];
	const cubeG = CUBE_VALUES[gIdx];
	const cubeB = CUBE_VALUES[bIdx];
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx];
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);
	const maxC = Math.max(r, g, b);
	const minC = Math.min(r, g, b);
	const spread = maxC - minC;
	if (spread < 10 && grayDist < cubeDist) return 232 + grayIdx;
	return cubeIndex;
}
function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}
function fgAnsi(color: string, mode: string): string {
	if (color === "") return "\x1b[39m";
	if (mode === "truecolor") {
		const { r, g, b } = hexToRgb(color);
		return `\x1b[38;2;${r};${g};${b}m`;
	}
	const index = hexTo256(color);
	return `\x1b[38;5;${index}m`;
}
function bgAnsi(color: string, mode: string): string {
	if (color === "") return "\x1b[49m";
	if (mode === "truecolor") {
		const { r, g, b } = hexToRgb(color);
		return `\x1b[48;2;${r};${g};${b}m`;
	}
	const index = hexTo256(color);
	return `\x1b[48;5;${index}m`;
}
function resolveVarRefs(value: unknown, vars: Record<string, unknown>, visited = new Set<string>()): unknown {
	if (typeof value === "string" && value !== "" && !value.startsWith("#")) {
		if (visited.has(value)) throw new Error(`Circular variable reference detected: ${value}`);
		visited.add(value);
		const varValue = vars[value];
		return varValue === undefined ? value : resolveVarRefs(varValue, vars, visited);
	}
	return value;
}
function resolveThemeColors(colors: Record<string, unknown>, vars: Record<string, unknown> = {}): Record<string, unknown> {
	const resolved: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved;
}
function withThemeColorFallbacks(colors: Record<string, unknown>): Record<string, unknown> {
	const computed = { ...colors };
	const fallback = (key: string, fallbackKey: string) => {
		if (!(key in computed) || computed[key] === undefined) computed[key] = computed[fallbackKey];
	};
	fallback("scrollbarTrack", "muted");
	fallback("scrollbarThumb", "text");
	fallback("thinkingMax", "thinkingXhigh");
	fallback("searchMatchBg", "selectedBg");
	fallback("searchMatchText", "text");
	return computed;
}
const BG_COLOR_KEYS = [
	"selectedBg", "searchMatchBg", "userMessageBg", "customMessageBg",
	"toolPendingBg", "toolSuccessBg", "toolErrorBg",
];
const darkJson = JSON.parse(readFileSync(new URL("./dark.json", import.meta.url), "utf8")) as {
	name: string;
	colors: Record<string, unknown>;
	vars?: Record<string, unknown>;
};
const resolvedColors = resolveThemeColors(withThemeColorFallbacks(darkJson.colors), darkJson.vars ?? {});
const fgColors = new Map<string, string>();
const bgColors = new Map<string, string>();
for (const [key, value] of Object.entries(resolvedColors)) {
	if (typeof value === "number") continue;
	if (BG_COLOR_KEYS.includes(key)) bgColors.set(key, bgAnsi(String(value), "truecolor"));
	else fgColors.set(key, fgAnsi(String(value), "truecolor"));
}

export const theme = {
	name: darkJson.name,
	fg(color: string, text: string): string {
		const ansi = fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`;
	},
	bg(color: string, text: string): string {
		const ansi = bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`;
	},
	bold(text: string): string {
		return `\x1b[1m${text}\x1b[22m`;
	},
	italic(text: string): string {
		return `\x1b[3m${text}\x1b[23m`;
	},
};
export function initTheme(_name?: string): void {
	// single fixed theme in the oracle
}

// ---- tui re-exports ----------------------------------------------------------
export const truncateToWidth = realTruncateToWidth;
export const visibleWidth = realVisibleWidth;
export const wrapTextWithAnsi = realWrapTextWithAnsi;
export const sliceByColumn = realSliceByColumn;
export const matchesKey = realMatchesKey;
export const fuzzyMatch = realFuzzyMatch;
export const Text = RealText;


// Real tui keybindings registry (KeybindingsManager + get/set + TUI_KEYBINDINGS).
export * from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/tui/src/keybindings.ts";
export { realGetKeybindings as getKeybindingsForOracle };

// ---- trivial real Container/Spacer -------------------------------------------
export type Component = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
};
export type Focusable = {
	focused: boolean;
};

export class Spacer {
	lines: number;
	constructor(lines = 1) {
		this.lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.lines }, () => "");
	}
}

export class Container implements Component {
	children: Component[] = [];
	addChild(component: Component): void {
		this.children.push(component);
	}
	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) this.children.splice(index, 1);
	}
	clear(): void {
		this.children = [];
	}
	invalidate(): void {
		for (const child of this.children) child.invalidate?.();
	}
	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) lines.push(...child.render(width));
		return lines;
	}
}

// ---- Input: r19 cursor-accurate stub + the real tui render --------------------
// handleInput keeps the r19 stub semantics (printable insert at cursor, backspace
// deletes before the cursor, Enter fires onSubmit); render mirrors the real tui
// Input.render (packages/tui/src/components/input.ts:412-498) including the
// default "> " prompt, inverse-video fake cursor and the zero-width CURSOR_MARKER.
const CURSOR_MARKER = "\x1b_pi:c\x07";
const inputSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class Input implements Component {
	value = "";
	cursor = 0;
	prompt = "> ";
	placeholder = "";
	focused = false;
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
	}
	getValue(): string {
		return this.value;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const availableWidth = width - visibleWidth(this.prompt);
		if (availableWidth <= 0) {
			return [truncateToWidth(this.prompt, width, "")];
		}
		if (this.value.length === 0 && this.placeholder) {
			const placeholder = truncateToWidth(this.placeholder, availableWidth, "");
			const graphemes = [...inputSegmenter.segment(placeholder)];
			const atCursor = graphemes[0]?.segment ?? " ";
			const afterCursor = placeholder.slice(atCursor.length);
			const marker = this.focused ? CURSOR_MARKER : "";
			const cursorChar = `\x1b[7m${atCursor}\x1b[27m`;
			const textWithCursor = marker + cursorChar + afterCursor;
			const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(textWithCursor)));
			return [this.prompt + textWithCursor + padding];
		}
		let visibleText = "";
		let cursorDisplay = this.cursor;
		const totalWidth = visibleWidth(this.value);
		if (totalWidth < availableWidth) {
			visibleText = this.value;
		} else {
			const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
			const cursorCol = visibleWidth(this.value.slice(0, this.cursor));
			if (scrollWidth > 0) {
				const halfWidth = Math.floor(scrollWidth / 2);
				let startCol = 0;
				if (cursorCol < halfWidth) {
					startCol = 0;
				} else if (cursorCol > totalWidth - halfWidth) {
					startCol = Math.max(0, totalWidth - scrollWidth);
				} else {
					startCol = Math.max(0, cursorCol - halfWidth);
				}
				visibleText = sliceByColumn(this.value, startCol, scrollWidth, true);
				const beforeCursor = sliceByColumn(this.value, startCol, Math.max(0, cursorCol - startCol), true);
				cursorDisplay = beforeCursor.length;
			} else {
				visibleText = "";
				cursorDisplay = 0;
			}
		}
		const graphemes = [...inputSegmenter.segment(visibleText.slice(cursorDisplay))];
		const cursorGrapheme = graphemes[0];
		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? " ";
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);
		const marker = this.focused ? CURSOR_MARKER : "";
		const cursorChar = `\x1b[7m${atCursor}\x1b[27m`;
		const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;
		const visualLength = visibleWidth(textWithCursor);
		const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
		return [this.prompt + textWithCursor + padding];
	}
	handleInput(data: string): void {
		if (data === "\x7f") {
			if (this.cursor > 0) {
				this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
				this.cursor -= 1;
			}
		} else if (data === "\r" || data === "\n") {
			this.onSubmit?.(this.value);
		} else if (data.length >= 1 && !data.startsWith("\x1b")) {
			for (const ch of data) {
				this.value = this.value.slice(0, this.cursor) + ch + this.value.slice(this.cursor);
				this.cursor += 1;
			}
		}
	}
}

