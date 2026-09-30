// r20 oracle driver — lower half (selectors / command handlers / exits).
// Same architecture as drive_shell.ts: a fake `this` (upstream private state
// at initial values + recording collaborators), verbatim extracted bodies from
// gen_lower.ts spread onto it, scenario groups drive them, and every log entry
// (JSON tuple) must be reproduced byte-for-byte by the Rust shell.
import * as path from "node:path";
import { writeFileSync } from "node:fs";
import {
	LOG, logReset, rec, theme, Container, Text, Spacer, TruncatedText, DynamicBorder,
	Markdown, ExpandableText, makeComponentStubs, makeStatusIndicatorStubs,
	RecComponent, recordingClass,
	type AnyRec,
} from "./shell_deps.ts";
import { makeShell } from "./gen_lower.ts";

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
		getTree: () => [],
		getLeafId: () => "leaf-1",
		appendLabelChange: (...args: unknown[]) => rec("sessionManager.appendLabelChange", ...args.map(describeArg)),
		appendSessionInfo: (...args: unknown[]) => rec("sessionManager.appendSessionInfo", ...args.map(describeArg)),
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
		getDefaultProvider: "anthropic",
		getDefaultModel: "claude-opus-4-8",
		getDefaultThinkingLevel: undefined,
		getAllModelThinkingLevels: () => ({}),
		getEnabledModels: undefined,
		getBranchSummarySkipPrompt: false,
		getExternalEditorCommand: "vim",
		getWarnings: () => ({ anthropicExtraUsage: true }),
		getImageAutoResize: true,
		getBlockImages: false,
		getTransport: "auto",
		getDefaultProjectTrust: "ask",
		getTreeFilterMode: "all",
		getEnableInstallTelemetry: false,
		...overrides,
	};
	const out: AnyRec = {};
	for (const [key, value] of Object.entries(values)) {
		out[key] = typeof value === "function" ? value : () => value;
	}
	const setter = (name: string) => (v: unknown) => rec(`settings.${name}`, describeArg(v));
	for (const name of [
		"setLastChangelogVersion", "setHideThinkingBlock", "setShowImages", "setImageWidthCells",
		"setImageAutoResize", "setBlockImages", "setEnableSkillCommands", "setTransport",
		"setHttpIdleTimeoutMs", "setModelThinkingLevel", "removeModelThinkingLevel", "setTheme",
		"setMermaidRenderingMode", "setShowCacheMissNotices", "setCollapseChangelog",
		"setEnableInstallTelemetry", "setQuietStartup", "setDefaultProjectTrust",
		"setDoubleEscapeAction", "setTreeFilterMode", "setShowHardwareCursor",
		"setEditorPaddingX", "setOutputPad", "setAutocompleteMaxVisible", "setClearOnShrink",
		"setShowTerminalProgress", "setTuiMode", "setFullscreenExitOutput",
		"setFullscreenScrollbar", "setFullscreenCopyOnSelect", "setWarnings",
		"setEnabledModels",
	]) {
		out[name] = setter(name);
	}
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
		emitUserBash: async (event: unknown) => {
			rec("extensionRunner.emitUserBash", describeArg(event));
			return undefined;
		},
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
function fakeModel(provider: string, id: string, name?: string): AnyRec {
	return { provider, id, name, reasoning: false };
}
function fakeModelRuntime(overrides: AnyRec = {}): AnyRec {
	const models: AnyRec[] = [fakeModel("anthropic", "claude-opus-4-8", "Claude Opus 4.8"), fakeModel("openai", "gpt-5.5", "GPT-5.5")];
	return {
		getAvailableSnapshot: () => models.map((m) => ({ ...m })),
		getError: () => undefined,
		getProviders: () => [
			{ id: "anthropic", name: "Anthropic", auth: { oauth: "claude", apiKey: true } },
			{ id: "openai", name: "OpenAI", auth: { apiKey: true } },
		],
		getProviderAuthStatus: (providerId: string) =>
			providerId === "anthropic"
				? { configured: true, label: "subscription", source: "auth.json" }
				: { configured: false, label: undefined, source: undefined },
		isUsingOAuth: (providerId: string) => providerId === "anthropic",
		checkAuth: async (providerId: string) => {
			rec("modelRuntime.checkAuth", providerId);
			return providerId === "anthropic" ? { type: "api_key" } : undefined;
		},
		getAuth: async (providerId: string) => {
			rec("modelRuntime.getAuth", providerId);
			return { auth: { apiKey: "sk-ant-oat-xyz" } };
		},
		listCredentials: async () => {
			rec("modelRuntime.listCredentials");
			return [{ providerId: "anthropic", type: "oauth" }];
		},
		logout: async (...args: unknown[]) => {
			rec("modelRuntime.logout", ...args.map(describeArg));
			return { ok: true };
		},
		login: async (providerId: string, method: string, opts: unknown) => {
			rec("modelRuntime.login", providerId, method, describeArg(opts));
			return { success: true };
		},
		refresh: async (...args: unknown[]) => {
			rec("modelRuntime.refresh", ...args.map(describeArg));
			return { aborted: false, errors: new Map() };
		},
		...overrides,
	};
}

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
		steeringMode: "interrupt",
		followUpMode: "queue",
		scopedModels: [],
		promptTemplates: [],
		state: { messages: [] },
		messages: [],
		modelRuntime: fakeModelRuntime(),
		model: undefined,
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
		abortBranchSummary: () => rec("session.abortBranchSummary"),
		cycleThinkingLevel: () => undefined,
		cycleModel: async () => undefined,
		getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high"],
		setThinkingLevel: (...args: unknown[]) => rec("session.setThinkingLevel", ...args.map(describeArg)),
		setModel: async (...args: unknown[]) => rec("session.setModel", ...args.map(describeArg)),
		setAutoCompactionEnabled: (v: boolean) => rec("session.setAutoCompactionEnabled", v),
		setSteeringMode: (m: unknown) => rec("session.setSteeringMode", describeArg(m)),
		setFollowUpMode: (m: unknown) => rec("session.setFollowUpMode", describeArg(m)),
		setScopedModels: (...args: unknown[]) => rec("session.setScopedModels", ...args.map(describeArg)),
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
		reload: async (opts: unknown) => {
			rec("session.reload", describeArg(opts));
			const beforeSessionStart = (opts as AnyRec)?.beforeSessionStart as (() => void) | undefined;
			beforeSessionStart?.();
			return { ok: true };
		},
		compact: async (...args: unknown[]) => {
			rec("session.compact", ...args.map(describeArg));
			return { summary: "s", tokensBefore: 1 };
		},
		executeBash: async (command: string, onChunk: unknown, opts: unknown) => {
			rec("session.executeBash", command, typeof onChunk, describeArg(opts));
			return { exitCode: 0, cancelled: false, output: "out", truncated: false };
		},
		recordBashResult: (...args: unknown[]) => rec("session.recordBashResult", ...args.map(describeArg)),
		getUserMessagesForForking: () => [],
		getSessionStats: () => ({
			sessionFile: "/s.jsonl",
			sessionId: "abc123",
			totalMessages: 4,
			userMessages: 2,
			assistantMessages: 1,
			toolCalls: 1,
			toolResults: 1,
			tokens: { input: 1200, output: 34, cacheRead: 0, cacheWrite: 100, total: 1334 },
			cost: 0.0123,
		}),
		getLastAssistantText: () => "last assistant text",
		setSessionName: (name: string) => rec("session.setSessionName", name),
		getToolDefinition: (name: string) => ({ name, builtIn: true }),
		getContextUsage: () => undefined,
		systemPrompt: "sys",
		isProjectTrusted: () => true,
		...overrides,
	} as AnyRec;
}

