// Oracle runner for the tui-main-screen.ts slice: executes the REAL upstream
// `TuiMainScreen` (tui-main-screen.ts) under node --experimental-strip-types
// and captures byte-exact terminal writes per scenario. Every write-array
// entry is one terminal.write call boundary (BoundedTerminalWriter chunk
// boundaries included). Copies in this directory are hash-verified against the
// read-only upstream originals (see slice report for the sha256 table).
import { writeFileSync, mkdtempSync, readFileSync, rmSync, mkdirSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CURSOR_MARKER } from "./tui.ts";
import { TuiMainScreen } from "./tui-main-screen.ts";
import {
	deleteKittyImage,
	encodeKitty,
	resetCapabilitiesCache,
	setCapabilities,
} from "./terminal-image.ts";

// Ensure ambient env does not leak into the default scenarios.
delete process.env.PI_TUI_DEBUG;
delete process.env.PI_TUI_DEBUG_REDRAW;
delete process.env.TERMUX_VERSION;

/** Memory terminal: writes recorded with boundaries, handlers programmable. */
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
	clearWrites() {
		this.writes.length = 0;
	}
}

class Lines {
	constructor(lines) {
		this.lines = lines;
	}
	render() {
		return this.lines;
	}
	invalidate() {}
}

class InputComponent extends Lines {
	constructor(lines) {
		super(lines ?? []);
		this.renderCount = 0;
	}
	render(width) {
		this.renderCount += 1;
		return super.render(width);
	}
	handleInput(data) {
		this.lines = [data];
	}
}

const tick = () => new Promise((resolve) => process.nextTick(resolve));
const settle = async () => {
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 25));
	await tick();
};

const out = {};

// Static content, then a mid-line change without a full redraw (spinner).
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines([]);
	tui.addChild(component);
	tui.start();
	await settle();
	const frames = [];
	terminal.clearWrites();
	for (const frame of ["|", "/", "-", "\\"]) {
		component.lines = ["Header", `Working ${frame}`, "Footer"];
		tui.requestRender();
		await settle();
		frames.push([...terminal.writes]);
		terminal.clearWrites();
	}
	out.spinner_frames = { frames };
	// No-change render: only cursor bookkeeping writes.
	tui.requestRender();
	await settle();
	out.no_change_writes = [...terminal.writes];
	terminal.clearWrites();
	tui.stop();
	await settle();
}

// Full lifecycle with static content + both stop modes.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines(["Line 0", "Line 1", "Line 2"]);
	tui.addChild(component);
	tui.start();
	await settle();
	out.first_render = { writes: [...terminal.writes], fullRedraws: tui.fullRedraws };
	terminal.clearWrites();
	tui.stop();
	out.stop_default_writes = [...terminal.writes];
	// Render after stop is a no-op.
	terminal.clearWrites();
	tui.requestRender();
	await settle();
	out.render_after_stop_writes = [...terminal.writes];
}
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines(["Line 0", "Line 1", "Line 2"]);
	tui.addChild(component);
	tui.start();
	await settle();
	terminal.clearWrites();
	tui.stop({ preserveScreen: true });
	out.stop_preserve_screen_writes = [...terminal.writes];
}

