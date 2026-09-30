// r19 oracle scenarios. Each scenario drives verbatim upstream component code
// and returns a JSON-able summary; the driver snapshots LOG around each run.
import {
	logReset,
	rec,
	theme,
	Container,
	Text,
	Spacer,
	TruncatedText,
	Markdown,
	DynamicBorder,
	Box,
	MouseRegion,
	Image,
	Input,
	Editor,
	SelectList,
	Loader,
	CancellableLoader,
	getKeybindings,
	truncateToWidth,
	truncateTail,
	DEFAULT_MAX_LINES,
	DEFAULT_MAX_BYTES,
	stripAnsi,
	fuzzyMatch,
	tickTimers,
	timers,
	setCaps,
	setXp,
	setTrustOptions,
	type AnyRec,
} from "./deps.ts";

import { formatKeyText, keyText, keyDisplayText, keyHint, rawKeyHint } from "./keybinding_hints_verbatim.ts";
import { CountdownTimer } from "./countdown_timer_verbatim.ts";
import { truncateToVisualLines } from "./visual_truncate_verbatim.ts";
import { renderDiff } from "./diff_verbatim.ts";
import { createMarkdownTransform } from "./markdown_transform_verbatim.ts";
import { AssistantMessageComponent } from "./assistant_message_verbatim.ts";
import { BashExecutionComponent } from "./bash_execution_verbatim.ts";
import { BorderedLoader } from "./bordered_loader_verbatim.ts";
import { BranchSummaryMessageComponent } from "./branch_summary_verbatim.ts";
import { CompactionSummaryMessageComponent } from "./compaction_summary_verbatim.ts";
import { SkillInvocationMessageComponent } from "./skill_invocation_verbatim.ts";
import { UserMessageComponent } from "./user_message_verbatim.ts";
import { CustomMessageComponent } from "./custom_message_verbatim.ts";
import { CustomEntryComponent } from "./custom_entry_verbatim.ts";
import { DaxnutsComponent } from "./daxnuts_verbatim.ts";
import { EarendilAnnouncementComponent } from "./earendil_verbatim.ts";
import { formatTokens, formatCwdForFooter, FooterComponent } from "./footer_verbatim.ts";
import { addUsageToTotals, createUsageTotals } from "./usage_totals_verbatim.ts";
import { LoginDialogComponent } from "./login_dialog_verbatim.ts";
import { OAuthSelectorComponent, formatAuthSelectorProviderType } from "./oauth_selector_verbatim.ts";
import { ExtensionInputComponent } from "./extension_input_verbatim.ts";
import { ExtensionSelectorComponent } from "./extension_selector_verbatim.ts";
import { ExtensionEditorComponent } from "./extension_editor_verbatim.ts";
import { FirstTimeSetupComponent } from "./first_time_setup_verbatim.ts";
import { ThemeSelectorComponent } from "./theme_selector_verbatim.ts";
import { ShowImagesSelectorComponent } from "./show_images_selector_verbatim.ts";
import { ThinkingSelectorComponent } from "./thinking_selector_verbatim.ts";
import {
	WorkingStatusIndicator,
	RetryStatusIndicator,
	CompactionStatusIndicator,
	BranchSummaryStatusIndicator,
	IdleStatus,
} from "./status_indicator_verbatim.ts";
import { ToolExecutionComponent } from "./tool_execution_verbatim.ts";
import { TrustSelectorComponent } from "./trust_selector_verbatim.ts";
import { UserMessageSelectorComponent } from "./user_message_selector_verbatim.ts";
import { createChatViewport } from "./chat_viewport_verbatim.ts";
import { parseSearchQuery, matchSession, filterAndSortSessions, hasSessionName } from "./session_selector_search_verbatim.ts";

export type ScenarioFn = () => unknown | Promise<unknown>;
const SCENARIOS: Record<string, ScenarioFn> = {};
function scenario(name: string, run: ScenarioFn): void {
	SCENARIOS[name] = run;
}

function anyUi(): AnyRec {
	return {
		requestRender: (force?: boolean) => rec("tui.requestRender", force ?? false),
		stop: () => rec("tui.stop"),
		start: () => rec("tui.start"),
	};
}

// ---------------------------------------------------------------------------
// S1 keybinding-hints + dynamic-border
// ---------------------------------------------------------------------------
scenario("keybinding_hints", () => {
	const out: AnyRec = {};
	out.format = [
		formatKeyText("ctrl+o"),
		formatKeyText("ctrl+o", { capitalize: true }),
		formatKeyText("alt+enter/ctrl+q"),
		formatKeyText("alt+enter", { capitalize: true }),
		formatKeyText(""),
		formatKeyText("a"),
	];
	out.keys = {
		cancel: keyText("tui.select.cancel"),
		confirm: keyDisplayText("tui.select.confirm"),
		expand: keyText("app.tools.expand"),
		interrupt: keyText("app.interrupt"),
		save: keyDisplayText("app.thinking.save"),
		cycle: keyDisplayText("app.thinking.cycle"),
	};
	out.hints = [
		keyHint("tui.select.cancel", "cancel"),
		rawKeyHint("↑↓", "navigate"),
		keyHint("app.tools.expand", "to expand"),
	];
	out.border = [
		new DynamicBorder().render(10),
		new DynamicBorder((t: string) => theme.fg("accent", t)).render(4),
	];
	return out;
});

// ---------------------------------------------------------------------------
// S2 countdown-timer
// ---------------------------------------------------------------------------
scenario("countdown_timer", () => {
	const ticks: number[] = [];
	let expired = 0;
	const timer = new CountdownTimer(3500, anyUi(), (s: number) => ticks.push(s), () => expired++);
	tickTimers(4);
	timer.dispose();
	const rendersAfterDispose = tickTimers(2);
	return { ticks, expired, timersCleared: timers().every((t) => t.cleared), rendersAfterDispose };
});

// ---------------------------------------------------------------------------
// S3 visual-truncate
// ---------------------------------------------------------------------------
scenario("visual_truncate", () => {
	const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
	const wrap = "word word word word word word word word word word word word";
	return [
		truncateToVisualLines("", 5, 40, 0),
		truncateToVisualLines("a\nb\nc", 5, 40, 0),
		truncateToVisualLines("a\nb\nc\nd\ne", 2, 40, 0),
		truncateToVisualLines(long, 3, 40, 1),
		truncateToVisualLines(wrap, 2, 20, 1),
		truncateToVisualLines(wrap, 2, 20, 0),
	];
});

