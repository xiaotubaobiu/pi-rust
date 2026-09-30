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

// ---------------------------------------------------------------- scenarios

// 1. lifecycle: start/stop writes (images disabled).
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	const component = new Lines(["hello"]);
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	await settle();
	out.lifecycle = {
		writes: [...terminal.writes],
		fullRedraws: tui.fullRedraws,
		renderCount: tui.renderCount,
	};
	terminal.writes.length = 0;
	tui.stop();
	out.lifecycle_stop = { writes: [...terminal.writes], stopCalls: terminal.stopCalls };
}

// 2. color-scheme notification writes around start/stop.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	tui.setTerminalColorSchemeNotifications(true);
	out.scheme_notifications_before_start = { writes: [...terminal.writes] };
	terminal.writes.length = 0;
	tui.start();
	await settle();
	out.scheme_notifications_start = { writes: [...terminal.writes] };
	terminal.writes.length = 0;
	tui.setTerminalColorSchemeNotifications(false);
	out.scheme_notifications_disable = { writes: [...terminal.writes] };
	terminal.writes.length = 0;
	tui.stop();
	out.scheme_notifications_stop = { writes: [...terminal.writes] };
}

// 3. keyboard input preempts a queued throttled frame (tui-render.test.ts).
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	const component = new InputComponent(["initial"]);
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	tui.renderNow();
	const renderCountBeforeInput = component.renderCount;
	component.lines = ["pending"];
	tui.requestRender();
	terminal.sendInput("first");
	terminal.sendInput("second");
	terminal.sendInput("typed");
	await tick();
	out.keyboard_preempt = {
		renderCountDelta: component.renderCount - renderCountBeforeInput,
		lines: [...component.lines],
		inputs: [...component.inputs],
	};
	tui.stop();
	await settle();
}

// 4. throttled frame timing: requestRender does not paint before the timer.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	const component = new Lines(["one"]);
	tui.addChild(component);
	tui.start();
	await settle();
	component.lines = ["two"];
	tui.requestRender();
	await tick();
	const beforeTimer = { writes: [...terminal.writes], renderCount: tui.renderCount };
	await settle();
	out.throttled_frame = {
		before_timer: { writes: beforeTimer.writes, renderCount: beforeTimer.renderCount },
		after_timer: { writes: terminal.writes.slice(beforeTimer.writes.length), renderCount: tui.renderCount },
	};
	tui.stop();
	await settle();
}

// 5. input pipeline: listeners, debug key, key release, focused dispatch.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	const component = new InputComponent([]);
	tui.addChild(component);
	tui.setFocus(component);
	tui.addInputListener((data) => {
		if (data === "consume-me") return { consume: true };
		if (data === "rewrite") return { data: "rewritten" };
		if (data === "to-empty") return { data: "" };
		return undefined;
	});
	const removedSecond = tui.addInputListener((data) => {
		if (data === "drop-second") return { consume: true };
		return undefined;
	});
	tui.start();
	await settle();
	terminal.sendInput("consume-me");
	terminal.sendInput("rewrite");
	terminal.sendInput("to-empty");
	terminal.sendInput("drop-second");
	terminal.sendInput("q");
	const pipelineInputs = [...component.inputs];
	// Removing a listener restores pass-through.
	removedSecond();
	terminal.sendInput("drop-second");
	out.input_pipeline = {
		inputs: pipelineInputs,
		inputsAfterRemove: [...component.inputs],
		renderCount: tui.renderCount,
	};

	// Debug key discovery: which sequences satisfy matchesKey("shift+ctrl+d")?
	const candidates = ["\x04", "\x1b[100;6u", "\x1b[100;4u", "\x1b[100;5u"];
	const debugHits = [];
	for (const candidate of candidates) {
		const t2 = new FakeTerminal(40, 10);
		const tui2 = new TestTui(t2);
		let debugCalls = 0;
		tui2.onDebug = () => {
			debugCalls += 1;
		};
		tui2.start();
		t2.sendInput(candidate);
		await tick();
		debugHits.push(debugCalls);
		tui2.stop();
		await settle();
	}
	out.debug_key = { candidates, hits: debugHits };

	// Key release filtering.
	const t3 = new FakeTerminal(40, 10);
	const tui3 = new TestTui(t3);
	const recorder = new InputComponent([]);
	const releaseOk = new InputComponent([]);
	releaseOk.wantsKeyRelease = true;
	tui3.addChild(recorder);
	tui3.setFocus(recorder);
	tui3.start();
	await settle();
	t3.sendInput("\x1b[100;1:3u");
	t3.sendInput("x");
	out.key_release = { inputs: [...recorder.inputs] };
	tui3.stop();
	await settle();
}

// 6. cell size query + responses (tui-cell-size-input.test.ts).
{
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	const terminal = new FakeTerminal(80, 24);
	const tui = new TestTui(terminal);
	const recorder = new InputComponent([]);
	tui.addChild(recorder);
	tui.setFocus(recorder);
	tui.start();
	await tick();
	out.cell_size_start = {
		writes: [...terminal.writes],
		cellDimensions: getCellDimensions(),
	};
	terminal.sendInput("\x1b[6;20;10t");
	await tick();
	out.cell_size_response = {
		inputs: [...recorder.inputs],
		cellDimensions: getCellDimensions(),
	};
	terminal.sendInput("q");
	await tick();
	out.cell_size_after = { inputs: [...recorder.inputs] };
	terminal.writes.length = 0;
	tui.stop();
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	await settle();
}

// 6b. bare escape still forwarded when images disabled (no 16t query).
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(80, 24);
	const tui = new TestTui(terminal);
	const recorder = new InputComponent([]);
	tui.addChild(recorder);
	tui.setFocus(recorder);
	tui.start();
	await tick();
	out.cell_size_disabled_start = {
		writes: [...terminal.writes],
	};
	terminal.sendInput("\x1b");
	await tick();
	out.cell_size_disabled_escape = { inputs: recorder.inputs };
	tui.stop();
	await settle();
}

