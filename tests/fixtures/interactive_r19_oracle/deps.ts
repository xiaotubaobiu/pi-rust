// r19 oracle deps layer. Extends the r18-verified base (theme machinery over
// the byte-identical dark.json with fixed chalk-enabled ANSI codes, recording
// Container/Text/Spacer/TruncatedText/Markdown/DynamicBorder/ExpandableText)
// with the extra stubs the component files need. Real upstream code used in
// this oracle:
//   - tui keybindings/keys (file:// import of packages/tui/src)
//   - tui utils.ts truncateToWidth/visibleWidth/wrapTextWithAnsi via a
//     node_modules/get-east-asian-width narrow-only stub (ASCII scenarios)
//   - tui components/text.ts (verbatim copy in text_verbatim.ts)
//   - tui components/loader.ts + cancellable-loader.ts (verbatim copies)
//   - coding-agent core/tools/truncate.ts, utils/ansi.ts, core/usage-totals.ts
//     (verbatim copies; import-free upstream modules)
//   - the jsdiff 8.0.4 package (node_modules/diff from the npm tarball)
// Timer stubs: globalThis.__TIMERS__ records every interval; components drive
// ticks explicitly so the oracle is deterministic.
import { getKeybindings as realGetKeybindings } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/tui/src/keybindings.ts";
import {
	truncateToWidth as realTruncateToWidth,
	visibleWidth as realVisibleWidth,
	wrapTextWithAnsi as realWrapTextWithAnsi,
} from "./utils_verbatim.ts";
import { Text as RealText } from "./text_verbatim.ts";
import { Loader as RealLoader, type LoaderIndicatorOptions } from "./loader_verbatim.ts";
import { CancellableLoader as RealCancellableLoader } from "./cancellable_loader_verbatim.ts";
import { truncateTail, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "./truncate_verbatim.ts";
import { stripAnsi as realStripAnsi } from "./ansi_verbatim.ts";
import { addUsageToTotals, createUsageTotals } from "./usage_totals_verbatim.ts";

export * from "./deps_base.ts";
export { rec, logReset } from "./deps_base.ts";
export {
	realTruncateToWidth,
	realVisibleWidth,
	realWrapTextWithAnsi,
	truncateTail,
	DEFAULT_MAX_LINES,
	DEFAULT_MAX_BYTES,
	realStripAnsi,
	addUsageToTotals,
	createUsageTotals,
};

// ---- timer stubs -------------------------------------------------------------
export interface TimerRecord {
	id: number;
	everyMs: number;
	fn: () => void;
	cleared: boolean;
}
(globalThis as Record<string, unknown>).__TIMERS__ = [] as TimerRecord[];
(globalThis as Record<string, unknown>).__NEXT_TIMER_ID__ = 1;

export function timers(): TimerRecord[] {
	return (globalThis as unknown as { __TIMERS__: TimerRecord[] }).__TIMERS__;
}
(globalThis as unknown as { setInterval: unknown }).setInterval = (fn: () => void, everyMs: number): number => {
	const id = (globalThis as unknown as { __NEXT_TIMER_ID__: number }).__NEXT_TIMER_ID__++;
	timers().push({ id, everyMs, fn, cleared: false });
	return id;
};
(globalThis as unknown as { clearInterval: unknown }).clearInterval = (id: number): void => {
	for (const t of timers()) if (t.id === id) t.cleared = true;
};
export function tickTimers(times: number): void {
	for (let i = 0; i < times; i++) {
		for (const t of [...timers()]) {
			if (!t.cleared) t.fn();
		}
	}
}

// ---- capability / env switches ------------------------------------------------
(globalThis as Record<string, unknown>).__CAPS__ = { images: false, hyperlinks: false };
(globalThis as Record<string, unknown>).__XP__ = false;
(globalThis as Record<string, unknown>).__OPENED_URLS__ = [] as string[];
export function caps(): { images: false | "kitty"; hyperlinks: boolean } {
	return (globalThis as unknown as { __CAPS__: { images: false | "kitty"; hyperlinks: boolean } }).__CAPS__;
}
export function setCaps(next: { images: false | "kitty"; hyperlinks: boolean }): void {
	(globalThis as unknown as { __CAPS__: { images: false | "kitty"; hyperlinks: boolean } }).__CAPS__ = next;
}
export function setXp(value: boolean): void {
	(globalThis as unknown as { __XP__: boolean }).__XP__ = value;
}
export function openedUrls(): string[] {
	return (globalThis as unknown as { __OPENED_URLS__: string[] }).__OPENED_URLS__;
}

// ---- upstream-verified pieces exposed under the names components import -------
// The tui registry lacks the coding-agent `app.*` ids (those are merged in by
// core/keybindings.ts, which is not loadable offline); the table below mirrors
// the upstream defaults the scenarios exercise.
const APP_KEYS: Record<string, string[]> = {
	"app.interrupt": ["escape"],
	"app.clear": ["ctrl+c"],
	"app.tools.expand": ["ctrl+o"],
	"app.thinking.save": ["ctrl+s"],
	"app.thinking.cycle": ["shift+tab"],
	"app.thinking.toggle": ["ctrl+t"],
	"app.editor.external": ["ctrl+g"],
};
export function getKeybindings(): {
	matches: (data: string, kb: string) => boolean;
	getKeys: (kb: string) => string[];
} {
	const real = realGetKeybindings();
	return {
		matches: (data: string, kb: string) => (APP_KEYS[kb] ?? []).includes(data) || real.matches(data, kb),
		getKeys: (kb: string) => APP_KEYS[kb] ?? real.getKeys(kb),
	};
}
export function truncateToWidth(text: string, width: number, ellipsis = "", pad = false): string {
	return realTruncateToWidth(text, width, ellipsis, pad);
}
export function visibleWidth(text: string): number {
	return realVisibleWidth(text);
}
export function wrapTextWithAnsi(text: string, width: number): string[] {
	return realWrapTextWithAnsi(text, width);
}
export function stripAnsi(text: string): string {
	return realStripAnsi(text);
}
export { RealText };
export { RealLoader, RealCancellableLoader };
export type LoaderIndicatorOptions = LoaderIndicatorOptions;

// ---- lighter recording stubs ---------------------------------------------------
export function getMarkdownTheme(): Record<string, unknown> {
	return {};
}
export function getSelectListTheme(): Record<string, unknown> {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}
export function getEditorTheme(): Record<string, unknown> {
	return { borderColor: (text: string) => theme.fg("borderMuted", text) };
}
export function getAvailableThemes(): string[] {
	return ["dark", "light"];
}
export const APP_NAME = "pi";
export function areExperimentalFeaturesEnabled(): boolean {
	return (globalThis as unknown as { __XP__: boolean }).__XP__;
}
export function openBrowser(url: string): void {
	openedUrls().push(url);
}

import { theme } from "./deps_base.ts";


export class Image {
	data: string;
	mimeType: string;
	opts: unknown;
	constructor(data: string, mimeType: string, _fallback?: unknown, opts?: unknown) {
		this.data = data;
		this.mimeType = mimeType;
		this.opts = opts ?? null;
	}
	describe(): unknown {
		return { kind: "Image", dataLen: this.data.length, mimeType: this.mimeType, opts: this.opts };
	}
}

export class Input {
	// Cursor-accurate stub of the real tui Input (packages/tui/src/components/input.ts):
	// setValue keeps the cursor (clamped to the new length), printable input inserts
	// at the cursor, backspace deletes before the cursor. The earlier append-only
	// stub diverged from the real widget for multi-keystroke input after a
	// non-empty initial value (e.g. oauth_selector's "a" + "n" -> "na", not "an").
	value = "";
	cursor = 0;
	onSubmit?: () => void;
	onEscape?: () => void;
	focused = false;
	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
	}
	getValue(): string {
		return this.value;
	}
	handleInput(data: string): void {
		// Enter fires onSubmit; escape sequences are ignored; the full input
		// widget is the separately-verified tui slice.
		if (data === "\x7f") {
			if (this.cursor > 0) {
				this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
				this.cursor -= 1;
			}
		} else if (data === "\r" || data === "\n") {
			this.onSubmit?.();
		} else if (data.length >= 1 && !data.startsWith("\x1b")) {
			for (const ch of data) {
				this.value = this.value.slice(0, this.cursor) + ch + this.value.slice(this.cursor);
				this.cursor += 1;
			}
		}
	}
	describe(): unknown {
		return { kind: "Input", value: this.value };
	}
}

