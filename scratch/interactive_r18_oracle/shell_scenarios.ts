// r18 oracle scenarios. register() is called by drive_shell.ts.
import { rec } from "./shell_deps.ts";

type AnyRec = Record<string, unknown>;
type ScenarioFn = (name: string, run: (t: AnyRec) => unknown | Promise<unknown>) => void;

export function register(
	scenario: ScenarioFn,
	ctx: {
		makeThis: (overrides?: AnyRec) => AnyRec;
		withCommandStubs: (overrides?: AnyRec) => AnyRec;
		fakeEditor: (name?: string) => AnyRec;
		sessionBag: AnyRec;
		describeArg: (v: unknown) => unknown;
		theme: AnyRec;
		Container: new (...a: unknown[]) => AnyRec;
		Text: new (...a: unknown[]) => AnyRec;
		Spacer: new (...a: unknown[]) => AnyRec;
		TruncatedText: new (...a: unknown[]) => AnyRec;
		DynamicBorder: new (...a: unknown[]) => AnyRec;
		Markdown: new (...a: unknown[]) => AnyRec;
		ExpandableText: new (...a: unknown[]) => AnyRec;
	},
): number {
	const { makeThis, withCommandStubs, fakeEditor, sessionBag, describeArg, theme, Container, Text, Spacer, TruncatedText, DynamicBorder, Markdown, ExpandableText } = ctx;

	// -----------------------------------------------------------------------
	// S1: submit ladder (setupEditorSubmitHandler -> onSubmit)
	// -----------------------------------------------------------------------
	function submit(t: AnyRec, text: string): Promise<void> {
		const handler = (t.defaultEditor as AnyRec).onSubmit as (text: string) => Promise<void>;
		if (!handler) throw new Error("onSubmit not registered");
		return handler.call(t, text);
	}
	function registeredShell(overrides: AnyRec = {}): AnyRec {
		const t = makeThis(withCommandStubs(overrides));
		(t.setupEditorSubmitHandler as () => void)();
		return t;
	}

	scenario("submit.empty", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "   ");
	});
	scenario("submit.settings", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "/settings");
	});
	scenario("submit.model.arg", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "/model gpt-5");
	});
	scenario("submit.model.bare", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "/model");
	});
	scenario("submit.thinking.arg", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "/thinking high");
	});
	scenario("submit.bash.normal", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "!ls -la");
	});
	scenario("submit.bash.excluded", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "!!rm -rf /tmp/x");
	});
	scenario("submit.bash.bang-only-falls-through", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "!");
	});
	scenario("submit.bash.conflict", (t0) => {
		const t = registeredShell({ session: fakeSessionOf(t0, { isBashRunning: true }) });
		return submit(t, "!echo hi");
	});
	scenario("submit.normal.idle", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "hello world");
	});
	scenario("submit.normal.idle.no-callback-queues", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "queued for later");
	});
	scenario("submit.streaming.steer", (t0) => {
		const t = registeredShell({ session: fakeSessionOf(t0, { isStreaming: true }) });
		return submit(t, "mid-stream input");
	});
	scenario("submit.compacting.queues", (t0) => {
		const t = registeredShell({ session: fakeSessionOf(t0, { isCompacting: true }) });
		return submit(t, "hold this");
	});
	scenario("submit.compacting.extension-command", (t0) => {
		const t = registeredShell({ session: fakeSessionOf(t0, { isCompacting: true }) });
		return submit(t, "/extcmd run");
	});
	scenario("submit.command.tail-not-recognized", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "/settingsfoo");
	});
	scenario("submit.share", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "/share");
	});
	scenario("submit.name.arg", (t0) => {
		const t = registeredShell(t0);
		return submit(t, "/name my session");
	});
	scenario("submit.bash.clears-bash-mode", (t0) => {
		const t = registeredShell(t0);
		((t.defaultEditor as AnyRec).onChange as unknown as ((text: string) => void) | undefined)?.("!ls");
		return submit(t, "!ls").then(() => {
			rec("final.isBashMode", (t as AnyRec).isBashMode);
		});
	});

	function fakeSessionOf(_t: AnyRec, overrides: AnyRec): AnyRec {
		// rebuild a session with the same collaborator identity as makeThis used
		const base = {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			thinkingLevel: "medium",
			scopedModels: [],
			promptTemplates: [],
			retryAttempt: 0,
			autoCompactionEnabled: true,
			pendingMessageCount: 0,
			modelRuntime: { getAvailableSnapshot: () => [], getError: () => undefined },
			getSteeringMessages: () => sessionBag.steering ?? [],
			getFollowUpMessages: () => sessionBag.followUp ?? [],
			clearQueue: () => {
				const cleared = { steering: sessionBag.steering ?? [], followUp: sessionBag.followUp ?? [] };
				rec("session.clearQueue", cleared);
				sessionBag.steering = [];
				sessionBag.followUp = [];
				return cleared;
			},
			prompt: async (...args: unknown[]) => rec("session.prompt", ...args.map(describeArg)),
			steer: async (...args: unknown[]) => rec("session.steer", ...args.map(describeArg)),
			followUp: async (...args: unknown[]) => rec("session.followUp", ...args.map(describeArg)),
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
			extensionRunner: {
				getCommand: (n: string) => (n === "extcmd" ? { name: n } : undefined),
				getRegisteredCommands: () => [],
				getCommandDiagnostics: () => [],
				getShortcutDiagnostics: () => [],
				getShortcuts: () => new Map(),
				getMarkdownTransformers: () => [],
				getEntryRenderer: () => undefined,
				getMessageRenderer: () => undefined,
				getModelRegistry: () => ({}),
			},
			sessionManager: {
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
			},
			settingsManager: settingsFactory(),
			resourceLoader: resourceLoaderFactory(),
			agent: { abort: () => rec("agent.abort"), signal: {} },
			bindExtensions: async (options: unknown) => rec("session.bindExtensions", options),
			waitForIdle: async () => rec("session.waitForIdle"),
			navigateTree: async () => ({ cancelled: false, editorText: undefined }),
			getToolDefinition: (name: string) => ({ name, builtIn: true }),
			getContextUsage: () => undefined,
			systemPrompt: "sys",
			isProjectTrusted: () => true,
			model: undefined,
			state: { messages: [] },
			...overrides,
		};
		return base;
	}
	function settingsFactory(): AnyRec {
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
			getHttpIdleTimeoutMs: () => 30000,
			getMermaidRenderingMode: "render",
			getEnableSkillCommands: true,
			getLastChangelogVersion: "1.0.0",
			getShowImages: false,
			getImageWidthCells: 20,
			isProjectTrusted: true,
			getTheme: "dark",
		};
		const out: AnyRec = {};
		for (const [key, value] of Object.entries(values)) out[key] = () => value;
		out.setLastChangelogVersion = (v: string) => rec("settings.setLastChangelogVersion", v);
		out.setHideThinkingBlock = (v: boolean) => rec("settings.setHideThinkingBlock", v);
		return out;
	}
	function resourceLoaderFactory(): AnyRec {
		return {
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getExtensions: () => ({ extensions: [], errors: [] }),
			getSystemPromptSource: () => undefined,
			getAppendSystemPromptSources: () => [],
			getAgentsFiles: () => ({ agentsFiles: [] }),
		};
	}

	// -----------------------------------------------------------------------
	// S2: escape ring (setupKeyHandlers -> onEscape)
	// -----------------------------------------------------------------------
	function keyedShell(overrides: AnyRec = {}): AnyRec {
		const t = makeThis(withCommandStubs(overrides));
		(t.setupKeyHandlers as () => void)();
		return t;
	}
	scenario("escape.streaming", (t0) => {
		const t = keyedShell({ session: fakeSessionOf(t0, { isStreaming: true }) });
		((t.defaultEditor as AnyRec).onEscape as () => void)();
	});
	scenario("escape.bash-running", (t0) => {
		const t = keyedShell({ session: fakeSessionOf(t0, { isBashRunning: true }) });
		((t.defaultEditor as AnyRec).onEscape as () => void)();
	});
	scenario("escape.bash-mode", (t0) => {
		const t = keyedShell(t0);
		(t as AnyRec).isBashMode = true;
		((t.defaultEditor as AnyRec).onEscape as () => void)();
		rec("final.isBashMode", (t as AnyRec).isBashMode);
	});
	scenario("escape.empty.once", (t0) => {
		const t = keyedShell(t0);
		((t.defaultEditor as AnyRec).onEscape as () => void)();
	});
	scenario("escape.empty.double-fork", (t0) => {
		const t = keyedShell(t0);
		const escape = (t.defaultEditor as AnyRec).onEscape as () => void;
		escape();
		escape();
	});
	scenario("escape.empty.double-tree", (t0) => {
		const t = keyedShell({ session: fakeSessionOf(t0, { settingsManager: settingsWith({ getDoubleEscapeAction: () => "tree" }) }) });
		const escape = (t.defaultEditor as AnyRec).onEscape as () => void;
		escape();
		escape();
	});
	scenario("escape.empty.double-none", (t0) => {
		const t = keyedShell({ session: fakeSessionOf(t0, { settingsManager: settingsWith({ getDoubleEscapeAction: () => "none" }) }) });
		const escape = (t.defaultEditor as AnyRec).onEscape as () => void;
		escape();
		escape();
	});
	scenario("escape.nonempty.idle", (t0) => {
		const t = keyedShell(t0);
		(t.defaultEditor as AnyRec)._state.text = "draft";
		((t.defaultEditor as AnyRec).onEscape as () => void)();
	});
	function settingsWith(overrides: AnyRec): AnyRec {
		const base = settingsFactory();
		return { ...base, ...overrides };
	}

	// registered action table (input ring wiring shape)
	scenario("keyring.action-table", (t0) => {
		const t = keyedShell(t0);
		const handlers = Array.from(((t.defaultEditor as AnyRec).actionHandlers as Map<string, unknown>).keys());
		rec("actionHandlerNames", handlers.sort());
	});

	// -----------------------------------------------------------------------
	// S3: ctrl-c / ctrl-d / startup submit / ctrl-z (win32 branch)
	// -----------------------------------------------------------------------
	scenario("ctrlc.first-clears", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.defaultEditor as AnyRec)._state.text = "draft";
		(t.handleCtrlC as () => void)();
		rec("final.lastSigintTimeSet", (t as AnyRec).lastSigintTime > 0);
	});
	scenario("ctrlc.double-shuts-down", async (t0) => {
		const t = makeThis(withCommandStubs(t0));
		let now = 1000;
		const realNow = Date.now;
		Date.now = () => now;
		patchProcess({ platform: "linux", isTTY: true });
		try {
			(t.handleCtrlC as () => void)();
			now = 1200;
			(t.handleCtrlC as () => void)();
			await settle();
		} finally {
			Date.now = realNow;
			restoreProcess();
		}
	});
	scenario("ctrlc.second-late-clears", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		let now = 1000;
		const realNow = Date.now;
		Date.now = () => now;
		(t.handleCtrlC as () => void)();
		now = 2000;
		(t.handleCtrlC as () => void)();
		Date.now = realNow;
	});
	scenario("ctrld.shuts-down", async (t0) => {
		const t = makeThis(withCommandStubs(t0));
		patchProcess({ platform: "linux", isTTY: true });
		try {
			(t.handleCtrlD as () => void)();
			await settle();
		} finally {
			restoreProcess();
		}
	});
	scenario("startup-submit", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.handleStartupSubmit as (text: string) => void)("early input");
	});
	scenario("ctrlz.win32", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		patchProcess({ platform: "win32" });
		try {
			(t.handleCtrlZ as () => void)();
		} finally {
			restoreProcess();
		}
	});
	scenario("shutdown.graceful", async (t0) => {
		const t = makeThis(withCommandStubs(t0));
		patchProcess({ platform: "linux", isTTY: true });
		try {
			await (t.shutdown as (options?: unknown) => Promise<void>)();
		} finally {
			restoreProcess();
		}
	});
	scenario("shutdown.from-signal", async (t0) => {
		const t = makeThis(withCommandStubs(t0));
		patchProcess({ platform: "linux", isTTY: true });
		try {
			await (t.shutdown as (options?: unknown) => Promise<void>)({ fromSignal: true });
		} finally {
			restoreProcess();
		}
	});
	scenario("shutdown.resumed-session-no-command", async (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.sessionManager as AnyRec).isPersisted = () => false;
		patchProcess({ platform: "linux", isTTY: true });
		try {
			await (t.shutdown as (options?: unknown) => Promise<void>)();
		} finally {
			restoreProcess();
		}
	});
	scenario("signals.register-and-unregister", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		patchProcess({ platform: "linux", isTTY: true });
		try {
			(t.registerSignalHandlers as () => void)();
			(t.unregisterSignalHandlers as () => void)();
		} finally {
			restoreProcess();
		}
	});
	scenario("signals.dead-terminal-error-codes", (t0) => {
		const t = makeThis(t0);
		const fn = (t.isDeadTerminalError as (e: unknown) => boolean);
		rec("deadTerminal", fn({ code: "EPIPE" }), fn({ code: "EIO" }), fn({ code: "ENOTCONN" }), fn({ code: "ENOENT" }), fn(undefined), fn("x"), fn({}));
	});
	scenario("check-shutdown-requested.idle", async (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t as AnyRec).shutdownRequested = false;
		await (t.checkShutdownRequested as () => Promise<void>)();
		(t as AnyRec).shutdownRequested = true;
		patchProcess({ platform: "linux", isTTY: true });
		try {
			await (t.checkShutdownRequested as () => Promise<void>)();
		} finally {
			restoreProcess();
		}
	});

	// process patch helpers
	let realProcess: NodeJS.Process | undefined;
	// Let floating `void this.shutdown()` continuations finish while the fake
	// process is still installed (a real process.exit would end node silently).
	function settle(ms = 25): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	function patchProcess(opts: { platform?: string; isTTY?: boolean }): void {
		realProcess = globalThis.process;
		const fake: AnyRec = {
			platform: opts.platform ?? "linux",
			env: {},
			stdout: { isTTY: opts.isTTY ?? true, write: (...a: unknown[]) => rec("process.stdout.write", ...a.map(describeArg)), on: () => rec("process.stdout.on"), off: () => rec("process.stdout.off") },
			stderr: { on: () => rec("process.stderr.on"), off: () => rec("process.stderr.off") },
			exit: (code: number) => rec("process.exit", code),
			prependListener: (signal: string, h: unknown) => rec("process.prependListener", signal, typeof h),
			on: (signal: string, h: unknown) => rec("process.on", signal, typeof h),
			once: (signal: string, h: unknown) => rec("process.once", signal, typeof h),
			off: (signal: string, h: unknown) => rec("process.off", signal, typeof h),
			removeListener: (signal: string, h: unknown) => rec("process.removeListener", signal, typeof h),
			kill: (pid: number, sig: string) => rec("process.kill", pid, sig),
		};
		(globalThis as AnyRec).process = fake;
	}
	function restoreProcess(): void {
		if (realProcess) (globalThis as AnyRec).process = realProcess;
		realProcess = undefined;
	}

	// -----------------------------------------------------------------------
	// S4-S9: queues
	// -----------------------------------------------------------------------
	scenario("queue.get-combines", (t0) => {
		const t = makeThis(t0);
		sessionBag.steering = ["s1", "s2"];
		sessionBag.followUp = ["f1"];
		(t as AnyRec).compactionQueuedMessages = [
			{ text: "cs1", mode: "steer" },
			{ text: "cf1", mode: "followUp" },
		];
		const result = (t.getAllQueuedMessages as () => unknown)();
		rec("result", describeArg(result));
	});
	scenario("queue.clear-all", (t0) => {
		const t = makeThis(t0);
		sessionBag.steering = ["s1"];
		sessionBag.followUp = ["f1", "f2"];
		(t as AnyRec).compactionQueuedMessages = [{ text: "cs1", mode: "steer" }];
		const result = (t.clearAllQueues as () => unknown)();
		rec("result", describeArg(result));
		rec("remaining", (t as AnyRec).compactionQueuedMessages.length);
	});
	scenario("queue.restore-to-editor", (t0) => {
		const t = makeThis(t0);
		sessionBag.steering = ["s1"];
		sessionBag.followUp = ["f1"];
		(t as AnyRec).compactionQueuedMessages = [{ text: "cs1", mode: "steer" }];
		(t.defaultEditor as AnyRec)._state.text = "current draft";
		const count = (t.restoreQueuedMessagesToEditor as (o?: unknown) => number)();
		rec("count", count);
		rec("editorText", (t.defaultEditor as AnyRec)._state.text);
	});
	scenario("queue.restore-empty-abort", (t0) => {
		const t = makeThis(t0);
		const count = (t.restoreQueuedMessagesToEditor as (o?: unknown) => number)({ abort: true });
		rec("count", count);
	});
	scenario("queue.restore-abort-with-queue", (t0) => {
		const t = makeThis(t0);
		sessionBag.steering = ["s1"];
		const count = (t.restoreQueuedMessagesToEditor as (o?: unknown) => number)({ abort: true });
		rec("count", count);
	});
	scenario("queue.restore-skips-empty-current", (t0) => {
		const t = makeThis(t0);
		sessionBag.steering = ["s1"];
		(t.defaultEditor as AnyRec)._state.text = "   ";
		const count = (t.restoreQueuedMessagesToEditor as (o?: unknown) => number)();
		rec("count", count);
		rec("editorText", (t.defaultEditor as AnyRec)._state.text);
	});
	scenario("queue.dequeue-empty", (t0) => {
		const t = makeThis(t0);
		(t.handleDequeue as () => void)();
	});
	scenario("queue.dequeue-restores", (t0) => {
		const t = makeThis(t0);
		sessionBag.steering = ["s1", "s2"];
		sessionBag.followUp = ["f1"];
		(t.handleDequeue as () => void)();
		rec("editorText", (t.defaultEditor as AnyRec)._state.text);
	});
	scenario("queue.compaction-message", (t0) => {
		const t = makeThis(t0);
		(t.queueCompactionMessage as (text: string, mode: string) => void)("queued text", "steer");
		rec("queued", describeArg((t as AnyRec).compactionQueuedMessages));
		rec("editorText", (t.defaultEditor as AnyRec)._state.text);
	});
	scenario("queue.follow-up.streaming", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { isStreaming: true }) });
		(t.defaultEditor as AnyRec)._state.text = "follow up please";
		return Promise.resolve((t.handleFollowUp as () => Promise<void>)());
	});
	scenario("queue.follow-up.streaming-extension-command", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { isStreaming: true }) });
		(t.defaultEditor as AnyRec)._state.text = "/extcmd do";
		return Promise.resolve((t.handleFollowUp as () => Promise<void>)());
	});
	scenario("queue.follow-up.compacting", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { isCompacting: true }) });
		(t.defaultEditor as AnyRec)._state.text = "wait for me";
		return Promise.resolve((t.handleFollowUp as () => Promise<void>)());
	});
	scenario("queue.follow-up.compacting-extension-command", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { isCompacting: true }) });
		(t.defaultEditor as AnyRec)._state.text = "/extcmd do";
		return Promise.resolve((t.handleFollowUp as () => Promise<void>)());
	});
	scenario("queue.follow-up.idle-acts-as-submit", (t0) => {
		const t = registeredShell(t0);
		(t.defaultEditor as AnyRec)._state.text = "idle follow";
		return Promise.resolve((t.handleFollowUp as () => Promise<void>)());
	});
	scenario("queue.follow-up.empty", (t0) => {
		const t = makeThis(t0);
		return Promise.resolve((t.handleFollowUp as () => Promise<void>)());
	});
	scenario("queue.is-extension-command", (t0) => {
		const t = makeThis(t0);
		const fn = t.isExtensionCommand as (text: string) => boolean;
		rec("results", fn("/extcmd a"), fn("/unknown"), fn("plain"), fn("/"));
	});
	scenario("queue.flush.will-retry", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, {}) });
		(t as AnyRec).compactionQueuedMessages = [
			{ text: "/extcmd prep", mode: "steer" },
			{ text: "real prompt", mode: "followUp" },
			{ text: "steered", mode: "steer" },
		];
		return Promise.resolve((t.flushCompactionQueue as (o?: unknown) => Promise<void>)({ willRetry: true }));
	});
	scenario("queue.flush.normal", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, {}) });
		(t as AnyRec).compactionQueuedMessages = [
			{ text: "/extcmd prep", mode: "steer" },
			{ text: "real prompt", mode: "followUp" },
			{ text: "extra", mode: "steer" },
			{ text: "extra2", mode: "followUp" },
		];
		return Promise.resolve((t.flushCompactionQueue as (o?: unknown) => Promise<void>)());
	});
	scenario("queue.flush.all-extension-commands", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, {}) });
		(t as AnyRec).compactionQueuedMessages = [
			{ text: "/extcmd a", mode: "steer" },
			{ text: "/extcmd b", mode: "followUp" },
		];
		return Promise.resolve((t.flushCompactionQueue as (o?: unknown) => Promise<void>)());
	});
	scenario("queue.flush.empty", (t0) => {
		const t = makeThis(t0);
		return Promise.resolve((t.flushCompactionQueue as (o?: unknown) => Promise<void>)());
	});
	scenario("queue.flush.prompt-error-restores", (t0) => {
		const session = fakeSessionOf(t0, {
			prompt: async (...args: unknown[]) => {
				if (String(args[0]) === "boom prompt") throw new Error("prompt failed");
				rec("session.prompt", ...args.map(describeArg));
			},
		});
		const t = makeThis({ session });
		(t as AnyRec).compactionQueuedMessages = [
			{ text: "boom prompt", mode: "steer" },
			{ text: "after", mode: "followUp" },
		];
		return Promise.resolve((t.flushCompactionQueue as (o?: unknown) => Promise<void>)()).then(() => {
			rec("restored", describeArg((t as AnyRec).compactionQueuedMessages));
		});
	});
	scenario("queue.flush-pending-bash", (t0) => {
		const t = makeThis(t0);
		const chat = (t as AnyRec).chatContainer as Container;
		const pending = (t as AnyRec).pendingMessagesContainer as Container;
		const c1 = { describe: () => ({ kind: "BashStub", id: 1 }) };
		const c2 = { describe: () => ({ kind: "BashStub", id: 2 }) };
		chat.addChild(c1);
		pending.addChild(c2);
		(t as AnyRec).pendingBashComponents = [c2 as unknown as RecComponent];
		(t.flushPendingBashComponents as () => void)();
		rec("pendingChildren", pending.children.length, "chatChildren", chat.children.map(describeArg));
	});

	// -----------------------------------------------------------------------
	// S10: status coalescing + notifications
	// -----------------------------------------------------------------------
	scenario("status.coalesce-consecutive", (t0) => {
		const t = makeThis(t0);
		(t.showStatus as (m: string) => void)("first");
		(t.showStatus as (m: string) => void)("second");
		(t.showStatus as (m: string) => void)("third");
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("status.not-coalesced-after-other", (t0) => {
		const t = makeThis(t0);
		(t.showStatus as (m: string) => void)("first");
		const other = new Text("user message", 1, 0);
		((t as AnyRec).chatContainer as Container).addChild(other);
		(t.showStatus as (m: string) => void)("second");
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("status.managed-tool", (t0) => {
		const t = makeThis(t0);
		(t.showManagedToolStatus as (s: unknown) => void)({ type: "info", message: "downloading fd" });
		(t.showManagedToolStatus as (s: unknown) => void)({ type: "warning", message: "checksum mismatch" });
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("status.error-and-warning", (t0) => {
		const t = makeThis(t0);
		(t.showError as (m: string) => void)("boom");
		(t.showWarning as (m: string) => void)("careful");
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("status.clear-editor", (t0) => {
		const t = makeThis(t0);
		(t.defaultEditor as AnyRec)._state.text = "text";
		(t.clearEditor as () => void)();
	});
	scenario("status.new-version-notification", (t0) => {
		const t = makeThis(t0);
		(t.showNewVersionNotification as (r: unknown) => void)({ version: "9.9.9", note: "  Fixed stuff.  " });
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("status.package-update-notification", (t0) => {
		const t = makeThis(t0);
		(t.showPackageUpdateNotification as (p: string[]) => void)(["ext-a", "ext-b"]);
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});

	// -----------------------------------------------------------------------
	// S11: event dispatch (handleEvent)
	// -----------------------------------------------------------------------
	async function event(t0: AnyRec, event: AnyRec): Promise<AnyRec> {
		const t = makeThis(withCommandStubs(t0));
		await (t.handleEvent as (e: AnyRec) => Promise<void>)(event);
		return t;
	}
	scenario("event.turn-start", (t0) => event(t0, { type: "turn_start" }));
	scenario("event.turn-start.progress-setting", (t0) =>
		event({ session: fakeSessionOf(t0, { settingsManager: settingsWith({ getShowTerminalProgress: () => true }) }) }, { type: "turn_start" }));
	scenario("event.queue-update", (t0) => event(t0, { type: "queue_update", steering: ["s"], followUp: ["f"] }));
	scenario("event.entry-appended-custom", (t0) =>
		event(t0, { type: "entry_appended", entry: { type: "custom", customType: "my-widget" } }));
	scenario("event.entry-appended-message", (t0) =>
		event(t0, { type: "entry_appended", entry: { type: "message", message: { role: "user", content: "x" } } }));
	scenario("event.session-info-changed", (t0) => event(t0, { type: "session_info_changed", name: "renamed" }));
	scenario("event.thinking-level-changed", (t0) => event(t0, { type: "thinking_level_changed", level: "high" }));
	scenario("event.message-start-user", (t0) =>
		event(t0, { type: "message_start", message: { role: "user", content: "hi" } }));
	scenario("event.message-start-assistant", (t0) =>
		event(t0, { type: "message_start", message: { role: "assistant", content: [], stopReason: null } }));
	scenario("event.message-start-custom-display", (t0) =>
		event(t0, { type: "message_start", message: { role: "custom", customType: "widget", display: true, content: [] } }));
	scenario("event.message-update-assistant", (t0) =>
		event(t0, {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } }], stopReason: null },
		}));
	scenario("event.message-update-known-tool", (t0) =>
		event(t0, {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } }], stopReason: null },
		}).then((t) => {
			// second update reuses the component
			return (t.handleEvent as (e: AnyRec) => Promise<void>)({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "b" } }], stopReason: null },
			});
		}));
	scenario("event.message-end-success", (t0) =>
		event(t0, { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } }).then((t) => {
			// seed a streaming component so the end path completes it
		}));
	scenario("event.message-end-with-streaming", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		return (t.handleEvent as (e: AnyRec) => Promise<void>)({
			type: "message_start",
			message: { role: "assistant", content: [], stopReason: null },
		}).then(() =>
			(t.handleEvent as (e: AnyRec) => Promise<void>)({
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "stop" },
			}),
		);
	});
	scenario("event.message-end-aborted", (t0) => {
		const t = makeThis(withCommandStubs({ session: fakeSessionOf(t0, { retryAttempt: 2 }) }));
		return (t.handleEvent as (e: AnyRec) => Promise<void>)({
			type: "message_start",
			message: { role: "assistant", content: [], stopReason: null },
		}).then(() =>
			(t.handleEvent as (e: AnyRec) => Promise<void>)({
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "aborted" },
			}),
		);
	});
	scenario("event.message-end-user-ignored", (t0) =>
		event(t0, { type: "message_end", message: { role: "user", content: "x" } }));
	scenario("event.bash-execution-update", (t0) => event(t0, { type: "bash_execution_update", delta: "out" }));
	scenario("event.tool-execution-start", (t0) =>
		event(t0, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } }));
	scenario("event.tool-execution-start-existing", (t0) =>
		event(t0, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } }).then((t) =>
			(t.handleEvent as (e: AnyRec) => Promise<void>)({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } }),
		));
	scenario("event.tool-execution-update", (t0) =>
		event(t0, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} }).then((t) =>
			(t.handleEvent as (e: AnyRec) => Promise<void>)({
				type: "tool_execution_update", toolCallId: "t1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "partial" }] },
			}),
		));
	scenario("event.tool-execution-end", (t0) =>
		event(t0, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} }).then((t) =>
			(t.handleEvent as (e: AnyRec) => Promise<void>)({
				type: "tool_execution_end", toolCallId: "t1", toolName: "bash", args: {}, result: { content: [{ type: "text", text: "done" }] }, isError: false,
			}),
		));
	scenario("event.agent-start", (t0) => event(t0, { type: "agent_start" }));
	scenario("event.agent-start-with-retry-handler", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		const retry = () => rec("retryEscape");
		(t as AnyRec).retryEscapeHandler = retry;
		return (t.handleEvent as (e: AnyRec) => Promise<void>)({ type: "agent_start" }).then(() => {
			rec("onEscapeIsRetry", (t.defaultEditor as AnyRec).onEscape === retry);
			rec("retryHandlerCleared", (t as AnyRec).retryEscapeHandler === undefined);
		});
	});
	scenario("event.agent-end", (t0) => event(t0, { type: "agent_end", messages: [], willRetry: false }));
	scenario("event.agent-end-clears-streaming", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		return (t.handleEvent as (e: AnyRec) => Promise<void>)({
			type: "message_start",
			message: { role: "assistant", content: [], stopReason: null },
		}).then(() => (t.handleEvent as (e: AnyRec) => Promise<void>)({ type: "agent_end", messages: [], willRetry: false }));
	});
	scenario("event.agent-settled", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t as AnyRec).shutdownRequested = false;
		return (t.handleEvent as (e: AnyRec) => Promise<void>)({ type: "agent_settled" });
	});
	scenario("event.agent-settled-shutdown", async (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t as AnyRec).shutdownRequested = true;
		patchProcess({ platform: "linux", isTTY: true });
		try {
			await (t.handleEvent as (e: AnyRec) => Promise<void>)({ type: "agent_settled" });
			await settle();
		} finally {
			restoreProcess();
		}
	});
	scenario("event.compaction-start", (t0) =>
		event({ session: fakeSessionOf(t0, { settingsManager: settingsWith({ getShowTerminalProgress: () => true }) }) }, { type: "compaction_start", reason: "threshold" }));
	scenario("event.compaction-start-escapes-abort", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		return (t.handleEvent as (e: AnyRec) => Promise<void>)({ type: "compaction_start", reason: "manual" }).then(() => {
			const escape = (t.defaultEditor as AnyRec).onEscape as () => void;
			escape();
			rec("onEscapeRestored", escape === (t as AnyRec).autoCompactionEscapeHandler);
		});
	});
	scenario("event.compaction-end-success", (t0) => {
		const session = fakeSessionOf(t0, {});
		(session.sessionManager as AnyRec).buildContextEntries = () => [
			{ type: "compaction", id: "c1", parentId: null, timestamp: "2026-01-01T00:00:00Z", summary: "sum", firstKeptEntryId: "k", tokensBefore: 100, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
		];
		const t = makeThis(withCommandStubs({ session }));
		return (t.handleEvent as (e: AnyRec) => Promise<void>)({
			type: "compaction_end", reason: "threshold", result: { summary: "sum", tokensBefore: 100, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }, aborted: false, willRetry: false, errorMessage: undefined,
		});
	});
	scenario("event.compaction-end-aborted-manual", (t0) =>
		event(t0, { type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false, errorMessage: undefined }));
	scenario("event.compaction-end-aborted-auto", (t0) =>
		event(t0, { type: "compaction_end", reason: "threshold", result: undefined, aborted: true, willRetry: false, errorMessage: undefined }));
	scenario("event.compaction-end-error-manual", (t0) =>
		event(t0, { type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false, errorMessage: "compact failed" }));
	scenario("event.compaction-end-error-auto", (t0) =>
		event(t0, { type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: "compact failed" }));
	scenario("event.compaction-end-flushes-queue", (t0) => {
		const session = fakeSessionOf(t0, {});
		(session.sessionManager as AnyRec).buildContextEntries = () => [];
		const t = makeThis(withCommandStubs({ session }));
		(t as AnyRec).compactionQueuedMessages = [{ text: "/extcmd after", mode: "steer" }];
		return (t.handleEvent as (e: AnyRec) => Promise<void>)({
			type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: undefined,
		});
	});
	scenario("event.auto-retry-start", (t0) =>
		event(t0, { type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 1500, errorMessage: "rate limited" }));
	scenario("event.auto-retry-start-escape-aborts", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		return (t.handleEvent as (e: AnyRec) => Promise<void>)({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "x" }).then(() => {
			const escape = (t.defaultEditor as AnyRec).onEscape as () => void;
			escape();
			rec("onEscapeRestored", escape === (t as AnyRec).retryEscapeHandler);
		});
	});
	scenario("event.auto-retry-end-success", (t0) =>
		event(t0, { type: "auto_retry_end", success: true, attempt: 2, finalError: undefined }));
	scenario("event.auto-retry-end-failure", (t0) =>
		event(t0, { type: "auto_retry_end", success: false, attempt: 3, finalError: "still failing" }));
	scenario("event.summarization-retry-scheduled", (t0) =>
		event(t0, { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 500, errorMessage: "sum failed" }));
	scenario("event.summarization-retry-attempt-branch-summary", (t0) =>
		event(t0, { type: "summarization_retry_attempt_start", source: "branchSummary" }));
	scenario("event.summarization-retry-attempt-compaction", (t0) =>
		event(t0, { type: "summarization_retry_attempt_start", source: "compaction" }));
	scenario("event.summarization-retry-finished", (t0) => event(t0, { type: "summarization_retry_finished" }));
	scenario("event.uninitialized-inits-first", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t as AnyRec).isInitialized = false;
		// init() is out of the r18 oracle scope; record that handleEvent short-circuits
		return (t.handleEvent as (e: AnyRec) => Promise<void>)({ type: "agent_settled" });
	});

	// -----------------------------------------------------------------------
	// S12: session rendering
	// -----------------------------------------------------------------------
	scenario("render.session-entries-compaction", (t0) => {
		const t = makeThis(withCommandStubs({ session: fakeSessionOf(t0, { settingsManager: settingsWith({ getShowCacheMissNotices: () => true }) }) }));
		(t.renderSessionEntries as (e: unknown[], o?: unknown) => void)(
			[
				{ type: "compaction", id: "current", parentId: "previous", timestamp: "2025-01-02T00:00:00Z", summary: "current summary", firstKeptEntryId: "kept", tokensBefore: 200, usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 } } },
				{ type: "compaction", id: "previous", parentId: null, timestamp: "2025-01-01T00:00:00Z", summary: "previous summary", firstKeptEntryId: "kept", tokensBefore: 100, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 } } },
			],
			{},
		);
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.add-compaction-cost-notice", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { settingsManager: settingsWith({ getShowCacheMissNotices: () => true }) }) });
		(t.addCompactionCostNotice as (n: unknown) => void)({ type: "compaction_cost", kind: "compaction", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 } } });
		(t.addCompactionCostNotice as (n: unknown) => void)({ type: "compaction_cost", kind: "branch_summary", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 } } });
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.add-compaction-cost-notice-disabled", (t0) => {
		const t = makeThis(t0);
		(t.addCompactionCostNotice as (n: unknown) => void)({ type: "compaction_cost", kind: "compaction", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.add-message-user", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.addMessageToChat as (m: unknown, o?: unknown) => void)({ role: "user", content: "hello there" });
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.add-message-user-with-skill-block", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.addMessageToChat as (m: unknown, o?: unknown) => void)({
			role: "user",
			content: '<skill name="review" location="/skills/review.md">\nskill body\n</skill>\n\nplease review',
		}, { populateHistory: true });
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.add-message-assistant", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.addMessageToChat as (m: unknown, o?: unknown) => void)({ role: "assistant", content: [], stopReason: "stop" });
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.add-message-bash-execution", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.addMessageToChat as (m: unknown, o?: unknown) => void)({
			role: "bashExecution", command: "ls -la", output: "file1\nfile2", exitCode: 0, cancelled: false, truncated: false, fullOutputPath: undefined,
		});
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.add-message-custom", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.addMessageToChat as (m: unknown, o?: unknown) => void)({
			role: "custom", customType: "widget", display: true, content: [], details: undefined, timestamp: 1700000000000,
		});
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.add-message-custom-undisplayed", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.addMessageToChat as (m: unknown, o?: unknown) => void)({
			role: "custom", customType: "widget", display: false, content: [], details: undefined, timestamp: 1700000000000,
		});
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.add-message-compaction-summary", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.addMessageToChat as (m: unknown, o?: unknown) => void)({
			role: "compactionSummary", summary: "sum", tokensBefore: 100, timestamp: 1700000000000,
		});
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.add-message-branch-summary", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.addMessageToChat as (m: unknown, o?: unknown) => void)({
			role: "branchSummary", summary: "b-sum", fromId: "e1", timestamp: 1700000000000,
		});
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.add-message-system-and-toolresult", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.addMessageToChat as (m: unknown, o?: unknown) => void)({ role: "system", content: "sys" });
		(t.addMessageToChat as (m: unknown, o?: unknown) => void)({ role: "toolResult", toolCallId: "t1", content: [] });
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.initial-messages", (t0) => {
		const session = fakeSessionOf(t0, {});
		(session.sessionManager as AnyRec).buildContextEntries = () => [
			{ type: "message", message: { role: "user", content: "first" } },
		];
		(session.sessionManager as AnyRec).getEntries = () => [
			{ type: "message", message: { role: "user", content: "first" } },
			{ type: "compaction", id: "c1", parentId: null, timestamp: "2025-01-01T00:00:00Z", summary: "s", firstKeptEntryId: "k", tokensBefore: 10, usage: undefined },
		];
		const t = makeThis(withCommandStubs({ session }));
		(t.renderInitialMessages as () => void)();
	});
	scenario("render.project-trust-warning", (t0) => {
		const session = fakeSessionOf(t0, { settingsManager: settingsWith({ isProjectTrusted: () => false }) });
		const t = makeThis(withCommandStubs({ session }));
		(t.renderProjectTrustWarningIfNeeded as () => void)();
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.project-trust-warning-trusted", (t0) => {
		const t = makeThis(t0);
		(t.renderProjectTrustWarningIfNeeded as () => void)();
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.user-message-text-extraction", (t0) => {
		const t = makeThis(t0);
		const fn = t.getUserMessageText as (m: unknown) => string;
		rec("text", fn({ role: "user", content: "plain" }), fn({ role: "user", content: [{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }] }), fn({ role: "assistant", content: "no" }));
	});
	scenario("render.custom-entry-no-renderer", (t0) => {
		const t = makeThis(t0);
		(t.addCustomEntryToChat as (e: unknown) => void)({ type: "custom", customType: "missing" });
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.startup-notices-collapsed", (t0) => {
		const t = makeThis(t0);
		(t as AnyRec).changelogMarkdown = "## [1.2.0]\n- entry";
		(t.showStartupNoticesIfNeeded as () => void)();
		(t.showStartupNoticesIfNeeded as () => void)(); // idempotent
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.startup-notices-expanded", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { settingsManager: settingsWith({ getCollapseChangelog: () => false }) }) });
		(t as AnyRec).changelogMarkdown = "## [1.2.0]\n- entry";
		(t.showStartupNoticesIfNeeded as () => void)();
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.startup-notices-none", (t0) => {
		const t = makeThis(t0);
		(t.showStartupNoticesIfNeeded as () => void)();
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("render.get-user-input-queues-first", (t0) => {
		const t = makeThis(t0);
		(t as AnyRec).pendingUserInputs = ["q1", "q2"];
		const p1 = (t.getUserInput as () => Promise<string>)();
		const p2 = (t.getUserInput as () => Promise<string>)();
		const p3 = (t.getUserInput as () => Promise<string>)();
		rec("results", "pending");
		return Promise.all([p1, p2]).then(([a, b]) => {
			rec("first-two", a, b);
			rec("third-pending", (t as AnyRec).onInputCallback !== undefined);
			const cb = (t as AnyRec).onInputCallback as (s: string) => void;
			cb("typed");
			return p3.then((c) => rec("third", c));
		});
	});

	// -----------------------------------------------------------------------
	// S13: pure module-level functions
	// -----------------------------------------------------------------------
	scenario("pure.quote-if-needed", (t0) => {
		const t = makeThis(t0);
		const fn = t.quoteIfNeeded as (v: string) => string;
		rec("results", fn("abc"), fn("a-b_c.d~e"), fn(""), fn("has space"), fn("it's"), fn("a:b"));
	});
	scenario("pure.resume-command", (t0) => {
		const t = makeThis(t0);
		patchProcess({ platform: "linux", isTTY: true });
		try {
			const fn = t.formatResumeCommand as (sm: unknown) => string | undefined;
			rec("default-dir", fn((t as AnyRec).sessionManager));
			(t as AnyRec).sessionManager = { ...((t as AnyRec).sessionManager as AnyRec), usesDefaultSessionDir: () => false, getSessionDir: () => "/custom dir/sessions" };
			rec("custom-dir", fn((t as AnyRec).sessionManager));
			(t as AnyRec).sessionManager = { ...((t as AnyRec).sessionManager as AnyRec), isPersisted: () => false };
			rec("not-persisted", fn((t as AnyRec).sessionManager));
			(t as AnyRec).sessionManager = { ...((t as AnyRec).sessionManager as AnyRec), isPersisted: () => true, getSessionFile: () => undefined };
			rec("no-file", fn((t as AnyRec).sessionManager));
		} finally {
			restoreProcess();
		}
	});
	scenario("pure.resume-command-no-tty", (t0) => {
		const t = makeThis(t0);
		patchProcess({ platform: "linux", isTTY: false });
		try {
			const fn = t.formatResumeCommand as (sm: unknown) => string | undefined;
			rec("result", fn((t as AnyRec).sessionManager));
		} finally {
			restoreProcess();
		}
	});
	scenario("pure.anthropic-warning-and-keys", (t0) => {
		const t = makeThis(t0);
		rec(
			"results",
			(t.isAnthropicSubscriptionAuthKey as (k: string | undefined) => boolean)("sk-ant-oat123"),
			(t.isAnthropicSubscriptionAuthKey as (k: string | undefined) => boolean)("sk-ant-api1"),
			(t.isAnthropicSubscriptionAuthKey as (k: string | undefined) => boolean)(undefined),
			(t.isUnknownModel as (m: unknown) => boolean)({ provider: "unknown", id: "unknown", api: "unknown" }),
			(t.isUnknownModel as (m: unknown) => boolean)({ provider: "anthropic", id: "x", api: "y" }),
			(t.isUnknownModel as (m: unknown) => boolean)(undefined),
			(t.llamaCppPostLoginGuidance as (a: string, n: number) => string)("Logged in", 0),
			(t.llamaCppPostLoginGuidance as (a: string, n: number) => string)("Logged in", 2),
		);
	});
	scenario("pure.login-provider-options", (t0) => {
		const t = makeThis(t0);
		const fn = t.getLoginProviderCompletionOptions as (p: unknown[]) => unknown;
		rec("grouped", describeArg(fn([
			{ id: "anthropic", name: "Anthropic", authType: "api_key" },
			{ id: "anthropic", name: "Anthropic", authType: "oauth" },
			{ id: "openai", name: "OpenAI", authType: "oauth" },
			{ id: "zai", name: "Z.ai", authType: "api_key" },
		])));
		const search = t.getLoginProviderSearchText as (p: unknown) => string;
		const desc = t.formatLoginProviderCompletionDescription as (p: unknown) => string;
		const grouped = fn([
			{ id: "anthropic", name: "Anthropic", authTypes: ["oauth", "api_key"] },
			{ id: "zai", name: "Z.ai", authTypes: ["api_key"] },
			{ id: "x", name: "x", authTypes: ["oauth"] },
		]) as Array<AnyRec>;
		for (const p of grouped) {
			rec("search", search(p));
			rec("desc", desc(p));
		}
	});
	scenario("pure.fuzzy-autocomplete-items", (t0) => {
		const t = makeThis(t0);
		const fn = t.createFuzzyAutocompleteItems as (i: unknown[], p: string, s: (x: unknown) => string, to: (x: unknown) => unknown) => unknown;
		const items = [{ id: "gpt-5", provider: "openai" }, { id: "claude", provider: "anthropic" }];
		rec("match", describeArg(fn(items, "gp", (i) => `${(i as AnyRec).id} ${(i as AnyRec).provider}`, (i) => ({ value: `${(i as AnyRec).provider}/${(i as AnyRec).id}`, label: (i as AnyRec).id, description: (i as AnyRec).provider }))));
		rec("no-match", describeArg(fn(items, "zzz", (i) => `${(i as AnyRec).id}`, (i) => i)));
	});
	scenario("pure.autocomplete-source-tag", (t0) => {
		const t = makeThis(t0);
		const fn = t.getAutocompleteSourceTag as (s?: unknown) => string | undefined;
		rec("none", fn(undefined));
		rec("auto-user", fn({ scope: "user", source: "auto" }));
		rec("local-project", fn({ scope: "project", source: "local" }));
		rec("cli-temporary", fn({ scope: "temporary", source: "cli" }));
		rec("npm", fn({ scope: "project", source: "npm:@scope/pkg" }));
		rec("git", fn({ scope: "project", source: "git:github.com/owner/repo" }));
		rec("git-ref", fn({ scope: "project", source: "git://gitlab.com/owner/repo#v2" }));
		rec("other", fn({ scope: "temporary", source: "weird" }));
	});
	scenario("pure.prefix-autocomplete-description", (t0) => {
		const t = makeThis(t0);
		const fn = t.prefixAutocompleteDescription as (d: string | undefined, s?: unknown) => string | undefined;
		rec("no-source", fn("plain"));
		rec("with-source", fn("plain", { scope: "user", source: "auto" }));
		rec("empty-desc", fn(undefined, { scope: "project", source: "local" }));
	});
	scenario("pure.builtin-command-conflict-diagnostics", (t0) => {
		const t = makeThis(t0);
		const runner = {
			getRegisteredCommands: () => [
				{ name: "model", invocationName: "model", sourceInfo: { path: "/ext/a.ts" } },
				{ name: "settings", invocationName: "my-settings", sourceInfo: { path: "/ext/b.ts" } },
				{ name: "custom", invocationName: "custom", sourceInfo: { path: "/ext/c.ts" } },
			],
		};
		rec("result", describeArg((t.getBuiltInCommandConflictDiagnostics as (r: unknown) => unknown)(runner)));
	});

	// -----------------------------------------------------------------------
	// S14: paths / labels / scope groups
	// -----------------------------------------------------------------------
	scenario("paths.short-path", (t0) => {
		const t = makeThis(t0);
		const fn = t.getShortPath as (p: string, s?: unknown) => string;
		rec("plain", fn("/home/u/proj/file.ts"));
		rec("home", fn("/home/u/file.ts"));
		rec("package", fn("/home/u/proj/node_modules/@scope/pkg/dist/ext/index.js", { baseDir: "/home/u/proj/node_modules/@scope/pkg", source: "npm:@scope/pkg", scope: "project" }));
		rec("package-external-under-root", fn("/home/u/proj/node_modules/@scope/pkg-other/ext.js", { baseDir: "/home/u/proj/node_modules/@scope/pkg", source: "npm:@scope/pkg", scope: "project" }));
		rec("npm-source", fn("/work/project/node_modules/other/lib/x.ts", { source: "npm:other", scope: "project" }));
		rec("npm-source-no-match", fn("/elsewhere/x.ts", { source: "npm:other", scope: "project" }));
		rec("no-source-info", fn("/work/project/a/b.ts"));
	});
	scenario("paths.compact-labels", (t0) => {
		const t = makeThis(t0);
		rec("path", (t.getCompactPathLabel as (p: string, s?: unknown) => string)("/home/u/deep/dir/file.ts"));
		rec("path-empty-segments", (t.getCompactPathLabel as (p: string, s?: unknown) => string)(""));
		rec("package-source", (t.getCompactPackageSourceLabel as (s?: unknown) => string)({ source: "npm:@scope/pkg", scope: "project" }));
		rec("package-source-git", (t.getCompactPackageSourceLabel as (s?: unknown) => string)({ source: "git://github.com/o/r", scope: "project" }));
		rec("package-source-bare", (t.getCompactPackageSourceLabel as (s?: unknown) => string)({ source: "local", scope: "project" }));
		rec("ext-label-package", (t.getCompactExtensionLabel as (p: string, s?: unknown) => string)("/work/project/node_modules/@scope/pkg/extensions/index.js", { baseDir: "/work/project/node_modules/@scope/pkg", source: "npm:@scope/pkg", scope: "project" }));
		rec("ext-label-package-subdir", (t.getCompactExtensionLabel as (p: string, s?: unknown) => string)("/work/project/node_modules/@scope/pkg/extensions/tools/run.js", { baseDir: "/work/project/node_modules/@scope/pkg", source: "npm:@scope/pkg", scope: "project" }));
		rec("ext-label-nonpackage", (t.getCompactExtensionLabel as (p: string, s?: unknown) => string)("/work/project/exts/my.ts"));
	});
	scenario("paths.compact-extension-labels", (t0) => {
		const t = makeThis(t0);
		const fn = t.getCompactExtensionLabels as (e: Array<{ path: string; sourceInfo?: unknown }>) => string[];
		rec("labels", fn([
			{ path: "/work/project/exts/alpha.ts" },
			{ path: "/work/project/exts/beta/index.ts" },
			{ path: "/work/project/exts/beta/gamma/index.js" },
			{ path: "/work/project/node_modules/@scope/pkg/extensions/index.js", sourceInfo: { baseDir: "/work/project/node_modules/@scope/pkg", source: "npm:@scope/pkg", scope: "project" } },
			{ path: "/single.ts" },
		]));
	});
	scenario("paths.display-source-info-and-scope", (t0) => {
		const t = makeThis(t0);
		const fn = t.getDisplaySourceInfo as (s?: unknown) => unknown;
		rec("undefined", fn(undefined));
		rec("local-user", fn({ scope: "user", source: "local" }));
		rec("local-project", fn({ scope: "project", source: "local" }));
		rec("local-temporary", fn({ scope: "temporary", source: "local" }));
		rec("cli", fn({ scope: "project", source: "cli" }));
		rec("cli-temp", fn({ scope: "temporary", source: "cli" }));
		rec("npm", fn({ scope: "project", source: "npm:pkg" }));
		const scope = t.getScopeGroup as (s?: unknown) => string;
		rec("scope", scope({ scope: "user", source: "local" }), scope({ scope: "project", source: "local" }), scope({ scope: "temporary", source: "cli" }), scope({ scope: "temporary", source: "local" }), scope(undefined));
	});
	scenario("paths.scope-groups", (t0) => {
		const t = makeThis(t0);
		const items = [
			{ path: "/work/project/b.ts" },
			{ path: "/work/project/a.ts" },
			{ path: "/home/u/.pi/skills/s.md", sourceInfo: { scope: "user", source: "local" } },
			{ path: "/work/project/node_modules/p/extensions/e.js", sourceInfo: { baseDir: "/work/project/node_modules/p", source: "npm:p", scope: "project" } },
			{ path: "/work/project/node_modules/p/extensions/a.js", sourceInfo: { baseDir: "/work/project/node_modules/p", source: "npm:p", scope: "project" } },
			{ path: "/tmp/x.ts", sourceInfo: { scope: "temporary", source: "cli" } },
		];
		const groups = (t.buildScopeGroups as (i: unknown[]) => unknown)(items);
		rec("groups", describeArg(groups));
		const formatted = (t.formatScopeGroups as (g: unknown[], o: unknown) => string)(groups, {
			formatPath: (item: AnyRec) => String(item.path),
			formatPackagePath: (item: AnyRec) => String(item.path),
		});
		rec("formatted", formatted.replace(/\x1b\[[0-9;]*m/g, ""));
	});
	scenario("paths.find-source-info", (t0) => {
		const t = makeThis(t0);
		const infos = new Map<string, unknown>([
			["/work/project/node_modules/p", { baseDir: "/work/project/node_modules/p", source: "npm:p", scope: "project" }],
			["/work/project", { scope: "project", source: "local" }],
		]);
		const fn = t.findSourceInfoForPath as (p: string, m: Map<string, unknown>) => unknown;
		rec("exact", fn("/work/project/a.ts", infos) !== undefined);
		rec("parent", describeArg(fn("/work/project/node_modules/p/dist/ext.js", infos)));
		rec("missing", fn("/nowhere/a.ts", infos));
	});
	scenario("paths.format-path-with-source", (t0) => {
		const t = makeThis(t0);
		const fn = t.formatPathWithSource as (p: string, s?: unknown) => string;
		rec("with-source", fn("/work/project/node_modules/p/ext.js", { baseDir: "/work/project/node_modules/p", source: "npm:p", scope: "project" }));
		rec("user-scope", fn("/home/u/.pi/x.md", { scope: "user", source: "local" }));
		rec("temp-scope", fn("/tmp/y.md", { scope: "temporary", source: "cli" }));
		rec("no-source", fn("/outside/path.md"));
	});
	scenario("paths.format-diagnostics", (t0) => {
		const t = makeThis(t0);
		const infos = new Map<string, unknown>([
			["/work/project/skills/a.md", { scope: "project", source: "local" }],
		]);
		const diagnostics = [
			{ type: "collision", message: "duplicate skill", path: "/work/project/skills/a.md", collision: { name: "review", winnerPath: "/work/project/skills/a.md", loserPath: "/work/project/skills/other/review.md" } },
			{ type: "collision", message: "duplicate skill 2", path: "/work/project/skills/other/review.md", collision: { name: "review", winnerPath: "/work/project/skills/a.md", loserPath: "/work/project/skills/other/review.md" } },
			{ type: "warning", message: "bad frontmatter", path: "/work/project/skills/a.md" },
			{ type: "error", message: "load failed", path: undefined },
		];
		const out = (t.formatDiagnostics as (d: unknown[], m: Map<string, unknown>) => string)(diagnostics, infos);
		rec("out", out.replace(/\x1b\[[0-9;]*m/g, ""));
	});
	scenario("paths.format-display-helpers", (t0) => {
		const t = makeThis(t0);
		rec("display", (t.formatDisplayPath as (p: string) => string)("/home/u/x.ts"));
		rec("display-other", (t.formatDisplayPath as (p: string) => string)("/var/x.ts"));
		rec("extension", (t.formatExtensionDisplayPath as (p: string) => string)("/home/u/pack/extensions/index.ts"));
		rec("extension-js", (t.formatExtensionDisplayPath as (p: string) => string)("/var/pack/extensions/index.js"));
		rec("context", (t.formatContextPath as (p: string) => string)("/work/project/AGENTS.md"));
		rec("context-absolute", (t.formatContextPath as (p: string) => string)("/outside/AGENTS.md"));
		rec("startup-expansion", (t.getStartupExpansionState as () => boolean)());
	});
	scenario("paths.show-loaded-resources", (t0) => {
		const session = fakeSessionOf(t0, {});
		(session.resourceLoader as AnyRec).getSkills = () => ({
			skills: [
				{ name: "review", filePath: "/work/project/skills/review.md", description: "Review code", sourceInfo: { scope: "project", source: "local" }, diagnostics: undefined },
				{ name: "deploy", filePath: "/work/project/node_modules/p/skills/deploy.md", description: "Deploy", sourceInfo: { baseDir: "/work/project/node_modules/p", source: "npm:p", scope: "project" } },
			],
			diagnostics: [{ type: "collision", message: "dup", path: "/work/project/skills/review.md", collision: { name: "review", winnerPath: "/work/project/skills/review.md", loserPath: "/work/project/skills/review.md" } }],
		});
		(session.resourceLoader as AnyRec).getPrompts = () => ({
			prompts: [{ name: "fix", filePath: "/work/project/prompts/fix.md", description: "Fix it", argumentHint: "[what]", sourceInfo: { scope: "project", source: "local" } }],
			diagnostics: [],
		});
		(session.resourceLoader as AnyRec).getThemes = () => ({
			themes: [{ name: "solarized", sourcePath: "/work/project/themes/solarized.json", sourceInfo: { scope: "project", source: "local" } }],
			diagnostics: [],
		});
		(session.resourceLoader as AnyRec).getExtensions = () => ({
			extensions: [
				{ path: "/work/project/exts/one.ts", sourceInfo: { scope: "project", source: "local" }, hidden: false },
				{ path: "/work/project/exts/hidden.ts", sourceInfo: { scope: "project", source: "local" }, hidden: true },
				{ path: "/work/project/node_modules/p/extensions/index.js", sourceInfo: { baseDir: "/work/project/node_modules/p", source: "npm:p", scope: "project" }, hidden: false },
			],
			errors: [{ path: "/work/project/exts/broken.ts", error: "syntax error" }],
		});
		(session.resourceLoader as AnyRec).getSystemPromptSource = () => ({ path: "/work/project/AGENTS.md" });
		(session.extensionRunner as AnyRec).getCommandDiagnostics = () => [{ type: "warning", message: "conflicting command", path: "/ext/x.ts" }];
		const t = makeThis({ session, verbose: undefined });
		(t as AnyRec).options = { tuiMode: "regular", verbose: true, startupDiagnostics: [] };
		(t.showLoadedResources as (o?: unknown) => void)({ force: false, showDiagnosticsWhenQuiet: true });
		rec("children", ((t as AnyRec).loadedResourcesContainer as Container).children.map(describeArg));
	});

	// -----------------------------------------------------------------------
	// S15: cycling + toggles + working indicator
	// -----------------------------------------------------------------------
	scenario("cycle.thinking-supported", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { cycleThinkingLevel: () => "high" }) });
		(t.cycleThinkingLevel as () => void)();
	});
	scenario("cycle.thinking-unsupported", (t0) => {
		const t = makeThis(t0);
		(t.cycleThinkingLevel as () => void)();
	});
	scenario("cycle.model-success", (t0) => {
		const t = makeThis({
			session: fakeSessionOf(t0, {
				cycleModel: async () => ({ model: { name: "Claude", id: "claude-x", provider: "anthropic" }, thinkingLevel: "medium" }),
			}),
		});
		return Promise.resolve((t.cycleModel as (d: string) => Promise<void>)("forward"));
	});
	scenario("cycle.model-success-thinking-off", (t0) => {
		const t = makeThis({
			session: fakeSessionOf(t0, {
				cycleModel: async () => ({ model: { name: undefined, id: "m1", provider: "p" }, thinkingLevel: "off" }),
			}),
		});
		return Promise.resolve((t.cycleModel as (d: string) => Promise<void>)("backward"));
	});
	scenario("cycle.model-single-in-scope", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { scopedModels: [{ model: { id: "m" }, thinkingLevel: "off" }] }) });
		return Promise.resolve((t.cycleModel as (d: string) => Promise<void>)("forward"));
	});
	scenario("cycle.model-single-available", (t0) => {
		const t = makeThis(t0);
		return Promise.resolve((t.cycleModel as (d: string) => Promise<void>)("backward"));
	});
	scenario("cycle.model-error", (t0) => {
		const t = makeThis({
			session: fakeSessionOf(t0, { cycleModel: async () => { throw new Error("no models"); } }),
		});
		return Promise.resolve((t.cycleModel as (d: string) => Promise<void>)("forward"));
	});
	scenario("cycle.model-custom-error", (t0) => {
		const t = makeThis({
			session: fakeSessionOf(t0, { cycleModel: async () => { throw "string error"; } }),
		});
		return Promise.resolve((t.cycleModel as (d: string) => Promise<void>)("forward"));
	});
	scenario("toggle.tool-output", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t as AnyRec).builtInHeader = { setExpanded: (v: boolean) => rec("header.setExpanded", v) };
		const child = { setExpanded: (v: boolean) => rec("child.setExpanded", v) };
		((t as AnyRec).chatContainer as Container).addChild(child);
		(t.setToolsExpanded as (v: boolean) => void)(true);
		(t.setToolsExpanded as (v: boolean) => void)(true); // idempotent
		(t.toggleToolOutputExpansion as () => void)();
		rec("final", (t as AnyRec).toolOutputExpanded);
	});
	scenario("toggle.thinking-blocks", (t0) => {
		const t = makeThis(t0);
		const child = { setHideThinkingBlock: (v: boolean) => rec("assistant.setHideThinkingBlock", v) };
		((t as AnyRec).chatContainer as Container).addChild(child);
		(t.toggleThinkingBlockVisibility as () => void)();
		rec("final", (t as AnyRec).hideThinkingBlock);
	});
	scenario("toggle.hidden-thinking-label", (t0) => {
		const t = makeThis(t0);
		const child = { setHiddenThinkingLabel: (v: string) => rec("assistant.setHiddenThinkingLabel", v) };
		((t as AnyRec).chatContainer as Container).addChild(child);
		const streaming = { setHiddenThinkingLabel: (v: string) => rec("streaming.setHiddenThinkingLabel", v) };
		(t as AnyRec).streamingComponent = streaming;
		(t.setHiddenThinkingLabel as (l?: string) => void)("Eliding...");
		(t.setHiddenThinkingLabel as (l?: string) => void)(undefined);
	});
	scenario("working.visible-false", (t0) => {
		const t = makeThis(t0);
		(t.setWorkingVisible as (v: boolean) => void)(false);
	});
	scenario("working.visible-true-while-streaming", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { isStreaming: true }) });
		(t.setWorkingVisible as (v: boolean) => void)(true);
	});
	scenario("working.indicator-options", (t0) => {
		const t = makeThis(t0);
		(t.setWorkingIndicator as (o?: unknown) => void)({ frames: ["a", "b"] });
		(t.setWorkingIndicator as (o?: unknown) => void)(undefined);
	});
	scenario("working.status-indicator-lifecycle", (t0) => {
		const t = makeThis(t0);
		const indicator = { kind: "working", dispose: () => rec("indicator.dispose"), invalidate: () => rec("indicator.invalidate"), setMessage: (m: string) => rec("indicator.setMessage", m), setIndicator: (o: unknown) => rec("indicator.setIndicator", describeArg(o)) };
		(t.showStatusIndicator as (i: unknown) => void)(indicator);
		(t.clearStatusIndicator as (k?: string) => void)("retry"); // wrong kind, no-op
		(t.clearStatusIndicator as (k?: string) => void)("working");
		rec("children", ((t as AnyRec).statusContainer as Container).children.map(describeArg));
	});
	scenario("working.show-working-indicator-non-embedded", (t0) => {
		const t = makeThis(t0);
		(t.defaultEditor as AnyRec).embedWorkingStatus = false;
		(t.showWorkingStatusIndicator as () => void)();
		rec("embedded", (t as AnyRec).activeWorkingIndicatorEmbedded);
		rec("children", ((t as AnyRec).statusContainer as Container).children.map(describeArg));
	});
	scenario("working.editor-embedded", (t0) => {
		const t = makeThis(t0);
		const indicator = { kind: "working", dispose: () => rec("indicator.dispose"), setMessage: (m: string) => rec("indicator.setMessage", m) };
		(t.showStatusIndicator as (i: unknown) => void)(indicator);
		rec("embedded", (t as AnyRec).activeWorkingIndicatorEmbedded);
	});
	scenario("extension.set-status", (t0) => {
		const t = makeThis(t0);
		(t.setExtensionStatus as (k: string, v?: string) => void)("k1", "text");
		(t.setExtensionStatus as (k: string, v?: string) => void)("k1", undefined);
	});

	// -----------------------------------------------------------------------
	// S16: markdown theme / transformers / tool definitions
	// -----------------------------------------------------------------------
	scenario("wire.markdown-theme-and-transformers", (t0) => {
		const t = makeThis(t0);
		rec("theme", describeArg((t.getMarkdownThemeWithSettings as () => unknown)()));
		rec("transformers", describeArg((t.getMarkdownTransformers as () => unknown)()));
		rec("toolDef", describeArg((t.getRegisteredToolDefinition as (n: string) => unknown)("bash")));
	});
	scenario("wire.update-terminal-title", (t0) => {
		const t = makeThis(t0);
		(t.updateTerminalTitle as () => void)();
		(t.sessionManager as AnyRec).getSessionName = () => "named session";
		(t.updateTerminalTitle as () => void)();
	});
	scenario("wire.changelog-resumed-session", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { state: { messages: [{ role: "user", content: "x" }] } }) });
		return Promise.resolve((t.getChangelogForDisplay as () => Promise<string | undefined>)()).then((r) => rec("result", r));
	});
	scenario("wire.changelog-fresh-install", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { settingsManager: settingsWith({ getLastChangelogVersion: () => undefined }) }) });
		patchProcess({ platform: "linux", env: {} });
		try {
			return Promise.resolve((t.getChangelogForDisplay as () => Promise<string | undefined>)()).then((r) => rec("result", r));
		} finally {
			restoreProcess();
		}
	});
	scenario("wire.changelog-new-entries", (t0) => {
		const t = makeThis(t0);
		patchProcess({ platform: "linux", env: {} });
		try {
			return Promise.resolve((t.getChangelogForDisplay as () => Promise<string | undefined>)()).then((r) => rec("result", r));
		} finally {
			restoreProcess();
		}
	});
	scenario("wire.changelog-no-new-entries", (t0) => {
		const t = makeThis({ session: fakeSessionOf(t0, { settingsManager: settingsWith({ getLastChangelogVersion: () => "9.9.9" }) }) });
		patchProcess({ platform: "linux", env: {} });
		try {
			return Promise.resolve((t.getChangelogForDisplay as () => Promise<string | undefined>)()).then((r) => rec("result", r));
		} finally {
			restoreProcess();
		}
	});
	scenario("wire.update-available-provider-count", (t0) => {
		const t = makeThis(t0);
		(t.updateAvailableProviderCount as () => void)();
	});
	scenario("wire.autocomplete-provider", (t0) => {
		const t = makeThis(t0);
		(t.setupAutocompleteProvider as () => void)();
		rec("wrappers-empty", (t as AnyRec).autocompleteProviderWrappers.length);
	});
	scenario("wire.base-autocomplete-provider", (t0) => {
		const t = makeThis(t0);
		(t.createBaseAutocompleteProvider as () => unknown)();
		rec("skillCommands", describeArg((t as AnyRec).skillCommands));
	});
	scenario("wire.tmux-check-disabled", (t0) => {
		const t = makeThis(t0);
		patchProcess({ platform: "linux", env: {} });
		try {
			return Promise.resolve((t.checkTmuxKeyboardSetup as () => Promise<string | undefined>)()).then((r) => rec("result", r));
		} finally {
			restoreProcess();
		}
	});
	scenario("wire.package-updates-offline", (t0) => {
		const t = makeThis(t0);
		patchProcess({ platform: "linux", env: { PI_OFFLINE: "1" } });
		try {
			return Promise.resolve((t.checkForPackageUpdates as () => Promise<string[]>)()).then((r) => rec("result", describeArg(r)));
		} finally {
			restoreProcess();
		}
	});
	scenario("wire.package-updates-found", (t0) => {
		const t = makeThis(t0);
		patchProcess({ platform: "linux", env: {} });
		try {
			return Promise.resolve((t.checkForPackageUpdates as () => Promise<string[]>)()).then((r) => rec("result", describeArg(r)));
		} finally {
			restoreProcess();
		}
	});

	// -----------------------------------------------------------------------
	// S17: session (re)binding
	// -----------------------------------------------------------------------
	scenario("rebind.ordering", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		return Promise.resolve((t.rebindCurrentSession as (o?: unknown) => Promise<void>)());
	});
	scenario("rebind.render-before-bind", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		return Promise.resolve((t.rebindCurrentSession as (o?: unknown) => Promise<void>)({ renderBeforeBind: true }));
	});
	scenario("rebind.session-replaced-mid-bind", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		const original = t.session as AnyRec;
		return Promise.resolve(
			(t.rebindCurrentSession as (o?: unknown) => Promise<void>)().then(() => {
				// simulate replacement during bind by swapping the runtime session getter
				(t.runtimeHost as AnyRec).session = fakeSessionOf(t0, {});
				rec("same-session", (t.session as AnyRec) === original);
			}),
		);
	});
	scenario("rebind.apply-runtime-settings", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.applyRuntimeSettings as () => void)();
	});
	scenario("rebind.render-current-state", (t0) => {
		const session = fakeSessionOf(t0, {});
		(session.sessionManager as AnyRec).buildContextEntries = () => [];
		const t = makeThis(withCommandStubs({ session }));
		(t as AnyRec).compactionQueuedMessages = [{ text: "x", mode: "steer" }];
		(t.renderCurrentSessionState as () => void)();
		rec("queued", (t as AnyRec).compactionQueuedMessages.length);
	});
	scenario("rebind.fatal-runtime-error", async (t0) => {
		const t = makeThis(withCommandStubs(t0));
		patchProcess({ platform: "linux", isTTY: true });
		try {
			await (t.handleFatalRuntimeError as (p: string, e: unknown) => Promise<never>)("Failed to fork session", new Error("boom"));
		} catch {
			// process.exit records and returns undefined in the fake process
		} finally {
			restoreProcess();
		}
	});
	scenario("rebind.bind-extensions", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		return Promise.resolve((t.bindCurrentSessionExtensions as () => Promise<void>)());
	});
	scenario("rebind.bind-extensions-command-context", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		const session = t.session as AnyRec;
		return Promise.resolve((t.bindCurrentSessionExtensions as () => Promise<void>)()).then(async () => {
			const options = (t as AnyRec).__bindOptions as AnyRec | undefined;
			void options;
			// drive the recorded bindExtensions options: commandContextActions.newSession / fork / navigateTree / shutdownHandler / abortHandler
			const bindCall = (t as AnyRec).__bindOptions;
			void bindCall;
			void session;
		});
	});

	// -----------------------------------------------------------------------
	// S18: extension widget/footer/header choreography
	// -----------------------------------------------------------------------
	scenario("extension.widgets", (t0) => {
		const t = makeThis(t0);
		(t.setExtensionWidget as (k: string, c: unknown, o?: unknown) => void)("w1", ["line one", "line two"]);
		(t.setExtensionWidget as (k: string, c: unknown, o?: unknown) => void)("w2", ["a"], { placement: "belowEditor" });
		(t.setExtensionWidget as (k: string, c: unknown, o?: unknown) => void)("w1", undefined);
		(t.setExtensionWidget as (k: string, c: unknown, o?: unknown) => void)("w2", ["b", "c", "d"], { placement: "belowEditor" });
		rec("above", describeArg((t as AnyRec).widgetContainerAbove));
		rec("below", describeArg((t as AnyRec).widgetContainerBelow));
	});
	scenario("extension.widgets-truncated", (t0) => {
		const t = makeThis(t0);
		(t.setExtensionWidget as (k: string, c: unknown, o?: unknown) => void)("big", Array.from({ length: 12 }, (_, i) => `line ${i}`));
		rec("above", describeArg((t as AnyRec).widgetContainerAbove));
	});
	scenario("extension.widgets-cleared", (t0) => {
		const t = makeThis(t0);
		(t.setExtensionWidget as (k: string, c: unknown, o?: unknown) => void)("w1", ["x"]);
		(t.clearExtensionWidgets as () => void)();
		rec("above", describeArg((t as AnyRec).widgetContainerAbove));
	});
	scenario("extension.footer-swap", (t0) => {
		const t = makeThis(t0);
		const custom = { describe: () => ({ kind: "CustomFooter" }), dispose: () => rec("customFooter.dispose") };
		(t.setExtensionFooter as (f: unknown) => void)(() => custom);
		rec("footerChildren", describeArg((t as AnyRec).footerContainer));
		(t.setExtensionFooter as (f: unknown) => void)(undefined);
		rec("footerChildren", describeArg((t as AnyRec).footerContainer));
	});
	scenario("extension.header-swap", (t0) => {
		const t = makeThis(t0);
		(t as AnyRec).builtInHeader = { describe: () => ({ kind: "BuiltInHeader" }), setExpanded: (v: boolean) => rec("builtInHeader.setExpanded", v) };
		((t as AnyRec).headerContainer as Container).addChild((t as AnyRec).builtInHeader);
		const custom = { describe: () => ({ kind: "CustomHeader" }), dispose: () => rec("customHeader.dispose") };
		(t.setExtensionHeader as (f: unknown) => void)(() => custom);
		rec("headerChildren", describeArg((t as AnyRec).headerContainer));
		(t.setExtensionHeader as (f: unknown) => void)(undefined);
		rec("headerChildren", describeArg((t as AnyRec).headerContainer));
	});
	scenario("extension.header-before-init", (t0) => {
		const t = makeThis(t0);
		(t.setExtensionHeader as (f: unknown) => void)(() => ({ describe: () => ({ kind: "CustomHeader" }) }));
	});
	scenario("extension.terminal-input-listeners", (t0) => {
		const t = makeThis(t0);
		const unsub = (t.addExtensionTerminalInputListener as (h: unknown) => () => void)(() => undefined);
		rec("subscriptions", (t as AnyRec).extensionTerminalInputSubscriptions.size);
		(t.rebindExtensionTerminalInputListeners as () => void)();
		unsub();
		rec("subscriptions", (t as AnyRec).extensionTerminalInputSubscriptions.size);
	});
	scenario("extension.custom-editor-swap", (t0) => {
		const t = makeThis(t0);
		(t.defaultEditor as AnyRec)._state.text = "saved text";
		(t.setCustomEditorComponent as (f: unknown) => void)(() => {
			const custom = fakeEditor("customEditor");
			custom.actionHandlers = new Map();
			return custom;
		});
		rec("editorIsCustom", (t as AnyRec).editor !== (t as AnyRec).defaultEditor);
		rec("customText", ((t as AnyRec).editor as AnyRec)._state.text);
		(t.setCustomEditorComponent as (f: unknown) => void)(undefined);
		rec("editorIsDefault", (t as AnyRec).editor === (t as AnyRec).defaultEditor);
		rec("defaultText", (t.defaultEditor as AnyRec)._state.text);
	});
	scenario("extension.reset-ui", (t0) => {
		const t = makeThis(t0);
		(t.resetExtensionUI as () => void)();
	});
	scenario("extension.notify", (t0) => {
		const t = makeThis(t0);
		(t.showExtensionNotify as (m: string, t2?: string) => void)("info msg", "info");
		(t.showExtensionNotify as (m: string, t2?: string) => void)("warn msg", "warning");
		(t.showExtensionNotify as (m: string, t2?: string) => void)("error msg", "error");
		(t.showExtensionNotify as (m: string, t2?: string) => void)("default msg", undefined);
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("extension.error-with-stack", (t0) => {
		const t = makeThis(t0);
		(t.showExtensionError as (p: string, e: string, s?: string) => void)("/ext/a.ts", "boom", "Error: boom\n    at f (/ext/a.ts:1:1)\n    at g (/ext/b.ts:2:2)");
		rec("children", ((t as AnyRec).chatContainer as Container).children.map(describeArg));
	});
	scenario("extension.selector-lifecycle", (t0) => {
		const t = makeThis(t0);
		const component = { describe: () => ({ kind: "SelectorStub" }) };
		(t.showSelector as (c: unknown) => void)((done: () => void) => {
			rec("selectorFactoryCalled");
			done();
			return { component, focus: component };
		});
		rec("editorChildren", describeArg((t as AnyRec).editorContainer));
	});
	scenario("extension.selector-dispose-active", (t0) => {
		const t = makeThis(t0);
		const first = { describe: () => ({ kind: "Selector1" }) };
		(t.showSelector as (c: unknown) => void)(() => ({ component: first, focus: first, dispose: () => rec("selector1.dispose") }));
		const second = { describe: () => ({ kind: "Selector2" }) };
		(t.showSelector as (c: unknown) => void)(() => ({ component: second, focus: second, dispose: () => rec("selector2.dispose") }));
		(t.disposeActiveSelector as () => void)();
		rec("tokenCleared", (t as AnyRec).activeSelectorToken === undefined);
	});

	// -----------------------------------------------------------------------
	// S19: clipboard
	// -----------------------------------------------------------------------
	scenario("clipboard.paste-text", (t0) => {
		const t = makeThis(t0);
		return Promise.resolve((t.handleClipboardPaste as () => Promise<void>)());
	});
	scenario("clipboard.right-click-paste", (t0) => {
		const t = makeThis(t0);
		const target = { handleInput: (d: string) => rec("target.handleInput", d) };
		(t.renderer as AnyRec).getFocusedComponent = () => target;
		return Promise.resolve((t.handleRightClickPaste as () => Promise<void>)());
	});

	// -----------------------------------------------------------------------
	// S20: stop / lifecycle
	// -----------------------------------------------------------------------
	scenario("lifecycle.stop-regular", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.stop as (o?: unknown) => void)();
		rec("isInitialized", (t as AnyRec).isInitialized);
	});
	scenario("lifecycle.stop-fullscreen-transcript", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		let overlays = 1;
		const renderer = t.renderer as AnyRec;
		renderer.mode = "fullscreen";
		Object.defineProperty(renderer, "hasOverlayEntries", { get: () => overlays > 0 });
		renderer.hideOverlay = () => {
			rec("renderer.hideOverlay");
			overlays -= 1;
		};
		renderer.renderNow = () => rec("renderer.renderNow");
		(t as AnyRec).fullscreenLayoutRoot = { tag: "root" };
		rec("switchResult", (t.switchTuiMode as (m: string, r?: boolean, s?: boolean) => boolean)("regular", false, false));
		(t.stop as (o?: unknown) => void)("transcript");
	});
	scenario("lifecycle.stop-idempotent-tui", (t0) => {
		const t = makeThis(withCommandStubs(t0));
		(t.stop as (o?: unknown) => void)();
		rec("isInitialized", (t as AnyRec).isInitialized);
		(t.stop as (o?: unknown) => void)();
	});
	scenario("lifecycle.mount-interactive-tui", (t0) => {
		const t = makeThis({
			...t0,
			renderer: {
				mode: "regular",
				addChild: (c: unknown) => rec("renderer.addChild", describeArg(c)),
				children: [] as unknown[],
			},
		});
		const children = [
			Object.assign(new Container(), { containerName: "a" }),
			Object.assign(new Container(), { containerName: "b" }),
		];
		(t.mountInteractiveTui as (tui: unknown, components: unknown[]) => void)(t.renderer, children);
		rec("rendererChildren", ((t.renderer as AnyRec).children as unknown[]).length);
	});
	scenario("lifecycle.subscribe-to-agent", (t0) => {
		const t = makeThis(t0);
		(t.subscribeToAgent as () => void)();
		rec("unsubscribeSet", (t as AnyRec).unsubscribe !== undefined);
		((t as AnyRec).unsubscribe as () => void)();
	});

	return 0;
}