// Differential paths: non-adjacent line changes, appends, deleted tail lines.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines(["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"]);
	tui.addChild(component);
	tui.start();
	await settle();
	terminal.clearWrites();
	component.lines = ["Line 0", "CHANGED 1", "Line 2", "CHANGED 3", "Line 4"];
	tui.requestRender();
	await settle();
	out.nonadjacent_change_writes = [...terminal.writes];
	terminal.clearWrites();
	// Append two lines (appendStart path).
	component.lines = [...component.lines, "Line 5", "Line 6"];
	tui.requestRender();
	await settle();
	out.append_lines_writes = [...terminal.writes];
	terminal.clearWrites();
	// Delete two tail lines (deleted-lines path, unchanged head).
	component.lines = component.lines.slice(0, 5);
	tui.requestRender();
	await settle();
	out.delete_tail_lines_writes = [...terminal.writes];
	terminal.clearWrites();
	// Cursor tracking after shrink: change line 1 of 3.
	component.lines = ["Line 0", "CHANGED", "Line 2"];
	tui.requestRender();
	await settle();
	out.shrink_then_change_writes = [...terminal.writes];
	terminal.clearWrites();
	// First-line-only and last-line-only changes.
	component.lines = ["CHANGED", "Line 1", "Line 2"];
	tui.requestRender();
	await settle();
	out.first_line_change_writes = [...terminal.writes];
	terminal.clearWrites();
	component.lines = ["CHANGED", "Line 1", "Line 2", "Line 3"];
	tui.requestRender();
	await settle();
	out.append_after_change_writes = [...terminal.writes];
	terminal.clearWrites();
	component.lines = ["CHANGED", "Line 1", "Line 2", "FINAL"];
	tui.requestRender();
	await settle();
	out.last_line_change_writes = [...terminal.writes];
	terminal.clearWrites();
	// Content -> empty -> content.
	component.lines = [];
	tui.requestRender();
	await settle();
	out.shrink_to_empty_writes = [...terminal.writes];
	terminal.clearWrites();
	component.lines = ["New Line 0", "New Line 1"];
	tui.requestRender();
	await settle();
	out.regrow_after_empty_writes = [...terminal.writes];
	tui.stop();
	await settle();
}

// clearOnShrink scenarios (tui-render.test.ts "TUI content shrinkage").
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	tui.setClearOnShrink(true);
	const component = new Lines([]);
	tui.addChild(component);
	component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
	tui.start();
	await settle();
	const initialRedraws = tui.fullRedraws;
	terminal.clearWrites();
	component.lines = ["Line 0", "Line 1"];
	tui.requestRender();
	await settle();
	out.clear_on_shrink_writes = [...terminal.writes];
	out.clear_on_shrink_delta = tui.fullRedraws - initialRedraws;
	terminal.clearWrites();
	component.lines = ["Only line"];
	tui.requestRender();
	await settle();
	out.clear_on_shrink_single_writes = [...terminal.writes];
	terminal.clearWrites();
	component.lines = [];
	tui.requestRender();
	await settle();
	out.clear_on_shrink_empty_writes = [...terminal.writes];
	tui.stop();
	await settle();
}

// tui-shrink.test.ts: tui.clear() then render with clearOnShrink disabled.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const content = new Lines(["first", "second", "third"]);
	tui.addChild(content);
	tui.start();
	await settle();
	terminal.clearWrites();
	tui.clear();
	tui.requestRender();
	await settle();
	out.clear_children_writes = [...terminal.writes];
	tui.stop();
	await settle();
}

// Deleted lines that move the viewport up force a full redraw (20x5, 12 -> 7);
// appending afterwards stays differential (tui-render.test.ts).
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(20, 5);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines([]);
	tui.addChild(component);
	component.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
	tui.start();
	await settle();
	const redrawsBefore = tui.fullRedraws;
	terminal.clearWrites();
	component.lines = Array.from({ length: 7 }, (_, i) => `Line ${i}`);
	tui.requestRender();
	await settle();
	out.deleted_viewport_up_writes = [...terminal.writes];
	out.deleted_viewport_up_delta = tui.fullRedraws - redrawsBefore;
	terminal.clearWrites();
	const redrawsAfterShrink = tui.fullRedraws;
	component.lines = ["Line 0", "Line 1", "Line 2"];
	tui.requestRender();
	await settle();
	out.append_after_viewport_reset_writes = [...terminal.writes];
	out.append_after_viewport_reset_delta = tui.fullRedraws - redrawsAfterShrink;
	tui.stop();
	await settle();
}

// maxLinesRendered inflated by a transient component (branch switch).
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
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
	terminal.clearWrites();
	chat.lines = shortChat;
	tui.requestRender();
	await settle();
	out.transient_inflation_writes = [...terminal.writes];
	out.transient_inflation_delta = tui.fullRedraws - redrawsBeforeSwitch;
	tui.stop();
	await settle();
}