function fakeRuntimeHost(session: AnyRec): AnyRec {
	return {
		session,
		agentDir: "/home/u/.pi/agent",
		services: { agentDir: "/home/u/.pi/agent" },
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
		switchSession: async (...args: unknown[]) => {
			rec("runtimeHost.switchSession", ...args.map(describeArg));
			return { cancelled: false };
		},
		importFromJsonl: async (...args: unknown[]) => {
			rec("runtimeHost.importFromJsonl", ...args.map(describeArg));
			return { cancelled: false };
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
	if (value instanceof Set) {
		return [...value].map(describeArg);
	}
	if (value instanceof Container) {
		return { container: value.containerName, children: value.children.map(describeArg) };
	}
	if (Array.isArray(value)) return value.map(describeArg);
	if (value instanceof Error) return { error: value.message };
	if (value && typeof value === "object" && typeof (value as RecComponent).describe === "function") {
		return (value as { describe: () => unknown }).describe();
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as AnyRec)) {
			if (typeof v === "function") out[k] = (v as { tag?: string }).tag ?? "function";
			else if (k.startsWith("_")) out[k] = "<state>";
			else out[k] = describeArg(v);
		}
		return out;
	}
	return value === undefined ? "undefined" : value;
}

function fakeUi(): AnyRec {
	const terminal: AnyRec = {
		columns: 80,
		rows: 24,
		setProgress: (v: boolean) => rec("terminal.setProgress", v),
		setTitle: (t: string) => rec("terminal.setTitle", t),
		drainInput: async (ms: number) => rec("terminal.drainInput", ms),
	};
	const ui: AnyRec = {
		mode: "regular",
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
		getCopyOnSelect: () => false,
		hasActiveSelection: () => false,
		copyActiveSelectionToClipboard: async () => rec("ui.copyActiveSelectionToClipboard"),
		flash: (t: string) => rec("ui.flash", t),
		terminal,
		onDebug: undefined as unknown,
		addInputListener: (h: unknown) => {
			rec("ui.addInputListener", typeof h);
			return () => rec("ui.removeInputListener");
		},
		hideOverlay: () => rec("ui.hideOverlay"),
		showOverlay: (c: unknown, o: unknown) => {
			rec("ui.showOverlay", describeArg(c), o === undefined ? "undefined" : describeArg(o));
			return { handle: 1 };
		},
		hasOverlayEntries: false,
		getFocusedComponent: () => undefined,
		addChild: (c: unknown) => rec("ui.addChild", describeArg(c)),
		clear: () => rec("ui.clear"),
		children: [] as unknown[],
		render: (_width: number) => ["line-one", "line-two"],
		captureRenderState: () => ({ state: true }),
		restoreRenderState: (s: unknown) => rec("ui.restoreRenderState", describeArg(s)),
		setLayoutRoot: (r: unknown) => rec("ui.setLayoutRoot", r === undefined ? "undefined" : "root"),
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
		getThemeSelection: () => "dark",
		getTerminalTheme: () => "dark",
		preview: (name: string) => rec("themeController.preview", name),
		setThemeName: (name: string) => {
			rec("themeController.setThemeName", name);
			return { success: true };
		},
		setThemeInstance: () => ({ success: false, error: "not-under-test" }),
	};
}

