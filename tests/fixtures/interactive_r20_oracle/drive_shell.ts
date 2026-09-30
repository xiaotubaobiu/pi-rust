// r18 oracle driver — fake collaborators + scenario runner. Builds a fake
// `this` (all upstream private state fields at their upstream initial values
// + recording session/editor/ui stubs), spreads the verbatim extracted methods
// onto it, and drives scenario groups. Output: shell_oracle.json
// { scenarios: [{ name, log }] }. Every log entry is a JSON-serializable
// tuple; the Rust test must reproduce the exact sequence byte-for-byte.
import * as path from "node:path";
import { writeFileSync } from "node:fs";
import {
	LOG, logReset, rec, theme, Container, Text, Spacer, TruncatedText, DynamicBorder,
	Markdown, ExpandableText, makeComponentStubs, makeStatusIndicatorStubs,
	type RecComponent,
} from "./shell_deps.ts";
import { makeShell } from "./gen_shell.ts";

type AnyRec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fake collaborators
// ---------------------------------------------------------------------------
function fakeSessionManager(overrides: AnyRec = {}): AnyRec {
	return {
		getCwd: () => "/work/project",
		isPersisted: () => true,
		getSessionFile: () => "/home/u/.pi/agent/sessions/--work--project/abc123.jsonl",
		getSessionId: () => "abc123",
		getSessionDir: () => "/home/u/.pi/agent/sessions/--work--project",
		usesDefaultSessionDir: () => true,
		getSessionName: () => undefined,
		getEntries: () => [],
		buildContextEntries: () => [],
		getBranch: () => [],
		...overrides,
	};
}

function fakeSettingsManager(overrides: AnyRec = {}): AnyRec {
	const values: AnyRec = {
		getQuietStartup: false,
		getShowTerminalProgress: false,
		getDoubleEscapeAction: "fork",
		getHideThinkingBlock: false,
		getShowCacheMissNotices: false,
		getCollapseChangelog: true,
		getOutputPad: 1,
		getEditorPaddingX: 2,
		getAutocompleteMaxVisible: 6,
		getClearOnShrink: true,
		getShowHardwareCursor: false,
		getFullscreenScrollbar: false,
		getFullscreenCopyOnSelect: false,
		getFullscreenExitOutput: "transcript",
		getCodeBlockIndent: "  ",
		getTerminalCapabilityOverrides: {},
		getHttpIdleTimeoutMs: 30000,
		getMermaidRenderingMode: "render",
		getEnableSkillCommands: true,
		getLastChangelogVersion: "1.0.0",
		getShowImages: false,
		getImageWidthCells: 20,
		isProjectTrusted: true,
		getTheme: "dark",
		...overrides,
	};
	const out: AnyRec = {};
	for (const [key, value] of Object.entries(values)) {
		out[key] = typeof value === "function" ? value : () => value;
	}
	out.setLastChangelogVersion = (v: string) => rec("settings.setLastChangelogVersion", v);
	out.setHideThinkingBlock = (v: boolean) => rec("settings.setHideThinkingBlock", v);
	return out;
}

function fakeExtensionRunner(overrides: AnyRec = {}): AnyRec {
	return {
		getRegisteredCommands: () => [],
		getCommand: (name: string) =>
			name === "extcmd" || name === "extcmd2" ? { name, invocationName: name } : undefined,
		getCommandDiagnostics: () => [],
		getShortcutDiagnostics: () => [],
		getShortcuts: () => new Map(),
		getMarkdownTransformers: () => [{ tag: "extTransformer" }],
		getEntryRenderer: () => undefined,
		getMessageRenderer: () => undefined,
		getModelRegistry: () => ({}),
		...overrides,
	};
}

function fakeResourceLoader(overrides: AnyRec = {}): AnyRec {
	return {
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getExtensions: () => ({ extensions: [], errors: [] }),
		getSystemPromptSource: () => undefined,
		getAppendSystemPromptSources: () => [],
		getAgentsFiles: () => ({ agentsFiles: [] }),
		...overrides,
	};
}