// 7. OSC 11 background color query: response, timeout, FIFO ordering.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(80, 24);
	const tui = new TestTui(terminal);
	tui.start();
	await settle();
	terminal.writes.length = 0;
	const results = [];
	tui.queryTerminalBackgroundColor({ timeoutMs: 5000 }).then((rgb) => results.push(["first", rgb]));
	tui.queryTerminalBackgroundColor({ timeoutMs: 5000 }).then((rgb) => results.push(["second", rgb]));
	await tick();
	out.osc11_query_writes = [...terminal.writes];
	terminal.writes.length = 0;
	terminal.sendInput("\x1b]11;rgb:2222/ffff/0000\x07");
	await tick();
	await tick();
	out.osc11_response = { results: [...results], writes: [...terminal.writes] };
	terminal.writes.length = 0;
	// Timeout path.
	const timeoutResults = [];
	tui.queryTerminalBackgroundColor({ timeoutMs: 20 }).then((rgb) => timeoutResults.push(rgb));
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 60));
	out.osc11_timeout = { results: timeoutResults };
	tui.stop();
	await settle();
}

// 8. color scheme query + listener.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(80, 24);
	const tui = new TestTui(terminal);
	tui.start();
	await settle();
	terminal.writes.length = 0;
	const schemes = [];
	const listenerIds = [];
	listenerIds.push(tui.onTerminalColorSchemeChange((scheme) => schemes.push(["listener", scheme])));
	tui.queryTerminalColorScheme({ timeoutMs: 5000 }).then((scheme) => schemes.push(["query", scheme]));
	await tick();
	out.scheme_query_writes = [...terminal.writes];
	terminal.writes.length = 0;
	terminal.sendInput("\x1b[?997;1n");
	await tick();
	await tick();
	out.scheme_report = { schemes: [...schemes], writes: [...terminal.writes] };
	terminal.writes.length = 0;
	const timeoutSchemes = [];
	tui.queryTerminalColorScheme({ timeoutMs: 20 }).then((scheme) => timeoutSchemes.push(scheme));
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 60));
	out.scheme_timeout = { schemes: timeoutSchemes };
	tui.stop();
	await settle();
}

// 9. shrink with clearOnShrink (tui-shrink.test.ts + render shrink tests).
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	tui.setClearOnShrink(true);
	const component = new Lines([]);
	tui.addChild(component);
	tui.start();
	await settle();
	const redrawsBefore = tui.fullRedraws;
	component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
	tui.requestRender();
	await settle();
	const initial = terminal.writes.slice();
	terminal.writes.length = 0;
	component.lines = ["Line 0", "Line 1"];
	tui.requestRender();
	await settle();
	out.shrink_clear = {
		initial_writes: initial,
		shrink_writes: [...terminal.writes],
		full_redraw_delta: tui.fullRedraws - redrawsBefore,
		viewport: viewport(tui),
	};
	terminal.writes.length = 0;
	// Shrink to single line and to empty.
	component.lines = ["Only line"];
	tui.requestRender();
	await settle();
	const singleViewport = viewport(tui);
	component.lines = [];
	tui.requestRender();
	await settle();
	out.shrink_more = { single_viewport: singleViewport, empty_viewport: viewport(tui) };
	tui.stop();
	await settle();
}

// 10. spinner: only a middle line changes.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	const component = new Lines([]);
	tui.addChild(component);
	tui.start();
	await settle();
	const frames = [];
	terminal.writes.length = 0;
	for (const frame of ["|", "/", "-", "\\"]) {
		component.lines = ["Header", `Working ${frame}`, "Footer"];
		tui.requestRender();
		await settle();
		frames.push([...terminal.writes]);
		terminal.writes.length = 0;
	}
	out.spinner = { frames, viewport: viewport(tui) };
	tui.stop();
	await settle();
}

// 11. deleted lines move the viewport upward -> full redraw; append stays diff.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(20, 5);
	const tui = new TestTui(terminal);
	const component = new Lines([]);
	tui.addChild(component);
	tui.start();
	await settle();
	const redrawsBefore = tui.fullRedraws;
	component.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
	tui.requestRender();
	await settle();
	const grown = terminal.writes.slice();
	terminal.writes.length = 0;
	component.lines = Array.from({ length: 7 }, (_, i) => `Line ${i}`);
	tui.requestRender();
	await settle();
	out.deleted_viewport_up = {
		grown_writes: grown,
		shrink_writes: [...terminal.writes],
		full_redraw_delta: tui.fullRedraws - redrawsBefore,
		viewport: viewport(tui),
	};
	terminal.writes.length = 0;
	const redrawsAfterShrink = tui.fullRedraws;
	component.lines = ["Line 0", "Line 1", "Line 2"];
	tui.requestRender();
	await settle();
	out.append_after_shrink = {
		writes: [...terminal.writes],
		full_redraw_delta: tui.fullRedraws - redrawsAfterShrink,
		viewport: viewport(tui),
	};
	tui.stop();
	await settle();
}