function containerNamed(name: string): Container {
	const c = new Container();
	c.containerName = name;
	return c;
}

function selectorStub(kind: string, extra?: (self: AnyRec) => void) {
	return simple(kind);
}
// recordingClass plus raw-arg retention (scenarios drive the ctor callbacks)
function simple(kind: string): unknown {
	const base = recordingClass(kind, LOG, [
		"dispose", "updateModels", "setRefreshStatus", "invalidate", "setMessage",
		"setIndicator", "hasContent",
	]) as unknown;
	const Cls = base as { new (...args: unknown[]): unknown };
	return class extends Cls {
		constructor(...args: unknown[]) {
			super(...args);
			(this as AnyRec).args = args;
		}
	};
}

function makeSelectorDeps(): AnyRec {
	const settingsSelector: AnyRec = class {
		constructor(config: unknown, callbacks: unknown) {
			LOG.push(["new SettingsSelectorComponent", describeArg(config), describeArg(callbacks)]);
			const self = this as AnyRec;
			self.args = [config, callbacks];
			self.describe = () => ({ kind: "SettingsSelectorComponent" });
			self.getSettingsList = () => ({
				updateValue: (...args: unknown[]) => rec("SettingsSelectorList.updateValue", ...args.map(describeArg)),
			});
			return new Proxy(self, {
				get(target, prop) {
					if (prop in target) return (target as AnyRec)[prop];
					return undefined;
				},
			});
		}
	};
	const userMessageSelector: AnyRec = class {
		constructor(...args: unknown[]) {
			LOG.push(["new UserMessageSelectorComponent", ...args.map(describeArg)]);
			const self = this as AnyRec;
			self.args = args;
			self.describe = () => ({ kind: "UserMessageSelectorComponent" });
			self.getMessageList = () => ({ describe: () => ({ kind: "MessageList" }) });
			return new Proxy(self, {
				get(target, prop) {
					if (prop in target) return (target as AnyRec)[prop];
					return undefined;
				},
			});
		}
	};
	const loginDialog: AnyRec = class {
		constructor(...args: unknown[]) {
			LOG.push(["new LoginDialogComponent", ...args.map(describeArg)]);
			const self = this as AnyRec;
			self.args = args;
			self.describe = () => ({ kind: "LoginDialogComponent" });
			self.signal = { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined };
			for (const m of [
				"showAuth", "showDeviceCode", "showManualInput", "showPrompt", "showDetails",
				"showInfo", "showWaiting", "showProgress",
			]) {
				(self as AnyRec)[m] = (...callArgs: unknown[]) => {
					LOG.push([`LoginDialogComponent.${m}`, ...callArgs.map(describeArg)]);
				};
			}
			self.showManualInputResolving = (_m: string) => {
				LOG.push(["LoginDialogComponent.showManualInput", _m]);
				return Promise.resolve("123456");
			};
			return new Proxy(self, {
				get(target, prop) {
					if (prop in target) return (target as AnyRec)[prop];
					return undefined;
				},
			});
		}
	};
	return {
		SettingsSelectorComponent: settingsSelector,
		ThinkingSelectorComponent: simple("ThinkingSelectorComponent"),
		ModelSelectorComponent: simple("ModelSelectorComponent"),
		ScopedModelsSelectorComponent: simple("ScopedModelsSelectorComponent"),
		UserMessageSelectorComponent: userMessageSelector,
		TreeSelectorComponent: simple("TreeSelectorComponent"),
		SessionSelectorComponent: simple("SessionSelectorComponent"),
		TrustSelectorComponent: simple("TrustSelectorComponent"),
		LoginDialogComponent: loginDialog,
		OAuthSelectorComponent: simple("OAuthSelectorComponent"),
		ExtensionSelectorComponent: simple("ExtensionSelectorComponent"),
		ExtensionInputComponent: simple("ExtensionInputComponent"),
		ExtensionEditorComponent: simple("ExtensionEditorComponent"),
		stopThemeWatcher: () => rec("stopThemeWatcher"),
	};
}