export class Editor {
	text = "";
	onSubmit?: (text: string) => void;
	focused = false;
	setText(text: string): void {
		deps_base_rec("Editor.setText", text);
		this.text = text;
	}
	getText(): string {
		return this.text;
	}
	handleInput(_data: string): void {}
	describe(): unknown {
		return { kind: "Editor", text: this.text };
	}
}

export class SelectList {
	items: unknown[];
	maxVisible: number;
	selectedIndex = 0;
	onSelect?: (item: AnyRec) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: AnyRec) => void;
	constructor(items: unknown[], maxVisible: number, _theme?: unknown, _layout?: unknown) {
		this.items = items;
		this.maxVisible = maxVisible;
	}
	setSelectedIndex(index: number): void {
		this.selectedIndex = index;
	}
	getSelectedItem(): AnyRec | undefined {
		return this.items[this.selectedIndex] as AnyRec | undefined;
	}
	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
		} else if (kb.matches(data, "tui.select.confirm")) {
			const item = this.getSelectedItem();
			if (item && this.onSelect) this.onSelect(item);
		} else if (kb.matches(data, "tui.select.cancel")) {
			if (this.onCancel) this.onCancel();
		}
	}
	describe(): unknown {
		return { kind: "SelectList", items: this.items, maxVisible: this.maxVisible, selectedIndex: this.selectedIndex };
	}
}

