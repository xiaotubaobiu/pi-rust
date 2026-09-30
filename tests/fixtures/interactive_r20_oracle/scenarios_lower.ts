// r20 oracle scenarios — lower half: selectors, command handlers, exits.
// register() is called by drive_lower.ts.
import type { AnyRec } from "./drive_lower.ts";

type ScenarioFn = (name: string, run: (t: AnyRec) => unknown | Promise<unknown>) => void;

interface Ctx {
	makeThis: (overrides?: AnyRec) => AnyRec;
	fakeEditor: (name?: string) => AnyRec;
	fakeSession: (overrides?: AnyRec) => AnyRec;
	fakeSettingsManager: (overrides?: AnyRec) => AnyRec;
	fakeSessionManager: (overrides?: AnyRec) => AnyRec;
	fakeModelRuntime: (overrides?: AnyRec) => AnyRec;
	fakeExtensionRunner: (overrides?: AnyRec) => AnyRec;
	fakeResourceLoader: (overrides?: AnyRec) => AnyRec;
	fakeUi: () => AnyRec;
	sessionBag: AnyRec;
	describeArg: (v: unknown) => unknown;
	theme: AnyRec;
	Container: new (...a: unknown[]) => AnyRec;
	Text: new (...a: unknown[]) => AnyRec;
	Spacer: new (...a: unknown[]) => AnyRec;
	LOG: unknown[];
	rec: (...parts: unknown[]) => void;
	DEPS: AnyRec;
}