// 12. transient inflation: stale content cleared after branch switch.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	const chat = new Lines([]);
	const editor = new Lines([]);
	tui.addChild(chat);
	tui.addChild(editor);
	const longChat = Array.from({ length: 15 }, (_, i) => `Chat ${i}`);
	const shortChat = Array.from({ length: 12 }, (_, i) => `Chat ${i}`);
	const editorLines = ["Editor 0", "Editor 1", "Editor 2"];
	const selectorLines = Array.from({ length: 8 }, (_, i) => `Selector ${i}`);
	chat.lines = longChat;
	editor.lines = editorLines;
	tui.start();
	await settle();
	editor.lines = selectorLines;
	tui.requestRender();
	await settle();
	editor.lines = editorLines;
	tui.requestRender();
	await settle();
	const redrawsBeforeSwitch = tui.fullRedraws;
	chat.lines = shortChat;
	tui.requestRender();
	await settle();
	out.transient_inflation = {
		writes: [...terminal.writes],
		full_redraw_delta: tui.fullRedraws - redrawsBeforeSwitch,
		viewport: viewport(tui),
	};
	tui.stop();
	await settle();
}

// 13. resize handling: width and height changes.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	const component = new Lines([]);
	tui.addChild(component);
	tui.start();
	await settle();
	component.lines = ["Line 0", "Line 1", "Line 2"];
	tui.requestRender();
	await settle();
	const redrawsBefore = tui.fullRedraws;
	terminal.writes.length = 0;
	terminal.resize(60, 10);
	await settle();
	const widthChange = { writes: [...terminal.writes], delta: tui.fullRedraws - redrawsBefore };
	terminal.writes.length = 0;
	terminal.resize(60, 15);
	await settle();
	out.resize = {
		width_change: widthChange,
		height_change: { writes: [...terminal.writes], delta: tui.fullRedraws - redrawsBefore - widthChange.delta },
		viewport: viewport(tui),
	};
	tui.stop();
	await settle();
}

// 14. overlay options: layout resolution through compositing.
{
	resetCapabilitiesCache();
	const cases = [
		{ name: "width_percent", lines: ["test"], options: { width: "50%" }, term: [100, 24] },
		{ name: "min_width", lines: ["test"], options: { width: "10%", minWidth: 30 }, term: [100, 24] },
		{ name: "top_left", lines: ["TOP-LEFT"], options: { anchor: "top-left", width: 10 }, term: [80, 24] },
		{ name: "bottom_right", lines: ["BTM-RIGHT"], options: { anchor: "bottom-right", width: 10 }, term: [80, 24] },
		{ name: "top_center", lines: ["CENTERED"], options: { anchor: "top-center", width: 10 }, term: [80, 24] },
		{
			name: "negative_margin",
			lines: ["NEG-MARGIN"],
			options: { anchor: "top-left", width: 12, margin: { top: -5, left: -10, right: 0, bottom: 0 } },
			term: [80, 24],
		},
		{ name: "margin_number", lines: ["MARGIN"], options: { anchor: "top-left", width: 10, margin: 5 }, term: [80, 24] },
		{
			name: "margin_object",
			lines: ["MARGIN"],
			options: { anchor: "top-left", width: 10, margin: { top: 2, left: 3, right: 0, bottom: 0 } },
			term: [80, 24],
		},
		{
			name: "offset",
			lines: ["OFFSET"],
			options: { anchor: "top-left", width: 10, offsetX: 10, offsetY: 5 },
			term: [80, 24],
		},
		{ name: "row_col_percent", lines: ["PCT"], options: { width: 10, row: "50%", col: "50%" }, term: [80, 24] },
		{ name: "row_percent_zero", lines: ["TOP"], options: { width: 10, row: "0%" }, term: [80, 24] },
		{ name: "row_percent_hundred", lines: ["BOTTOM"], options: { width: 10, row: "100%" }, term: [80, 24] },
		{
			name: "max_height",
			lines: ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"],
			options: { maxHeight: 3 },
			term: [80, 24],
		},
		{
			name: "max_height_percent",
			lines: ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"],
			options: { maxHeight: "50%" },
			term: [80, 10],
		},
		{
			name: "absolute",
			lines: ["ABSOLUTE"],
			options: { anchor: "bottom-right", row: 3, col: 5, width: 10 },
			term: [80, 24],
		},
		{ name: "wide_overflow", lines: ["X".repeat(100)], options: { width: 20 }, term: [80, 24] },
		{
			name: "complex_ansi",
			lines: [
				"\x1b[48;2;40;50;40m \x1b[38;2;128;128;128mSome styled content\x1b[39m\x1b[49m" +
					"\x1b]8;;http://example.com\x07link\x1b]8;;\x07" +
					" more content ".repeat(10),
			],
			options: { width: 60 },
			term: [80, 24],
		},
		{ name: "cjk_boundary", lines: ["中文日本語한글테스트"], options: { width: 15 }, term: [80, 24] },
		{ name: "edge_col", lines: ["X".repeat(50)], options: { col: 60, width: 20 }, term: [80, 24] },
	];
	const results = [];
	for (const c of cases) {
		const terminal = new FakeTerminal(c.term[0], c.term[1]);
		const tui = new TestTui(terminal);
		const overlay = new Lines(c.lines);
		tui.addChild(new EmptyContent());
		tui.showOverlay(overlay, c.options);
		tui.start();
		await renderAndFlush(tui);
		results.push({
			name: c.name,
			requestedWidth: overlay.requestedWidth,
			viewport: viewport(tui),
		});
		tui.stop();
		await settle();
	}
	out.overlay_options = results;
}

// 14b. stacked overlays and hide order.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(80, 24);
	const tui = new TestTui(terminal);
	tui.addChild(new EmptyContent());
	tui.showOverlay(new Lines(["FIRST-OVERLAY"]), { anchor: "top-left", width: 20 });
	tui.showOverlay(new Lines(["SECOND"]), { anchor: "top-left", width: 10 });
	tui.start();
	await renderAndFlush(tui);
	const stacked = viewport(tui)[0];
	tui.hideOverlay();
	await renderAndFlush(tui);
	const afterHide = viewport(tui)[0];
	out.overlay_stack = { stacked, after_hide: afterHide };
	tui.stop();
	await settle();
}