// Resize: width and height changes (TERMUX_VERSION unset).
{
	resetCapabilitiesCache();
	delete process.env.TERMUX_VERSION;
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines(["Line 0", "Line 1", "Line 2"]);
	tui.addChild(component);
	tui.start();
	await settle();
	const redrawsBefore = tui.fullRedraws;
	terminal.clearWrites();
	terminal.resize(60, 10);
	await settle();
	out.resize_width_writes = [...terminal.writes];
	out.resize_width_delta = tui.fullRedraws - redrawsBefore;
	terminal.clearWrites();
	terminal.resize(60, 15);
	await settle();
	out.resize_height_writes = [...terminal.writes];
	out.resize_height_delta = tui.fullRedraws - redrawsBefore - out.resize_width_delta;
	tui.stop();
	await settle();
}

// Termux: height changes stay on the differential path (no clears).
{
	resetCapabilitiesCache();
	process.env.TERMUX_VERSION = "1";
	try {
		const terminal = new FakeTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const component = new Lines(Array.from({ length: 20 }, (_, i) => `Line ${i}`));
		tui.addChild(component);
		tui.start();
		await settle();
		terminal.clearWrites();
		const initialRedraws = tui.fullRedraws;
		const frames = [];
		for (const height of [15, 8, 14, 11]) {
			terminal.resize(40, height);
			await settle();
			frames.push([...terminal.writes]);
			terminal.clearWrites();
		}
		out.termux_resize_frames = { frames };
		out.termux_resize_delta = tui.fullRedraws - initialRedraws;
		tui.stop();
		await settle();
	} finally {
		delete process.env.TERMUX_VERSION;
	}
}

// Cursor marker extraction and hardware cursor positioning.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines([`alpha${CURSOR_MARKER}`, "beta"]);
	tui.addChild(component);
	tui.start();
	await settle();
	terminal.clearWrites();
	component.lines = ["alpha", `beta${CURSOR_MARKER}`];
	tui.requestRender();
	await settle();
	out.cursor_marker_moved_writes = [...terminal.writes];
	terminal.clearWrites();
	tui.stop();
	await settle();
	// With showHardwareCursor enabled the positioning keeps the cursor visible.
	const terminal2 = new FakeTerminal(40, 10);
	const tui2 = new TuiMainScreen(terminal2, { showHardwareCursor: true });
	const component2 = new Lines([`alpha${CURSOR_MARKER}`, "beta"]);
	tui2.addChild(component2);
	tui2.start();
	await settle();
	terminal2.clearWrites();
	component2.lines = ["alpha", `beta${CURSOR_MARKER}`];
	tui2.requestRender();
	await settle();
	out.cursor_marker_visible_writes = [...terminal2.writes];
	terminal2.clearWrites();
	tui2.stop();
	await settle();
}

// applyLineResets: SGR/OSC8 state is reset after every rendered line.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(20, 6);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines(["\x1b[3mItalic", "Plain"]);
	tui.addChild(component);
	tui.start();
	await settle();
	out.styles_reset_writes = [...terminal.writes];
	tui.stop();
	await settle();
}

// Keyboard input preempts a queued throttled frame (scheduling wiring).
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
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
	};
	tui.stop();
	await settle();
}

// ------------------------------------------------------------------ bounded

const kittyHuge = `\x1b_Ga=T,f=100;${"A".repeat(1_200_000)}\x1b\\`;
const joined0 = (terminal) => terminal.writes.join("");
const captureBounded = (terminal) => {
	const joined = terminal.writes.join("");
	return {
		writeCount: terminal.writes.length,
		writeLengths: terminal.writes.map((w) => w.length),
		joinedLength: joined.length,
		joinedSha256: createHash("sha256").update(joined, "utf16le").digest("hex"),
		head: joined.slice(0, 80),
		tail: joined.slice(-80),
	};
};
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines([kittyHuge, kittyHuge]);
	tui.addChild(component);
	tui.renderNow();
	out.bounded_full = { ...captureBounded(terminal), fullRedraws: tui.fullRedraws };
	tui.stop();
	await settle();
}
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines(["before"]);
	tui.addChild(component);
	tui.renderNow();
	terminal.clearWrites();
	component.lines = ["before", kittyHuge, kittyHuge];
	tui.renderNow();
	out.bounded_diff = {
		...captureBounded(terminal),
		startsWithSync: joined0(terminal).startsWith("\x1b[?2026h"),
		endsWithSync: joined0(terminal).endsWith("\x1b[?2026l"),
		hasFullClear: terminal.writes.join("").includes("\x1b[2J"),
	};
	tui.stop();
	await settle();
}