// ---------------------------------------------------------------------------
// S4 diff renderDiff (real jsdiff)
// ---------------------------------------------------------------------------
scenario("diff_render_diff", () => {
	return [
		renderDiff(""),
		renderDiff("context line\nanother ctx"),
		renderDiff("+12 added line\n-3 removed line"),
		renderDiff("-3 old value\n+3 new value"),
		renderDiff("-3 const a = alpha;\n+3 const a = beta;"),
		renderDiff("-3 alpha beta gamma\n+3 alpha beta delta\n-7 x\n+7 y"),
		renderDiff(" 1 shared\n-2 gone\n+2 here\n 3 tail"),
		renderDiff("-1\ttabbed\n+1\ttabbed\ttwo"),
		renderDiff("+5 only added\n+6 second"),
		renderDiff("-1 only removed\n-2 second removed"),
		renderDiff("-1 keep alpha, drop beta\n+1 keep alpha, keep beta, add gamma"),
	];
});

// ---------------------------------------------------------------------------
// S5 markdown-transform
// ---------------------------------------------------------------------------
scenario("markdown_transform", () => {
	const transformers = [
		(md: string, ctx: AnyRec) => (md.includes("SWAP") ? md.replace("SWAP", `swapped:${ctx.messageType}`) : md),
		(_md: string, _ctx: AnyRec) => {
			throw new Error("boom");
		},
		(_md: string, _ctx: AnyRec) => 42,
		(md: string) => md + "|t4",
	];
	const t = createMarkdownTransform("user", false, transformers);
	return [
		t("hello", 40),
		t("SWAP text", 40),
		t("", 0),
		createMarkdownTransform("assistant", true, [])(`x${"y".repeat(50)}`, 10),
		createMarkdownTransform("assistant-thinking", false, transformers)("SWAP", 5),
	];
});

// ---------------------------------------------------------------------------
// S6 mermaid codeSpan / isMermaid (verbatim helpers)
// ---------------------------------------------------------------------------
scenario("mermaid_code_span", () => {
	function codeSpan(line: string): string {
		const content = line || " ";
		const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
		const fence = "`".repeat(longestBacktickRun + 1);
		const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
		return `${fence}${padding}${content}${padding}${fence}`;
	}
	function isMermaid(token: AnyRec): boolean {
		return (
			token.type === "code" &&
			(token.lang as string | undefined)?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid"
		);
	}
	return [
		codeSpan("┌──┐"),
		codeSpan(""),
		codeSpan("plain ` tick"),
		codeSpan("two `` ticks"),
		codeSpan("`edge`"),
		codeSpan("``"),
		[
			isMermaid({ type: "code", lang: "mermaid", text: "graph TD" }),
			isMermaid({ type: "code", lang: " MERMAID ", text: "" }),
			isMermaid({ type: "code", lang: "mermaid extra", text: "" }),
			isMermaid({ type: "code", lang: "mermaidx", text: "" }),
			isMermaid({ type: "code", text: "" }),
			isMermaid({ type: "text", lang: "mermaid" }),
			isMermaid({ type: "code", lang: "  " }),
		],
	];
});

// ---------------------------------------------------------------------------
// S7 assistant-message
// ---------------------------------------------------------------------------
interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
}
function assistantMessage(content: ContentBlock[], stopReason = "stop", errorMessage?: string): AnyRec {
	return { role: "assistant", content, stopReason, errorMessage };
}
function describeChild(c: AnyRec): unknown {
	if (c instanceof Spacer) return "Spacer(1)";
	if (c instanceof Markdown) return { md: (c as AnyRec).text, paddingX: (c as AnyRec).paddingX };
	if (c instanceof MouseRegion) return { region: describeChild((c as AnyRec).child as AnyRec) };
	if (c instanceof Text)
		return { text: (c as AnyRec).text, paddingX: (c as AnyRec).paddingX, paddingY: (c as AnyRec).paddingY };
	return String(c);
}
function describeContent(comp: AnyRec): unknown {
	return (comp.contentContainer.children as AnyRec[]).map(describeChild);
}
scenario("assistant_message", () => {
	const mk = (c: ContentBlock[], stopReason?: string, err?: string, streaming = false) => {
		const comp = new AssistantMessageComponent(assistantMessage(c, stopReason, err), false, undefined, "Thinking...", 1, []);
		comp.updateContent(comp.lastMessage, streaming);
		return comp;
	};
	const textOnly = mk([{ type: "text", text: "  hello world  " }]);
	const thinkingThenText = mk([
		{ type: "thinking", thinking: " step one " },
		{ type: "thinking", thinking: "step two" },
		{ type: "text", text: "answer" },
	]);
	const hidden = mk([{ type: "thinking", thinking: "secret" }, { type: "text", text: "visible" }]);
	hidden.setHideThinkingBlock(true);
	const toolCalls = mk([{ type: "text", text: "working" }, { type: "toolCall", id: "t1" }]);
	const lenStop = mk([{ type: "text", text: "partial" }], "length");
	const aborted = mk([{ type: "text", text: "p" }], "aborted");
	const abortedCustom = mk([{ type: "text", text: "p" }], "aborted", "user hit the button");
	const errored = mk([{ type: "text", text: "p" }], "error", "boom");
	const blank = mk([{ type: "text", text: "   " }, { type: "thinking", thinking: "" }]);
	const streamingRun = mk([{ type: "thinking", thinking: "t" }, { type: "text", text: "a" }], "stop", undefined, true);
	// zone wrapper probe: temporarily give the content container fixed lines
	const realMarkdownRender = (Markdown.prototype as AnyRec).render;
	(Markdown.prototype as AnyRec).render = function (): string[] {
		return ["MDLINE-A", "MDLINE-B"];
	};
	const probe = new AssistantMessageComponent(assistantMessage([{ type: "text", text: "probe" }]));
	const probeLines = probe.render(40);
	const probeTool = new AssistantMessageComponent(assistantMessage([{ type: "text", text: "p" }, { type: "toolCall", id: "x" }]));
	const probeToolLines = probeTool.render(40);
	const probeEmpty = new AssistantMessageComponent();
	const probeEmptyLines = probeEmpty.render(40);
	(Markdown.prototype as AnyRec).render = realMarkdownRender;
	return {
		textOnly: describeContent(textOnly),
		thinkingThenText: describeContent(thinkingThenText),
		hiddenThinking: describeContent(hidden),
		hasToolCalls: toolCalls.hasToolCalls,
		toolCallsContent: describeContent(toolCalls),
		lengthStop: describeContent(lenStop),
		aborted: describeContent(aborted),
		abortedCustom: describeContent(abortedCustom),
		errored: describeContent(errored),
		blank: describeContent(blank),
		streaming: describeContent(streamingRun),
		zoneProbe: probeLines,
		zoneProbeTool: probeToolLines,
		zoneProbeEmpty: probeEmptyLines,
	};
});

