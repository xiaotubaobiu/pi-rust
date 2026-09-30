// r18 oracle extractor. Reads the REAL upstream
// `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
// (sha256 ca84ff33b44af038d71a8b3c6579084fb360bd24358d397604774bcaa21aeb2a)
// plus a few small pure helpers from their upstream modules, extracts the
// listed method/function bodies VERBATIM by brace matching (no transcription),
// and writes `gen_shell.ts`: a factory `makeShell(deps)` whose returned object
// holds every extracted function so they can call each other through `this`.
// Only mutations: `private `/`public `/`export ` modifiers dropped so the
// bodies are valid object shorthand / inner declarations.
import { readFileSync, writeFileSync } from "node:fs";

const UP = "C:/Users/13063/Desktop/code/agent work/pi/packages/coding-agent/src";
const src = readFileSync(`${UP}/modes/interactive/interactive-mode.ts`, "utf8");
const footerSrc = readFileSync(`${UP}/modes/interactive/components/footer.ts`, "utf8");
const sessionManagerSrc = readFileSync(`${UP}/core/session-manager.ts`, "utf8");
const messagesSrc = readFileSync(`${UP}/core/messages.ts`, "utf8");
const agentSessionSrc = readFileSync(`${UP}/core/agent-session.ts`, "utf8");
const oauthSrc = readFileSync(`${UP}/modes/interactive/components/oauth-selector.ts`, "utf8");
const sessionCwdSrc = readFileSync(`${UP}/core/session-cwd.ts`, "utf8");
const keybindingHintsSrc = readFileSync(`${UP}/modes/interactive/components/keybinding-hints.ts`, "utf8");

function findBlock(text, openIdx) {
	let depth = 0;
	let paren = 0;
	let bracket = 0;
	let inStr = null;
	for (let i = openIdx; i < text.length; i++) {
		const c = text[i];
		const prev = text[i - 1];
		if (inStr) {
			if (c === inStr && prev !== "\\") inStr = null;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			inStr = c;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i) + 1;
			continue;
		}
		if (c === "(") paren++;
		else if (c === ")") paren--;
		else if (c === "[") bracket++;
		else if (c === "]") bracket--;
		// Braces inside a parameter list (e.g. `options = {}` defaults) are
		// neutral; the body is the first top-level brace after the signature.
		else if (c === "{" && paren === 0 && bracket === 0) depth++;
		else if (c === "}" && paren === 0 && bracket === 0) {
			depth--;
			if (depth === 0) {
				// A function's return TYPE can be an object literal (`: { ... }`)
				// or wrapped in type args (`Array<{ ... }>`); the real body `{`
				// follows. If the next non-space char is `{` the block ended on
				// a type; if it is `>`/`]` the type wrapper still closes first.
				let j = i + 1;
				while (j < text.length && /\s/.test(text[j])) j++;
				if (text[j] !== "{" && text[j] !== ">" && text[j] !== "]") {
					return text.slice(openIdx, i + 1);
				}
			}
		}
	}
	throw new Error("unbalanced block");
}

