// Oracle runner: executes the REAL upstream tui.ts (TuiBase) under node
// --experimental-strip-types and captures byte-exact terminal writes for each
// scenario. The concrete renderer (`doRender`) is not part of tui.ts, so the
// TestTui subclass below carries a reference implementation copied from the
// core of tui-main-screen.ts `doRender` (non-Kitty-image paths, single-buffer
// flush, no debug/crash logging). Copies of the upstream sources in this
// directory are hash-verified against the read-only originals (see
// gen_data.mjs header + slice report).
import { writeFileSync } from "node:fs";
import { visibleWidth, stripTerminalSequences } from "./utils.ts";
import { TuiBase, Container, compositeTuiLine, CURSOR_MARKER } from "./tui.ts";
import {
	setCapabilities,
	resetCapabilitiesCache,
	setCellDimensions,
	getCellDimensions,
} from "./terminal-image.ts";

const ESC = "\x1b";

/** Memory terminal: writes recorded, input/resize handlers programmable. */
class FakeTerminal {
	constructor(columns = 80, rows = 24) {
		this.writes = [];
		this.columns = columns;
		this.rows = rows;
		this.onInput = undefined;
		this.onResize = undefined;
		this.startCalls = 0;
		this.stopCalls = 0;
	}
	start(onInput, onResize) {
		this.onInput = onInput;
		this.onResize = onResize;
		this.startCalls += 1;
	}
	stop() {
		this.onInput = undefined;
		this.onResize = undefined;
		this.stopCalls += 1;
	}
	write(data) {
		this.writes.push(data);
	}
	hideCursor() {
		this.writes.push("\x1b[?25l");
	}
	showCursor() {
		this.writes.push("\x1b[?25h");
	}
	sendInput(data) {
		if (this.onInput) this.onInput(data);
	}
	resize(columns, rows) {
		this.columns = columns;
		this.rows = rows;
		if (this.onResize) this.onResize();
	}
	joined() {
		return this.writes.join("");
	}
}

/** Reference renderer: tui-main-screen.ts doRender core without Kitty images,
 * bounded chunking (single buffered flush instead), crash dumps and debug logs.
 * The width-overflow guard is kept: it throws after clearing the current line
 * position, matching the upstream control flow (buffered writes are lost). */
class TestTui extends TuiBase {
	constructor(terminal, showHardwareCursor) {
		super(terminal, showHardwareCursor);
		this.mode = "regular";
		this.previousLines = [];
		this.previousWidth = 0;
		this.previousHeight = 0;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
		this.renderCount = 0;
		this.lastNewLines = null;
	}
	resetRenderState() {
		this.previousLines = [];
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
	}
	positionHardwareCursor(cursorPos, totalLines) {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
		else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
		buffer += `\x1b[${targetCol + 1}G`;
		if (buffer) this.terminal.write(buffer);
		this.hardwareCursorRow = targetRow;
		if (this.getShowHardwareCursor()) this.terminal.showCursor();
		else this.terminal.hideCursor();
	}
	doRender() {
		if (this.stopped) return;
		this.renderCount += 1;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow) => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		let newLines = this.render(width);
		if (this.hasOverlayEntries) {
			newLines = this.compositeOverlays(newLines, width, height);
		}
		const cursorPos = this.extractCursorPosition(newLines, height);
		newLines = this.applyLineResets(newLines);
		this.lastNewLines = [...newLines];

		const flush = (buffer) => {
			if (buffer) this.terminal.write(buffer);
		};

