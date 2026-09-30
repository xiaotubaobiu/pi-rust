// r18 oracle driver — deps layer. Stubs for the module-level identifiers the
// verbatim extracted bodies reference (gen_shell.ts). Component stubs RECORD
// their construction/method calls into the global LOG so the oracle captures
// the full action sequence. The theme is the r17-verified machinery
// (scratch/interactive_r17_oracle/theme_oracle.mjs) over the byte-identical
// dark.json with fixed chalk-enabled ANSI codes.
import { readFileSync } from "node:fs";

// ---- global action log -----------------------------------------------------
export const LOG: unknown[] = [];
export function rec(...parts: unknown[]): void {
	LOG.push(parts);
}
export function logReset(): void {
	LOG.length = 0;
}

// ---- theme (r17-verified machinery, verbatim from theme_oracle.mjs) --------
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
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		}
		const index = hexTo256(color);
		return `\x1b[38;5;${index}m`;
	}
	const index = parseInt(color, 10);
	return `\x1b[38;5;${index}m`;
}
function resolveVarRefs(value: unknown, vars: Record<string, unknown>, visited = new Set<string>()): unknown {
	if (typeof value === "string" && value !== "" && !value.startsWith("#")) {
		// upstream: any non-empty non-hex string is a variable reference
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
const resolved = resolveThemeColors(withThemeColorFallbacks(darkJson.colors), darkJson.vars ?? {});
const fgColors = new Map<string, string>();
const bgColors = new Map<string, string>();
for (const [key, value] of Object.entries(resolved)) {
	const ansi = fgAnsi(String(value), "truecolor");
	if (BG_COLOR_KEYS.includes(key)) bgColors.set(key, ansi);
	else fgColors.set(key, ansi);
}
// Constructor fallbacks (upstream Theme constructor).
if (!fgColors.has("scrollbarTrack")) fgColors.set("scrollbarTrack", fgColors.get("muted")!);
if (!fgColors.has("scrollbarThumb")) fgColors.set("scrollbarThumb", fgColors.get("text")!);
if (!fgColors.has("thinkingMax")) fgColors.set("thinkingMax", fgColors.get("thinkingXhigh")!);
if (!fgColors.has("searchMatchText")) fgColors.set("searchMatchText", fgColors.get("text")!);

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
	getThinkingBorderColor(level: string): ((str: string) => string) & { tag: string } {
		const key = `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}`;
		const fn = ((str: string) => this.fg(key, str)) as ((str: string) => string) & { tag: string };
		fn.tag = `color:${key}`;
		return fn;
	},
	getBashModeBorderColor(): ((str: string) => string) & { tag: string } {
		const fn = ((str: string) => this.fg("bashMode", str)) as ((str: string) => string) & { tag: string };
		fn.tag = "color:bashMode";
		return fn;
	},
};

// ---- component stubs (recording) -------------------------------------------
export class Container {
	children: unknown[] = [];
	constructor(...initial: unknown[]) {
		this.children.push(...initial);
	}
	addChild(child: unknown): void {
		rec("Container.addChild", this.containerName, describe(child));
		this.children.push(child);
	}
	removeChild(child: unknown): void {
		const idx = this.children.indexOf(child);
		rec("Container.removeChild", this.containerName, describe(child));
		if (idx >= 0) this.children.splice(idx, 1);
	}
	clear(): void {
		rec("Container.clear", this.containerName);
		this.children.length = 0;
	}
	containerName = "container";
}
function describe(value: unknown): unknown {
	if (value === null || value === undefined) return String(value);
	if (value instanceof Spacer) return { kind: "Spacer" };
	if (value instanceof Text) return { kind: "Text", text: (value as Text).text, paddingX: (value as Text).paddingX, paddingY: (value as Text).paddingY };
	if (value instanceof TruncatedText) return { kind: "TruncatedText", text: (value as Text).text, paddingX: (value as Text).paddingX, paddingY: (value as Text).paddingY };
	if (value instanceof DynamicBorder) return { kind: "DynamicBorder", colorTag: (value as DynamicBorder).colorTag };
	if (value instanceof Markdown) return { kind: "Markdown", text: (value as Markdown).text, paddingX: (value as Markdown).paddingX };
	if (typeof value === "object" && value !== null && "describe" in value) {
		return (value as { describe: () => unknown }).describe();
	}
	return String(value);
}
export class Text {
	text: string;
	paddingX: number;
	paddingY: number;
	constructor(text: string, paddingX = 0, paddingY = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}
	setText(text: string): void {
		rec("Text.setText", this.text, text);
		this.text = text;
	}
}
export class Spacer {
	height: number;
	constructor(height = 1) {
		this.height = height;
	}
}
export class TruncatedText extends Text {}
export class Markdown {
	text: string;
	paddingX: number;
	constructor(text: string, paddingX = 0, _paddingY = 0, _theme?: unknown, _opts?: unknown) {
		this.text = text;
		this.paddingX = paddingX;
	}
}
export class DynamicBorder {
	colorTag = "default";
	constructor(colorFn?: (text: string) => string) {
		if (colorFn && "tag" in (colorFn as { tag?: string })) {
			this.colorTag = (colorFn as { tag: string }).tag;
		}
	}
}
// Hand-mirrors upstream `class ExpandableText extends Text` (10 lines).
export class ExpandableText extends Text {
	getCollapsedText: () => string;
	getExpandedText: () => string;
	constructor(getCollapsedText: () => string, getExpandedText: () => string, expanded = false, paddingX = 0, paddingY = 0) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}
	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}