const sessionBag: AnyRec = {};
function fakeSession(overrides: AnyRec = {}): AnyRec {
	return {
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		isIdle: true,
		thinkingLevel: "medium",
		retryAttempt: 0,
		pendingMessageCount: 0,
		autoCompactionEnabled: true,
		scopedModels: [],
		promptTemplates: [],
		state: { messages: [] },
		modelRuntime: {
			getAvailableSnapshot: () => [],
			getError: () => undefined,
		},
		getSteeringMessages: () => sessionBag.steering ?? [],
		getFollowUpMessages: () => sessionBag.followUp ?? [],
		clearQueue: () => {
			const cleared = { steering: sessionBag.steering ?? [], followUp: sessionBag.followUp ?? [] };
			rec("session.clearQueue", cleared);
			sessionBag.steering = [];
			sessionBag.followUp = [];
			return cleared;
		},
		prompt: async (...args: unknown[]) => {
			rec("session.prompt", ...args.map(describeArg));
		},
		steer: async (...args: unknown[]) => {
			rec("session.steer", ...args.map(describeArg));
		},
		followUp: async (...args: unknown[]) => {
			rec("session.followUp", ...args.map(describeArg));
		},
		abort: () => rec("session.abort"),
		abortBash: () => rec("session.abortBash"),
		abortCompaction: () => rec("session.abortCompaction"),
		abortRetry: () => rec("session.abortRetry"),
		cycleThinkingLevel: () => undefined,
		cycleModel: async () => undefined,
		getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high"],
		subscribe: () => {
			rec("session.subscribe");
			return () => rec("session.unsubscribe");
		},
		extensionRunner: fakeExtensionRunner(),
		sessionManager: fakeSessionManager(),
		settingsManager: fakeSettingsManager(),
		resourceLoader: fakeResourceLoader(),
		agent: { abort: () => rec("agent.abort"), signal: {} },
		bindExtensions: async (options: unknown) => {
			rec("session.bindExtensions", describeArg(options));
		},
		waitForIdle: async () => rec("session.waitForIdle"),
		navigateTree: async (...args: unknown[]) => {
			rec("session.navigateTree", ...args.map(describeArg));
			return { cancelled: false, editorText: undefined };
		},
		getToolDefinition: (name: string) => ({ name, builtIn: true }),
		getContextUsage: () => undefined,
		systemPrompt: "sys",
		isProjectTrusted: () => true,
		model: undefined,
		...overrides,
	} as AnyRec;
}

function fakeRuntimeHost(session: AnyRec): AnyRec {
	return {
		session,
		setBeforeSessionInvalidate: (cb: unknown) => rec("runtimeHost.setBeforeSessionInvalidate", typeof cb),
		setRebindSession: (cb: unknown) => rec("runtimeHost.setRebindSession", typeof cb),
		dispose: async () => rec("runtimeHost.dispose"),
		newSession: async (...args: unknown[]) => {
			rec("runtimeHost.newSession", ...args.map(describeArg));
			return { cancelled: false };
		},
		fork: async (...args: unknown[]) => {
			rec("runtimeHost.fork", ...args.map(describeArg));
			return { cancelled: false, selectedText: "picked" };
		},
	};
}

function fakeEditor(name = "defaultEditor"): AnyRec {
	const state: AnyRec = { text: "", history: [] as string[], borderColor: undefined };
	const editor: AnyRec = {
		_editorName: name,
		_state: state,
		onEscape: undefined,
		onCtrlD: undefined,
		onSubmit: undefined,
		onChange: undefined,
		onPasteImage: undefined,
		onExtensionShortcut: undefined,
		embedWorkingStatus: true,
		actionHandlers: new Map<string, () => void>(),
		getText: () => state.text,
		getExpandedText: () => state.text,
		setText: (t: string) => {
			rec(`${name}.setText`, t);
			state.text = t;
		},
		addToHistory: (t: string) => {
			rec(`${name}.addToHistory`, t);
			(state.history as string[]).push(t);
		},
		insertTextAtCursor: (t: string) => rec(`${name}.insertTextAtCursor`, t),
		handleInput: (t: string) => rec(`${name}.handleInput`, t),
		setWorkingStatusIndicator: (i: unknown) =>
			rec(`${name}.setWorkingStatusIndicator`, i === undefined ? "undefined" : describeArg(i)),
		setAutocompleteProvider: (p: unknown) =>
			rec(`${name}.setAutocompleteProvider`, p === undefined ? "undefined" : "provider"),
		setPaddingX: (n: number) => rec(`${name}.setPaddingX`, n),
		getPaddingX: () => 2,
		setAutocompleteMaxVisible: (n: number) => rec(`${name}.setAutocompleteMaxVisible`, n),
		getAutocompleteMaxVisible: () => 6,
		onAction: (action: string, handler: () => void) => {
			rec(`${name}.onAction`, action, "handler");
			(editor.actionHandlers as Map<string, () => void>).set(action, handler);
		},
	};
	Object.defineProperty(editor, "borderColor", {
		set(v: unknown) {
			state.borderColor =
				v && (typeof v === "object" || typeof v === "function") && "tag" in (v as AnyRec)
					? (v as { tag: string }).tag
					: v;
			rec(`${name}.borderColor`, state.borderColor);
		},
		get() {
			return state.borderColor;
		},
	});
	return editor;
}