export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	// Real upstream implementation via the file:// import.
	return realFuzzyFilter(items, query, getText);
}
import { fuzzyFilter as realFuzzyFilter, fuzzyMatch as realFuzzyMatch } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/tui/src/fuzzy.ts";
export { realFuzzyMatch as fuzzyMatch };

export function getCapabilities(): { images: false | "kitty"; hyperlinks: boolean } {
	return caps();
}
export function getImageDimensions(_data: string, _mime: string): undefined {
	return undefined;
}
// Byte-faithful face of the real packages/tui/src/terminal-image.ts
 // imageFallback for the stub's inputs (no filename, no dimensions).
export function imageFallback(mimeType: string, _dims?: unknown, filename?: string): string {
	const parts: string[] = [];
	if (filename) parts.push(filename);
	parts.push(`[${mimeType}]`);
	return `[Image: ${parts.join(" ")}]`;
}
export function hyperlink(text: string, _url: string): string {
	return caps().hyperlinks ? `\x1b]8;;${_url}\x07${text}\x1b]8;;\x07` : text;
}
export function convertToPng(_data: string, mimeType: string): Promise<{ data: string; mimeType: string } | null> {
	// Deterministic stub: only png survives unchanged.
	return Promise.resolve(mimeType === "image/png" ? { data: "pngdata", mimeType } : null);
}

export class ScrollView {
	child: unknown;
	options: AnyRec;
	constructor(child: unknown, options: AnyRec) {
		this.child = child;
		this.options = options;
	}
	describe(): unknown {
		return { kind: "ScrollView", options: this.options };
	}
}
export class VStack {
	entries: unknown[];
	constructor(entries: unknown[]) {
		this.entries = entries;
	}
	describe(): unknown {
		return {
			kind: "VStack",
			entries: this.entries.map((e) => {
				const entry = e as AnyRec;
				return {
					component: describe(entry.component),
					basis: entry.basis,
					grow: entry.grow,
					shrink: entry.shrink,
					minSize: entry.minSize,
				};
			}),
		};
	}
}