// -------------------------------------------------------------------- kitty

const kitty2 = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
const kitty2b = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 88, moveCursor: false });
const kitty1 = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 42, moveCursor: false });
const kitty3 = encodeKitty("AAAA", { columns: 3, rows: 3, imageId: 55, moveCursor: false });
const kitty6 = encodeKitty("AAAA", { columns: 6, rows: 6, imageId: 66, moveCursor: false });
const kitty77 = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 77, moveCursor: false });

function kittyHarness(columns, rows) {
	resetCapabilitiesCache();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const terminal = new FakeTerminal(columns, rows);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines([]);
	tui.addChild(component);
	return { terminal, tui, component };
}
const kittyTeardown = (tui) => {
	tui.stop();
	resetCapabilitiesCache();
};

// Reserved rows are cleared before the placement is drawn (diff path).
{
	const { terminal, tui, component } = kittyHarness(40, 10);
	component.lines = ["before"];
	tui.start();
	await settle();
	terminal.clearWrites();
	component.lines = ["before", kitty2, "", "after"];
	tui.requestRender();
	await settle();
	out.kitty_reserved_rows_diff = { writes: [...terminal.writes] };
	kittyTeardown(tui);
	await settle();
}

// Pre-clear that would scroll falls back to a full redraw.
{
	const { terminal, tui, component } = kittyHarness(40, 2);
	component.lines = ["before"];
	tui.start();
	await settle();
	const redrawsBefore = tui.fullRedraws;
	terminal.clearWrites();
	component.lines = ["before", kitty2, "", "after"];
	tui.requestRender();
	await settle();
	out.kitty_preclear_scroll = { writes: [...terminal.writes], delta: tui.fullRedraws - redrawsBefore };
	kittyTeardown(tui);
	await settle();
}

// Full-redraw fallback reserves visible image rows (3-row placement).
{
	const { terminal, tui, component } = kittyHarness(40, 5);
	component.lines = ["l0", "l1", "l2", "l3", "l4"];
	tui.start();
	await settle();
	const redrawsBefore = tui.fullRedraws;
	terminal.clearWrites();
	component.lines = ["l0", "l1", "l2", "l3", "l4", kitty3, "", "", "after"];
	tui.requestRender();
	await settle();
	out.kitty_fullredraw_reserved = { writes: [...terminal.writes], delta: tui.fullRedraws - redrawsBefore };
	kittyTeardown(tui);
	await settle();
}

// Images taller than the viewport keep the first-row placement (no cursor-up).
{
	const { terminal, tui, component } = kittyHarness(40, 5);
	component.lines = ["before"];
	tui.start();
	await settle();
	terminal.clearWrites();
	component.lines = ["before", kitty6, "", "", "", "", "", "after"];
	tui.requestRender(true);
	await settle();
	out.kitty_taller_than_viewport = {
		writes: [...terminal.writes],
		hasCursorUpPrefix: terminal.writes.join("").includes(`\x1b[7A${kitty6}`),
	};
	kittyTeardown(tui);
	await settle();
}

// Changed image ids are deleted before the moved placement is drawn.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines(["top", kitty2]);
	tui.addChild(component);
	tui.start();
	await settle();
	terminal.clearWrites();
	component.lines = [kitty1, ""];
	tui.requestRender();
	await settle();
	const writes = terminal.writes.join("");
	const deleteIndex = writes.indexOf(deleteKittyImage(42));
	const drawIndex = writes.indexOf(kitty1);
	out.kitty_delete_changed = {
		writes,
		deleteIndex,
		drawIndex,
		deleteBeforeDraw: deleteIndex >= 0 && drawIndex >= 0 && deleteIndex < drawIndex,
	};
	tui.stop();
	await settle();
}