// ---------------------------------------------------------------------------
// S8 bash-execution
// ---------------------------------------------------------------------------
scenario("bash_execution", () => {
	const renders: number[] = [];
	const ui = { requestRender: () => renders.push(1), stop: () => {}, start: () => {} };
	const comp = new BashExecutionComponent("echo hi", ui, false);
	comp.appendOutput("first\nsec");
	comp.appendOutput("ond\nthird\r\nfourth\rfifth");
	const previewChild = (comp.contentContainer.children as AnyRec[]).find(
		(c: AnyRec) => typeof c.render === "function" && !(c instanceof Loader),
	);
	const collapsed = previewChild ? (previewChild.render(40) as string[]) : [];
	comp.setExpanded(true);
	const expanded = (comp.contentContainer.children as AnyRec[]).map((c: AnyRec) =>
		c instanceof Text ? { text: (c as AnyRec).text, paddingX: (c as AnyRec).paddingX } : c instanceof Loader ? "loader" : String(c),
	);
	comp.setComplete(0, false, undefined, undefined);
	const completeLines = (comp.contentContainer.children as AnyRec[]).map((c: AnyRec) =>
		c instanceof Text ? { text: (c as AnyRec).text, paddingX: (c as AnyRec).paddingX } : c instanceof Loader ? "loader" : String(c),
	);
	comp.setComplete(3, false, undefined, "/tmp/full.out");
	const errorLines = (comp.contentContainer.children as AnyRec[]).map((c: AnyRec) =>
		c instanceof Text ? { text: (c as AnyRec).text, paddingX: (c as AnyRec).paddingX } : c instanceof Loader ? "loader" : String(c),
	);
	comp.setComplete(undefined, true, { truncated: true, content: "x" } as AnyRec, "/tmp/full2.out");
	const cancelledLines = (comp.contentContainer.children as AnyRec[]).map((c: AnyRec) =>
		c instanceof Text ? { text: (c as AnyRec).text, paddingX: (c as AnyRec).paddingX } : c instanceof Loader ? "loader" : String(c),
	);
	const excluded = new BashExecutionComponent("!! ls", ui, true);
	excluded.appendOutput("out");
	excluded.setComplete(0, false, undefined, undefined);
	const big = new BashExecutionComponent("big", ui, false);
	const longOutput = Array.from({ length: DEFAULT_MAX_LINES + 10 }, (_, i) => `L${i}`).join("\n");
	big.appendOutput(longOutput);
	big.setComplete(0, false, undefined, "/tmp/big.out");
	const bigStatus = (big.contentContainer.children as AnyRec[])
		.filter((c: unknown) => c instanceof Text)
		.map((c: AnyRec) => c.text as string);
	const bigPreview = (big.contentContainer.children as AnyRec[]).find(
		(c: AnyRec) => typeof c.render === "function" && !(c instanceof Loader),
	);
	return {
		renders: renders.length,
		loaderMessage: (comp.loader as AnyRec).message,
		collapsed,
		expanded,
		completeLines,
		errorLines,
		cancelledLines,
		output: comp.getOutput(),
		command: comp.getCommand(),
		excludedHeader: (excluded.contentContainer.children as AnyRec[])[0] instanceof Text
			? ((excluded.contentContainer.children as AnyRec[])[0] as AnyRec).text
			: null,
		excludedStatus: bigStatus,
		bigPreviewLines: bigPreview ? (bigPreview.render(40) as string[]).length : 0,
		bigPreviewFirst: bigPreview ? (bigPreview.render(40) as string[])[0] : null,
		bigOutputLines: big.getOutput().split("\n").length,
		defaults: { DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES },
		truncateTailProbe: truncateTail("a\nb\nc", { maxLines: 2, maxBytes: 100 }).content,
		stripAnsiProbe: stripAnsi("\x1b[31mred\x1b[0m plain"),
	};
});

// ---------------------------------------------------------------------------
// S9 bordered-loader
// ---------------------------------------------------------------------------
scenario("bordered_loader", () => {
	const events: unknown[] = [];
	const ui = {
		requestRender: () => events.push("render"),
		stop: () => {},
		start: () => {},
	};
	const cancellable = new BorderedLoader(ui, theme, "Working...", { cancellable: true });
	const nonCancellable = new BorderedLoader(ui, theme, "Loading...", { cancellable: false });
	const plain = new BorderedLoader(ui, theme, "Plain...");
	const kidsOf = (b: AnyRec) =>
		(b.children as AnyRec[]).map((c: AnyRec) =>
			c instanceof Loader ? { loader: (c as AnyRec).message } : c instanceof DynamicBorder ? "border" : c instanceof Spacer ? "spacer" : c instanceof Text ? { text: (c as AnyRec).text } : String(c),
		);
	const loader = cancellable.loader as unknown as CancellableLoader;
	loader.onAbort = () => events.push("abort");
	cancellable.handleInput("\x1b");
	return {
		cancellable: kidsOf(cancellable),
		nonCancellable: kidsOf(nonCancellable),
		plain: kidsOf(plain),
		aborted: loader.aborted,
		events,
		render: cancellable.render(30),
	};
});