// Extract a class method by name (tab-indented declaration).
function extractMethod(source, name) {
	const re = new RegExp(`\\n\\t(?:private |public )?(?:static )?(?:async )?${name}\\(`);
	const m = source.match(re);
	if (!m) throw new Error(`method not found: ${name}`);
	const declStart = m.index + 1;
	const full = findBlock(source, declStart);
	// drop a leading `\tprivate `/`\tstatic `/`\tpublic ` (keep `async name(...)`)
	const cleaned = full
		.replace(/^[\t ]*private /, "")
		.replace(/^[\t ]*static /, "")
		.replace(/^[\t ]*public /, "");
	// rewrite method shorthand -> function declaration (statement position)
	return cleaned.replace(/^([\t ]*)(async )?([A-Za-z_][A-Za-z0-9_]*)\(/, "$1$2function $3(");
}

// Extract a module-level `function name(` / `export function name(` (optionally generic).
function extractFn(source, name) {
	const re = new RegExp(`\\n(?:export )?function ${name}[<(]`);
	const m = source.match(re);
	if (!m) throw new Error(`function not found: ${name}`);
	let declStart = m.index + 1;
	if (source.slice(declStart, declStart + 7) === "export ") declStart += 7;
	return findBlock(source, declStart);
}

// Extract `const NAME = ...;` module constants (single declaration).
function extractConst(source, name) {
	const re = new RegExp(`\\n(?:export )?const ${name}[: =]`);
	const m = source.match(re);
	if (!m) throw new Error(`const not found: ${name}`);
	let declStart = m.index + 1;
	if (source.slice(declStart, declStart + 7) === "export ") declStart += 7;
	let depthSq = 0, depthBr = 0, depthCurl = 0, inStr = null;
	for (let i = declStart; i < source.length; i++) {
		const c = source[i];
		const prev = source[i - 1];
		if (inStr) {
			if (c === inStr && prev !== "\\") inStr = null;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") { inStr = c; continue; }
		if (c === "[") depthSq++;
		else if (c === "]") depthSq--;
		else if (c === "{") depthCurl++;
		else if (c === "}") depthCurl--;
		else if (c === "(") depthBr++;
		else if (c === ")") depthBr--;
		else if (c === ";" && depthSq === 0 && depthBr === 0 && depthCurl === 0) {
			return source.slice(declStart, i + 1);
		}
	}
	console.error("DEBUG depths", depthSq, depthBr, depthCurl, "inStr", inStr, JSON.stringify(source.slice(declStart, declStart + 130)));
	throw new Error(`const not terminated: ${name}`);
}

const CLASS_METHODS = [
	// input ring / submit
	"setupKeyHandlers", "handleRightClickPaste", "handleClipboardPaste",
	"handleStartupSubmit", "setupEditorSubmitHandler",
	// events -> UI
	"handleEvent", "getUserMessageText", "showManagedToolStatus", "showStatus",
	"addCustomEntryToChat", "addMessageToChat", "renderSessionItems",
	"renderSessionEntries", "addCompactionCostNotice", "maybeShowThinkingDropNotice",
	"maybeShowCacheMissNotice", "addCacheMissNotice", "renderInitialMessages",
	"renderProjectTrustWarningIfNeeded",
	// lifecycle / signals
	"handleCtrlC", "handleCtrlD", "shutdown", "checkShutdownRequested",
	"handleCtrlZ", "handleFatalRuntimeError",
	"stop", "stopInteractiveTui", "mountInteractiveTui", "registerSignalHandlers",
	"unregisterSignalHandlers", "getUserInput", "updateAvailableProviderCount",
	"showPackageUpdateNotification", "switchTuiMode", "reportInstallTelemetry",
	// queues
	"handleFollowUp", "handleDequeue", "getAllQueuedMessages", "clearAllQueues",
	"updatePendingMessagesDisplay", "restoreQueuedMessagesToEditor",
	"queueCompactionMessage", "isExtensionCommand", "flushCompactionQueue",
	"flushPendingBashComponents",
	// status / working indicator
	"setEditorWorkingStatusIndicator", "showStatusIndicator", "clearStatusIndicator",
	"showWorkingStatusIndicator", "setWorkingVisible", "setWorkingIndicator",
	"setHiddenThinkingLabel", "setExtensionStatus", "countDroppedThinkingBlocks",
	"getAppKeyDisplay", "getEditorKeyDisplay",
	// toggles
	"updateEditorBorderColor", "cycleThinkingLevel", "cycleModel",
	"toggleToolOutputExpansion", "setToolsExpanded", "updateThinkingBlockVisibility",
	"toggleThinkingBlockVisibility", "handleOpenExternalEditor",
	// notifications / helpers
	"clearEditor", "showError", "showWarning", "showNewVersionNotification",
	"getMarkdownThemeWithSettings", "getMarkdownTransformers",
	"getRegisteredToolDefinition", "updateTerminalTitle", "getChangelogForDisplay",
	"checkForPackageUpdates", "checkTmuxKeyboardSetup",
	// session (re)binding
	"applyFullscreenScrollbarSetting", "applyRuntimeSettings", "rebindCurrentSession",
	"renderCurrentSessionState", "bindCurrentSessionExtensions",
	"createExtensionUIContext", "createProjectTrustContext", "resetExtensionUI",
	// autocomplete
	"getAutocompleteSourceTag", "prefixAutocompleteDescription",
	"getBuiltInCommandConflictDiagnostics", "createBaseAutocompleteProvider",
	"setupAutocompleteProvider",
	// resource labels / paths
	"formatDisplayPath", "formatExtensionDisplayPath", "formatContextPath",
	"getStartupExpansionState", "getShortPath", "getCompactPathLabel",
	"getCompactPackageSourceLabel", "getCompactExtensionLabel",
	"getCompactDisplayPathSegments", "getCompactNonPackageExtensionLabel",
	"getCompactExtensionLabels", "getDisplaySourceInfo", "getScopeGroup",
	"isPackageSource", "buildScopeGroups", "formatScopeGroups",
	"findSourceInfoForPath", "formatPathWithSource", "formatDiagnostics",
	"showLoadedResources", "showStartupNoticesIfNeeded", "subscribeToAgent", "setupExtensionShortcuts",
	// selector mechanism (component creation stays behind the factory seam)
	"disposeActiveSelector", "showSelector",
	// extension ui (widget/footer/header/terminal-input choreography)
	"setExtensionWidget", "clearExtensionWidgets", "renderWidgets",
	"renderWidgetContainer", "setExtensionFooter", "setExtensionHeader",
	"addExtensionTerminalInputListener", "rebindExtensionTerminalInputListeners",
	"clearExtensionTerminalInputListeners",
	"showExtensionSelector", "hideExtensionSelector", "showExtensionConfirm",
	"promptForMissingSessionCwd", "showExtensionInput", "hideExtensionInput",
	"showExtensionEditor", "hideExtensionEditor", "setCustomEditorComponent",
	"showExtensionNotify", "showExtensionError",
];

const MODULE_FNS = [
	"quoteIfNeeded", "formatResumeCommand", "isDeadTerminalError",
	"isAnthropicSubscriptionAuthKey", "isUnknownModel", "llamaCppPostLoginGuidance", "isWorkingStatusEditor", "isExpandable", "isCustomSessionEntry", "isCompactionCostNotice",
	"createFuzzyAutocompleteItems", "getLoginProviderCompletionOptions",
	"getLoginProviderSearchText", "formatLoginProviderCompletionDescription",
];

const CONSTANTS = [
	"DEAD_TERMINAL_ERROR_CODES", "ANTHROPIC_SUBSCRIPTION_AUTH_WARNING", "AUTH_TYPE_ORDER",
];

const HELPER_FNS = [
	["footerSrc", "formatTokens"],
	["messagesSrc", "createCompactionSummaryMessage"],
	["messagesSrc, createBranchSummaryMessage"], // placeholder, replaced below
];

const parts = [];
for (const name of CONSTANTS) parts.push(`${extractConst(src, name)}`);
for (const name of MODULE_FNS) parts.push(extractFn(src, name));
// helpers from other upstream modules (verbatim single functions)
parts.push(extractFn(footerSrc, "formatTokens"));
parts.push(extractFn(messagesSrc, "createCompactionSummaryMessage"));
parts.push(extractFn(messagesSrc, "createBranchSummaryMessage"));
parts.push(extractFn(messagesSrc, "createCustomMessage"));
parts.push(extractFn(sessionManagerSrc, "sessionEntryToContextMessages"));
parts.push(extractFn(agentSessionSrc, "parseSkillBlock"));
parts.push(extractFn(oauthSrc, "formatAuthSelectorProviderType"));
parts.push(extractFn(sessionCwdSrc, "formatMissingSessionCwdPrompt"));
parts.push(extractFn(keybindingHintsSrc, "formatKeyPart"));
parts.push(extractFn(keybindingHintsSrc, "formatKeys"));
parts.push(extractFn(keybindingHintsSrc, "formatKeyText"));
parts.push(extractFn(keybindingHintsSrc, "keyText"));
parts.push(extractFn(keybindingHintsSrc, "keyHint"));
parts.push(extractFn(keybindingHintsSrc, "keyDisplayText"));
parts.push(extractFn(keybindingHintsSrc, "rawKeyHint"));
for (const name of CLASS_METHODS) parts.push(extractMethod(src, name));

const EXPORTS = [
	...CONSTANTS, ...MODULE_FNS,
	"formatTokens", "createCompactionSummaryMessage", "createBranchSummaryMessage",
	"createCustomMessage", "sessionEntryToContextMessages", "parseSkillBlock",
	"formatAuthSelectorProviderType", "formatMissingSessionCwdPrompt",
	"formatKeyPart", "formatKeys", "formatKeyText", "keyText", "keyHint", "keyDisplayText", "rawKeyHint", "showStartupNoticesIfNeeded", "subscribeToAgent", "setupExtensionShortcuts", "reportInstallTelemetry", "switchTuiMode",
	...CLASS_METHODS,
];

const out = `// GENERATED by extract_shell.mjs from upstream interactive-mode.ts
// (sha256 ca84ff33b44af038d71a8b3c6579084fb360bd24358d397604774bcaa21aeb2a)
// plus verbatim single-function extracts from upstream helper modules:
// components/footer.ts (formatTokens), core/messages.ts
// (createCompactionSummaryMessage/createBranchSummaryMessage/createCustomMessage),
// core/session-manager.ts (sessionEntryToContextMessages),
// core/agent-session.ts (parseSkillBlock),
// components/oauth-selector.ts (formatAuthSelectorProviderType),
// core/session-cwd.ts (formatMissingSessionCwdPrompt),
// components/keybinding-hints.ts (formatKeyText/keyText/keyHint/keyDisplayText/rawKeyHint).
// Bodies are brace-matched VERBATIM from the real upstream source; only
// \`private\`/\`public\`/\`export\` modifiers are dropped. Deps arrive via the
// factory argument (the interactive components / global singletons are the
// r18 seam surface — see pi-rust interactive_mode.rs).
/* eslint-disable */
// @ts-nocheck
export function makeShell(deps: Record<string, any>) {
	const {
		theme, APP_NAME, APP_TITLE, fs, os, path, Container, Text, Spacer,
		TruncatedText, DynamicBorder, Markdown, ExpandableText, AssistantMessageComponent,
		ToolExecutionComponent, CustomEntryComponent, BashExecutionComponent,
		CompactionSummaryMessageComponent, BranchSummaryMessageComponent,
		UserMessageComponent, SkillInvocationMessageComponent, CustomMessageComponent,
		WorkingStatusIndicator, CompactionStatusIndicator, RetryStatusIndicator,
		BranchSummaryStatusIndicator, IdleStatus, CombinedAutocompleteProvider,
		withBuiltInRenderers, collectCacheMisses, detectCacheMiss, CACHE_TTL_MS,
		getCapabilities, hyperlink, spawn, parseGitUrl, BUILTIN_SLASH_COMMANDS,
		fuzzyFilter, getEditorTheme, hasTrustRequiringProjectResources, CONFIG_DIR_NAME,
		setRegisteredThemes, setCapabilityOverrides, configureHttpDispatcher,
		getMarkdownTheme, getChangelogPath, parseChangelog, getNewEntries, getKeybindings,
		normalizeChangelogLinks, isInstallTelemetryEnabled, getPiUserAgent,
		DefaultPackageManager, getCwdRelativePath, readClipboardText, readClipboardImage,
		extensionForImageMimeType, editInExternalEditor, VERSION, crypto, matchesKey, chalk, InteractiveMode,
		TuiLayouts, TuiMainScreen, TuiAltScreen, createInteractiveTui, getAgentDir,
	} = deps;
	void [
		theme, APP_NAME, APP_TITLE, fs, os, path, Container, Text, Spacer,
		TruncatedText, DynamicBorder, Markdown, ExpandableText, AssistantMessageComponent,
		ToolExecutionComponent, CustomEntryComponent, BashExecutionComponent,
		CompactionSummaryMessageComponent, BranchSummaryMessageComponent,
		UserMessageComponent, SkillInvocationMessageComponent, CustomMessageComponent,
		WorkingStatusIndicator, CompactionStatusIndicator, RetryStatusIndicator,
		BranchSummaryStatusIndicator, IdleStatus, CombinedAutocompleteProvider,
		withBuiltInRenderers, collectCacheMisses, detectCacheMiss, CACHE_TTL_MS,
		getCapabilities, hyperlink, spawn, parseGitUrl, BUILTIN_SLASH_COMMANDS,
		fuzzyFilter, getEditorTheme, hasTrustRequiringProjectResources, CONFIG_DIR_NAME,
		setRegisteredThemes, setCapabilityOverrides, configureHttpDispatcher,
		getMarkdownTheme, getChangelogPath, parseChangelog, getNewEntries, getKeybindings,
		normalizeChangelogLinks, isInstallTelemetryEnabled, getPiUserAgent,
		DefaultPackageManager, getCwdRelativePath, readClipboardText, readClipboardImage,
		extensionForImageMimeType, editInExternalEditor, VERSION, crypto, matchesKey, chalk, InteractiveMode,
		TuiLayouts, TuiMainScreen, TuiAltScreen, createInteractiveTui, getAgentDir,
	];

${parts.join("\n")}
	return {
		${EXPORTS.join(",\n\t\t")},
	};
}
`;
writeFileSync(new URL("./gen_shell.ts", import.meta.url), out);
console.log("gen_shell.ts written:", parts.join("\n").length, "bytes of bodies,", CLASS_METHODS.length, "methods,", MODULE_FNS.length, "module fns");