// A changed reserved row redraws (and deletes) the image line above it.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines(["", kitty2b]);
	tui.addChild(component);
	tui.start();
	await settle();
	terminal.clearWrites();
	component.lines = ["covered", kitty2b];
	tui.requestRender();
	await settle();
	const writes = terminal.writes.join("");
	const deleteIndex = writes.indexOf(deleteKittyImage(88));
	const drawIndex = writes.indexOf(kitty2b);
	out.kitty_reserved_row_change = {
		writes,
		deleteIndex,
		drawIndex,
		deleteBeforeDraw: deleteIndex >= 0 && drawIndex >= 0 && deleteIndex < drawIndex,
		hasFullClear: writes.includes("\x1b[2J"),
	};
	tui.stop();
	await settle();
}

// Full redraws delete previously rendered ids before the clear.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines([kitty77]);
	tui.addChild(component);
	tui.start();
	await settle();
	terminal.clearWrites();
	component.lines = ["plain text"];
	tui.requestRender(true);
	await settle();
	const writes = terminal.writes.join("");
	const deleteIndex = writes.indexOf(deleteKittyImage(77));
	const clearIndex = writes.indexOf("\x1b[2J");
	out.kitty_fullredraw_deletes_previous = {
		writes,
		deleteIndex,
		clearIndex,
		deleteBeforeClear: deleteIndex >= 0 && clearIndex >= 0 && deleteIndex < clearIndex,
	};
	tui.stop();
	await settle();
}

// ------------------------------------------------------------------- crash

const maskTs = (text) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TS>");

// Crash dump into the configured log directory.
{
	resetCapabilitiesCache();
	const logDir = mkdtempSync(join(tmpdir(), "pi-tui-ms-crash-"));
	try {
		const terminal = new FakeTerminal(40, 10);
		const tui = new TuiMainScreen(terminal, undefined, logDir);
		const component = new Lines(["ok"]);
		tui.addChild(component);
		tui.start();
		await settle();
		terminal.clearWrites();
		let message = null;
		try {
			component.lines = ["ok", "x".repeat(60)];
			tui.renderNow();
		} catch (error) {
			message = String(error.message).split(logDir).join("<LOG_DIR>");
		}
		const crashText = maskTs(readFileSync(join(logDir, "pi-tui-crash.log"), "utf-8")).split(logDir).join("<LOG_DIR>");
		out.crash_dump_logdir = { message, crashText, stopWrites: [...terminal.writes], stopped: tui.stopped ?? null };
	} finally {
		rmSync(logDir, { recursive: true, force: true });
	}
	await settle();
}

// Crash dump falls back to the OS temp directory.
{
	resetCapabilitiesCache();
	const crashDir = mkdtempSync(join(tmpdir(), "pi-tui-ms-crash2-"));
	const previous = {};
	for (const name of ["TMPDIR", "TEMP", "TMP"]) {
		previous[name] = process.env[name];
		process.env[name] = crashDir;
	}
	try {
		const terminal = new FakeTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const component = new Lines(["ok"]);
		tui.addChild(component);
		tui.start();
		await settle();
		let message = null;
		try {
			component.lines = ["ok", "x".repeat(60)];
			tui.renderNow();
		} catch (error) {
			message = String(error.message).split(crashDir).join("<CRASH_DIR>");
		}
		const crashText = maskTs(readFileSync(join(crashDir, "pi-tui-crash.log"), "utf-8")).split(crashDir).join("<CRASH_DIR>");
		out.crash_dump_tmpdir = { message, crashText };
	} finally {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(crashDir, { recursive: true, force: true });
	}
	await settle();
}