// ---------------------------------------------------------------------------
// S10 message components (branch/compaction/skill/user/custom)
// ---------------------------------------------------------------------------
function describeBoxChild(c: AnyRec): unknown {
	if (c instanceof MouseRegion) {
		const inner = (c as AnyRec).child as AnyRec;
		return {
			region:
				inner instanceof Container
					? (inner.children as AnyRec[]).map((k: AnyRec) =>
							k instanceof Text ? { text: (k as AnyRec).text } : k instanceof Markdown ? { md: (k as AnyRec).text, paddingX: (k as AnyRec).paddingX } : k instanceof Spacer ? "spacer" : String(k),
						)
					: String(inner),
		};
	}
	if (c instanceof Text) return { text: (c as AnyRec).text };
	return String(c);
}
scenario("message_components", () => {
	const branch = new BranchSummaryMessageComponent({ summary: "Did **stuff**" } as AnyRec);
	const branchCollapsed = (branch.children as AnyRec[]).map(describeBoxChild);
	branch.setExpanded(true);
	const branchExpanded = branch.render(40);
	branch.setExpanded(false);
	const branchToggled = (branch.children as AnyRec[]).map(describeBoxChild);
	const compaction = new CompactionSummaryMessageComponent({ summary: "compact summary", tokensBefore: 1234567 } as AnyRec);
	const compactionCollapsed = (compaction.children as AnyRec[]).map(describeBoxChild);
	compaction.setExpanded(true);
	const compactionExpanded = (compaction.children as AnyRec[]).map(describeBoxChild);
	const skill = new SkillInvocationMessageComponent({ name: "my-skill", content: "skill body" } as AnyRec);
	const skillCollapsed = (skill.children as AnyRec[]).map(describeBoxChild);
	skill.setExpanded(true);
	const skillExpanded = (skill.children as AnyRec[]).map(describeBoxChild);
	const user = new UserMessageComponent("# Title\n\nbody", undefined, 1, []);
	user.setOutputPad(2);
	const userBox = (user.children as AnyRec[])[0] as AnyRec;
	const userBoxInfo = { kind: "Box", paddingX: userBox.paddingX, paddingY: userBox.paddingY, bgTag: userBox.bgTag, children: (userBox.children as AnyRec[]).map((k: AnyRec) => (k instanceof Markdown ? { md: (k as AnyRec).text, paddingX: (k as AnyRec).paddingX } : String(k))) };
	// zone wrapper probe: fixed inner lines
	const realBoxRender = (Box.prototype as AnyRec).render;
	(Box.prototype as AnyRec).render = function (): string[] {
		return ["BB-FIRST", "BB-SECOND"];
	};
	const userProbe = new UserMessageComponent("probe text");
	const userProbeLines = userProbe.render(40);
	(Box.prototype as AnyRec).render = realBoxRender;
	const userCustom = new UserMessageComponent("text", undefined, 1, [(md: string) => md.toUpperCase()]);
	const customMd = ((userCustom.children as AnyRec[])[0] as AnyRec).children[0] as AnyRec;
	const custom = new CustomMessageComponent({ customType: "plan", content: "steps" } as AnyRec);
	const customInfo = (custom.children as AnyRec[]).map((c: AnyRec) => (c instanceof Box ? { box: (c.children as AnyRec[]).map((k: AnyRec) => (k instanceof Text ? { text: (k as AnyRec).text } : k instanceof Markdown ? { md: (k as AnyRec).text } : k instanceof Spacer ? "spacer" : String(k))) } : String(c)));
	const customBlocks = new CustomMessageComponent({ customType: "note", content: [{ type: "text", text: "one" }, { type: "image", data: "x" }, { type: "text", text: "two" }] } as AnyRec);
	const customBlocksInfo = (customBlocks.children as AnyRec[]).map((c: AnyRec) => (c instanceof Box ? { box: (c.children as AnyRec[]).map((k: AnyRec) => (k instanceof Markdown ? { md: (k as AnyRec).text } : String(k))) } : String(c)));
	let rendererCalls = 0;
	const customWithRenderer = new CustomMessageComponent({ customType: "n", content: "c" } as AnyRec, () => {
		rendererCalls++;
		return new Text("custom rendered", 0, 0);
	});
	const customRendererNull = new CustomMessageComponent({ customType: "n", content: "c" } as AnyRec, () => null);
	const customRendererThrows = new CustomMessageComponent({ customType: "n", content: "c" } as AnyRec, () => {
		throw new Error("renderer exploded");
	});
	customWithRenderer.setOutputPad(3);
	const entryOk = new CustomEntryComponent({ customType: "ext" } as AnyRec, () => new Text("entry body", 0, 0));
	const entryEmpty = new CustomEntryComponent({ customType: "ext" } as AnyRec, () => undefined);
	const entryThrow = new CustomEntryComponent({ customType: "bad" } as AnyRec, () => {
		throw new Error("entry failed");
	});
	entryOk.setExpanded(true);
	const entryOkInfo = (entryOk.children as AnyRec[]).map((c: AnyRec) => (c instanceof Spacer ? "spacer" : c instanceof Text ? { text: (c as AnyRec).text } : String(c)));
	const entryThrowInfo = (entryThrow.children as AnyRec[]).map((c: AnyRec) => (c instanceof Box ? { box: (c.children as AnyRec[]).map((k: AnyRec) => (k instanceof Text ? { text: (k as AnyRec).text } : String(k))) } : String(c)));
	return {
		branchCollapsed,
		branchExpanded,
		branchToggled,
		compactionCollapsed,
		compactionExpanded,
		skillCollapsed,
		skillExpanded,
		userBoxInfo,
		userZoneProbe: userProbeLines,
		userCustomMd: { md: customMd.text, paddingX: customMd.paddingX },
		custom: customInfo,
		customBlocks: customBlocksInfo,
		customWithRenderer: (customWithRenderer.children as AnyRec[]).map((c: AnyRec) => (c instanceof Text ? { text: (c as AnyRec).text } : String(c))),
		rendererCalls,
		customRendererNull: (customRendererNull.children as AnyRec[]).map(String),
		customRendererThrows: (customRendererThrows.children as AnyRec[]).map((c: AnyRec) => (c instanceof Box ? { box: (c.children as AnyRec[]).map((k: AnyRec) => (k instanceof Text ? { text: (k as AnyRec).text } : String(k))) } : String(c))),
		entryOk: entryOkInfo,
		entryHasContent: [entryOk.hasContent(), entryEmpty.hasContent()],
		entryEmpty: (entryEmpty.children as AnyRec[]).length,
		entryThrow: entryThrowInfo,
	};
});

// ---------------------------------------------------------------------------
// S11 daxnuts
// ---------------------------------------------------------------------------
scenario("daxnuts", () => {
	const renders: unknown[] = [];
	const ui = { requestRender: () => renders.push(1), stop: () => {}, start: () => {} };
	const comp = new DaxnutsComponent(ui);
	const tick0 = comp.render(60);
	tickTimers(1);
	const tick1 = comp.render(60);
	for (let i = 0; i < 14; i++) tickTimers(1);
	const tick15 = comp.render(60);
	for (let i = 0; i < 10; i++) tickTimers(1);
	const tick25 = comp.render(60);
	for (let i = 0; i < 5; i++) tickTimers(1);
	const tick30 = comp.render(60);
	comp.dispose();
	const before = renders.length;
	tickTimers(3);
	return {
		imageRows: comp.image.length,
		imageRow0: comp.image[0],
		imageRowLast: comp.image[comp.image.length - 1],
		tick0,
		tick1,
		tick15,
		tick25,
		tick30,
		rendersAfterDispose: renders.length - before,
	};
});

// ---------------------------------------------------------------------------
// S12 earendil-announcement
// ---------------------------------------------------------------------------
scenario("earendil_announcement", () => {
	const comp = new EarendilAnnouncementComponent();
	return (comp.children as AnyRec[]).map((c: AnyRec) =>
		c instanceof Text ? { text: (c as AnyRec).text, paddingX: (c as AnyRec).paddingX } : c instanceof DynamicBorder ? { border: c.colorTag } : c instanceof Spacer ? "spacer" : c instanceof Image ? "image" : String(c),
	);
});

