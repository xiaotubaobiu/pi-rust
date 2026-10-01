// Theme delta oracle driver. Executes the VERBATIM upstream HEAD
// (`pi@2bbfcca43`, v0.99.1) `theme/theme.ts` + `theme/system-theme.ts` under
// `node --experimental-strip-types`; the `@earendil-works/pi-tui` imports
// resolve to the SHA-pinned tui sources copied next to this file (see
// manifest.json). `chalk`, `config.ts`, `fs-watch.ts`, `syntax-highlight.ts`,
// and `text.ts` are harness seams (see loader.mjs and the stub files).
//
// theme.ts module state (terminalColors / terminalColorScheme /
// terminalColorsPending / the globalThis theme store) is process-global per
// module instance; every scenario group imports a fresh instance via the
// `./theme.ts?g=<group>` query trick, mirroring how the Rust side resets its
// mutex-guarded state per test.
//
// Output: theme_delta_oracle.json — every entry is a byte-exact expectation.
import "./register.mjs";
import { writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Determinism: the real process env must not leak into the COLORFGBG
// fallbacks of getTerminalTheme().
delete process.env.COLORFGBG;

const XTERM16 = [
	"#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
	"#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];

const rgb = (hex) => {
	const n = hex.replace("#", "");
	return {
		r: parseInt(n.slice(0, 2), 16),
		g: parseInt(n.slice(2, 4), 16),
		b: parseInt(n.slice(4, 6), 16),
	};
};

// The pinned tui pipeline (same sources the barrel re-exports).
const tui = await import("./colors.ts?g=driver");
const colorToHex = (color) => tui.colorToHex(color);

const FG_TOKENS = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
	"muted", "dim", "text", "thinkingText", "scrollbarTrack", "scrollbarThumb",
	"searchMatchText", "userMessageText", "customMessageText", "customMessageLabel",
	"toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock",
	"mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
	"toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
	"syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType",
	"syntaxOperator", "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow",
	"thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
];
const BG_TOKENS = [
	"selectedBg", "searchMatchBg", "userMessageBg", "customMessageBg", "toolPendingBg",
	"toolSuccessBg", "toolErrorBg",
];

const ansiOf = (call) => {
	try {
		return call();
	} catch (error) {
		return { error: error.message };
	}
};

// A theme dump: every token's ANSI sequence, resolved colors as hex,
// appearance, color mode, and the text-styler codes.
const dumpTheme = (theme) => {
	const fg = {};
	for (const token of FG_TOKENS) fg[token] = ansiOf(() => theme.getFgAnsi(token));
	const bg = {};
	for (const token of BG_TOKENS) bg[token] = ansiOf(() => theme.getBgAnsi(token));
	const colorsHex = {};
	for (const [token, color] of Object.entries(theme.colors)) colorsHex[token] = colorToHex(color);
	return {
		name: theme.name ?? null,
		appearance: theme.appearance,
		colorMode: theme.getColorMode(),
		fg,
		bg,
		colorsHex,
		stylers: {
			bold: theme.bold("x"),
			italic: theme.italic("x"),
			underline: theme.underline("x"),
			inverse: theme.inverse("x"),
			strikethrough: theme.strikethrough("x"),
		},
		probes: {
			fg_accent: theme.fg("accent", "x"),
			bg_selectedBg: ansiOf(() => theme.bg("selectedBg", "x")),
			style_fg_token: theme.style("x", { fg: "accent" }),
			style_fg_dim: theme.style("x", { fg: "dim" }),
			style_fg_bg_tokens: theme.style("x", { fg: "muted", bg: "toolPendingBg" }),
			style_attributes: theme.style("x", { fg: "text", bold: true, underline: true }),
			style_italic_dim: theme.style("x", { fg: "dim", italic: true }),
			unknown_fg: ansiOf(() => theme.fg("nope", "x")),
			unknown_bg: ansiOf(() => theme.bg("nope", "x")),
		},
	};
};

const out = {};

// ==========================================================================
// Groups 1-2: builtin dark/light themes in both color modes, empty terminal
// state (guessed defaults; the builtins declare no terminal-default tokens,
// so the resolved colors equal the concrete colors).
// ==========================================================================
for (const mode of ["truecolor", "256color"]) {
	const th = await import(`./theme.ts?g=builtin-${mode}`);
	globalThis.__piColorMode = mode;
	th.setTerminalColors({});
	out[`builtin_${mode}`] = {
		dark: dumpTheme(th.getThemeByName("dark")),
		light: dumpTheme(th.getThemeByName("light")),
	};
}

// ==========================================================================
// Group 3: terminal-default tokens, appearance detection, and the
// resolved-colors cache — via loadThemeFromPath over synthetic documents
// (written next to this file; removed at the end).
// ==========================================================================
{
	const th = await import("./theme.ts?g=defaults");
	globalThis.__piColorMode = "truecolor";

	const defaultsDoc = {
		$schema: "https://example.invalid/theme-schema.json",
		name: "defaults-dummy",
		appearance: "dark",
		vars: { brand: "#ff0000" },
		colors: {
			accent: "brand",
			border: "",
			borderAccent: "oklch(0.62 0.12 250)",
			borderMuted: 24,
			success: "okhsl(150 50% 60%)",
			error: "#00ff00",
			warning: "#0000ff",
			muted: "#808080",
			dim: "#a0a0a0",
			text: "",
			thinkingText: "#c0c0c0",
			selectedBg: "",
			userMessageBg: "#202020",
			userMessageText: "#ffffff",
			customMessageBg: "#303030",
			customMessageText: "#eeeeee",
			customMessageLabel: "#dddddd",
			toolPendingBg: "#404040",
			toolSuccessBg: "#505050",
			toolErrorBg: "#606060",
			toolTitle: "#f0f0f0",
			toolOutput: "#e0e0e0",
			thinkingXhigh: "#d0d0d0",
		},
	};
	const detectedDarkDoc = {
		name: "detected-dark",
		colors: {
			accent: "#ffffff", border: "#e0e0e0", borderAccent: "#d0d0d0", borderMuted: "#c0c0c0",
			success: "#b0b0b0", error: "#f0f0f0", warning: "#a0a0a0", muted: "#909090",
			dim: "#808080", text: "#ffffff", thinkingText: "#eeeeee", selectedBg: "#101010",
			userMessageBg: "#181818", userMessageText: "#ffffff", customMessageBg: "#202020",
			customMessageText: "#eeeeee", customMessageLabel: "#dddddd", toolPendingBg: "#282828",
			toolSuccessBg: "#303030", toolErrorBg: "#383838", toolTitle: "#f8f8f8",
			toolOutput: "#e8e8e8", thinkingXhigh: "#d8d8d8",
		},
	};
	const detectedLightDoc = {
		name: "detected-light",
		colors: {
			accent: "#202020", border: "#303030", borderAccent: "#404040", borderMuted: "#505050",
			success: "#606060", error: "#101010", warning: "#707070", muted: "#808080",
			dim: "#909090", text: "#1a1a1a", thinkingText: "#282828", selectedBg: "#e0e0e0",
			userMessageBg: "#d8d8d8", userMessageText: "#101010", customMessageBg: "#d0d0d0",
			customMessageText: "#181818", customMessageLabel: "#282828", toolPendingBg: "#c8c8c8",
			toolSuccessBg: "#c0c0c0", toolErrorBg: "#b8b8b8", toolTitle: "#080808",
			toolOutput: "#181818", thinkingXhigh: "#303030",
		},
	};
	const indexedOnlyDoc = {
		name: "indexed-only",
		colors: {
			accent: 4, border: 8, borderAccent: 12, borderMuted: 0, success: 2, error: 1,
			warning: 3, muted: 7, dim: 8, text: 7, thinkingText: 15, selectedBg: 0,
			userMessageBg: 0, userMessageText: 15, customMessageBg: 0, customMessageText: 15,
			customMessageLabel: 15, toolPendingBg: 0, toolSuccessBg: 0, toolErrorBg: 0,
			toolTitle: 15, toolOutput: 7, thinkingXhigh: 15,
		},
	};

	const dir = fileURLToPath(new URL(".", import.meta.url));
	const written = [];
	const writeDoc = (name, doc) => {
		const path = dir + name;
		writeFileSync(path, JSON.stringify(doc, null, "\t"));
		written.push(path);
		return path;
	};

	const defaultsPath = writeDoc("defaults-dummy.json", defaultsDoc);
	const detectedDarkPath = writeDoc("detected-dark.json", detectedDarkDoc);
	const detectedLightPath = writeDoc("detected-light.json", detectedLightDoc);
	const indexedOnlyPath = writeDoc("indexed-only.json", indexedOnlyDoc);

	try {
		// Terminal-color states the group cycles through. Scenario order
		// matters: the resolved-colors cache is keyed by identity.
		const states = {
			// (b) guessed defaults (nothing reported).
			guessed: () => {
				th.setTerminalColorScheme(undefined);
				th.setTerminalColors({});
			},
			// (a) reported terminal colors (dark).
			reported_dark: () => {
				th.setTerminalColors({
					foreground: rgb("#c4c4d4"),
					background: rgb("#1e1e2e"),
					palette: XTERM16.map(rgb),
				});
			},
			// A different report: the resolved-colors cache must re-key (light).
			reported_light: () => {
				th.setTerminalColors({
					foreground: rgb("#202028"),
					background: rgb("#e8e8e8"),
				});
			},
			// Background only (no foreground): terminalAppearance classifies alone.
			reported_bg_only: () => {
				th.setTerminalColors({ background: rgb("#808080") });
			},
		};

		const captureDefaults = (label) => {
			const defaults = th.loadThemeFromPath(defaultsPath);
			const detectedDark = th.loadThemeFromPath(detectedDarkPath);
			const detectedLight = th.loadThemeFromPath(detectedLightPath);
			const indexedOnly = th.loadThemeFromPath(indexedOnlyPath);
			out[label] = {
				defaults: dumpTheme(defaults),
				defaults_probes: {
					border_fg: defaults.fg("border", "x"),
					text_fg: defaults.fg("text", "x"),
					selectedBg_as_fg: ansiOf(() => defaults.fg("selectedBg", "x")),
					style_bg_token_as_fg: ansiOf(() => defaults.style("x", { fg: "selectedBg" })),
					dim_getFgAnsi: defaults.getFgAnsi("dim"),
					text_getFgAnsi: defaults.getFgAnsi("text"),
					style_raw_fg: defaults.style("x", { fg: toRawColor("#ff8800") }),
					style_raw_fg_token_bg: defaults.style("x", {
						fg: toRawColor("#00ff00"),
						bg: "userMessageBg",
					}),
					style_raw_both: defaults.style("x", {
						fg: toRawColor("#00ff00"),
						bg: toRawColor("#404040"),
					}),
				},
				detected_dark: {
					appearance: detectedDark.appearance,
					fg_sample: detectedDark.getFgAnsi("text"),
					bg_sample: detectedDark.getBgAnsi("selectedBg"),
				},
				detected_light: {
					appearance: detectedLight.appearance,
					fg_sample: detectedLight.getFgAnsi("text"),
					bg_sample: detectedLight.getBgAnsi("selectedBg"),
				},
				indexed_only: {
					appearance: indexedOnly.appearance,
					fg: Object.fromEntries(FG_TOKENS.map((token) => [token, ansiOf(() => indexedOnly.getFgAnsi(token))])),
					bg: Object.fromEntries(BG_TOKENS.map((token) => [token, ansiOf(() => indexedOnly.getBgAnsi(token))])),
					colorsHex: Object.fromEntries(
						Object.entries(indexedOnly.colors).map(([token, color]) => [token, colorToHex(color)]),
					),
				},
			};
		};

		const toRawColor = (hex) => tui.parseColor(hex);

		for (const [label, prepare] of Object.entries(states)) {
			prepare();
			captureDefaults(`defaults_${label}`);
		}

		// Cache identity: two reads under the same report share the snapshot;
		// a new report (even with equal content) re-keys. The Rust port
		// mirrors this with Arc identity (values replayed, identity noted).
		th.setTerminalColors({ foreground: rgb("#c4c4d4"), background: rgb("#1e1e2e") });
		const cacheProbe = th.loadThemeFromPath(defaultsPath);
		const first = cacheProbe.colors;
		const again = cacheProbe.colors;
		const identitySame = first === again;
		th.setTerminalColors({ foreground: rgb("#c4c4d4"), background: rgb("#1e1e2e") });
		const identityAfterReset = cacheProbe.colors === first;
		out.cache_identity = { identitySame, identityAfterReset };
	} finally {
		for (const path of written) rmSync(path);
	}
}

// ==========================================================================
// Groups 4-5: the system theme with fixed TerminalColors inputs (grayscale
// pending + full report + scheme-only), in both color modes.
// ==========================================================================
for (const mode of ["truecolor", "256color"]) {
	const th = await import(`./theme.ts?g=system-${mode}`);
	globalThis.__piColorMode = mode;
	const systemScenarios = {};

	th.setTerminalColors({});
	th.setTerminalColorScheme(undefined);
	th.markTerminalColorsPending();
	systemScenarios.pending_empty = dumpTheme(th.getThemeByName("system"));

	th.markTerminalColorsPending();
	th.setTerminalColorScheme("light");
	th.setTerminalColors({});
	systemScenarios.pending_scheme_light = dumpTheme(th.getThemeByName("system"));

	th.setTerminalColorScheme(undefined);
	th.setTerminalColors({
		foreground: rgb("#c4c4d4"),
		background: rgb("#1e1e2e"),
		palette: XTERM16.map(rgb),
	});
	systemScenarios.full_dark = dumpTheme(th.getThemeByName("system"));

	th.setTerminalColors({
		foreground: rgb("#202028"),
		background: rgb("#e8e8e8"),
		palette: XTERM16.map(rgb),
	});
	systemScenarios.full_light = dumpTheme(th.getThemeByName("system"));

	// Palette but no background: tier-2 hues; getTerminalTheme() falls back to
	// the (unset) scheme, then dark.
	th.setTerminalColors({ palette: XTERM16.map(rgb) });
	systemScenarios.palette_only = dumpTheme(th.getThemeByName("system"));

	out[`system_${mode}`] = systemScenarios;
}

// ==========================================================================
// Group 6: pure helpers — detectColorFgBgTheme / detectTerminalTheme grids,
// setting helpers, the name-based export helpers, theme ordering.
// ==========================================================================
{
	const th = await import("./theme.ts?g=helpers");
	globalThis.__piColorMode = "truecolor";

	const colorfgbgCases = [
		"0;15", "15;0", "0;7;15", undefined, "", "15;bad;300", "15;bad",
		"7", "8", "6", "9", "16", "007", "1", "0; 8 ", "a;9;", "-1", "08",
	];
	out.detect_colorfgbg = colorfgbgCases.map((value) => {
		const env = value === undefined ? {} : { COLORFGBG: value };
		return { colorfgbg: value ?? null, theme: th.detectColorFgBgTheme(env) ?? null };
	});

	const terminalColorCases = [
		{},
		{ background: rgb("#1e1e2e"), foreground: rgb("#c4c4d4") },
		{ background: rgb("#e8e8e8"), foreground: rgb("#202028") },
		{ background: rgb("#808080"), foreground: rgb("#808080") },
		{ background: rgb("#000000") },
		{ background: rgb("#ffffff") },
		{ foreground: rgb("#c4c4d4") },
	];
	const schemes = [undefined, "dark", "light"];
	const colorfgbg = [undefined, "15;0", "15;7"];
	out.detect_terminal_theme = [];
	for (const colors of terminalColorCases) {
		for (const scheme of schemes) {
			for (const envValue of colorfgbg) {
				const env = envValue === undefined ? {} : { COLORFGBG: envValue };
				out.detect_terminal_theme.push({
					background: colors.background ? colorToHex(tui.rgbColor(colors.background.r, colors.background.g, colors.background.b)) : null,
					foreground: colors.foreground ? colorToHex(tui.rgbColor(colors.foreground.r, colors.foreground.g, colors.foreground.b)) : null,
					scheme: scheme ?? null,
					colorfgbg: envValue ?? null,
					theme: th.detectTerminalTheme(colors, scheme, env),
				});
			}
		}
	}

	const autoCases = [
		"light/dark", " my-light / my-dark ", "light/dark/extra", "light/", "/dark",
		"plain", "", undefined, "a/b/c", "dark/", "/", "system/light",
	];
	out.auto = autoCases.map((value) => {
		const parsed = th.parseAutoThemeSetting(value);
		return parsed ? { lightTheme: parsed.lightTheme, darkTheme: parsed.darkTheme } : null;
	});

	const settings = ["dark", "light/dark", "light/dark/extra", undefined, "system", "a/b"];
	const terminals = ["light", "dark"];
	out.resolve_setting = settings.map((setting) =>
		terminals.map((terminal) => th.resolveThemeSetting(setting, terminal) ?? null),
	);

	// Name-based export helpers (they run through the theme store).
	th.setTerminalColors({
		foreground: rgb("#c4c4d4"),
		background: rgb("#1e1e2e"),
		palette: XTERM16.map(rgb),
	});
	th.setTheme("dark");
	out.resolved_dark_hex = th.getResolvedThemeColors();
	out.export_dark = th.getThemeExportColors("dark");
	out.export_system = th.getThemeExportColors("system");
	out.export_missing = th.getThemeExportColors("nope");
	th.setTheme("light");
	out.resolved_light_hex = th.getResolvedThemeColors();
	out.is_light = {
		light: th.isLightTheme("light"),
		dark: th.isLightTheme("dark"),
		system: th.isLightTheme("system"),
	};
	out.available_themes = th.getAvailableThemes();
	const oracleDir = fileURLToPath(new URL(".", import.meta.url));
	out.available_themes_with_paths = th.getAvailableThemesWithPaths().map(({ name, path }) => ({
		name,
		path: path === undefined ? null : path.slice(oracleDir.length - 1),
	}));
}

const json = JSON.stringify(out, null, "\t") + "\n";
writeFileSync(new URL("./theme_delta_oracle.json", import.meta.url), json);
console.log(
	JSON.stringify({
		groups: Object.keys(out),
		sha256: createHash("sha256").update(json).digest("hex"),
	}),
);