// 14c. style leak: compositing resets SGR/OSC8 at overlay edges.
{
	resetCapabilitiesCache();
	const width = 20;
	const baseLine = `\x1b[3m${"X".repeat(width)}\x1b[23m`;
	const terminal = new FakeTerminal(width, 6);
	const tui = new TestTui(terminal);
	tui.addChild(new Lines([baseLine, "INPUT"]));
	tui.start();
	await renderAndFlush(tui);
	const noOverlayLines = [...tui.lastNewLines];
	tui.stop();
	await settle();

	const terminal2 = new FakeTerminal(width, 6);
	const tui2 = new TestTui(terminal2);
	tui2.addChild(new Lines([baseLine, "INPUT"]));
	tui2.showOverlay(new Lines(["OVR"]), { row: 0, col: 5, width: 3 });
	tui2.start();
	await renderAndFlush(tui2);
	out.style_leak = {
		no_overlay_lines: noOverlayLines,
		overlay_lines: [...tui2.lastNewLines],
	};
	tui2.stop();
	await settle();
}

// 15. pure compositeTuiLine table.
{
	resetCapabilitiesCache();
	const table = [
		["base", "ovr", 0, 3, 10],
		["\x1b[3mbase\x1b[23m", "ovr", 2, 3, 10],
		["left-overside", "OVR", 5, 3, 14],
		["XXXXXXXXXX", "YYYYYYYYYY", 3, 10, 10],
		["\x1b[3mXXXXXXXXXX\x1b[23m", "\x1b[1mYY\x1b[22m", 3, 4, 10],
		["日本語のテキスト", "英語", 2, 4, 16],
		["hyper\x1b]8;;http://x\x07link\x1b]8;;\x07tail", "ov", 5, 4, 24],
		["", "only", 0, 4, 8],
		["base", "", 2, 3, 10],
	];
	out.composite_table = table.map((args) => compositeTuiLine(...args));
}

// 16. cursor marker extraction + hardware cursor positioning.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	const component = new Lines([`alpha${CURSOR_MARKER}`, "beta"]);
	tui.addChild(component);
	tui.setFocus(component);
	tui.setShowHardwareCursor(true);
	tui.start();
	await settle();
	out.cursor_marker = { writes: [...terminal.writes], viewport: viewport(tui) };
	terminal.writes.length = 0;
	// Move the marker to a new position; only cursor writes expected.
	component.lines = ["alpha", `beta${CURSOR_MARKER}`];
	tui.requestRender();
	await settle();
	out.cursor_marker_moved = { writes: [...terminal.writes], viewport: viewport(tui) };
	terminal.writes.length = 0;
	tui.setShowHardwareCursor(false);
	await settle();
	out.cursor_marker_disabled = { writes: [...terminal.writes] };
	tui.stop();
	await settle();
}

// ---------------------------------------------------------------- focus machine

class FocusableOverlay extends TestComponent {
	constructor(lines) {
		super();
		this.lines = lines;
		this.focused = false;
		this.inputs = [];
	}
	handleInput(data) {
		this.inputs.push(data);
	}
}

function focusHarness(contentLines = ["EDITOR"]) {
	const terminal = new FakeTerminal(80, 24);
	const tui = new TestTui(terminal);
	const editor = new FocusableOverlay([contentLines]);
	tui.addChild(new EmptyContent());
	tui.setFocus(editor);
	tui.start();
	return { terminal, tui, editor };
}

const focusResults = {};