		const fullRender = (clear) => {
			this.fullRedrawCount += 1;
			let buffer = "\x1b[?2026h";
			if (clear) buffer += "\x1b[2J\x1b[H\x1b[3J";
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l";
			flush(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			if (clear) this.maxLinesRendered = newLines.length;
			else this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousWidth = width;
			this.previousHeight = height;
		};

		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			fullRender(false);
			return;
		}
		if (widthChanged) {
			fullRender(true);
			return;
		}
		if (heightChanged) {
			fullRender(true);
			return;
		}
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			fullRender(true);
			return;
		}

		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";
			if (oldLine !== newLine) {
				if (firstChanged === -1) firstChanged = i;
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) firstChanged = this.previousLines.length;
			lastChanged = newLines.length - 1;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					fullRender(true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					buffer += `\x1b[${clearStartOffset}B`;
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					buffer += `\x1b[${moveBack}A`;
				}
				buffer += "\x1b[?2026l";
				flush(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		if (firstChanged < prevViewportTop) {
			fullRender(true);
			return;
		}

		let buffer = "\x1b[?2026h";
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`;
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`;
		}
		buffer += appendStart ? "\r\n" : "\r";
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			const line = newLines[i];
			if (!line.startsWith(ESC + "_G") && visibleWidth(line) > width) {
				throw new Error(`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`);
			}
			buffer += "\x1b[2K";
			buffer += line;
		}
		let finalCursorRow = renderEnd;
		if (this.previousLines.length > newLines.length) {
			if (renderEnd < newLines.length - 1) {
				buffer += `\x1b[${newLines.length - 1 - renderEnd}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			buffer += `\x1b[${extraLines}A`;
		}
		buffer += "\x1b[?2026l";
		flush(buffer);

		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);
		this.positionHardwareCursor(cursorPos, newLines.length);
		this.previousLines = newLines;
		this.previousWidth = width;
		this.previousHeight = height;
	}
}

class TestComponent {
	constructor() {
		this.lines = [];
		this.renderCount = 0;
		this.inputs = [];
		this.focused = false;
		this.wantsKeyRelease = false;
		this.requestedWidth = undefined;
	}
	render(width) {
		this.renderCount += 1;
		this.requestedWidth = width;
		return this.lines;
	}
	handleInput(data) {
		this.inputs.push(data);
	}
	invalidate() {}
}

class Lines extends TestComponent {
	constructor(lines) {
		super();
		this.lines = lines;
	}
}

class InputComponent extends TestComponent {
	constructor(lines) {
		super(lines);
		this.lines = lines ?? [];
	}
	handleInput(data) {
		this.inputs.push(data);
		this.lines = [data];
	}
}

class EmptyContent extends TestComponent {
	render() {
		return [];
	}
}

const tick = () => new Promise((resolve) => process.nextTick(resolve));
const settle = async () => {
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 25));
	await tick();
};
const renderAndFlush = async (tui) => {
	tui.requestRender(true);
	await tick();
	await settle();
};

const out = {};
const strip = (line) => stripTerminalSequences(line).trimEnd();
const viewport = (tui) => (tui.lastNewLines ?? []).map(strip);


// v0.99.1 delta scenarios -----------------------------------------------------

const PALETTE_REPLIES = Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};#000000\x07`);
const DA1 = "\x1b[?62;22c";
const jsonRgb = (rgb) => (rgb === undefined ? null : { r: rgb.r, g: rgb.g, b: rgb.b });

// 1. queryTerminalColors: one write, all replies resolve without DA1.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(80, 24);
	const tui = new TestTui(terminal);
	const component = new InputComponent([]);
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	await settle();
	terminal.writes.length = 0;
	let resolved;
	const query = tui.queryTerminalColors({ timeoutMs: 1000 }).then((colors) => {
		resolved = colors;
		return colors;
	});
	await tick();
	out.tui_color_query_write = [...terminal.writes];
	terminal.writes.length = 0;
	terminal.sendInput("x");
	terminal.sendInput("\x1b]10;#ffffff\x07");
	terminal.sendInput("\x1b]11;rgb:0000/0000/0000\x1b\\");
	for (const reply of PALETTE_REPLIES) terminal.sendInput(reply);
	await tick();
	await tick();
	out.tui_color_query_resolved = {
		colors: {
			foreground: jsonRgb(resolved?.foreground),
			background: jsonRgb(resolved?.background),
			palette: resolved?.palette ? resolved.palette.map(jsonRgb) : null,
		},
		inputs: [...component.inputs],
	};
	terminal.writes.length = 0;
	terminal.sendInput(DA1);
	await tick();
	terminal.writes.length = 0;
	tui.stop();
	await settle();
}

// 2. FIFO: DA1 resolves the oldest query with the replies that arrived.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(80, 24);
	const tui = new TestTui(terminal);
	const component = new InputComponent([]);
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	await settle();
	terminal.writes.length = 0;
	const results = [];
	tui.queryTerminalColors({ timeoutMs: 5000 }).then((colors) => results.push(["first", colors]));
	tui.queryTerminalColors({ timeoutMs: 5000 }).then((colors) => results.push(["second", colors]));
	await tick();
	terminal.sendInput("\x1b]11;#000000\x07");
	for (const reply of PALETTE_REPLIES.slice(0, 8)) terminal.sendInput(reply);
	terminal.sendInput(DA1);
	await tick();
	await tick();
	terminal.sendInput(DA1);
	await tick();
	await tick();
	out.tui_color_query_fifo = {
		results: results.map(([id, colors]) => [
			id,
			{
				foreground: jsonRgb(colors?.foreground),
				background: jsonRgb(colors?.background),
				palette: colors?.palette ? colors.palette.map(jsonRgb) : null,
			},
		]),
	};
	tui.stop();
	await settle();
}