export function register(scenario: ScenarioFn, ctx: Ctx): number {
	const {
		makeThis, fakeEditor, fakeSession, fakeSettingsManager, fakeSessionManager,
		fakeModelRuntime, fakeExtensionRunner, fakeResourceLoader, fakeUi,
		sessionBag, describeArg, theme, Text, Spacer, LOG, rec, DEPS,
	} = ctx;

	// helpers ---------------------------------------------------------------
	function lastNew(t: AnyRec, kind: string): AnyRec | undefined {
		// the created component instance is the last child of the editor container
		const children = (t.editorContainer as AnyRec).children as unknown[];
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i] as AnyRec;
			if (child && typeof child.describe === "function") {
				const described = child.describe() as AnyRec;
				if (described.kind === kind) return child;
			}
		}
		return undefined;
	}
	function ctorArgs(instance: AnyRec): unknown[] {
		return (instance.args as unknown[]) ?? [];
	}

	// -- settings selector ----------------------------------------------------
	scenario("settings.open", (t0) => {
		const t = makeThis(t0);
		return (t.showSettingsSelector as () => void)();
	});
	scenario("settings.cancel", async (t0) => {
		const t = makeThis(t0);
		(t.showSettingsSelector as () => void)();
		const selector = lastNew(t, "SettingsSelectorComponent")!;
		const callbacks = ctorArgs(selector)[1] as AnyRec;
		(callbacks.onCancel as () => void)();
	});
	scenario("settings.autoCompact", async (t0) => {
		const t = makeThis(t0);
		(t.showSettingsSelector as () => void)();
		const selector = lastNew(t, "SettingsSelectorComponent")!;
		const callbacks = ctorArgs(selector)[1] as AnyRec;
		(callbacks.onAutoCompactChange as (v: boolean) => void)(false);
		(callbacks.onCancel as () => void)();
	});
	scenario("settings.hideThinking", async (t0) => {
		const t = makeThis(t0);
		(t.showSettingsSelector as () => void)();
		const selector = lastNew(t, "SettingsSelectorComponent")!;
		const callbacks = ctorArgs(selector)[1] as AnyRec;
		(callbacks.onHideThinkingBlockChange as (v: boolean) => void)(true);
		(callbacks.onCancel as () => void)();
	});
	scenario("settings.outputPad.rebuild", async (t0) => {
		const t = makeThis(t0);
		(t.showSettingsSelector as () => void)();
		const selector = lastNew(t, "SettingsSelectorComponent")!;
		const callbacks = ctorArgs(selector)[1] as AnyRec;
		(callbacks.onOutputPadChange as (v: number) => void)(3);
		(callbacks.onCancel as () => void)();
	});
	scenario("settings.tuiMode.conflict", async (t0) => {
		const t = makeThis({ ui: Object.assign(fakeUi(), { hasOverlayEntries: true }) });
		(t.showSettingsSelector as () => void)();
		const selector = lastNew(t, "SettingsSelectorComponent")!;
		const callbacks = ctorArgs(selector)[1] as AnyRec;
		(callbacks.onTuiModeChange as (m: string) => void)("fullscreen");
		(callbacks.onCancel as () => void)();
	});
	scenario("settings.tuiMode.ok", async (t0) => {
		const t = makeThis(t0);
		(t.showSettingsSelector as () => void)();
		const selector = lastNew(t, "SettingsSelectorComponent")!;
		const callbacks = ctorArgs(selector)[1] as AnyRec;
		(callbacks.onTuiModeChange as (m: string) => void)("fullscreen");
		(callbacks.onCancel as () => void)();
	});
	scenario("settings.showHardwareCursor", async (t0) => {
		const t = makeThis(t0);
		(t.showSettingsSelector as () => void)();
		const selector = lastNew(t, "SettingsSelectorComponent")!;
		const callbacks = ctorArgs(selector)[1] as AnyRec;
		(callbacks.onShowHardwareCursorChange as (v: boolean) => void)(true);
		(callbacks.onClearOnShrinkChange as (v: boolean) => void)(false);
		(callbacks.onCancel as () => void)();
	});

	// -- thinking --------------------------------------------------------------
	scenario("thinking.command.unknown", (t0) => {
		const t = makeThis(t0);
		return (t.handleThinkingCommand as (s?: string) => void)("bogus");
	});
	scenario("thinking.command.known", (t0) => {
		const t = makeThis(t0);
		return (t.handleThinkingCommand as (s?: string) => void)("high");
	});
	scenario("thinking.command.bare", (t0) => {
		const t = makeThis(t0);
		return (t.handleThinkingCommand as (s?: string) => void)();
	});
	scenario("thinking.selector.persist", async (t0) => {
		const t = makeThis(t0);
		(t.showThinkingSelector as () => void)();
		const selector = lastNew(t, "ThinkingSelectorComponent")!;
		const args = ctorArgs(selector);
		(args[2] as (l: string) => void)("low"); // onSelect
	});
	scenario("thinking.selector.persistDefault", async (t0) => {
		const t = makeThis(t0);
		(t.showThinkingSelector as () => void)();
		const selector = lastNew(t, "ThinkingSelectorComponent")!;
		const args = ctorArgs(selector);
		(args[4] as (l: string) => void)("high"); // onPersist
	});
	scenario("thinking.selector.cancel", async (t0) => {
		const t = makeThis(t0);
		(t.showThinkingSelector as () => void)();
		const selector = lastNew(t, "ThinkingSelectorComponent")!;
		(ctorArgs(selector)[3] as () => void)(); // onCancel
	});

	// -- model -------------------------------------------------------------------
	scenario("model.command.exact", (t0) => {
		const t = makeThis(t0);
		return (t.handleModelCommand as (s?: string) => Promise<void>)("openai/gpt-5.5");
	});
	scenario("model.command.exact.bare-id", (t0) => {
		const t = makeThis(t0);
		return (t.handleModelCommand as (s?: string) => Promise<void>)("gpt-5.5");
	});
	scenario("model.command.miss.fallsToSelector", (t0) => {
		const t = makeThis(t0);
		return (t.handleModelCommand as (s?: string) => Promise<void>)("nope");
	});
	scenario("model.command.miss.refresh.thenSelector", (t0) => {
		const runtime = fakeModelRuntime({
			getAvailableSnapshot: () => [],
			refresh: async () => {
				rec("modelRuntime.refresh");
				return { aborted: false, errors: new Map() };
			},
		});
		const session = fakeSession({ modelRuntime: runtime });
		const t = makeThis({ session });
		return (t.handleModelCommand as (s?: string) => Promise<void>)("gpt-5.5");
	});
	scenario("model.command.setError", (t0) => {
		const session = fakeSession({
			setModel: async () => {
				throw new Error("model rejected");
			},
		});
		const t = makeThis({ session });
		return (t.handleModelCommand as (s?: string) => Promise<void>)("openai/gpt-5.5");
	});
	scenario("model.selector.select", async (t0) => {
		const t = makeThis(t0);
		(t.showModelSelector as (s?: string) => void)("gpt");
		const selector = lastNew(t, "ModelSelectorComponent")!;
		const args = ctorArgs(selector);
		await (args[4] as (m: AnyRec) => Promise<void>)({ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" });
	});
	scenario("model.selector.persist", async (t0) => {
		const t = makeThis(t0);
		(t.showModelSelector as (s?: string) => void)();
		const selector = lastNew(t, "ModelSelectorComponent")!;
		const args = ctorArgs(selector);
		await (args[7] as (m: AnyRec) => Promise<void>)({ provider: "anthropic", id: "claude-opus-4-8" });
	});
	scenario("model.selector.cancel", async (t0) => {
		const t = makeThis(t0);
		(t.showModelSelector as (s?: string) => void)();
		const selector = lastNew(t, "ModelSelectorComponent")!;
		(ctorArgs(selector)[5] as () => void)();
	});
	scenario("model.selector.dispose", async (t0) => {
		const t = makeThis(t0);
		(t.showModelSelector as (s?: string) => void)();
		const selector = lastNew(t, "ModelSelectorComponent")!;
		(selector.dispose as () => void)();
		(t.disposeActiveSelector as () => void)();
	});

	// -- scoped models ---------------------------------------------------------
	scenario("models.selector.toggleAndPersist", async (t0) => {
		const t = makeThis(t0);
		await (t.showModelsSelector as () => Promise<void>)();
		const selector = lastNew(t, "ScopedModelsSelectorComponent")!;
		const callbacks = ctorArgs(selector)[1] as AnyRec;
		(callbacks.onChange as (ids: string[] | null) => void)(["anthropic/claude-opus-4-8"]);
		(callbacks.onChange as (ids: string[] | null) => void)(["anthropic/claude-opus-4-8", "openai/gpt-5.5"]);
		(callbacks.onChange as (ids: string[] | null) => void)(null);
		(callbacks.onPersist as (ids: string[] | null) => void)(["anthropic/claude-opus-4-8"]);
		(callbacks.onCancel as () => void)();
	});
	scenario("models.selector.persistAll", async (t0) => {
		const t = makeThis(t0);
		await (t.showModelsSelector as () => Promise<void>)();
		const selector = lastNew(t, "ScopedModelsSelectorComponent")!;
		const callbacks = ctorArgs(selector)[1] as AnyRec;
		(callbacks.onPersist as (ids: string[] | null) => void)(["anthropic/claude-opus-4-8", "openai/gpt-5.5"]);
		(callbacks.onPersist as (ids: string[] | null) => void)(null);
		(callbacks.onCancel as () => void)();
	});

	// -- fork / user message selector --------------------------------------------
	scenario("fork.empty", (t0) => {
		const t = makeThis(t0);
		return (t.showUserMessageSelector as () => void)();
	});
	scenario("fork.select", async (t0) => {
		const session = fakeSession({
			getUserMessagesForForking: () => [
				{ entryId: "e1", text: "first" },
				{ entryId: "e2", text: "second" },
			],
		});
		const t = makeThis({ session });
		(t.showUserMessageSelector as () => void)();
		const selector = lastNew(t, "UserMessageSelectorComponent")!;
		const args = ctorArgs(selector);
		await (args[1] as (id: string) => Promise<void>)("e2");
	});
	scenario("fork.cancel", async (t0) => {
		const session = fakeSession({
			getUserMessagesForForking: () => [{ entryId: "e1", text: "first" }],
		});
		const t = makeThis({ session });
		(t.showUserMessageSelector as () => void)();
		const selector = lastNew(t, "UserMessageSelectorComponent")!;
		(ctorArgs(selector)[2] as () => void)();
	});
	scenario("clone.fresh", (t0) => {
		const t = makeThis(t0);
		return (t.handleCloneCommand as () => Promise<void>)();
	});
	scenario("clone.ok", (t0) => {
		const t = makeThis(t0);
		return (t.handleCloneCommand as () => Promise<void>)();
	});

	// -- tree ---------------------------------------------------------------------
	scenario("tree.empty", (t0) => {
		const t = makeThis(t0);
		return (t.showTreeSelector as (s?: string) => void)();
	});
	scenario("tree.leaf.noop", async (t0) => {
		const manager = fakeSessionManager({
			getTree: () => [{ id: "leaf-1", type: "message" }],
			getLeafId: () => "leaf-1",
		});
		const session = fakeSession({ sessionManager: manager });
		const t = makeThis({ session, sessionManager: manager });
		(t.showTreeSelector as (s?: string) => void)();
		const selector = lastNew(t, "TreeSelectorComponent")!;
		await (ctorArgs(selector)[3] as (id: string) => Promise<void>)("leaf-1");
	});
	scenario("tree.navigate.noSummary", async (t0) => {
		const manager = fakeSessionManager({
			getTree: () => [{ id: "leaf-1", type: "message" }, { id: "e0", type: "message" }],
			getLeafId: () => "leaf-1",
		});
		const session = fakeSession({ sessionManager: manager });
		const t = makeThis({ session, sessionManager: manager });
		(t.showTreeSelector as (s?: string) => void)();
		const selector = lastNew(t, "TreeSelectorComponent")!;
		const selectPromise = (ctorArgs(selector)[3] as (id: string) => Promise<void>)("e0");
		// summary dialog appears as an ExtensionSelectorComponent
		const summary = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(summary)[2] as (o: string | undefined) => void)(undefined); // escape → re-show
		await selectPromise;
	});
	scenario("tree.navigate.withSummary", async (t0) => {
		const manager = fakeSessionManager({
			getTree: () => [{ id: "leaf-1", type: "message" }, { id: "e0", type: "message" }],
			getLeafId: () => "leaf-1",
		});
		const session = fakeSession({ sessionManager: manager });
		const t = makeThis({ session, sessionManager: manager });
		(t.showTreeSelector as (s?: string) => void)();
		const selector = lastNew(t, "TreeSelectorComponent")!;
		const selectPromise = (ctorArgs(selector)[3] as (id: string) => Promise<void>)("e0");
		const summary = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(summary)[2] as (o: string | undefined) => void)("Summarize");
		await selectPromise;
	});
	scenario("tree.navigate.customPromptCancelled", async (t0) => {
		const manager = fakeSessionManager({
			getTree: () => [{ id: "leaf-1", type: "message" }, { id: "e0", type: "message" }],
			getLeafId: () => "leaf-1",
		});
		const session = fakeSession({ sessionManager: manager });
		const t = makeThis({ session, sessionManager: manager });
		(t.showTreeSelector as (s?: string) => void)();
		const selector = lastNew(t, "TreeSelectorComponent")!;
		const selectPromise = (ctorArgs(selector)[3] as (id: string) => Promise<void>)("e0");
		const summary = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(summary)[2] as (o: string | undefined) => void)("Summarize with custom prompt");
		// let the editor dialog open, then cancel it through its own cancel
		// callback (ctor arg 5: ui, keybindings, title, prefill, submit, cancel)
		await new Promise((r) => setImmediate(r));
		const editorDialog = lastNew(t, "ExtensionEditorComponent")!;
		(ctorArgs(editorDialog)[5] as () => void)();
		// loop continues: pick "No summary" this time (let the cancel
		// continuation re-open the summary selector first)
		await new Promise((r) => setImmediate(r));
		const summary2 = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(summary2)[2] as (o: string | undefined) => void)("No summary");
		await selectPromise;
	});
	scenario("tree.copy.noText", async (t0) => {
		const manager = fakeSessionManager({
			getTree: () => [{ id: "leaf-1", type: "message" }],
			getLeafId: () => "leaf-1",
		});
		const session = fakeSession({ sessionManager: manager });
		const t = makeThis({ session, sessionManager: manager });
		(t.showTreeSelector as (s?: string) => void)();
		const selector = lastNew(t, "TreeSelectorComponent")!;
		const onCopy = (selector as AnyRec).onCopy as ((text: string) => Promise<void>) | undefined;
		if (!onCopy) {
			LOG.push(["tree.onCopy.missing"]);
			return;
		}
		await onCopy("");
	});
	scenario("tree.copy.ok", async (t0) => {
		const manager = fakeSessionManager({
			getTree: () => [{ id: "leaf-1", type: "message" }],
			getLeafId: () => "leaf-1",
		});
		const session = fakeSession({ sessionManager: manager });
		const t = makeThis({ session, sessionManager: manager });
		(t.showTreeSelector as (s?: string) => void)();
		const selector = lastNew(t, "TreeSelectorComponent")!;
		const onCopy = (selector as AnyRec).onCopy as ((text: string) => Promise<void>) | undefined;
		if (!onCopy) {
			LOG.push(["tree.onCopy.missing"]);
			return;
		}
		await onCopy("entry text");
	});

	// -- session selector / resume -------------------------------------------------
	scenario("session.selector.open", (t0) => {
		const t = makeThis(t0);
		return (t.showSessionSelector as () => void)();
	});
	scenario("resume.ok", (t0) => {
		const t = makeThis(t0);
		return (t.handleResumeSession as (p: string) => Promise<unknown>)("/s/other.jsonl");
	});
	scenario("resume.missingCwd.confirmed", async (t0) => {
		const host = makeThis(t0).runtimeHost as AnyRec;
		const MissingCwd = DEPS.MissingSessionCwdError as new (i: unknown) => Error;
		host.switchSession = async (...args: unknown[]) => {
			const options = args[1] as AnyRec | undefined;
			if (!options?.cwdOverride) {
				throw new MissingCwd({ fallbackCwd: "/fallback" });
			}
			return { cancelled: false };
		};
		const t = makeThis({ runtimeHost: host });
		const guarded = (t.handleResumeSession as (p: string) => Promise<unknown>)("/s/other.jsonl")
			.then(
				(r: unknown) => ({ result: r }),
				(error: unknown) => ({ error: (error as Error).message }),
			);
		// let the failure surface and the missing-cwd confirm dialog open
		await new Promise((r) => setImmediate(r));
		const confirm = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(confirm)[2] as (o: string) => void)("Yes");
		LOG.push(["resumeOutcome", await guarded]);
	});

	// -- trust ------------------------------------------------------------------------
	scenario("trust.open", (t0) => {
		const t = makeThis(t0);
		(t.showTrustSelector as () => void)();
		const selector = lastNew(t, "TrustSelectorComponent")!;
		const config = ctorArgs(selector)[0] as AnyRec;
		(config.onSelect as (s: unknown) => void)({ trusted: true, updates: [{ cwd: "/w", trusted: true }] });
	});
	scenario("trust.cancel", (t0) => {
		const t = makeThis(t0);
		(t.showTrustSelector as () => void)();
		const selector = lastNew(t, "TrustSelectorComponent")!;
		const config = ctorArgs(selector)[0] as AnyRec;
		(config.onCancel as () => void)();
	});
	scenario("trust.autoSaveAfterReload", (t0) => {
		const t = makeThis({ autoTrustOnReloadCwd: "/work/project" });
		// force hasTrustRequiringProjectResources true through the body's dep —
		// the extracted body calls the module fn directly; drive via the shell
		// method with the stubbed global (returns false) exercises the early-out.
		return (t.maybeSaveImplicitProjectTrustAfterReload as () => boolean)();
	});

	// -- login ladders -----------------------------------------------------------------
	scenario("login.bare", (t0) => {
		const t = makeThis(t0);
		return (t.handleLoginCommand as (r?: string) => Promise<void>)();
	});
	scenario("login.byName.unique", (t0) => {
		const t = makeThis(t0);
		return (t.handleLoginCommand as (r?: string) => Promise<void>)("OpenAI");
	});
	scenario("login.byName.ambiguous", (t0) => {
		const runtime = fakeModelRuntime({
			getProviders: () => [
				{ id: "a1", name: "Same", auth: { apiKey: true } },
				{ id: "a2", name: "Same", auth: { apiKey: true } },
			],
		});
		const t = makeThis({ session: fakeSession({ modelRuntime: runtime }) });
		return (t.handleLoginCommand as (r?: string) => Promise<void>)("same");
	});
	scenario("login.byName.unknown", (t0) => {
		const t = makeThis(t0);
		return (t.handleLoginCommand as (r?: string) => Promise<void>)("mystery");
	});
	scenario("login.authType.oauth", (t0) => {
		const t = makeThis(t0);
		(t.showLoginAuthTypeSelector as () => void)();
		const selector = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(selector)[2] as (o: string) => void)("Sign in with an account");
	});
	scenario("login.provider.oauth", (t0) => {
		const t = makeThis(t0);
		(t.showLoginProviderSelector as (a?: string) => void)("oauth");
		const selector = lastNew(t, "OAuthSelectorComponent")!;
		const args = ctorArgs(selector);
		return (args[2] as (id: string, t2: string) => Promise<void>)("anthropic", "oauth");
	});
	scenario("login.provider.empty", (t0) => {
		const runtime = fakeModelRuntime({ getProviders: () => [] });
		const t = makeThis({ session: fakeSession({ modelRuntime: runtime }) });
		(t.showLoginProviderSelector as (a?: string) => void)("oauth");
		(t.showLoginProviderSelector as (a?: string) => void)("api_key");
		(t.showLoginProviderSelector as (a?: string) => void)();
	});
	scenario("login.oauthDialog", (t0) => {
		const t = makeThis(t0);
		return (t.showLoginDialog as (id: string, name: string) => Promise<void>)("anthropic", "Anthropic");
	});
	scenario("login.apiKeyDialog", (t0) => {
		const t = makeThis(t0);
		return (t.showApiKeyLoginDialog as (id: string, name: string) => Promise<void>)("openai", "OpenAI");
	});
	scenario("login.ambient", (t0) => {
		const t = makeThis(t0);
		return (t.showAmbientAuthDialog as (o: unknown) => Promise<void>)({
			id: "ollama", name: "Ollama", authType: "api_key", method: undefined, status: undefined,
		});
	});
	scenario("login.bedrockDetails", (t0) => {
		const t = makeThis(t0);
		return (t.showApiKeyLoginDialog as (id: string, name: string) => Promise<void>)("amazon-bedrock", "Bedrock");
	});
	scenario("login.authSelect", (t0) => {
		const t = makeThis(t0);
		const dialog = { describe: () => ({ kind: "LoginDialogComponent" }) } as AnyRec;
		const promise = (t.showAuthSelect as (d: AnyRec, p: unknown) => Promise<string>)(
			dialog,
			{ type: "select", message: "Pick one", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
		);
		const selector = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(selector)[2] as (o: string) => void)("B");
		return promise;
	});
	scenario("login.authSelect.cancelled", (t0) => {
		const t = makeThis(t0);
		const dialog = { describe: () => ({ kind: "LoginDialogComponent" }) } as AnyRec;
		const promise = (t.showAuthSelect as (d: AnyRec, p: unknown) => Promise<string>)(
			dialog,
			{ type: "select", message: "Pick one", options: [{ id: "a", label: "A" }] },
		);
		const selector = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(selector)[3] as () => void)();
		return promise.catch((error: unknown) => LOG.push(["caught", (error as Error).message]));
	});
	scenario("login.authPrompt.select", (t0) => {
		const t = makeThis(t0);
		const dialog = { describe: () => ({ kind: "LoginDialogComponent" }) } as AnyRec;
		const promise = (t.showAuthPrompt as (d: AnyRec, p: unknown) => Promise<string>)(
			dialog,
			{ type: "select", message: "Pick one", options: [{ id: "a", label: "A" }] },
		);
		const selector = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(selector)[2] as (o: string) => void)("A");
		return promise;
	});
	scenario("login.authPrompt.manual", (t0) => {
		const t = makeThis(t0);
		const dialog = {
			describe: () => ({ kind: "LoginDialogComponent" }),
			showManualInput: (_m: string) => Promise.resolve("123456"),
		} as AnyRec;
		return (t.showAuthPrompt as (d: AnyRec, p: unknown) => Promise<string>)(
			dialog,
			{ type: "manual_code", message: "Enter code" },
		);
	});
	scenario("login.authPrompt.signalAborted", (t0) => {
		const t = makeThis(t0);
		const dialog = {
			describe: () => ({ kind: "LoginDialogComponent" }),
			showManualInput: (_m: string) => Promise.resolve("123456"),
		} as AnyRec;
		return (t.showAuthPrompt as (d: AnyRec, p: unknown) => Promise<string>)(
			dialog,
			{ type: "manual_code", message: "Enter code", signal: { aborted: true } },
		).catch((error: unknown) => LOG.push(["caught", (error as Error).message]));
	});
	scenario("login.notify.deviceCode", (t0) => {
		const t = makeThis(t0);
		const dialog = {
			describe: () => ({ kind: "LoginDialogComponent" }),
			showDeviceCode: () => undefined,
			showWaiting: () => undefined,
			showInfo: () => undefined,
			showProgress: () => undefined,
			showAuth: () => undefined,
		} as AnyRec;
		(t.notifyAuthDialog as (d: AnyRec, e: unknown) => void)(dialog, {
			type: "device_code",
			verificationUrl: "https://example/activate",
			userCode: "ABC-123",
			websiteUrl: undefined,
			expiresInSeconds: 600,
			interval: 5,
			providerId: "x",
			message: undefined,
		});
		(t.notifyAuthDialog as (d: AnyRec, e: unknown) => void)(dialog, { type: "info", message: "hello", links: [] });
		(t.notifyAuthDialog as (d: AnyRec, e: unknown) => void)(dialog, { type: "progress", message: "working" });
		(t.notifyAuthDialog as (d: AnyRec, e: unknown) => void)(dialog, { type: "auth_url", url: "https://x", instructions: "go" });
	});
	scenario("logout.selector", (t0) => {
		const t = makeThis(t0);
		return (t.showOAuthSelector as (m: string) => Promise<void>)("logout");
	});
	scenario("logout.empty", (t0) => {
		const runtime = fakeModelRuntime({ listCredentials: async () => [] });
		const t = makeThis({ session: fakeSession({ modelRuntime: runtime }) });
		return (t.showOAuthSelector as (m: string) => Promise<void>)("logout");
	});
	scenario("logout.error", (t0) => {
		const runtime = fakeModelRuntime({
			listCredentials: async () => {
				throw new Error("keychain locked");
			},
		});
		const t = makeThis({ session: fakeSession({ modelRuntime: runtime }) });
		return (t.showOAuthSelector as (m: string) => Promise<void>)("logout");
	});
	scenario("completeAuth.knownModel", (t0) => {
		const t = makeThis(t0);
		return (t.completeProviderAuthentication as (...a: unknown[]) => Promise<void>)(
			"openai", "OpenAI", "api_key", { provider: "openai", id: "gpt-5.5", api: "openai" },
		);
	});
	scenario("completeAuth.unknownModel.defaultAvailable", (t0) => {
		const t = makeThis(t0);
		return (t.completeProviderAuthentication as (...a: unknown[]) => Promise<void>)(
			"anthropic", "Anthropic", "oauth", { provider: "unknown", id: "unknown", api: "unknown" },
		);
	});
	scenario("completeAuth.unknownModel.deferred", (t0) => {
		const runtime = fakeModelRuntime({ getAvailableSnapshot: () => [] });
		const session = fakeSession({ modelRuntime: runtime, model: { provider: "unknown", id: "unknown", api: "unknown" } });
		const t = makeThis({ session });
		return (t.completeProviderAuthentication as (...a: unknown[]) => Promise<void>)(
			"radius", "Radius", "oauth", (t.session as AnyRec).model,
		);
	});
	scenario("completeAuth.llama", (t0) => {
		const runtime = fakeModelRuntime({ getAvailableSnapshot: () => [] });
		const session = fakeSession({ modelRuntime: runtime, model: { provider: "unknown", id: "unknown", api: "unknown" } });
		const t = makeThis({ session });
		return (t.completeProviderAuthentication as (...a: unknown[]) => Promise<void>)(
			"llama.cpp", "llama.cpp", "api_key", (t.session as AnyRec).model,
		);
	});
	scenario("completeAuth.noDefaultProvider", (t0) => {
		const runtime = fakeModelRuntime({ getAvailableSnapshot: () => [] });
		const session = fakeSession({ modelRuntime: runtime, model: { provider: "unknown", id: "unknown", api: "unknown" } });
		const t = makeThis({ session });
		return (t.completeProviderAuthentication as (...a: unknown[]) => Promise<void>)(
			"mystery-provider", "Mystery", "api_key", (t.session as AnyRec).model,
		);
	});
	scenario("warn.anthropic.disabled", (t0) => {
		const settings = fakeSettingsManager({ getWarnings: () => ({ anthropicExtraUsage: false }) });
		const t = makeThis({ session: fakeSession({ settingsManager: settings, settingsManager2: settings }), settingsManager: settings });
		return (t.maybeWarnAboutAnthropicSubscriptionAuth as (m?: unknown) => Promise<void>)(
			{ provider: "anthropic", id: "claude-opus-4-8" },
		);
	});
	scenario("warn.anthropic.oauth", (t0) => {
		const runtime = fakeModelRuntime({ checkAuth: async () => ({ type: "oauth" }) });
		const t = makeThis({ session: fakeSession({ modelRuntime: runtime }) });
		return (t.maybeWarnAboutAnthropicSubscriptionAuth as (m?: unknown) => Promise<void>)(
			{ provider: "anthropic", id: "claude-opus-4-8" },
		);
	});
	scenario("warn.anthropic.oatKey", (t0) => {
		const t = makeThis(t0);
		return (t.maybeWarnAboutAnthropicSubscriptionAuth as (m?: unknown) => Promise<void>)(
			{ provider: "anthropic", id: "claude-opus-4-8" },
		);
	});
	scenario("warn.anthropic.plainKey", (t0) => {
		const runtime = fakeModelRuntime({
			checkAuth: async () => ({ type: "api_key" }),
			getAuth: async () => ({ auth: { apiKey: "sk-plain" } }),
		});
		const t = makeThis({ session: fakeSession({ modelRuntime: runtime }) });
		return (t.maybeWarnAboutAnthropicSubscriptionAuth as (m?: unknown) => Promise<void>)(
			{ provider: "anthropic", id: "claude-opus-4-8" },
		);
	});
	scenario("warn.anthropic.nonAnthropic", (t0) => {
		const t = makeThis(t0);
		return (t.maybeWarnAboutAnthropicSubscriptionAuth as (m?: unknown) => Promise<void>)(
			{ provider: "openai", id: "gpt-5.5" },
		);
	});

	// -- command handlers -----------------------------------------------------------------
	scenario("cmd.name.set", (t0) => {
		const t = makeThis(t0);
		return (t.handleNameCommand as (s: string) => void)("/name My Session");
	});
	scenario("cmd.name.empty", (t0) => {
		const t = makeThis(t0);
		return (t.handleNameCommand as (s: string) => void)("/name");
	});
	scenario("cmd.name.existing", (t0) => {
		const manager = fakeSessionManager({ getSessionName: () => "existing" });
		const t = makeThis({ sessionManager: manager, session: fakeSession({ sessionManager: manager }) });
		return (t.handleNameCommand as (s: string) => void)("/name");
	});
	scenario("cmd.name.normalized", (t0) => {
		const manager = fakeSessionManager({ getSessionName: () => "normalized" });
		const t = makeThis({ sessionManager: manager, session: fakeSession({ sessionManager: manager }) });
		return (t.handleNameCommand as (s: string) => void)("/name raw name");
	});
	scenario("cmd.session", (t0) => {
		const t = makeThis(t0);
		return (t.handleSessionCommand as () => void)();
	});
	scenario("cmd.changelog", (t0) => {
		const t = makeThis(t0);
		return (t.handleChangelogCommand as () => void)();
	});
	scenario("cmd.hotkeys", (t0) => {
		const t = makeThis(t0);
		return (t.handleHotkeysCommand as () => void)();
	});
	scenario("cmd.debug", (t0) => {
		const t = makeThis(t0);
		return (t.handleDebugCommand as () => void)();
	});
	scenario("cmd.pathArg.grid", (t0) => {
		const t = makeThis(t0);
		const cases = [
			["/export", "/export"],
			["/export", "/export out.jsonl"],
			["/export", "/export 'my file.jsonl'"],
			["/export", "/export \"double.jsonl\""],
			["/export", "/export unterminated'"],
			["/export", "/export a b c"],
			["/export", "/export "],
			["/export", "/exportx y"],
			["/import", "/import in.jsonl"],
		] as Array<[string, string]>;
		for (const [command, text] of cases) {
			LOG.push(["pathArg", text, (t.getPathCommandArgument as (s: string, c: string) => string | undefined)(text, command)]);
		}
	});
	scenario("cmd.export.jsonl", (t0) => {
		const session = fakeSession({
			exportToJsonl: (p: string) => {
				rec("session.exportToJsonl", p);
				return p;
			},
		});
		const t = makeThis({ session });
		return (t.handleExportCommand as (s: string) => Promise<void>)("/export out.jsonl");
	});
	scenario("cmd.export.html", (t0) => {
		const session = fakeSession({
			exportToHtml: async (p: string | undefined, opts: unknown) => {
				rec("session.exportToHtml", p === undefined ? "undefined" : p, describeArg(opts));
				return "/out.html";
			},
		});
		const t = makeThis({ session });
		return (t.handleExportCommand as (s: string) => Promise<void>)("/export");
	});
	scenario("cmd.export.error", (t0) => {
		const session = fakeSession({
			exportToJsonl: () => {
				throw new Error("disk full");
			},
		});
		const t = makeThis({ session });
		return (t.handleExportCommand as (s: string) => Promise<void>)("/export out.jsonl");
	});
	scenario("cmd.import.confirmed", (t0) => {
		const t = makeThis(t0);
		const promise = (t.handleImportCommand as (s: string) => Promise<void>)("/import in.jsonl");
		const selector = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(selector)[2] as (o: string) => void)("Yes");
		return promise;
	});
	scenario("cmd.import.declined", (t0) => {
		const t = makeThis(t0);
		const promise = (t.handleImportCommand as (s: string) => Promise<void>)("/import in.jsonl");
		const selector = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(selector)[2] as (o: string) => void)("No");
		return promise;
	});
	scenario("cmd.import.missingCwd", async (t0) => {
		const host = makeThis(t0).runtimeHost as AnyRec;
		const MissingCwd = DEPS.MissingSessionCwdError as new (i: unknown) => Error;
		host.importFromJsonl = async (_path: string, _cwd?: string) => {
			if (_cwd === undefined) throw new MissingCwd({ fallbackCwd: "/fallback" });
			return { cancelled: false };
		};
		const t = makeThis({ runtimeHost: host });
		const guarded = (t.handleImportCommand as (s: string) => Promise<void>)("/import in.jsonl").then(
			() => "done",
			(error: unknown) => `error:${(error as Error).message}`,
		);
		// first confirm: import
		const confirm = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(confirm)[2] as (o: string) => void)("Yes");
		// let the failure surface and the fallback-cwd confirm open
		await new Promise((r) => setImmediate(r));
		const confirm2 = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(confirm2)[2] as (o: string) => void)("Yes");
		LOG.push(["importOutcome", await guarded]);
	});
	scenario("cmd.import.fileNotFound", (t0) => {
		const host = makeThis(t0).runtimeHost as AnyRec;
		const NotFound = DEPS.SessionImportFileNotFoundError as new (m: string) => Error;
		host.importFromJsonl = async () => {
			throw new NotFound("file not found: in.jsonl");
		};
		const t = makeThis({ runtimeHost: host });
		const promise = (t.handleImportCommand as (s: string) => Promise<void>)("/import in.jsonl");
		const selector = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(selector)[2] as (o: string) => void)("Yes");
		return promise;
	});
	scenario("cmd.share", (t0) => {
		const t = makeThis(t0);
		return (t.handleShareCommand as () => Promise<void>)();
	});
	scenario("cmd.copy.plain", (t0) => {
		const t = makeThis(t0);
		return (t.handleCopyCommand as (o?: unknown) => Promise<void>)();
	});
	scenario("cmd.copy.flash", (t0) => {
		const t = makeThis(t0);
		return (t.handleCopyCommand as (o?: unknown) => Promise<void>)({ flashConfirmation: true, preferSelection: true });
	});
	scenario("cmd.copy.none", (t0) => {
		const session = fakeSession({ getLastAssistantText: () => undefined });
		const t = makeThis({ session });
		return (t.handleCopyCommand as (o?: unknown) => Promise<void>)();
	});
	scenario("cmd.clear", (t0) => {
		const t = makeThis(t0);
		return (t.handleClearCommand as () => Promise<void>)();
	});
	scenario("cmd.clear.cancelled", (t0) => {
		const host = makeThis(t0).runtimeHost as AnyRec;
		host.newSession = async () => ({ cancelled: true });
		const t = makeThis({ runtimeHost: host });
		return (t.handleClearCommand as () => Promise<void>)();
	});
	scenario("cmd.compact", (t0) => {
		const t = makeThis(t0);
		return (t.handleCompactCommand as (c?: string) => Promise<void>)("focus on tests");
	});
	scenario("cmd.bash.extensionResult", (t0) => {
		const runner = fakeExtensionRunner({
			emitUserBash: async () => ({ result: { output: "hi", exitCode: 0, cancelled: false } }),
		});
		const t = makeThis({ session: fakeSession({ extensionRunner: runner }) });
		return (t.handleBashCommand as (c: string, e?: boolean) => Promise<void>)("echo hi", false);
	});
	scenario("cmd.bash.exec", (t0) => {
		const t = makeThis(t0);
		return (t.handleBashCommand as (c: string, e?: boolean) => Promise<void>)("echo hi", false);
	});
	scenario("cmd.bash.exec.streamingDeferred", (t0) => {
		const t = makeThis({ session: fakeSession({ isStreaming: true }) });
		return (t.handleBashCommand as (c: string, e?: boolean) => Promise<void>)("echo hi", false);
	});
	scenario("cmd.bash.exec.error", (t0) => {
		const session = fakeSession({
			executeBash: async () => {
				throw new Error("spawn failed");
			},
		});
		const t = makeThis({ session });
		return (t.handleBashCommand as (c: string, e?: boolean) => Promise<void>)("echo hi", false);
	});
	scenario("cmd.bash.emitThrows", (t0) => {
		const runner = fakeExtensionRunner({
			emitUserBash: async () => {
				throw new Error("extension crashed");
			},
		});
		const t = makeThis({ session: fakeSession({ extensionRunner: runner }) });
		return (t.handleBashCommand as (c: string, e?: boolean) => Promise<void>)("echo hi", false);
	});
	scenario("easter.daxnuts", (t0) => {
		const t = makeThis(t0);
		(t.checkDaxnutsEasterEgg as (m: unknown) => void)({ provider: "opencode", id: "kimi-k2.5-instruct" });
		(t.checkDaxnutsEasterEgg as (m: unknown) => void)({ provider: "opencode", id: "other" });
		(t.handleArminSaysHi as () => void)();
		(t.handleDementedDelves as () => void)();
		(t.handleDaxnuts as () => void)();
	});

	// -- reload -----------------------------------------------------------------------
	scenario("reload.blocked.streaming", (t0) => {
		const t = makeThis({ session: fakeSession({ isStreaming: true }) });
		return (t.handleReloadCommand as () => Promise<void>)();
	});
	scenario("reload.blocked.compacting", (t0) => {
		const t = makeThis({ session: fakeSession({ isCompacting: true }) });
		return (t.handleReloadCommand as () => Promise<void>)();
	});
	scenario("reload.ok", (t0) => {
		const t = makeThis(t0);
		return (t.handleReloadCommand as () => Promise<void>)();
	});
	scenario("reload.failure", (t0) => {
		const session = fakeSession({
			reload: async () => {
				throw new Error("boom");
			},
		});
		const t = makeThis({ session });
		return (t.handleReloadCommand as () => Promise<void>)();
	});

	// -- extension ui dialogs ------------------------------------------------------------
	scenario("extui.selector.choose", (t0) => {
		const t = makeThis(t0);
		const promise = (t.showExtensionSelector as (t2: string, o: string[]) => Promise<string | undefined>)(
			"Pick", ["A", "B"],
		);
		const selector = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(selector)[2] as (o: string) => void)("B");
		return promise;
	});
	scenario("extui.selector.cancel", (t0) => {
		const t = makeThis(t0);
		const promise = (t.showExtensionSelector as (t2: string, o: string[]) => Promise<string | undefined>)(
			"Pick", ["A"],
		);
		const selector = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(selector)[3] as () => void)();
		return promise;
	});
	scenario("extui.selector.abortedSignal", (t0) => {
		const t = makeThis(t0);
		return (t.showExtensionSelector as (t2: string, o: string[], o2?: unknown) => Promise<string | undefined>)(
			"Pick", ["A"], { signal: { aborted: true } },
		);
	});
	scenario("extui.confirm", (t0) => {
		const t = makeThis(t0);
		const promise = (t.showExtensionConfirm as (t2: string, m: string) => Promise<boolean>)("Title", "Body");
		const selector = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(selector)[2] as (o: string) => void)("Yes");
		return promise;
	});
	scenario("extui.confirm.no", (t0) => {
		const t = makeThis(t0);
		const promise = (t.showExtensionConfirm as (t2: string, m: string) => Promise<boolean>)("Title", "Body");
		const selector = lastNew(t, "ExtensionSelectorComponent")!;
		(ctorArgs(selector)[2] as (o: string) => void)("No");
		return promise;
	});
	scenario("extui.input", (t0) => {
		const t = makeThis(t0);
		const promise = (t.showExtensionInput as (t2: string, p?: string) => Promise<string | undefined>)("Name", "hint");
		const input = lastNew(t, "ExtensionInputComponent")!;
		(ctorArgs(input)[2] as (v: string) => void)("typed");
		return promise;
	});
	scenario("extui.editor", (t0) => {
		const t = makeThis(t0);
		const promise = (t.showExtensionEditor as (t2: string, p?: string) => Promise<string | undefined>)("Edit", "seed");
		const editor = lastNew(t, "ExtensionEditorComponent")!;
		(ctorArgs(editor)[4] as (v: string) => void)("edited text");
		return promise;
	});
	scenario("extui.notify", (t0) => {
		const t = makeThis(t0);
		(t.showExtensionNotify as (m: string, k?: string) => void)("info message");
		(t.showExtensionNotify as (m: string, k?: string) => void)("warn message", "warning");
		(t.showExtensionNotify as (m: string, k?: string) => void)("error message", "error");
	});
	scenario("extui.error.stack", (t0) => {
		const t = makeThis(t0);
		(t.showExtensionError as (p: string, e: string, s?: string) => void)(
			"/ext/path.ts", "exploded", "Error: exploded\n    at fn (/ext/path.ts:1:1)\n    at inner (/x:2:2)",
		);
	});
	scenario("extui.custom.editorMode", (t0) => {
		const t = makeThis(t0);
		const promise = (t.showExtensionCustom as (f: unknown, o?: unknown) => Promise<string>)(
			(_tui: unknown, _theme: unknown, _kb: unknown, done: (r: string) => void) => {
				done("custom-result");
				return { describe: () => ({ kind: "CustomExt" }) };
			},
		);
		return promise;
	});
	scenario("extui.custom.overlay", (t0) => {
		const t = makeThis(t0);
		const promise = (t.showExtensionCustom as (f: unknown, o?: unknown) => Promise<string>)(
			(_tui: unknown, _theme: unknown, _kb: unknown, done: (r: string) => void) => {
				done("overlay-result");
				return { describe: () => ({ kind: "CustomOverlay" }) };
			},
			{ overlay: true },
		);
		return promise;
	});
	scenario("extui.customEditor.swap", (t0) => {
		const custom = fakeEditor("customEditor");
		const t = makeThis({ editor: custom });
		(t.setCustomEditorComponent as (f: unknown) => void)(() => custom);
		(t.setCustomEditorComponent as (f: unknown) => void)(undefined);
	});
	scenario("extui.resetExtensionUI", (t0) => {
		const t = makeThis(t0);
		(t.resetExtensionUI as () => void)();
	});

	// -- shortcuts ------------------------------------------------------------------------
	scenario("shortcuts.setupAndMatch", (t0) => {
		const runner = fakeExtensionRunner({
			getShortcuts: () => new Map([["ctrl+shift+g", { handler: () => rec("shortcut.handler"), description: "go" }]]),
		});
		const t = makeThis({ session: fakeSession({ extensionRunner: runner }) });
		(t.setupExtensionShortcuts as (r: unknown) => void)(runner);
		const handler = (t.defaultEditor as AnyRec).onExtensionShortcut as (d: string) => boolean;
		LOG.push(["shortcut.match", handler?.("ctrl+shift+g")]);
		LOG.push(["shortcut.miss", handler?.("ctrl+shift+z")]);
	});

	// -- loaded resources -------------------------------------------------------------------
	scenario("resources.quietSkip", (t0) => {
		const settings = fakeSettingsManager({ getQuietStartup: true });
		const t = makeThis({ session: fakeSession({ settingsManager: settings, resourceLoader: fakeResourceLoader() }), settingsManager: settings });
		(t.showLoadedResources as (o?: unknown) => void)();
	});
	scenario("resources.full", (t0) => {
		const loader = fakeResourceLoader({
			getSkills: () => ({
				skills: [{ name: "search", filePath: "/work/.pi/skills/search/SKILL.md", sourceInfo: undefined }],
				diagnostics: [],
			}),
			getPrompts: () => ({
				prompts: [{ name: "review", filePath: "/work/.pi/prompts/review.md", sourceInfo: undefined }],
				diagnostics: [],
			}),
			getThemes: () => ({
				themes: [{ name: "solarized", sourcePath: "/work/.pi/themes/solarized.json", sourceInfo: undefined }],
				diagnostics: [],
			}),
			getExtensions: () => ({
				extensions: [{ path: "/work/.pi/extensions/tag.ts", sourceInfo: undefined, hidden: false }],
				errors: [],
			}),
			getSystemPromptSource: () => ({ path: "/work/PI.md" }),
			getAppendSystemPromptSources: () => [{ path: "/work/EXTRA.md" }],
			getAgentsFiles: () => ({ agentsFiles: [{ path: "/work/AGENTS.md" }] }),
		});
		const t = makeThis({ session: fakeSession({ resourceLoader: loader }) });
		(t.showLoadedResources as (o?: unknown) => void)({ force: true });
	});
	scenario("resources.diagnostics", (t0) => {
		const loader = fakeResourceLoader({
			getSkills: () => ({
				skills: [],
				diagnostics: [{ type: "collision", message: "two skills named search", path: "/a/SKILL.md", collision: undefined }],
			}),
			getPrompts: () => ({
				prompts: [],
				diagnostics: [{ type: "warning", message: "prompt shadowed", path: "/p.md", collision: undefined }],
			}),
			getThemes: () => ({
				themes: [],
				diagnostics: [{ type: "error", message: "bad theme", path: "/t.json", collision: undefined }],
			}),
			getExtensions: () => ({
				extensions: [],
				errors: [{ path: "/broken.ts", error: "cannot load" }],
			}),
		});
		const runner = fakeExtensionRunner({
			getCommandDiagnostics: () => [{ type: "warning", message: "conflicts with built-in", path: "/c.ts", collision: undefined }],
			getShortcutDiagnostics: () => [],
		});
		const t = makeThis({ session: fakeSession({ resourceLoader: loader, extensionRunner: runner }) });
		(t.showLoadedResources as (o?: unknown) => void)({ showDiagnosticsWhenQuiet: true });
	});

	// -- exits -----------------------------------------------------------------------------
	scenario("exit.stop", (t0) => {
		const t = makeThis(t0);
		(t.stop as () => void)();
	});
	scenario("exit.stop.notInitialized", (t0) => {
		const t = makeThis({ isInitialized: false });
		(t.stop as () => void)();
	});
	scenario("exit.shutdown.interactive", (t0) => {
		const t = makeThis(t0);
		return (t.shutdown as () => Promise<void>)().catch(() => undefined);
	});
	scenario("exit.shutdown.fromSignal", (t0) => {
		const t = makeThis(t0);
		const promise = (t.shutdown as (o?: unknown) => Promise<void>)({ fromSignal: true });
		return promise.catch((error: unknown) => LOG.push(["caught", (error as Error).message]));
	});
	scenario("exit.shutdown.double", (t0) => {
		const t = makeThis(t0);
		const first = (t.shutdown as () => Promise<void>)().catch(() => undefined);
		const second = (t.shutdown as () => Promise<void>)().catch(() => undefined);
		return Promise.all([first, second]);
	});
	scenario("exit.emergency", (t0) => {
		const t = makeThis(t0);
		try {
			(t.emergencyTerminalExit as () => never)();
		} catch {
			// process.exit sentinel
		}
	});
	scenario("exit.uncaught.first", (t0) => {
		const t = makeThis(t0);
		try {
			(t.uncaughtCrash as (e: Error) => never)(new Error("kaboom"));
		} catch {
			// process.exit sentinel
		}
	});
	scenario("exit.uncaught.whileShuttingDown", (t0) => {
		const t = makeThis({ isShuttingDown: true });
		try {
			(t.uncaughtCrash as (e: Error) => never)(new Error("kaboom"));
		} catch {
			// process.exit sentinel
		}
	});
	scenario("exit.checkShutdownRequested", (t0) => {
		const t = makeThis({ shutdownRequested: true });
		return (t.checkShutdownRequested as () => Promise<void>)().catch(() => undefined);
	});
	scenario("exit.fatalRuntimeError", (t0) => {
		const t = makeThis(t0);
		return (t.handleFatalRuntimeError as (p: string, e: string) => Promise<never>)(
			"Failed to resume session", "gone",
		).catch((error: unknown) => LOG.push(["caught", (error as Error).message]));
	});
	scenario("exit.resumeCommand", (t0) => {
		const t = makeThis(t0);
		const cmd = (t.formatResumeCommand as (m: unknown) => string | undefined)(t.sessionManager);
		LOG.push(["resumeCommand", cmd]);
	});

	void theme; void describeArg; void sessionBag; void rec; void Text; void Spacer;
	return scenarios_count_placeholder();
}

function scenarios_count_placeholder(): number {
	return 0;
}