// ---------------------------------------------------------------------------
// S13 footer
// ---------------------------------------------------------------------------
function makeSession(state: AnyRec, entries: AnyRec[], contextUsage: AnyRec | null, cwd = "C:\\Users\\n\\proj", sessionName?: string): AnyRec {
	return {
		state,
		getContextUsage: () => contextUsage,
		sessionManager: {
			getEntries: () => entries,
			getCwd: () => cwd,
			getSessionName: () => sessionName,
		},
		modelRuntime: { isUsingSubscription: (provider: string) => provider === "sub-provider" },
	};
}
const FOOTER_PROVIDER = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map([["b", "second status"], ["a", "first\tstatus"]]),
	getAvailableProviderCount: () => 2,
};
const FOOTER_MODEL = { id: "kimi-k2", provider: "kimi-coding", contextWindow: 100000, reasoning: true };
const FOOTER_ENTRIES = [
	{ type: "message", message: { role: "assistant", usage: { input: 1500, output: 250, cacheRead: 100, cacheWrite: 50, cost: { total: 0.5 } } } },
	{ type: "message", message: { role: "toolResult", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } } } },
	{ type: "branch_summary", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
];
scenario("footer", () => {
	const out: AnyRec = {};
	out.formatTokens = [0, 999, 1000, 1234, 9999, 10_000, 999_999, 1_000_000, 1_234_567, 9_999_999, 10_000_000].map((n) => formatTokens(n));
	out.cwd = [
		formatCwdForFooter("C:\\Users\\n\\proj", "C:\\Users\\n"),
		formatCwdForFooter("C:\\Users\\n\\proj", "C:\\Users\\m"),
		formatCwdForFooter("C:\\Users\\n", "C:\\Users\\n"),
		formatCwdForFooter("C:\\other", undefined),
		formatCwdForFooter("C:\\Users\\n\\..\\elsewhere", "C:\\Users\\n"),
	];
	const totals = createUsageTotals();
	addUsageToTotals(totals, { input: 1500, output: 250, cacheRead: 100, cacheWrite: 50, cost: { total: 0.5 }, tokens: {} });
	addUsageToTotals(totals, { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 }, tokens: {} });
	out.usageTotals = totals;
	const noUsage = new FooterComponent(
		makeSession({ model: null }, [], null),
		{ getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1 } as AnyRec,
	);
	out.noModel = noUsage.render(60);
	const session = makeSession({ model: FOOTER_MODEL, thinkingLevel: "high" }, FOOTER_ENTRIES, { contextWindow: 200000, percent: 42.55 }, "C:\\Users\\n\\proj", "my-session");
	const footer = new FooterComponent(session, FOOTER_PROVIDER as AnyRec);
	out.full = footer.render(80);
	setXp(true);
	out.xp = footer.render(80);
	setXp(false);
	footer.setAutoCompactEnabled(false);
	(session.state as AnyRec).thinkingLevel = "off";
	out.autoOff = footer.render(80);
	(session.state as AnyRec).thinkingLevel = "high";
	const unknownPct = new FooterComponent(makeSession({ model: FOOTER_MODEL }, FOOTER_ENTRIES, { contextWindow: 200000, percent: null }) as AnyRec, FOOTER_PROVIDER as AnyRec);
	out.unknownPct = unknownPct.render(80);
	const narrow = new FooterComponent(session, FOOTER_PROVIDER as AnyRec);
	out.narrow = narrow.render(30);
	out.narrower = narrow.render(12);
	const over90 = new FooterComponent(makeSession({ model: FOOTER_MODEL }, FOOTER_ENTRIES, { contextWindow: 200000, percent: 91.1 }) as AnyRec, FOOTER_PROVIDER as AnyRec);
	out.over90 = over90.render(80);
	const over70 = new FooterComponent(makeSession({ model: FOOTER_MODEL }, FOOTER_ENTRIES, { contextWindow: 200000, percent: 70.1 }) as AnyRec, FOOTER_PROVIDER as AnyRec);
	out.over70 = over70.render(80);
	const sub = new FooterComponent(makeSession({ model: { id: "m", provider: "sub-provider", contextWindow: 1000, reasoning: false } }, FOOTER_ENTRIES, { contextWindow: 1000, percent: 5 }) as AnyRec, FOOTER_PROVIDER as AnyRec);
	out.subscription = sub.render(80);
	const noBranch = new FooterComponent(session, { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1 } as AnyRec);
	out.noBranchNoStatuses = noBranch.render(80);
	return out;
});

// ---------------------------------------------------------------------------
// S14 login-dialog
// ---------------------------------------------------------------------------
scenario("login_dialog", async () => {
	const completions: unknown[] = [];
	const dialog = new LoginDialogComponent(anyUi(), "openai", (success: boolean, message?: string) => completions.push([success, message]));
	dialog.showAuth("https://auth.example.com", "Paste the code below");
	dialog.showDeviceCode({ verificationUri: "https://device.example.com", userCode: "ABCD-1234" });
	dialog.showDetails(["line one", "line two"]);
	dialog.showInfo("info message", [{ label: "docs", url: "https://docs.example.com" }, { url: "https://bare.example.com" }], true);
	dialog.showWaiting("waiting...");
	dialog.showProgress("progressing");
	const content = () => (dialog.contentContainer.children as AnyRec[]).map((c: AnyRec) => (c instanceof Text ? (c as AnyRec).text : c instanceof Spacer ? "spacer" : c instanceof Input ? "input" : String(c)));
	const contentAfterShows = content();
	const p1 = dialog.showManualInput("enter code");
	(dialog as AnyRec).input.setValue("the-code");
	(dialog as AnyRec).input.onSubmit();
	const manualValue = await (p1 as Promise<string>).then((v: string) => ["resolved", v]);
	const p2 = dialog.showPrompt("Who are you?", "your name");
	const promptContent = content();
	(dialog as AnyRec).input.setValue("my name");
	(dialog as AnyRec).input.handleInput("\r");
	const promptValue = await (p2 as Promise<string>).then((v: string) => ["resolved", v]);
	const p3 = dialog.showPrompt("again");
	(dialog as AnyRec).input.setValue("will cancel");
	dialog.handleInput("\x1b");
	const cancelled = await (p3 as Promise<string>).then(() => ["resolved"], (e: Error) => ["rejected", e.message]);
	return {
		contentAfterShows,
		manualContent: content(),
		manualValue,
		promptContent,
		promptValue,
		cancelled,
		completions,
		focused: (dialog as AnyRec).focused,
	};
});