// 3. Late replies after the timeout feed onLateReply until DA1.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(80, 24);
	const tui = new TestTui(terminal);
	const component = new InputComponent([]);
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	await settle();
	terminal.writes.length = 0;
	const late = [];
	const query = tui.queryTerminalColors({ timeoutMs: 1, onLateReply: (colors) => late.push(colors) });
	await new Promise((resolve) => setTimeout(resolve, 5));
	const timedOut = await query;
	terminal.writes.length = 0;
	terminal.sendInput("\x1b]11;#ffffff\x07");
	terminal.sendInput(DA1);
	await tick();
	await tick();
	out.tui_color_query_late = {
		timedOut: {
			foreground: jsonRgb(timedOut?.foreground),
			background: jsonRgb(timedOut?.background),
			palette: timedOut?.palette ? timedOut.palette.map(jsonRgb) : null,
		},
		late: late.map((colors) => ({
			foreground: jsonRgb(colors?.foreground),
			background: jsonRgb(colors?.background),
			palette: colors?.palette ? colors.palette.map(jsonRgb) : null,
		})),
		inputs: [...component.inputs],
	};
	// With no query pending, color replies are ordinary input again.
	terminal.writes.length = 0;
	terminal.sendInput("\x1b]11;#ffffff\x07");
	await tick();
	out.tui_color_after_queries = { inputs: [...component.inputs] };
	tui.stop();
	await settle();
}

// 4. hideTerminalCursor: cursor stays hidden-agnostic after stop().
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	tui.start();
	await settle();
	tui.stop();
	await settle();
	terminal.writes.length = 0;
	tui.setShowHardwareCursor(false);
	await tick();
	out.tui_hide_cursor_after_stop = { writes: [...terminal.writes] };
	// While running, the hide still goes out.
	tui.start();
	await settle();
	terminal.writes.length = 0;
	tui.setShowHardwareCursor(true);
	await tick();
	terminal.writes.length = 0;
	tui.setShowHardwareCursor(false);
	await tick();
	out.tui_hide_cursor_running = { writes: [...terminal.writes] };
	tui.stop();
	await settle();
}


import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const target = process.argv[2] ?? fileURLToPath(new URL("./tui_oracle.json", import.meta.url));
out.provenance = {
	tuiSha256: createHash("sha256").update(readFileSync(fileURLToPath(new URL("./tui.ts", import.meta.url)))).digest("hex"),
	utilsSha256: createHash("sha256").update(readFileSync(fileURLToPath(new URL("./utils.ts", import.meta.url)))).digest("hex"),
	keysSha256: createHash("sha256").update(readFileSync(fileURLToPath(new URL("./keys.ts", import.meta.url)))).digest("hex"),
	terminalColorsSha256: createHash("sha256").update(readFileSync(fileURLToPath(new URL("./terminal-colors.ts", import.meta.url)))).digest("hex"),
	terminalImageSha256: createHash("sha256").update(readFileSync(fileURLToPath(new URL("./terminal-image.ts", import.meta.url)))).digest("hex"),
	node: process.version,
	platform: process.platform,
};
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log("delta tui oracle scenarios:", Object.keys(out).length, createHash("sha256").update(readFileSync(target)).digest("hex"));