function describeArg(value: unknown): unknown {
	if (typeof value === "function") {
		const tag = (value as { tag?: string }).tag;
		return tag ?? "function";
	}
	if (value instanceof Map) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of value.entries()) out[String(k)] = describeArg(v);
		return out;
	}
	if (value instanceof Container) {
		return { container: value.containerName, children: value.children.map(describeArg) };
	}
	if (Array.isArray(value)) return value.map(describeArg);
	if (value && typeof value === "object" && typeof (value as RecComponent).describe === "function") {
		return (value as { describe: () => unknown }).describe();
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as AnyRec)) {
			if (typeof v === "function") out[k] = "function";
			else if (k.startsWith("_")) out[k] = "<state>";
			else out[k] = describeArg(v);
		}
		return out;
	}
	return value === undefined ? "undefined" : value;
}

function fakeUi(): AnyRec {
	const terminal: AnyRec = {
		setProgress: (v: boolean) => rec("terminal.setProgress", v),
		setTitle: (t: string) => rec("terminal.setTitle", t),
		drainInput: async (ms: number) => rec("terminal.drainInput", ms),
	};
	const ui: AnyRec = {
		requestRender: (force?: boolean) => rec("ui.requestRender", ...(force === undefined ? [] : [force])),
		invalidate: () => rec("ui.invalidate"),
		renderNow: () => rec("ui.renderNow"),
		start: () => rec("ui.start"),
		stop: (opts?: unknown) => rec("ui.stop", ...(opts === undefined ? [] : [describeArg(opts)])),
		setFocus: (c: unknown) => rec("ui.setFocus", c === undefined ? "undefined" : describeArg(c)),
		setClearOnShrink: (v: boolean) => rec("ui.setClearOnShrink", v),
		getClearOnShrink: () => false,
		setShowHardwareCursor: (v: boolean) => rec("ui.setShowHardwareCursor", v),
		getShowHardwareCursor: () => false,
		terminal,
		onDebug: undefined as unknown,
		addInputListener: (h: unknown) => {
			rec("ui.addInputListener", typeof h);
			return () => rec("ui.removeInputListener");
		},
		hideOverlay: () => rec("ui.hideOverlay"),
		hasOverlayEntries: false,
		getFocusedComponent: () => undefined,
		addChild: (c: unknown) => rec("ui.addChild", describeArg(c)),
		clear: () => rec("ui.clear"),
		children: [] as unknown[],
		showOverlay: (c: unknown, o: unknown) => {
			rec("ui.showOverlay", describeArg(c), o === undefined ? "undefined" : describeArg(o));
			return { handle: 1 };
		},
	};
	ui.describe = () => ({ kind: "ui" });
	return ui;
}

function fakeFooter(): AnyRec {
	return {
		invalidate: () => rec("footer.invalidate"),
		dispose: () => rec("footer.dispose"),
		setSession: (s: unknown) => rec("footer.setSession", typeof s),
		setAutoCompactEnabled: (v: boolean) => rec("footer.setAutoCompactEnabled", v),
	};
}

function fakeFooterDataProvider(): AnyRec {
	return {
		setExtensionStatus: (k: string, t: string | undefined) =>
			rec("footerDataProvider.setExtensionStatus", k, t === undefined ? "undefined" : t),
		clearExtensionStatuses: () => rec("footerDataProvider.clearExtensionStatuses"),
		setAvailableProviderCount: (n: number) => rec("footerDataProvider.setAvailableProviderCount", n),
		onBranchChange: () => () => rec("footerDataProvider.offBranchChange"),
		setCwd: (c: string) => rec("footerDataProvider.setCwd", c),
		dispose: () => rec("footerDataProvider.dispose"),
	};
}