// ---- shared types ---------------------------------------------------------------
export type AnyRec = Record<string, unknown>;

export function describe(value: unknown): unknown {
	if (value === null || value === undefined) return String(value);
	if (value instanceof Box || value instanceof MouseRegion || value instanceof Image || value instanceof Input
		|| value instanceof Editor || value instanceof SelectList || value instanceof ScrollView || value instanceof VStack) {
		return value.describe();
	}
	if (value instanceof RealText) {
		return { kind: "Text", text: (value as unknown as { text: string }).text, paddingX: (value as unknown as { paddingX: number }).paddingX, paddingY: (value as unknown as { paddingY: number }).paddingY };
	}
	if (value instanceof RealLoader) {
		const loader = value as unknown as { message: string };
		return { kind: "Loader", message: loader.message };
	}
	if (typeof value === "function") return (value as { tag?: string }).tag ?? "function";
	if (Array.isArray(value)) return value.map(describe);
	if (typeof value === "object" && typeof (value as { describe?: () => unknown }).describe === "function") {
		return (value as { describe: () => unknown }).describe();
	}
	return String(value);
}

// The base describe() is not exported; components copied verbatim import the
// stubs by name, so this re-export list mirrors their import surface.
export const earendilAssetMissing = true;
export function getBundledInteractiveAssetPath(_name: string): string {
	return "Z:/definitely/missing/clankolas.png";
}

// ---- loader aliases (components import `Loader` / `CancellableLoader`) -------
export { RealLoader as Loader, RealCancellableLoader as CancellableLoader };

// `Text` is the REAL upstream component (via text_verbatim.ts) so render
// outputs are faithful; the deps_base recording stub remains only inside
// deps_base-internal describe() paths.
export { RealText as Text };

// The real Text class carries setCustomBgFn already; nothing to patch.

import * as deps_base_module2 from "./deps_base.ts";
const deps_base_Container = deps_base_module2.Container;
const deps_base_Spacer = deps_base_module2.Spacer;
const deps_base_Markdown = deps_base_module2.Markdown;
const deps_base_rec = deps_base_module2.rec;
const deps_base_theme = deps_base_module2.theme;

// The r17-verified theme machinery exposes bold/italic; the r19 components
// additionally use underline/inverse (chalk-enabled fixed codes).
(deps_base_theme as AnyRec).underline = (text: string): string => `\x1b[4m${text}\x1b[24m`;
(deps_base_theme as AnyRec).inverse = (text: string): string => `\x1b[7m${text}\x1b[27m`;

// ---- faithful render patches for the remaining deps_base stubs ---------------
(deps_base_Container.prototype as AnyRec).render = function (width: number): string[] {
	const out: string[] = [];
	for (const child of (this as AnyRec).children as unknown[]) {
		if (child && typeof (child as AnyRec).render === "function") out.push(...(child as AnyRec).render(width));
	}
	return out;
};
(deps_base_Container.prototype as AnyRec).invalidate = function (): void {
	for (const child of (this as AnyRec).children as unknown[]) {
		if (child && typeof (child as AnyRec).invalidate === "function") (child as AnyRec).invalidate();
	}
};
(deps_base_Spacer.prototype as AnyRec).render = function (): string[] {
	return new Array((this as AnyRec).height as number).fill("");
};
(deps_base_Markdown.prototype as AnyRec).render = function (): string[] {
	// STUB FACE: markdown engine rendering is verified in its own slice; here a
	// Markdown child contributes its raw source lines.
	return ((this as AnyRec).text as string).split("\n");
};

// DynamicBorder with faithful render (keeps the r18 colorTag bookkeeping).
export class DynamicBorder {
	colorFn?: (text: string) => string;
	colorTag: string;
	constructor(colorFn?: (text: string) => string) {
		this.colorFn = colorFn;
		this.colorTag = colorFn && "tag" in (colorFn as { tag?: string }) ? (colorFn as { tag: string }).tag : colorFn ? "fn" : "default";
	}
	render(width: number): string[] {
		const line = "\u2500".repeat(Math.max(1, width));
		return [this.colorFn ? this.colorFn(line) : theme.fg("border", line)];
	}
	describe(): unknown {
		return { kind: "DynamicBorder", colorTag: this.colorTag };
	}
}