// ---------------------------------------------------------------------------
// S15 oauth-selector
// ---------------------------------------------------------------------------
interface Provider {
	id: string;
	name: string;
	authType: string;
	method?: AnyRec;
	status?: AnyRec;
}
scenario("oauth_selector", () => {
	const providers: Provider[] = [
		{ id: "anthropic", name: "Anthropic", authType: "oauth", method: { name: "Claude Pro" }, status: { type: "oauth", source: "OAuth" } },
		{ id: "openai", name: "OpenAI", authType: "api_key", status: { type: "api_key", source: "ENV_VAR,OTHER_ENV" } },
		{ id: "kimi", name: "Kimi", authType: "oauth", method: { name: "Kimi Login" }, status: { type: "oauth", source: "stored credential" } },
		{ id: "gemini", name: "Gemini", authType: "api_key", status: { type: "oauth", source: "Google OAuth" } },
		{ id: "bare", name: "Bare", authType: "api_key" },
		{ id: "local", name: "Local", authType: "api_key", status: { type: "api_key", source: "config file" } },
	];
	const selections: unknown[] = [];
	let cancels = 0;
	const sel = new OAuthSelectorComponent("login", providers, (id: string, t: string) => selections.push([id, t]), () => cancels++, "a");
	const lines = (comp: AnyRec) => (comp.listContainer.children as AnyRec[]).map((c: AnyRec) => (c instanceof TruncatedText ? (c as AnyRec).text : "other"));
	const loginLines = lines(sel);
	sel.handleInput("\x1b[B");
	sel.handleInput("n");
	const filteredLines = lines(sel);
	sel.handleInput("\r");
	const logout = new OAuthSelectorComponent("logout", providers.slice(0, 2), (id: string, t: string) => selections.push([id, t]), () => cancels++);
	logout.handleInput("\x1b[A");
	logout.handleInput("\r");
	const empty = new OAuthSelectorComponent("login", [], () => {}, () => cancels++);
	const emptyLines = lines(empty);
	const noMatch = new OAuthSelectorComponent("logout", providers, () => {}, () => cancels++);
	noMatch.handleInput("zzzz");
	const noMatchLines = lines(noMatch);
	return {
		typeLabels: [formatAuthSelectorProviderType("oauth"), formatAuthSelectorProviderType("api_key")],
		loginLines,
		filteredLines,
		selections,
		cancels,
		logoutLines: lines(logout),
		emptyLines,
		noMatchLines,
		fuzzyProbe: [fuzzyMatch("anth", "Anthropic oauth").score, fuzzyMatch("zzz", "no match here").matches],
	};
});

// ---------------------------------------------------------------------------
// S16 extension-input / selector / editor
// ---------------------------------------------------------------------------
scenario("extension_components", async () => {
	const submits: unknown[] = [];
	const cancels: unknown[] = [];
	const toggles: unknown[] = [];
	const ui = anyUi();
	const input = new ExtensionInputComponent("Pick one", undefined, (v: string) => submits.push(v), () => cancels.push("input"), { tui: ui, timeout: 2500 });
	tickTimers(2);
	input.handleInput("h");
	input.handleInput("i");
	input.handleInput("\r");
	tickTimers(1);
	const inputTitle = input.titleText.text;
	input.dispose();
	const selector = new ExtensionSelectorComponent("Choose", ["alpha", "beta"], (v: string) => submits.push(v), () => cancels.push("selector"), { tui: ui, timeout: 1500, onToggleToolsExpanded: () => toggles.push(1) });
	selector.handleInput("j");
	selector.handleInput("\x1b[B");
	selector.handleInput("k");
	selector.handleInput("\x1b[A");
	tickTimers(1);
	const selectorTitle = selector.titleText.text;
	selector.handleInput("\x1b");
	const editor = new ExtensionEditorComponent(ui, { matches: (d: string, k: string) => k === "app.editor.external" && d === "\x07" }, "Edit me", "prefill", (v: string) => submits.push(v), () => cancels.push("editor"));
	await (editor as AnyRec).handleOpenExternalEditor();
	const editorCancel = editor.handleInput("\x1b");
	const editorKbExternal = editor.keybindings.matches("\x07", "app.editor.external");
	return {
		submits,
		cancels,
		toggles,
		inputTitle,
		selectorTitle,
		selectorLines: (selector.listContainer.children as AnyRec[]).map((c: AnyRec) => (c instanceof Text ? (c as AnyRec).text : String(c))),
		hintsLine: (selector.children as AnyRec[]).filter((c: unknown) => c instanceof Text).map((c: AnyRec) => (c as AnyRec).text as string).join("||"),
		editorText: editor.editor.getText(),
		editorCancel,
		editorKbExternal,
	};
});

// ---------------------------------------------------------------------------
// S17 first-time-setup
// ---------------------------------------------------------------------------
scenario("first_time_setup", () => {
	const results: unknown[] = [];
	const previews: string[] = [];
	let cancels = 0;
	const setup = new FirstTimeSetupComponent({
		detectedTheme: "light",
		onThemePreview: (t: string) => previews.push(t),
		onSubmit: (r: AnyRec) => results.push(r),
		onCancel: () => cancels++,
	});
	const texts = (c: AnyRec) => (c.children as AnyRec[]).map((k: AnyRec) => (k instanceof Text ? (k as AnyRec).text : k instanceof DynamicBorder ? "border" : k instanceof Spacer ? "spacer" : String(k)));
	const initial = texts(setup);
	setup.handleInput("j");
	setup.handleInput("\r");
	const analytics = texts(setup);
	setup.handleInput("\x1b[A");
	setup.handleInput("j");
	setup.handleInput("\r");
	const s2 = new FirstTimeSetupComponent({ detectedTheme: "dark", onThemePreview: () => {}, onSubmit: () => {}, onCancel: () => cancels++ });
	s2.handleInput("\x1b");
	return { initial, analytics, results, previews, cancels, detectedIndex: setup.themeIndex };
});

// ---------------------------------------------------------------------------
// S18 simple selectors (theme/show-images/thinking)
// ---------------------------------------------------------------------------
scenario("simple_selectors", () => {
	const selected: unknown[] = [];
	let cancels = 0;
	const themeSel = new ThemeSelectorComponent("dark", (v: string) => selected.push(["theme", v]), () => cancels++, (v: string) => selected.push(["preview", v]));
	themeSel.selectList.onSelectionChange?.({ value: "light" } as AnyRec);
	themeSel.selectList.handleInput("\r");
	const images = new ShowImagesSelectorComponent(true, (v: boolean) => selected.push(["images", v]), () => cancels++);
	images.selectList.handleInput("\x1b[B");
	images.selectList.handleInput("\r");
	const thinking = new ThinkingSelectorComponent("medium", ["off", "low", "medium", "high"], (v: string) => selected.push(["thinking", v]), () => cancels++, (v: string) => selected.push(["default", v]), "low");
	const thinkingItems = thinking.allItems;
	thinking.handleInput("\x1b[B");
	thinking.handleInput("\x1b[B");
	thinking.handleInput("\r");
	thinking.handleInput("f");
	const filteredItems = thinking.selectList.items;
	thinking.handleInput("\x13");
	return {
		themeItems: themeSel.selectList.items,
		imagesItems: images.selectList.items,
		thinkingItems,
		filteredItems,
		selected,
		cancels,
		layout: { themeMaxVisible: themeSel.selectList.maxVisible, imagesMaxVisible: images.selectList.maxVisible, thinkingMaxVisible: thinking.selectList.maxVisible },
	};
});