const DEPS = deps();
const extracted = makeShell(DEPS);
function deps(): AnyRec {
	return {
		theme,
		APP_NAME: "pi",
		APP_TITLE: "Pi",
		fs: {
			existsSync: (p: string) => String(p).endsWith("abc123.jsonl"),
			writeFileSync: (p: string, data: unknown) => rec("fs.writeFileSync", p, describeArg(data)),
			mkdirSync: (p: string) => rec("fs.mkdirSync", p),
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
		...makeSelectorDeps(),
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
		getKeybindings: () => ({ getKeys: (k: string) => ["ctrl+c"] }),
		crypto: { randomUUID: () => "uuid-1234" },
		chalk: { dim: (s: string) => `[2m${s}[22m` },
		VERSION: "1.2.3",
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
		// lower-half deps
		ProjectTrustStore: class {
			constructor(agentDir: string) {
				LOG.push(["new ProjectTrustStore", agentDir]);
			}
			get(cwd: string) {
				rec("trustStore.get", cwd);
				return null;
			}
			getEntry(cwd: string) {
				rec("trustStore.getEntry", cwd);
				return { trusted: true, scope: "project" };
			}
			set(cwd: string, trusted: boolean) {
				rec("trustStore.set", cwd, trusted);
			}
			setMany(updates: unknown) {
				rec("trustStore.setMany", describeArg(updates));
			}
		},
		shareSession: async (opts: unknown) => {
			rec("shareSession", describeArg(opts));
			return { url: "https://share.example/s/abcd1234" };
		},
		copyToClipboard: async (text: string) => {
			rec("copyToClipboard", text);
		},
		getAuthPath: () => "/home/u/.pi/agent/auth.json",
		getDocsPath: () => "/docs",
		defaultModelPerProvider: { anthropic: "claude-opus-4-8", radius: "balanced" },
		hasDefaultModelProvider: (providerId: string) => providerId === "anthropic" || providerId === "radius",
		resolveModelScopeFromModels: (patterns: string[], models: AnyRec[]) => {
			const scopedModels: unknown[] = [];
			const diagnostics: unknown[] = [];
			for (const pattern of patterns) {
				const match = models.find((m) => `${m.provider}/${m.id}` === pattern || m.id === pattern);
				if (match) scopedModels.push({ model: match, thinkingLevel: undefined });
				else diagnostics.push({ code: "no-match", pattern });
			}
			return { scopedModels, diagnostics };
		},
		findExactModelReferenceMatch: (reference: string, models: AnyRec[]) => {
			const normalized = String(reference).trim().toLowerCase();
			const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === normalized);
			if (canonical.length === 1) return canonical[0];
			const byId = models.filter((m) => String(m.id).toLowerCase() === normalized);
			return byId.length === 1 ? byId[0] : undefined;
		},
		refreshModelCatalogs: async (_runtime: unknown, signal: unknown) => {
			rec("refreshModelCatalogs", signal === undefined ? "undefined" : "signal");
			return { aborted: false, errors: new Map() };
		},
		getAvailableThemes: () => ["dark", "light"],
		getAvailableThemesWithPaths: () => [{ name: "dark" }, { name: "light" }],
		getThemeByName: (name: string) => (name === "dark" || name === "light" ? { name } : undefined),
		DEFAULT_THINKING_LEVEL: "medium",
		THINKING_LEVEL_OPTIONS: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		visibleWidth: (s: string) => String(s).length,
		getDebugLogPath: () => "/tmp/pi-debug.log",
		ArminComponent: selectorStub("ArminComponent"),
		EarendilAnnouncementComponent: selectorStub("EarendilAnnouncementComponent"),
		DaxnutsComponent: selectorStub("DaxnutsComponent"),
		computeCacheWaste: () => ({ missedTokens: 25000, missedCost: 0.02, missCount: 2 }),
		getUsageCostBreakdown: () => [
			{ key: "anthropic/claude-opus-4-8", cost: 0.01, tokens: 1000 },
			{ key: "openai/gpt-5.5", cost: 0.0023, tokens: 334 },
		],
		CredentialSynchronizationError: class extends Error {
			constructor(message: string) {
				super(message);
				this.name = "CredentialSynchronizationError";
			}
		},
		MissingSessionCwdError: class extends Error {
			issue: unknown;
			constructor(issue: unknown) {
				super("missing session cwd");
				this.issue = issue;
			}
		},
		SessionImportFileNotFoundError: class extends Error {},
		killTrackedDetachedChildren: () => rec("killTrackedDetachedChildren"),
		formatHttpIdleTimeoutMs: (ms: unknown) => (ms === undefined ? "default" : `${Number(ms) / 1000}s`),
		formatMissingSessionCwdPrompt: (issue: unknown) => `Session cwd missing: ${describeArg(issue)}`,
		ThemeController: class {},
		matchesKey: (data: string, key: string) => data === key,
		SessionManager: class {
			static list(...args: unknown[]) {
				LOG.push(["SessionManager.list", ...args.map(describeArg)]);
				return [{ path: "/s/a.jsonl", name: "a" }];
			}
			static listAll(...args: unknown[]) {
				LOG.push(["SessionManager.listAll", ...args.map(describeArg)]);
				return [{ path: "/s/a.jsonl", name: "a" }];
			}
			static open(...args: unknown[]) {
				LOG.push(["SessionManager.open", ...args.map(describeArg)]);
				return { appendSessionInfo: (n: unknown) => rec("sessionManager.appendSessionInfo", describeArg(n)) };
			}
		},
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
			reload: () => rec("keybindings.reload"),
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

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------
type Scenario = { name: string; run: (t: AnyRec) => unknown | Promise<unknown> };
const scenarios: Scenario[] = [];
function scenario(name: string, run: (t: AnyRec) => unknown | Promise<unknown>): void {
	scenarios.push({ name, run });
}

const scenariosModule = await import("./scenarios_lower.ts");
scenariosModule.register(scenario, {
	makeThis,
	fakeEditor,
	fakeSession,
	fakeSettingsManager,
	fakeSessionManager,
	fakeModelRuntime,
	fakeExtensionRunner,
	fakeResourceLoader,
	fakeUi,
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
	containerNamed,
	LOG,
	rec,
	DEPS,
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
	const realExit = process.exit;
	(process as AnyRec).exit = ((code?: number) => {
		rec("process.exit", code === undefined ? "undefined" : code);
		throw new Error(`process.exit(${code})`);
	}) as typeof process.exit;
	try {
		await s.run(makeThis());
		// drain microtasks + resolved timers so voided promise chains land
		// inside THIS scenario's log segment
		for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	} catch (error) {
		LOG.push(["scenario.error", String((error as Error).message), (error as Error).stack ?? ""]);
		if (process.env.PROBE) {
			const kids = ((arguments as unknown as AnyRec), undefined);
			void kids;
		}
	} finally {
		(process as AnyRec).exit = realExit;
		(globalThis as AnyRec).Date = RealDate;
	}
	results.push({ name: s.name, log: LOG.map((entry) => JSON.parse(JSON.stringify(entry))) });
}

writeFileSync(new URL("./lower_oracle.json", import.meta.url), `${JSON.stringify({ scenarios: results }, null, "\t")}\n`);
console.log(`lower_oracle.json: ${results.length} scenarios, ${results.reduce((n, r) => n + r.log.length, 0)} log entries`);
void path;