// Faithful port of upstream Box render (minus mouse bookkeeping).
export class Box {
	children: unknown[] = [];
	paddingX: number;
	paddingY: number;
	bgFn?: (text: string) => string;
	bgTag: string | null;
	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
		this.bgTag = bgFn && "tag" in (bgFn as { tag?: string }) ? (bgFn as { tag: string }).tag : bgFn ? "fn" : null;
	}
	addChild(child: unknown): void {
		this.children.push(child);
	}
	clear(): void {
		this.children = [];
	}
	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		this.bgTag = bgFn && "tag" in (bgFn as { tag?: string }) ? (bgFn as { tag: string }).tag : bgFn ? "fn" : null;
	}
	applyBg(line: string, width: number): string {
		const visLen = realVisibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);
		if (this.bgFn) return realApplyBackgroundToLine(padded, width, this.bgFn);
		return padded;
	}
	render(width: number): string[] {
		if (this.children.length === 0) return [];
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);
		const childLines: string[] = [];
		for (const child of this.children) {
			const c = child as AnyRec;
			for (const line of c.render(contentWidth) as string[]) childLines.push(leftPad + line);
		}
		if (childLines.length === 0) return [];
		const result: string[] = [];
		for (let i = 0; i < this.paddingY; i++) result.push(this.applyBg("", width));
		for (const line of childLines) result.push(this.applyBg(line, width));
		for (let i = 0; i < this.paddingY; i++) result.push(this.applyBg("", width));
		return result;
	}
	describe(): unknown {
		return { kind: "Box", paddingX: this.paddingX, paddingY: this.paddingY, bgTag: this.bgTag };
	}
}
import { applyBackgroundToLine as realApplyBackgroundToLine } from "./utils_verbatim.ts";

export class MouseRegion {
	child: unknown;
	constructor(child: unknown, _onMouse: unknown) {
		this.child = child;
	}
	render(width: number): string[] {
		const c = this.child as AnyRec;
		return typeof c.render === "function" ? (c.render(width) as string[]) : [];
	}
	describe(): unknown {
		return { kind: "MouseRegion", child: describe(this.child) };
	}
}

// ---- faithful local copies of two upstream util fns (their home modules pull
// config.ts / cross-spawn which are not loadable offline) -----------------------
export function sanitizeBinaryOutput(str: string): string {
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}
export function resolvePath(input: string, baseDir = process.cwd()): string {
	const isAbs = /^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\") || input.startsWith("/") || input.startsWith("\\");
	return isAbs ? input : `${baseDir.replace(/[\\/]+$/, "")}\\${input}`;
}

// ---- external editor stub ------------------------------------------------------
export async function editInExternalEditor(options: { command: string; content: string }): Promise<AnyRec> {
	deps_base_rec("editInExternalEditor", options.command, options.content);
	return { status: "complete", content: `EDITED(${options.content})` };
}

// ---- trust options (upstream module is not loadable offline; the deterministic
// options table itself is verified by the earlier trust_oracle.json round) -------
export interface ProjectTrustOption {
	label: string;
	trusted: boolean;
	updates: boolean;
	savedPath: string | undefined;
}
export interface ProjectTrustStoreEntry {
	path: string;
	decision: boolean;
}
(globalThis as Record<string, unknown>).__TRUST_OPTIONS__ = [] as ProjectTrustOption[];
export function setTrustOptions(options: ProjectTrustOption[]): void {
	(globalThis as unknown as { __TRUST_OPTIONS__: ProjectTrustOption[] }).__TRUST_OPTIONS__ = options;
}
export function getProjectTrustOptions(_cwd: string): ProjectTrustOption[] {
	return (globalThis as unknown as { __TRUST_OPTIONS__: ProjectTrustOption[] }).__TRUST_OPTIONS__;
}