function fakeThemeController(): AnyRec {
	return {
		applyFromSettings: async () => rec("themeController.applyFromSettings"),
		disableAutoSync: () => rec("themeController.disableAutoSync"),
		rebindTui: () => rec("themeController.rebindTui"),
		setThemeName: () => ({ success: false, error: "not-under-test" }),
		setThemeInstance: () => ({ success: false, error: "not-under-test" }),
	};
}

function containerNamed(name: string): Container {
	const c = new Container();
	c.containerName = name;
	return c;
}

const extracted = makeShell(deps());
function deps(): AnyRec {
	return {
		theme,
		APP_NAME: "pi",
		APP_TITLE: "Pi",
		fs: {
			existsSync: (p: string) => String(p).endsWith("abc123.jsonl"),
			writeFileSync: (p: string, data: unknown) => rec("fs.writeFileSync", p, describeArg(data)),
		},
		os: { homedir: () => "/home/u", tmpdir: () => "/tmp" },
		path,
		Container,
		Text,
		Spacer,
		TruncatedText,
		DynamicBorder,
		Markdown,
		ExpandableText,
		...makeComponentStubs(LOG),
		...makeStatusIndicatorStubs(LOG),
		CombinedAutocompleteProvider: class {
			constructor(commands: unknown[], cwd: string, fdPath: string) {
				LOG.push([
					"new CombinedAutocompleteProvider",
					describeArg(commands),
					cwd,
					fdPath === undefined ? "undefined" : fdPath,
				]);
			}
		},
		withBuiltInRenderers: (name: string, def: unknown) => ({ name, def, via: "builtInRenderers" }),
		collectCacheMisses: () => new Map(),
		detectCacheMiss: () => undefined,
		CACHE_TTL_MS: 300000,
		getCapabilities: () => ({ hyperlinks: false }),
		hyperlink: (text: string, url: string) => `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`,
		spawn: () => {
			throw new Error("spawn not expected in scenarios");
		},
		parseGitUrl: (source: string) => {
			const m = String(source).match(/^git:\/\/([^/]+)\/(.+)$/);
			return m ? { host: m[1], path: m[2], ref: undefined } : null;
		},
		BUILTIN_SLASH_COMMANDS: [
			{ name: "model", description: "Switch AI model", argumentHint: "[term]" },
			{ name: "thinking", description: "Set thinking level" },
			{ name: "settings", description: "Open settings" },
		],
		fuzzyFilter: (items: unknown[], prefix: string, getSearchText: (x: unknown) => string) =>
			items.filter((i) => getSearchText(i).toLowerCase().includes(prefix.toLowerCase())),
		getEditorTheme: () => ({ tag: "editorTheme" }),
		hasTrustRequiringProjectResources: () => false,
		CONFIG_DIR_NAME: ".pi",
		setRegisteredThemes: (t: unknown) => rec("setRegisteredThemes", describeArg(t)),
		setCapabilityOverrides: (o: unknown) => rec("setCapabilityOverrides", describeArg(o)),
		configureHttpDispatcher: (ms: unknown) => rec("configureHttpDispatcher", ms === undefined ? "undefined" : ms),
		getMarkdownTheme: () => ({ tag: "markdownTheme" }),
		getChangelogPath: () => "/changelog.md",
		parseChangelog: () => [{ version: "1.2.0", content: "old" }, { version: "1.1.0", content: "older" }],
		getNewEntries: (entries: Array<{ version: string }>, last: string) =>
			entries.filter((e) => e.version > last),
		normalizeChangelogLinks: (content: string) => content,
		isInstallTelemetryEnabled: () => false,
		getPiUserAgent: (v: string) => `pi/${v}`,
		DefaultPackageManager: class {
			constructor(opts: unknown) {
				LOG.push(["new DefaultPackageManager", describeArg(opts)]);
			}
			async checkForAvailableUpdates() {
				return [{ displayName: "pkg-a" }];
			}
		},
		getCwdRelativePath: (p: string, cwd: string) =>
			String(p).startsWith(cwd) ? String(p).slice(cwd.length + 1) : undefined,
		readClipboardText: async () => "clip text",
		readClipboardImage: async () => undefined,
		extensionForImageMimeType: () => undefined,
		editInExternalEditor: async (opts: unknown) => {
			rec("editInExternalEditor", describeArg(opts));
			return { status: "complete", content: "edited" };
		},
		setRegisteredThemesUnused: undefined,
		getKeybindings: () => ({ getKeys: (k: string) => ["ctrl+c"] }),
		crypto: { randomUUID: () => "uuid-1234" },
		chalk: { dim: (s: string) => `[2m${s}[22m` },
		VERSION: "1.2.3",
		// upstream static references: InteractiveMode.MAX_WIDGET_LINES and
		// InteractiveMode.countDroppedThinkingBlocks
		InteractiveMode: {
			MAX_WIDGET_LINES: 10,
			countDroppedThinkingBlocks: (...args: unknown[]) =>
				(extracted as AnyRec).countDroppedThinkingBlocks(...(args as [never])),
		},
		getShowHardwareCursor: () => false,
		createInteractiveTui: (opts: unknown) => {
			rec("createInteractiveTui", describeArg(opts));
			return Object.assign(fakeUi(), { mode: (opts as AnyRec).tuiMode });
		},
		getAgentDir: () => "/home/u/.pi/agent",
		TuiLayouts: { isViewportTUI: () => false },
		TuiMainScreen: class {},
		TuiAltScreen: class {},
	};
}