// focus management
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		tui.showOverlay(overlay, { nonCapturing: true });
		await renderAndFlush(tui);
		focusResults.nc_preserves_focus = { editor: editor.focused, overlay: overlay.focused };
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		const handle = tui.showOverlay(overlay, { nonCapturing: true });
		handle.focus();
		await renderAndFlush(tui);
		focusResults.focus_transfers = {
			editor: editor.focused,
			overlay: overlay.focused,
			handleFocused: handle.isFocused(),
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		const handle = tui.showOverlay(overlay, { nonCapturing: true });
		handle.focus();
		handle.unfocus();
		await renderAndFlush(tui);
		focusResults.unfocus_restores = {
			editor: editor.focused,
			overlay: overlay.focused,
			handleFocused: handle.isFocused(),
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		const handle = tui.showOverlay(overlay, { nonCapturing: true });
		handle.setHidden(true);
		handle.setHidden(false);
		await renderAndFlush(tui);
		focusResults.set_hidden_false_no_autofocus = { editor: editor.focused, overlay: overlay.focused };
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		const handle = tui.showOverlay(overlay, { nonCapturing: true });
		handle.hide();
		await renderAndFlush(tui);
		focusResults.hide_not_focused = { editor: editor.focused };
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		const handle = tui.showOverlay(overlay, { nonCapturing: true });
		handle.focus();
		handle.hide();
		await renderAndFlush(tui);
		focusResults.hide_focused_restores = { editor: editor.focused, overlay: overlay.focused };
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const nonCapturing = new FocusableOverlay(["NC"]);
	const capturing = new FocusableOverlay(["CAP"]);
	try {
		tui.showOverlay(nonCapturing, { nonCapturing: true });
		const handle = tui.showOverlay(capturing);
		const focusedOnShow = capturing.focused;
		handle.hide();
		await renderAndFlush(tui);
		focusResults.capturing_removed_nc_below = {
			focusedOnShow,
			editor: editor.focused,
			nonCapturing: nonCapturing.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const timer = new FocusableOverlay(["TIMER"]);
	const controller = new FocusableOverlay(["CTRL"]);
	try {
		const timerHandle = tui.showOverlay(timer, { nonCapturing: true });
		tui.showOverlay(controller);
		const controllerFocused = controller.focused;
		const editorFocusedAfterShow = editor.focused;
		timerHandle.hide();
		tui.hideOverlay();
		await renderAndFlush(tui);
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.sub_overlay_cleanup = {
			controllerFocused,
			editorFocusedAfterShow,
			editor: editor.focused,
			controller: controller.focused,
			timer: timer.focused,
			editorInputs: [...editor.inputs],
			controllerInputs: [...controller.inputs],
			timerInputs: [...timer.inputs],
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const child = new FocusableOverlay(["CHILD"]);
	const parent = new FocusableOverlay(["PARENT"]);
	try {
		const childHandle = tui.showOverlay(child, { nonCapturing: true });
		childHandle.focus();
		const parentHandle = tui.showOverlay(parent);
		const parentFocused = parent.focused;
		childHandle.hide();
		parentHandle.hide();
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.removed_child_no_fallback = {
			parentFocused,
			editorInputs: [...editor.inputs],
			childInputs: [...child.inputs],
			parentInputs: [...parent.inputs],
			editor: editor.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const fallbackCapturing = new FocusableOverlay(["FALLBACK"]);
	const nonCapturing = new FocusableOverlay(["NC"]);
	const primary = new FocusableOverlay(["PRIMARY"]);
	let isVisible = true;
	try {
		tui.showOverlay(fallbackCapturing);
		tui.showOverlay(nonCapturing, { nonCapturing: true });
		tui.showOverlay(primary, { visible: () => isVisible });
		const primaryFocused = primary.focused;
		isVisible = false;
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.invisible_redirect = {
			primaryFocused,
			primaryInputs: [...primary.inputs],
			nonCapturingInputs: [...nonCapturing.inputs],
			fallbackInputs: [...fallbackCapturing.inputs],
			fallbackFocused: fallbackCapturing.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const replacement = new FocusableOverlay(["REPLACEMENT"]);
	const overlay = new FocusableOverlay(["OVERLAY"]);
	overlay.handleInput = (data) => {
		overlay.inputs.push(data);
		if (data === "b") tui.setFocus(replacement);
	};
	replacement.handleInput = (data) => {
		replacement.inputs.push(data);
		if (data === "\r") tui.setFocus(editor);
	};
	try {
		tui.showOverlay(overlay);
		const overlayFocused = overlay.focused;
		terminal.sendInput("b");
		await renderAndFlush(tui);
		const replacementFocused = replacement.focused;
		terminal.sendInput("\r");
		await renderAndFlush(tui);
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.base_replacement_close_input = {
			overlayFocused,
			replacementFocused,
			replacementInputs: [...replacement.inputs],
			overlayInputs: [...overlay.inputs],
			overlayFocusedEnd: overlay.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const replacement = new FocusableOverlay(["REPLACEMENT"]);
	const passive = new FocusableOverlay(["PASSIVE"]);
	const overlay = new FocusableOverlay(["OVERLAY"]);
	overlay.handleInput = (data) => {
		overlay.inputs.push(data);
		if (data === "b") tui.setFocus(replacement);
	};
	replacement.handleInput = (data) => {
		replacement.inputs.push(data);
		if (data === "\r") tui.setFocus(editor);
	};
	try {
		tui.setFocus(replacement);
		tui.showOverlay(passive, { nonCapturing: true });
		tui.setFocus(editor);
		tui.showOverlay(overlay);
		terminal.sendInput("b");
		await renderAndFlush(tui);
		const replacementFocused = replacement.focused;
		terminal.sendInput("1");
		terminal.sendInput("\r");
		await renderAndFlush(tui);
		focusResults.replacement_is_pre_focus = {
			replacementFocused,
			replacementInputs: [...replacement.inputs],
			overlayInputs: [...overlay.inputs],
			overlayFocusedEnd: overlay.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	// Blocked replacement can move focus internally before overlay restore.
	const terminal = new FakeTerminal(80, 24);
	const tui = new TestTui(terminal);
	const base = new Container();
	const editor = new FocusableOverlay(["EDITOR"]);
	const firstReplacement = new FocusableOverlay(["FIRST"]);
	const secondReplacement = new FocusableOverlay(["SECOND"]);
	const overlay = new FocusableOverlay(["OVERLAY"]);
	overlay.handleInput = (data) => {
		overlay.inputs.push(data);
		if (data === "b") tui.setFocus(firstReplacement);
	};
	firstReplacement.handleInput = (data) => {
		firstReplacement.inputs.push(data);
		if (data === "n") tui.setFocus(secondReplacement);
	};
	secondReplacement.handleInput = (data) => {
		secondReplacement.inputs.push(data);
		if (data === "\r") {
			base.clear();
			base.addChild(editor);
			tui.setFocus(editor);
		}
	};
	base.addChild(editor);
	base.addChild(firstReplacement);
	base.addChild(secondReplacement);
	tui.addChild(base);
	tui.setFocus(editor);
	tui.start();
	try {
		tui.showOverlay(overlay);
		terminal.sendInput("b");
		await renderAndFlush(tui);
		terminal.sendInput("n");
		await renderAndFlush(tui);
		terminal.sendInput("2");
		terminal.sendInput("\r");
		await renderAndFlush(tui);
		focusResults.blocked_internal_moves = {
			overlayInputs: [...overlay.inputs],
			firstInputs: [...firstReplacement.inputs],
			secondInputs: [...secondReplacement.inputs],
			overlayFocused: overlay.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const terminal = new FakeTerminal(80, 24);
	const tui = new TestTui(terminal);
	const base = new Container();
	const editor = new FocusableOverlay(["EDITOR"]);
	const palette = new FocusableOverlay(["PALETTE"]);
	const replacement = new FocusableOverlay(["REPLACEMENT"]);
	const overlay = new FocusableOverlay(["OVERLAY"]);
	overlay.handleInput = (data) => {
		overlay.inputs.push(data);
		if (data === "b") tui.setFocus(replacement);
	};
	replacement.handleInput = (data) => {
		replacement.inputs.push(data);
		if (data === "\r") {
			base.clear();
			base.addChild(editor);
			tui.setFocus(editor);
		}
	};
	base.addChild(editor);
	base.addChild(palette);
	base.addChild(replacement);
	tui.addChild(base);
	tui.setFocus(palette);
	tui.start();
	try {
		tui.showOverlay(overlay);
		terminal.sendInput("b");
		await renderAndFlush(tui);
		terminal.sendInput("\r");
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.removed_replacement_restores = {
			overlayInputs: [...overlay.inputs],
			replacementInputs: [...replacement.inputs],
			editorInputs: [...editor.inputs],
			overlayFocused: overlay.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui } = focusHarness();
	const fallback = new FocusableOverlay(["FALLBACK"]);
	const target = new FocusableOverlay(["TARGET"]);
	const replacement = new FocusableOverlay(["REPLACEMENT"]);
	const overlay = new FocusableOverlay(["OVERLAY"]);
	replacement.handleInput = (data) => {
		replacement.inputs.push(data);
		if (data === "\r") tui.setFocus(fallback);
	};
	try {
		const overlayHandle = tui.showOverlay(overlay);
		overlay.handleInput = (data) => {
			overlay.inputs.push(data);
			if (data === "b") {
				tui.setFocus(replacement);
				overlayHandle.unfocus({ target });
			}
		};
		terminal.sendInput("b");
		await renderAndFlush(tui);
		const replacementFocused = replacement.focused;
		terminal.sendInput("\r");
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.unfocus_target_releases_blocked = {
			replacementFocused,
			overlayInputs: [...overlay.inputs],
			replacementInputs: [...replacement.inputs],
			fallbackInputs: [...fallback.inputs],
			targetInputs: [...target.inputs],
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const replacement = new FocusableOverlay(["REPLACEMENT"]);
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		tui.showOverlay(overlay);
		const overlayFocused = overlay.focused;
		tui.setFocus(replacement);
		tui.setFocus(editor);
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.restore_after_steal = {
			overlayFocused,
			overlayInputs: [...overlay.inputs],
			editorInputs: [...editor.inputs],
			overlayFocusedEnd: overlay.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const controller = new FocusableOverlay(["CONTROLLER"]);
	const subOverlay = new FocusableOverlay(["SUB"]);
	try {
		tui.showOverlay(controller);
		const subHandle = tui.showOverlay(subOverlay, { nonCapturing: true });
		subHandle.focus();
		tui.setFocus(editor);
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.raw_sub_overlay_restore = {
			subInputs: [...subOverlay.inputs],
			controllerInputs: [...controller.inputs],
			editorInputs: [...editor.inputs],
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const passive = new FocusableOverlay(["PASSIVE"]);
	try {
		tui.showOverlay(passive, { nonCapturing: true });
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.passive_no_regain = {
			editorInputs: [...editor.inputs],
			passiveInputs: [...passive.inputs],
			editor: editor.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["NC"]);
	try {
		const handle = tui.showOverlay(overlay, { nonCapturing: true });
		handle.focus();
		tui.setFocus(editor);
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.explicit_nc_regains = {
			overlayInputs: [...overlay.inputs],
			editorInputs: [...editor.inputs],
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		const handle = tui.showOverlay(overlay);
		handle.unfocus();
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.unfocus_prevents_regain = {
			editorInputs: [...editor.inputs],
			overlayInputs: [...overlay.inputs],
			editor: editor.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui } = focusHarness(undefined, true);
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		tui.showOverlay(overlay);
		tui.setFocus(null);
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.set_focus_null_clears = {
			overlayInputs: [...overlay.inputs],
			overlay: overlay.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui } = focusHarness(undefined, true);
	const replacement = new FocusableOverlay(["REPLACEMENT"]);
	const overlay = new FocusableOverlay(["OVERLAY"]);
	replacement.handleInput = (data) => {
		replacement.inputs.push(data);
		if (data === "\r") tui.setFocus(null);
	};
	overlay.handleInput = (data) => {
		overlay.inputs.push(data);
		if (data === "b") tui.setFocus(replacement);
	};
	try {
		tui.showOverlay(overlay);
		terminal.sendInput("b");
		await renderAndFlush(tui);
		terminal.sendInput("\r");
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.blocked_set_focus_null = {
			replacementInputs: [...replacement.inputs],
			overlayInputs: [...overlay.inputs],
			overlay: overlay.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	let visible = true;
	try {
		tui.showOverlay(overlay, { visible: () => visible });
		tui.setFocus(editor);
		visible = false;
		terminal.sendInput("x");
		await renderAndFlush(tui);
		const afterX = { editorInputs: [...editor.inputs], overlayInputs: [...overlay.inputs] };
		visible = true;
		terminal.sendInput("y");
		await renderAndFlush(tui);
		focusResults.invisible_keeps_eligibility = {
			...afterX,
			editorInputsEnd: [...editor.inputs],
			overlayInputsEnd: [...overlay.inputs],
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui } = focusHarness(undefined, true);
	const overlay = new FocusableOverlay(["OVERLAY"]);
	let visible = true;
	try {
		tui.showOverlay(overlay, { visible: () => visible });
		visible = false;
		terminal.sendInput("x");
		await renderAndFlush(tui);
		const afterX = [...overlay.inputs];
		visible = true;
		terminal.sendInput("y");
		await renderAndFlush(tui);
		focusResults.invisible_null_pre_focus = {
			afterX,
			overlayInputs: [...overlay.inputs],
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		tui.setFocus(overlay);
		const handle = tui.showOverlay(overlay, { nonCapturing: true });
		handle.focus();
		tui.setFocus(editor);
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.cyclic_pre_focus = {
			editorInputs: [...editor.inputs],
			overlayInputs: [...overlay.inputs],
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const lower = new FocusableOverlay(["LOWER"]);
	const upper = new FocusableOverlay(["UPPER"]);
	try {
		const lowerHandle = tui.showOverlay(lower);
		tui.showOverlay(upper);
		lowerHandle.focus();
		tui.setFocus(editor);
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.focus_order_top = {
			lowerInputs: [...lower.inputs],
			upperInputs: [...upper.inputs],
			editorInputs: [...editor.inputs],
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const capturing = new FocusableOverlay(["CAP"]);
	const nonCapturing = new FocusableOverlay(["NC"]);
	try {
		tui.showOverlay(capturing);
		tui.showOverlay(nonCapturing, { nonCapturing: true });
		const capturingFocused = capturing.focused;
		tui.hideOverlay();
		await renderAndFlush(tui);
		focusResults.hide_overlay_nc_top = {
			capturingFocused,
			capturingFocusedEnd: capturing.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const c1 = new FocusableOverlay(["C1"]);
	const n1 = new FocusableOverlay(["N1"]);
	const c2 = new FocusableOverlay(["C2"]);
	const n2 = new FocusableOverlay(["N2"]);
	try {
		const c1Handle = tui.showOverlay(c1);
		tui.showOverlay(n1, { nonCapturing: true });
		const c2Handle = tui.showOverlay(c2);
		tui.showOverlay(n2, { nonCapturing: true });
		const c2Focused = c2.focused;
		c2Handle.hide();
		await renderAndFlush(tui);
		const c1Focused = c1.focused;
		c1Handle.hide();
		await renderAndFlush(tui);
		focusResults.mixed_removals = {
			c2Focused,
			c1Focused,
			editorFocused: editor.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const capturing = new FocusableOverlay(["CAP"]);
	try {
		const handle = tui.showOverlay(capturing);
		const capturingFocused = capturing.focused;
		handle.unfocus();
		await renderAndFlush(tui);
		focusResults.unfocus_topmost_falls_back = {
			capturingFocused,
			editorFocused: editor.focused,
			capturingFocusedEnd: capturing.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
// no-op guards
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		const handle = tui.showOverlay(overlay, { nonCapturing: true });
		handle.setHidden(true);
		handle.focus();
		await renderAndFlush(tui);
		focusResults.focus_hidden_noop = {
			editor: editor.focused,
			handleFocused: handle.isFocused(),
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		const handle = tui.showOverlay(overlay, { nonCapturing: true });
		handle.hide();
		handle.focus();
		await renderAndFlush(tui);
		focusResults.focus_after_hide_noop = {
			editor: editor.focused,
			handleFocused: handle.isFocused(),
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		const handle = tui.showOverlay(overlay, { nonCapturing: true });
		handle.unfocus();
		await renderAndFlush(tui);
		focusResults.unfocus_not_focused_noop = {
			editor: editor.focused,
			overlay: overlay.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui } = focusHarness(undefined, true);
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		const handle = tui.showOverlay(overlay);
		const overlayFocused = overlay.focused;
		handle.unfocus();
		const afterUnfocus = overlay.focused;
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.unfocus_null_pre_focus = {
			overlayFocused,
			afterUnfocus,
			overlayInputs: [...overlay.inputs],
			handleFocused: handle.isFocused(),
		};
	} finally {
		tui.stop();
		await settle();
	}
}
// focus cycle prevention
{
	const { terminal, tui, editor } = focusHarness();
	const a = new FocusableOverlay(["A"]);
	const b = new FocusableOverlay(["B"]);
	try {
		const aHandle = tui.showOverlay(a, { nonCapturing: true });
		const bHandle = tui.showOverlay(b, { nonCapturing: true });
		aHandle.focus();
		bHandle.focus();
		aHandle.focus();
		aHandle.unfocus();
		await renderAndFlush(tui);
		focusResults.toggle_cycle = {
			editor: editor.focused,
			a: a.focused,
			b: b.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const a = new FocusableOverlay(["A"]);
	const b = new FocusableOverlay(["B"]);
	const c = new FocusableOverlay(["C"]);
	try {
		const aHandle = tui.showOverlay(a);
		const bHandle = tui.showOverlay(b);
		const cHandle = tui.showOverlay(c);
		aHandle.focus();
		terminal.sendInput("a");
		await renderAndFlush(tui);
		bHandle.focus();
		terminal.sendInput("b");
		await renderAndFlush(tui);
		cHandle.focus();
		terminal.sendInput("c");
		await renderAndFlush(tui);
		cHandle.unfocus({ target: editor });
		terminal.sendInput("e");
		await renderAndFlush(tui);
		aHandle.focus();
		terminal.sendInput("A");
		await renderAndFlush(tui);
		aHandle.unfocus({ target: editor });
		terminal.sendInput("E");
		await renderAndFlush(tui);
		focusResults.explicit_targets_cycle = {
			aInputs: [...a.inputs],
			bInputs: [...b.inputs],
			cInputs: [...c.inputs],
			editorInputs: [...editor.inputs],
			editor: editor.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui } = focusHarness(undefined, true);
	const overlay = new FocusableOverlay(["OVERLAY"]);
	try {
		const handle = tui.showOverlay(overlay);
		handle.unfocus({ target: null });
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.null_unfocus_target = {
			overlayInputs: [...overlay.inputs],
			handleFocused: handle.isFocused(),
		};
	} finally {
		tui.stop();
		await settle();
	}
}
{
	const { terminal, tui, editor } = focusHarness();
	const a = new FocusableOverlay(["A"]);
	const b = new FocusableOverlay(["B"]);
	const c = new FocusableOverlay(["C"]);
	try {
		const aHandle = tui.showOverlay(a);
		const bHandle = tui.showOverlay(b);
		tui.showOverlay(c);
		aHandle.focus();
		bHandle.focus();
		bHandle.setHidden(true);
		terminal.sendInput("x");
		await renderAndFlush(tui);
		focusResults.hidden_falls_to_frontmost = {
			aInputs: [...a.inputs],
			cInputs: [...c.inputs],
			a: a.focused,
		};
	} finally {
		tui.stop();
		await settle();
	}
}
// rendering order
{
	const terminal = new FakeTerminal(20, 6);
	const tui = new TestTui(terminal);
	tui.addChild(new EmptyContent());
	tui.start();
	const aHandle = tui.showOverlay(new Lines(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	tui.showOverlay(new Lines(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	await renderAndFlush(tui);
	const first = tui.lastNewLines[0];
	aHandle.focus();
	await renderAndFlush(tui);
	const second = tui.lastNewLines[0];
	focusResults.visual_order_bump = { first: strip(first), second: strip(second) };
	tui.stop();
	await settle();
}
{
	const terminal = new FakeTerminal(20, 6);
	const tui = new TestTui(terminal);
	tui.addChild(new EmptyContent());
	tui.start();
	tui.showOverlay(new Lines(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	tui.showOverlay(new Lines(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	await renderAndFlush(tui);
	focusResults.visual_order_creation = { first: strip(tui.lastNewLines[0]) };
	tui.stop();
	await settle();
}
{
	const terminal = new FakeTerminal(20, 6);
	const tui = new TestTui(terminal);
	tui.addChild(new EmptyContent());
	tui.start();
	const lower = tui.showOverlay(new Lines(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	tui.showOverlay(new Lines(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	await renderAndFlush(tui);
	const before = strip(tui.lastNewLines[0]);
	lower.focus();
	await renderAndFlush(tui);
	const after = strip(tui.lastNewLines[0]);
	focusResults.visual_order_lower_focus = { before, after };
	tui.stop();
	await settle();
}
{
	const terminal = new FakeTerminal(20, 6);
	const tui = new TestTui(terminal);
	tui.addChild(new EmptyContent());
	tui.start();
	tui.showOverlay(new Lines(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	const middle = tui.showOverlay(new Lines(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	const top = tui.showOverlay(new Lines(["C"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	await renderAndFlush(tui);
	const s0 = strip(tui.lastNewLines[0]);
	middle.focus();
	await renderAndFlush(tui);
	const s1 = strip(tui.lastNewLines[0]);
	middle.hide();
	await renderAndFlush(tui);
	const s2 = strip(tui.lastNewLines[0]);
	top.hide();
	await renderAndFlush(tui);
	const s3 = strip(tui.lastNewLines[0]);
	focusResults.visual_order_middle = { s0, s1, s2, s3 };
	tui.stop();
	await settle();
}
{
	const terminal = new FakeTerminal(20, 6);
	const tui = new TestTui(terminal);
	tui.addChild(new EmptyContent());
	tui.start();
	tui.showOverlay(new Lines(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	const capturing = tui.showOverlay(new Lines(["B"]), { row: 0, col: 0, width: 1 });
	await renderAndFlush(tui);
	const s0 = strip(tui.lastNewLines[0]);
	capturing.setHidden(true);
	tui.showOverlay(new Lines(["C"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	await renderAndFlush(tui);
	const s1 = strip(tui.lastNewLines[0]);
	capturing.setHidden(false);
	await renderAndFlush(tui);
	const s2 = strip(tui.lastNewLines[0]);
	focusResults.visual_order_unhide = { s0, s1, s2 };
	tui.stop();
	await settle();
}
{
	const terminal = new FakeTerminal(20, 6);
	const tui = new TestTui(terminal);
	tui.addChild(new EmptyContent());
	tui.start();
	const a = tui.showOverlay(new Lines(["A"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	const b = tui.showOverlay(new Lines(["B"]), { row: 0, col: 0, width: 1, nonCapturing: true });
	await renderAndFlush(tui);
	const s0 = strip(tui.lastNewLines[0]);
	a.focus();
	await renderAndFlush(tui);
	const s1 = strip(tui.lastNewLines[0]);
	a.unfocus();
	await renderAndFlush(tui);
	const s2 = strip(tui.lastNewLines[0]);
	b.focus();
	await renderAndFlush(tui);
	const s3 = strip(tui.lastNewLines[0]);
	focusResults.visual_order_unfocus_keeps_order = { s0, s1, s2, s3 };
	tui.stop();
	await settle();
}

out.focus_suite = focusResults;

// ------------------------------------------------------------ mouse dispatch
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TestTui(terminal);
	tui.addChild(new EmptyContent());
	const overlay = new Lines(["BTN"]);
	tui.showOverlay(overlay, { row: 1, col: 2, width: 10, nonCapturing: true });
	tui.start();
	await renderAndFlush(tui);
	let seen = null;
	overlay.handleMouse = (event) => {
		seen = {
			x: event.x,
			y: event.y,
			screenX: event.screenX,
			screenY: event.screenY,
			width: event.width,
			height: event.height,
		};
		return { handled: true };
	};
	const result = tui.dispatchMouseToOverlay({
		type: "press",
		button: "left",
		x: 4,
		y: 1,
		screenX: 4,
		screenY: 1,
		width: 40,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
	});
	out.mouse_overlay_hit = { seen, resultHit: result?.hit ?? null, handled: result?.result?.handled ?? null };
	tui.stop();
	await settle();
}

writeFileSync(new URL("./oracle_output.json", import.meta.url), JSON.stringify(out, null, 1));
console.log("oracle scenarios complete:", Object.keys(out).length);