// PI_TUI_DEBUG_REDRAW=1 appends fullRender reasons to the log directory.
{
	resetCapabilitiesCache();
	const logDir = mkdtempSync(join(tmpdir(), "pi-tui-ms-log-"));
	process.env.PI_TUI_DEBUG_REDRAW = "1";
	try {
		const terminal = new FakeTerminal(40, 10);
		const tui = new TuiMainScreen(terminal, undefined, logDir);
		const component = new Lines(["Line 0", "Line 1", "Line 2"]);
		tui.addChild(component);
		tui.start();
		await settle();
		terminal.resize(60, 10);
		await settle();
		tui.setClearOnShrink(true);
		component.lines = ["Line 0"];
		tui.requestRender();
		await settle();
		const logText = maskTs(readFileSync(join(logDir, "pi-tui-debug.log"), "utf-8"));
		out.debug_redraw_log = { logText: logText.split(logDir).join("<LOG_DIR>") };
		tui.stop();
	} finally {
		delete process.env.PI_TUI_DEBUG_REDRAW;
		rmSync(logDir, { recursive: true, force: true });
	}
	await settle();
}

// PI_TUI_DEBUG=1 dumps a render debug file into /tmp/tui.
{
	resetCapabilitiesCache();
	const debugDir = join("/tmp", "tui");
	mkdirSync(debugDir, { recursive: true });
	const before = new Set(existsSync(debugDir) ? readdirSync(debugDir) : []);
	process.env.PI_TUI_DEBUG = "1";
	try {
		const terminal = new FakeTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const component = new Lines(["Header", "Working |", "Footer"]);
		tui.addChild(component);
		tui.start();
		await settle();
		terminal.clearWrites();
		component.lines = ["Header", "Working /", "Footer"];
		tui.requestRender();
		await settle();
		const fresh = readdirSync(debugDir).filter((name) => name.startsWith("render-") && !before.has(name));
		if (fresh.length === 1) {
			const content = readFileSync(join(debugDir, fresh[0]), "utf-8");
			out.pi_tui_debug_dump = { fileNamePattern: fresh[0].startsWith("render-"), content };
			unlinkSync(join(debugDir, fresh[0]));
		} else {
			out.pi_tui_debug_dump = { error: `expected one fresh debug file, got ${fresh.length}` };
		}
		tui.stop();
	} finally {
		delete process.env.PI_TUI_DEBUG;
	}
	await settle();
}

// ------------------------------------------------- capture/restore state

{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines(["alpha", "beta"]);
	tui.addChild(component);
	tui.start();
	await settle();
	const state = tui.captureRenderState();
	component.lines = ["alpha", "gamma"];
	tui.requestRender();
	await settle();
	terminal.clearWrites();
	tui.restoreRenderState(state);
	component.lines = ["alpha", "beta"];
	tui.requestRender();
	await settle();
	out.restore_render_state = { writes: [...terminal.writes] };
	terminal.clearWrites();
	tui.stop();
	await settle();

	// Restoring drops image ids: image lines become empty placeholders.
	const terminal2 = new FakeTerminal(40, 10);
	const tui2 = new TuiMainScreen(terminal2);
	const component2 = new Lines(["keep", kitty2, ""]);
	tui2.addChild(component2);
	tui2.start();
	await settle();
	const state2 = tui2.captureRenderState();
	component2.lines = ["keep", "changed", ""];
	tui2.requestRender();
	await settle();
	terminal2.clearWrites();
	tui2.restoreRenderState(state2);
	component2.lines = ["keep", "changed", ""];
	tui2.requestRender();
	await settle();
	out.restore_render_state_images = { writes: [...terminal2.writes] };
	tui2.stop();
	await settle();
}

// Sanity: captureRenderState shape.
{
	resetCapabilitiesCache();
	const terminal = new FakeTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines(["a", "b"]);
	tui.addChild(component);
	tui.start();
	await settle();
	const state = tui.captureRenderState();
	out.render_state_shape = {
		previousWidth: state.previousWidth,
		previousHeight: state.previousHeight,
		cursorRow: state.cursorRow,
		hardwareCursorRow: state.hardwareCursorRow,
		maxLinesRendered: state.maxLinesRendered,
		previousViewportTop: state.previousViewportTop,
		previousLinesLength: state.previousLines.length,
		mode: tui.mode,
	};
	tui.stop();
	await settle();
}

writeFileSync(new URL("./oracle_output.json", import.meta.url), JSON.stringify(out, null, 1));
console.log("main-screen oracle scenarios complete:", Object.keys(out).length);