function makeThis(overrides: AnyRec = {}): AnyRec {
	const session = overrides.session ?? fakeSession();
	const ui = fakeUi();
	const defaultEditor = overrides.defaultEditor ?? fakeEditor("defaultEditor");
	const editor = overrides.editor ?? defaultEditor;
	const shell: AnyRec = {
		mainScreenRenderState: undefined,
		loadedResourcesContainer: containerNamed("loadedResources"),
		chatContainer: containerNamed("chat"),
		documentContainer: containerNamed("document"),
		transcriptScrollView: undefined,
		fullscreenLayoutRoot: undefined,
		pendingMessagesContainer: containerNamed("pendingMessages"),
		statusContainer: containerNamed("status"),
		defaultEditor,
		editor,
		editorComponentFactory: undefined,
		autocompleteProvider: undefined,
		autocompleteProviderWrappers: [],
		fdPath: undefined,
		editorContainer: containerNamed("editorContainer"),
		activeSelectorToken: undefined,
		activeSelectorDispose: undefined,
		footer: fakeFooter(),
		footerContainer: containerNamed("footer"),
		footerDataProvider: fakeFooterDataProvider(),
		keybindings: {
			getKeys: (a: string) => (a === "app.model.cycleForward" ? ["ctrl+right"] : ["ctrl+x"]),
			getEffectiveConfig: () => ({}),
		},
		version: "1.2.3",
		isInitialized: true,
		onInputCallback: undefined as unknown,
		pendingUserInputs: [] as string[],
		activeStatusIndicator: undefined,
		activeWorkingIndicatorEmbedded: false,
		idleStatus: { kind: "idle", describe: () => ({ kind: "IdleStatus" }) },
		workingMessage: undefined,
		workingVisible: true,
		workingIndicatorOptions: undefined,
		defaultWorkingMessage: "Working",
		defaultHiddenThinkingLabel: "Thinking...",
		hiddenThinkingLabel: "Thinking...",
		lastSigintTime: 0,
		lastEscapeTime: 0,
		changelogMarkdown: undefined,
		startupNoticesShown: false,
		anthropicSubscriptionWarningShown: false,
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		managedToolStatusStarted: false,
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map<string, RecComponent>(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		outputPad: 1,
		mermaidMarkdownTransformer: { tag: "mermaid" },
		skillCommands: new Map<string, string>(),
		unsubscribe: undefined as unknown,
		signalCleanupHandlers: [] as Array<() => void>,
		isBashMode: false,
		bashComponent: undefined,
		pendingBashComponents: [] as RecComponent[],
		autoCompactionEscapeHandler: undefined as unknown,
		retryEscapeHandler: undefined as unknown,
		compactionQueuedMessages: [] as Array<{ text: string; mode: string }>,
		shutdownRequested: false,
		isShuttingDown: false,
		extensionSelector: undefined,
		extensionInput: undefined,
		extensionEditor: undefined,
		extensionTerminalInputSubscriptions: new Set<AnyRec>(),
		extensionWidgetsAbove: new Map<string, RecComponent>(),
		extensionWidgetsBelow: new Map<string, RecComponent>(),
		widgetContainerAbove: containerNamed("widgetsAbove"),
		widgetContainerBelow: containerNamed("widgetsBelow"),
		customFooter: undefined,
		headerContainer: containerNamed("header"),
		builtInHeader: undefined,
		customHeader: undefined,
		autoTrustOnReloadCwd: undefined,
		themeController: fakeThemeController(),
		options: { tuiMode: "regular", verbose: false, startupDiagnostics: [] },
		renderer: Object.assign(fakeUi(), { mode: "regular" }),
		ui,
		session,
		runtimeHost: fakeRuntimeHost(session),
		settingsManager: (session as AnyRec).settingsManager,
		sessionManager: (session as AnyRec).sessionManager,
		...overrides,
	};
	// `agent` mirrors the (possibly overridden) session, like the upstream getter
	(shell as AnyRec).agent = ((shell as AnyRec).session as AnyRec).agent;
	for (const [k, v] of Object.entries(extracted)) {
		(shell as AnyRec)[k] = typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(shell) : v;
	}
	return shell;
}

// Recorder stubs for the lower-half command handlers (r19): the submit-ladder
// and key-ring scenarios record WHICH handler fires with WHICH args; the
// handler bodies themselves are out of the r18 scope.
const COMMAND_HANDLERS = [
	"showSettingsSelector", "showModelsSelector", "handleModelCommand",
	"handleThinkingCommand", "handleExportCommand", "handleImportCommand",
	"handleShareCommand", "handleCopyCommand", "handleNameCommand",
	"handleSessionCommand", "handleChangelogCommand", "handleHotkeysCommand",
	"showUserMessageSelector", "handleCloneCommand", "showTreeSelector",
	"showTrustSelector", "handleLoginCommand", "showOAuthSelector",
	"handleClearCommand", "handleCompactCommand", "handleReloadCommand",
	"handleDebugCommand", "handleArminSaysHi", "handleDementedDelves",
	"showSessionSelector", "handleBashCommand", "showModelSelector",
	"maybeWarnAboutAnthropicSubscriptionAuth", "showSettingsSelectorUnused",
	"init",
];
function withCommandStubs(overrides: AnyRec = {}): AnyRec {
	const stubs: AnyRec = {};
	for (const name of COMMAND_HANDLERS) {
		stubs[name] = async (...args: unknown[]) => {
			rec(`cmd.${name}`, ...args.map((a) => (a === undefined ? "undefined" : describeArg(a))));
		};
	}
	return { ...stubs, ...overrides };
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------
type Scenario = { name: string; run: (t: AnyRec) => unknown | Promise<unknown> };
const scenarios: Scenario[] = [];
function scenario(name: string, run: (t: AnyRec) => unknown | Promise<unknown>): void {
	scenarios.push({ name, run });
}

const scenariosModule = await import("./shell_scenarios.ts");
scenariosModule.register(scenario, {
	makeThis,
	withCommandStubs,
	fakeEditor,
	sessionBag,
	describeArg,
	theme,
	Container,
	Text,
	Spacer,
	TruncatedText,
	DynamicBorder,
	Markdown,
	ExpandableText,
});

const results: Array<{ name: string; log: unknown[] }> = [];
for (const s of scenarios) {
	logReset();
	// fresh queue state per scenario
	sessionBag.steering = [];
	sessionBag.followUp = [];
	const RealDate = Date;
	const FIXED_MS = 1790604147438;
	const FixedDate: any = class extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) super(FIXED_MS);
			else super(...(args as []));
		}
		static now() {
			return FIXED_MS;
		}
	};
	(globalThis as AnyRec).Date = FixedDate;
	try {
		await s.run(makeThis());
	} catch (error) {
		LOG.push(["scenario.error", String((error as Error).message), (error as Error).stack ?? ""]);
	} finally {
		(globalThis as AnyRec).Date = RealDate;
	}
	results.push({ name: s.name, log: LOG.map((entry) => JSON.parse(JSON.stringify(entry))) });
}

writeFileSync(new URL("./shell_oracle.json", import.meta.url), `${JSON.stringify({ scenarios: results }, null, "\t")}\n`);
console.log(`shell_oracle.json: ${results.length} scenarios, ${results.reduce((n, r) => n + r.log.length, 0)} log entries`);