// ---------------------------------------------------------------------------
// S19 status-indicator
// ---------------------------------------------------------------------------
scenario("status_indicator", () => {
	const ui = anyUi();
	const working = new WorkingStatusIndicator(ui, "Running...");
	const workingInBorder = working.renderInBorder(30);
	const workingSpinner = working.renderSpinnerInBorder(30);
	const retry = new RetryStatusIndicator(ui, 2, 5, 2500);
	const retryInitial = retry.message;
	tickTimers(3);
	const retryAfterTicks = retry.message;
	retry.dispose();
	const retryDisposeUncleared = timers().filter((t) => !t.cleared).length;
	const compaction = new CompactionStatusIndicator(ui, "manual");
	const compactionOverflow = new CompactionStatusIndicator(ui, "overflow");
	const compactionThreshold = new CompactionStatusIndicator(ui, "threshold");
	const branch = new BranchSummaryStatusIndicator(ui);
	const idle = new IdleStatus();
	return {
		kind: working.kind,
		workingInBorder,
		workingSpinner,
		retryKind: retry.kind,
		retryInitial,
		retryAfterTicks,
		retryDisposeUncleared,
		compactionLabel: compaction.message,
		compactionOverflowLabel: compactionOverflow.message,
		compactionThresholdLabel: compactionThreshold.message,
		branchLabel: branch.message,
		idle: idle.render(10),
		workingRender: working.render(30),
	};
});

// ---------------------------------------------------------------------------
// S20 tool-execution
// ---------------------------------------------------------------------------
function describeInner(c: AnyRec): unknown {
	if (c instanceof Text) return { text: (c as AnyRec).text, paddingX: (c as AnyRec).paddingX, paddingY: (c as AnyRec).paddingY, bg: (c as AnyRec).customBgFn ? "set" : null };
	if (c instanceof Box) return { box: ((c as AnyRec).children as AnyRec[]).map(describeInner) };
	return String(c);
}
function describeToolBox(b: AnyRec): unknown {
	return ((b as AnyRec).children as AnyRec[]).map(describeInner);
}
scenario("tool_execution", () => {
	const ui = anyUi();
	const plain = new ToolExecutionComponent("read", "call-1", { path: "a.txt", n: 2 }, {}, undefined, ui, "C:\\w");
	const plainContent = plain.contentText.text;
	plain.markExecutionStarted();
	plain.setArgsComplete();
	plain.updateResult({ content: [{ type: "text", text: "file contents" }, { type: "image", data: "imgdata", mimeType: "image/png" }], isError: false, details: null }, false);
	const plainAfter = plain.contentText.text;
	plain.setExpanded(true);
	const plainExpanded = plain.contentText.text;
	const renderers = {
		renderCall: (args: AnyRec, _theme: unknown, ctx: AnyRec) => new Text(`CALL(${JSON.stringify(args)} ${ctx.isPartial} ${ctx.expanded})`, 0, 0),
		renderResult: (result: AnyRec, options: AnyRec, _theme: unknown, _ctx: AnyRec) => {
			if (options.isPartial) return new Text(`PARTIAL(${JSON.stringify(result.details)})`, 0, 0);
			return new Text(`RESULT(${(result.content as AnyRec[]).map((c: AnyRec) => c.text ?? "[img]").join(",")} ${options.expanded})`, 0, 0);
		},
	};
	const withRenderers = new ToolExecutionComponent("bash", "call-2", { cmd: "ls" }, {}, renderers as AnyRec, ui, "C:\\w");
	withRenderers.updateResult({ content: [{ type: "text", text: "out" }], isError: false, details: { n: 1 } }, true);
	const partialBox = describeToolBox(withRenderers.contentBox);
	withRenderers.updateResult({ content: [{ type: "text", text: "out" }], isError: false, details: undefined }, false);
	const finalBox = describeToolBox(withRenderers.contentBox);
	withRenderers.setExpanded(true);
	const expandedBox = describeToolBox(withRenderers.contentBox);
	const throwing = new ToolExecutionComponent("t", "c3", {}, {}, { renderCall: () => { throw new Error("call boom"); }, renderResult: () => { throw new Error("result boom"); } } as AnyRec, ui, "C:\\w");
	throwing.updateResult({ content: [{ type: "text", text: "fallback output\nline2\nline3\nline4" }], isError: true, details: undefined }, false);
	const throwingBox = describeToolBox(throwing.contentBox);
	const throwingExpanded = (throwing.setExpanded(true), describeToolBox(throwing.contentBox));
	setCaps({ images: "kitty", hyperlinks: false });
	const kitty = new ToolExecutionComponent("img", "c4", {}, {}, undefined, ui, "C:\\w");
	const png = { type: "image", data: "pngdata", mimeType: "image/png" } as AnyRec;
	const jpeg = { type: "image", data: "jpegdata", mimeType: "image/jpeg" } as AnyRec;
	kitty.updateResult({ content: [png, jpeg], isError: false, details: undefined }, false);
	const kittyImages = kitty.imageComponents.map((i: AnyRec) => i.describe());
	setCaps({ images: true, hyperlinks: false });
	const noKitty = new ToolExecutionComponent("img", "c5", {}, {}, undefined, ui, "C:\\w");
	noKitty.updateResult({ content: [jpeg], isError: false, details: undefined }, false);
	const noKittyImages = noKitty.imageComponents.map((i: AnyRec) => i.describe());
	noKitty.setShowImages(false);
	const hiddenImages = noKitty.imageComponents.length;
	noKitty.setShowImages(true);
	noKitty.setImageWidthCells(40);
	const widthCells = noKitty.imageWidthCells;
	setCaps({ images: false, hyperlinks: false });
	const selfShell = new ToolExecutionComponent("self", "c6", {}, {}, { renderShell: "self", renderCall: () => new Text("SELF CALL", 0, 0) } as AnyRec, ui, "C:\\w");
	const selfRender = selfShell.render(30);
	const emptyHide = new ToolExecutionComponent("ghost", "c7", {}, {}, { renderCall: () => new Text("", 0, 0) } as AnyRec, ui, "C:\\w");
	emptyHide.updateResult({ content: [], isError: false, details: undefined }, false);
	const hideRender = emptyHide.render(30);
	const textOutputProbe = new ToolExecutionComponent("p", "c8", {}, {}, undefined, ui, "C:\\w");
	textOutputProbe.updateResult({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }, { type: "image", data: "d", mimeType: "image/jpeg" }], isError: false, details: undefined }, false);
	return {
		plainContent,
		plainAfter,
		plainExpanded,
		partialBox,
		finalBox,
		expandedBox,
		throwingBox,
		throwingExpanded,
		kittyImages,
		noKittyImages,
		hiddenImages,
		widthCells,
		selfRender,
		hideRender,
		textOutputProbe: textOutputProbe.contentText.text,
	};
});