// Generic recording component: every method call lands in the LOG.
export class RecComponent {
	kind: string;
	args: unknown[];
	log: unknown[];
	constructor(kind: string, args: unknown[], log: unknown[]) {
		this.kind = kind;
		this.args = args;
		this.log = log;
		for (const a of args) {
			if (a && typeof a === "object" && "tag" in (a as { tag?: string })) {
				// color functions are recorded by tag
			}
		}
	}
	describe(): unknown {
		return { kind: this.kind, args: this.args.map(describeArg) };
	}
}
function describeArg(value: unknown): unknown {
	if (typeof value === "function") {
		const tag = (value as { tag?: string }).tag;
		return tag ?? "function";
	}
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return value.map(describeArg);
	if (value && typeof value === "object" && typeof (value as { describe?: () => unknown }).describe === "function") {
		return (value as { describe: () => unknown }).describe();
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (typeof v === "function") out[k] = (v as { tag?: string }).tag ?? "function";
			else out[k] = describeArg(v);
		}
		return out;
	}
	return value;
}
export function recordingClass(kind: string, log: unknown[], methods: string[] = []) {
	return class {
		constructor(...args: unknown[]) {
			const self = this as AnyRec;
			log.push([`new ${kind}`, ...args.map(describeArg)]);
			self.describe = () => ({ kind });
			return new Proxy(self, {
				get(target, prop) {
					if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
					if (typeof prop === "string" && methods.includes(prop)) {
						return (...callArgs: unknown[]) => {
							log.push([`${kind}.${String(prop)}`, ...callArgs.map(describeArg)]);
						};
					}
					return undefined;
				},
			});
		}
	};
}
export function makeComponentStubs(log: unknown[]) {
	const methodsFor = (kind: string) =>
		kind === "AssistantMessageComponent"
			? ["updateContent", "setHideThinkingBlock", "setHiddenThinkingLabel", "setExpanded"]
			: kind === "ToolExecutionComponent"
				? ["setExpanded", "updateArgs", "updateResult", "setArgsComplete", "markExecutionStarted"]
				: ["setExpanded", "appendOutput", "setComplete", "hasContent"];
	const out: Record<string, unknown> = {};
	for (const kind of [
		"AssistantMessageComponent", "ToolExecutionComponent", "CustomEntryComponent",
		"BashExecutionComponent", "CompactionSummaryMessageComponent",
		"BranchSummaryMessageComponent", "UserMessageComponent",
		"SkillInvocationMessageComponent", "CustomMessageComponent",
	]) {
		out[kind] = recordingClass(kind, log, methodsFor(kind));
	}
	return out;
}
export function makeStatusIndicatorStubs(log: unknown[]) {
	const out: Record<string, unknown> = {};
	for (const kind of [
		"WorkingStatusIndicator", "CompactionStatusIndicator",
		"RetryStatusIndicator", "BranchSummaryStatusIndicator",
	]) {
		out[kind] = recordingClass(kind, log, ["setMessage", "setIndicator", "dispose", "invalidate"]);
	}
	out.IdleStatus = class {
		kind = "idle";
		describe(): unknown {
			return { kind: "IdleStatus" };
		}
	};
	return out;
}