// ---------------------------------------------------------------------------
// S21 trust-selector
// ---------------------------------------------------------------------------
scenario("trust_selector", () => {
	const selections: unknown[] = [];
	let cancels = 0;
	setTrustOptions([
		{ label: "Trust this project", trusted: true, updates: false, savedPath: "C:\\w" },
		{ label: "Trust without updates", trusted: true, updates: true, savedPath: undefined },
		{ label: "Never trust", trusted: false, updates: false, savedPath: undefined },
	]);
	const sel = new TrustSelectorComponent({
		cwd: "C:\\w",
		savedDecision: { path: "C:\\w", decision: true },
		projectTrusted: true,
		onSelect: (s: AnyRec) => selections.push(s),
		onCancel: () => cancels++,
	} as AnyRec);
	const lines = (c: AnyRec) => (c.listContainer.children as AnyRec[]).map((k: AnyRec) => (k instanceof Text ? (k as AnyRec).text : String(k)));
	const initial = lines(sel);
	sel.handleInput("j");
	sel.handleInput("\r");
	const noneSaved = new TrustSelectorComponent({ cwd: "C:\\w", savedDecision: null, projectTrusted: false, onSelect: () => {}, onCancel: () => {} } as AnyRec);
	const inherited = new TrustSelectorComponent({ cwd: "C:\\w", savedDecision: { path: "C:\\parent", decision: false }, projectTrusted: false, onSelect: () => {}, onCancel: () => {} } as AnyRec);
	return {
		initial,
		selections,
		cancels,
		header: sel.children.filter((c: unknown) => c instanceof Text).map((c: AnyRec) => (c as AnyRec).text as string),
		noneSavedHeader: noneSaved.children.filter((c: unknown) => c instanceof Text).map((c: AnyRec) => (c as AnyRec).text as string),
		inheritedLines: lines(inherited),
	};
});

// ---------------------------------------------------------------------------
// S22 user-message-selector
// ---------------------------------------------------------------------------
scenario("user_message_selector", () => {
	const selected: string[] = [];
	let cancels = 0;
	const messages = [
		{ id: "e1", text: "first message" },
		{ id: "e2", text: "second\nmultiline message" },
		{ id: "e3", text: "third" },
	];
	const sel = new UserMessageSelectorComponent(messages as AnyRec[], (id: string) => selected.push(id), () => cancels++);
	const initial = sel.messageList.render(40);
	sel.messageList.handleInput("\x1b[A");
	sel.messageList.handleInput("\x1b[A");
	const wrapped = sel.messageList.render(40);
	sel.messageList.handleInput("\r");
	sel.messageList.handleInput("\x1b[B");
	sel.messageList.handleInput("\r");
	const empty = new UserMessageSelectorComponent([], () => {}, () => cancels++);
	return {
		initial,
		wrapped,
		selected,
		cancels,
		emptyRender: empty.messageList.render(40),
	};
});

// ---------------------------------------------------------------------------
// S23 chat-viewport
// ---------------------------------------------------------------------------
scenario("chat_viewport", () => {
	const doc = { describe: () => ({ kind: "doc" }) };
	const pending = { describe: () => ({ kind: "pending" }) };
	const status = { describe: () => ({ kind: "status" }) };
	const editor = { describe: () => ({ kind: "editor" }) };
	const footer = { describe: () => ({ kind: "footer" }) };
	const above = { describe: () => ({ kind: "above" }) };
	const below = { describe: () => ({ kind: "below" }) };
	const full = createChatViewport({ document: doc, pendingMessages: pending, status, editor, footer, widgetsAbove: above, widgetsBelow: below, scrollbar: "always", scrollbarTrackStyle: (t: string) => t, scrollbarThumbStyle: (t: string) => t });
	const minimal = createChatViewport({ document: doc, pendingMessages: pending, status, editor, footer });
	return {
		full: (full.root as AnyRec).describe(),
		minimal: (minimal.root as AnyRec).describe(),
		transcriptOptions: (full.transcript as AnyRec).options,
	};
});

// ---------------------------------------------------------------------------
// S24 session-selector-search
// ---------------------------------------------------------------------------
function sess(id: string, name: string | null, text: string, cwd: string, modified: number): AnyRec {
	return { id, name, allMessagesText: text, cwd, modified: new Date(modified), path: `C:\\s\\${id}.jsonl`, created: new Date(modified - 1000), messageCount: 3, firstMessage: text.slice(0, 10), parentSessionPath: null };
}
scenario("session_selector_search", () => {
	const out: AnyRec = {};
	out.hasName = [hasSessionName(sess("a", "named", "", "", 0) as AnyRec), hasSessionName(sess("b", "  ", "", "", 0) as AnyRec), hasSessionName(sess("c", null, "", "", 0) as AnyRec)];
	out.parse = [
		parseSearchQuery(""),
		parseSearchQuery("   "),
		parseSearchQuery("foo bar"),
		parseSearchQuery('foo "node cve" bar'),
		parseSearchQuery('unclosed "quote here'),
		parseSearchQuery("re:^Err(or)?$"),
		parseSearchQuery("re:"),
		parseSearchQuery("re:   "),
		parseSearchQuery("re:([bad"),
		parseSearchQuery("multi  spaces\ttabs"),
	].map((q: AnyRec) => ({ mode: q.mode, tokens: q.tokens, error: q.error ?? null, hasRegex: q.regex !== null }));
	const s1 = sess("1", "alpha session", "fix the parser bug", "C:\\work", 2000);
	const s2 = sess("2", null, "review PR node cve fix", "C:\\work", 3000);
	const s3 = sess("3", "beta notes", "random chatter about rust", "C:\\other", 1000);
	const sessions = [s1, s2, s3];
	out.match = [
		matchSession(s1 as AnyRec, parseSearchQuery("parser") as AnyRec),
		matchSession(s1 as AnyRec, parseSearchQuery('fix "parser bug"') as AnyRec),
		matchSession(s2 as AnyRec, parseSearchQuery("re:node cve") as AnyRec),
		matchSession(s2 as AnyRec, parseSearchQuery("re:zzz") as AnyRec),
		matchSession(s1 as AnyRec, parseSearchQuery("re:(") as AnyRec),
		matchSession(s1 as AnyRec, parseSearchQuery("") as AnyRec),
		matchSession(s3 as AnyRec, parseSearchQuery("alpha") as AnyRec),
	];
	out.filterRecent = [
		filterAndSortSessions(sessions as AnyRec[], "work", "recent"),
		filterAndSortSessions(sessions as AnyRec[], "", "recent", "named"),
		filterAndSortSessions(sessions as AnyRec[], "node cve", "recent"),
		filterAndSortSessions(sessions as AnyRec[], "re:(", "recent"),
	];
	out.filterRelevance = [
		filterAndSortSessions(sessions as AnyRec[], "fix", "relevance"),
		filterAndSortSessions(sessions as AnyRec[], "the", "relevance"),
	];
	out.filterThreaded = filterAndSortSessions(sessions as AnyRec[], "alpha", "threaded");
	return out;
});

export { SCENARIOS, logReset, truncateToWidth, getKeybindings };
