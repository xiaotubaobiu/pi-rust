// r17 oracle driver. The function bodies below are copied VERBATIM from
// upstream `coding-agent/src/modes/interactive/theme/theme.ts`
// (sha256 c3bf2e3b72f6bb782f34de0535fcc1758b9b6ea7a0d2e7d6f17244fa55c3f31a)
// except where a comment marks the single seam adjustment (module-private
// state / fs+config loading replaced by explicit inputs; the bodies of the
// seeded expressions are unchanged).
// The typebox-backed validateThemeJson seam is replicated separately in
// validate_theme_json_oracle.mjs (see the header comment there).
// Output: theme_oracle.json — every entry is a byte-exact expectation.
import { readFileSync, writeFileSync } from "node:fs";

// ---- verbatim theme.ts: Color Utilities -------------------------------
function hexToRgb(hex) {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

// The 6x6x6 color cube channel values (indices 0-5)
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

// Grayscale ramp values (indices 232-255, 24 grays from 8 to 238)
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function findClosestCubeIndex(value) {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - CUBE_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function findClosestGrayIndex(gray) {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - GRAY_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
	// Weighted Euclidean distance (human eye is more sensitive to green)
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbTo256(r, g, b) {
	// Find closest color in the 6x6x6 cube
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	const cubeR = CUBE_VALUES[rIdx];
	const cubeG = CUBE_VALUES[gIdx];
	const cubeB = CUBE_VALUES[bIdx];
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

	// Find closest grayscale
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx];
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

	// Check if color has noticeable saturation (hue matters)
	// If max-min spread is significant, prefer cube to preserve tint
	const maxC = Math.max(r, g, b);
	const minC = Math.min(r, g, b);
	const spread = maxC - minC;

	// Only consider grayscale if color is nearly neutral (spread < 10)
	// AND grayscale is actually closer
	if (spread < 10 && grayDist < cubeDist) {
		return grayIndex;
	}

	return cubeIndex;
}

function hexTo256(hex) {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

function fgAnsi(color, mode) {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[38;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function bgAnsi(color, mode) {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[48;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[48;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function resolveVarRefs(value, vars, visited = new Set()) {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors(colors, vars = {}) {
	const resolved = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved;
}

function withThemeColorFallbacks(colors) {
	return {
		...colors,
		scrollbarTrack: colors.scrollbarTrack ?? colors.muted,
		scrollbarThumb: colors.scrollbarThumb ?? colors.text,
		thinkingMax: colors.thinkingMax ?? colors.thinkingXhigh,
		searchMatchBg: colors.searchMatchBg ?? colors.selectedBg,
		searchMatchText: colors.searchMatchText ?? colors.text,
	};
}

// ---- verbatim theme.ts: HTML Export Helpers ---------------------------
function ansi256ToHex(index) {
	// Basic colors (0-15) - approximate common terminal values
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

// ---- verbatim theme.ts: getResolvedThemeColors body over explicit json
// (upstream reads `themeName` through loadThemeJson/getBuiltinThemes fs+config
// indirection; here the byte-identical built-in JSONs are read directly)
function getResolvedThemeColorsFor(themeJson) {
	const isLight = themeJson.name === "light";
	const resolved = resolveThemeColors(withThemeColorFallbacks(themeJson.colors), themeJson.vars);

	// Default text color for empty values (terminal uses default fg color)
	const defaultText = isLight ? "#000000" : "#e5e5e7";

	const cssColors = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// Empty means default terminal color - use sensible fallback for HTML
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

// ---- verbatim theme.ts: getThemeExportColors body over explicit json ---
function getThemeExportColorsFor(themeJson) {
	const exportSection = themeJson.export;
	if (!exportSection) return {};

	const vars = themeJson.vars ?? {};
	const resolve = (value) => {
		if (value === undefined) return undefined;
		const resolved = resolveVarRefs(value, vars);
		if (typeof resolved === "number") return ansi256ToHex(resolved);
		if (resolved === "") return undefined;
		return resolved;
	};

	return {
		pageBg: resolve(exportSection.pageBg),
		cardBg: resolve(exportSection.cardBg),
		infoBg: resolve(exportSection.infoBg),
	};
}

// ---- verbatim theme.ts: terminal theme detection ----------------------
function getColorFgBgBackgroundIndex(colorfgbg) {
	const parts = colorfgbg.split(";");
	for (let i = parts.length - 1; i >= 0; i--) {
		const bg = parseInt(parts[i].trim(), 10);
		if (Number.isInteger(bg) && bg >= 0 && bg <= 255) {
			return bg;
		}
	}
	return undefined;
}

function getRgbColorLuminance({ r, g, b }) {
	const toLinear = (channel) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function getAnsiColorLuminance(index) {
	return getRgbColorLuminance(hexToRgb(ansi256ToHex(index)));
}

function getThemeForRgbColor(rgb) {
	return getRgbColorLuminance(rgb) >= 0.5 ? "light" : "dark";
}

// upstream signature `detectTerminalBackgroundFromEnv(options = {})` with
// `options.env ?? process.env` — the env lookup is the seam; the body is verbatim.
function detectTerminalBackgroundFromEnv(env) {
	const colorfgbg = env.COLORFGBG || "";
	const bg = getColorFgBgBackgroundIndex(colorfgbg);
	if (bg !== undefined) {
		return {
			theme: getAnsiColorLuminance(bg) >= 0.5 ? "light" : "dark",
			source: "COLORFGBG",
			detail: `background color index ${bg}`,
			confidence: "high",
		};
	}

	return {
		theme: "dark",
		source: "fallback",
		detail: "no terminal background hint found",
		confidence: "low",
	};
}

// ---- verbatim theme.ts: theme setting helpers -------------------------
function parseAutoThemeSetting(themeSetting) {
	if (!themeSetting) return undefined;
	const slashIndex = themeSetting.indexOf("/");
	if (slashIndex === -1 || themeSetting.indexOf("/", slashIndex + 1) !== -1) {
		return undefined;
	}

	const lightTheme = themeSetting.slice(0, slashIndex).trim();
	const darkTheme = themeSetting.slice(slashIndex + 1).trim();
	if (!lightTheme || !darkTheme) {
		return undefined;
	}
	return { lightTheme, darkTheme };
}

function resolveThemeSetting(themeSetting, terminalTheme) {
	const autoTheme = parseAutoThemeSetting(themeSetting);
	if (autoTheme) {
		return terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme;
	}
	if (themeSetting?.includes("/")) return undefined;
	if (typeof themeSetting === "string") return themeSetting;
	return undefined;
}

// ---- verbatim theme.ts: getLanguageFromPath ----------------------------
function getLanguageFromPath(filePath) {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

// ==========================================================================
// Driver
// ==========================================================================
const out = {};

// 1. rgbTo256 over a dense RGB grid (channel step 17 -> 5832 colors) plus the
//    grayscale ramp boundaries.
{
	const grid = [];
	for (let r = 0; r <= 255; r += 17)
		for (let g = 0; g <= 255; g += 17)
			for (let b = 0; b <= 255; b += 17) grid.push(`${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`);
	out.rgb_to_256 = grid.map((hex) => hexTo256(`#${hex}`));
}

// 2. ansi256ToHex over all 256 indices.
out.ansi256_to_hex = Array.from({ length: 256 }, (_, i) => ansi256ToHex(i));

// 3. fgAnsi/bgAnsi over representative values in both modes, plus error cases.
{
	const values = ["", "#ff0000", "#00d7ff", "#d4d4d4", "#808080", 0, 15, 24, 255];
	const modes = ["truecolor", "256color"];
	const entries = [];
	for (const mode of modes)
		for (const value of values) {
			entries.push(fgAnsi(value, mode));
			entries.push(bgAnsi(value, mode));
		}
	out.ansi = entries;
	try {
		fgAnsi("primary", "truecolor");
		out.ansi_error = null;
	} catch (e) {
		out.ansi_error = e.message;
	}
}

// 4. resolveVarRefs: literals, var chains, circular + missing errors.
{
	const vars = { a: "#112233", b: "a", c: "b", loop1: "loop2", loop2: "loop1", missing: "nope" };
	out.resolve = {
		hex: resolveVarRefs("#abcdef", vars),
		empty: resolveVarRefs("", vars),
		index: resolveVarRefs(24, vars),
		direct: resolveVarRefs("a", vars),
		nested: resolveVarRefs("c", vars),
		circular_error: (() => {
			try {
				resolveVarRefs("loop1", vars);
				return null;
			} catch (e) {
				return e.message;
			}
		})(),
		missing_error: (() => {
			try {
				resolveVarRefs("nope", vars);
				return null;
			} catch (e) {
				return e.message;
			}
		})(),
	};
}

// 5. withThemeColorFallbacks + resolved builtin colors for dark/light.
{
	const dark = JSON.parse(readFileSync(new URL("./dark.json", import.meta.url), "utf-8"));
	const light = JSON.parse(readFileSync(new URL("./light.json", import.meta.url), "utf-8"));
	out.resolved_dark = getResolvedThemeColorsFor(dark);
	out.resolved_light = getResolvedThemeColorsFor(light);
	// fallbacks on a doc without the optional keys
	const stripped = JSON.parse(JSON.stringify(dark));
	for (const key of ["scrollbarTrack", "scrollbarThumb", "thinkingMax", "searchMatchBg", "searchMatchText"])
		delete stripped.colors[key];
	out.fallback_resolved = resolveThemeColors(withThemeColorFallbacks(stripped.colors), stripped.vars);
	// the same fallback doc rendered through the Theme ANSI table (256color mode)
	const fallbackAnsi = {};
	for (const [key, value] of Object.entries(withThemeColorFallbacks(stripped.colors))) {
		const resolvedValue = resolveVarRefs(value, stripped.vars);
		fallbackAnsi[key] =
			key === "selectedBg" || key === "searchMatchBg" || key.endsWith("Bg")
				? bgAnsi(resolvedValue, "256color")
				: fgAnsi(resolvedValue, "256color");
	}
	out.fallback_ansi_256 = fallbackAnsi;
}

// 6. getThemeExportColors semantics.
{
	const dark = JSON.parse(readFileSync(new URL("./dark.json", import.meta.url), "utf-8"));
	const withVars = {
		...dark,
		name: "custom-export-vars",
		vars: { ...(dark.vars ?? {}), pageBgVar: "#112233", pageBgAlias: "pageBgVar", infoBgVar: "#445566", cardBgVar: "#223344" },
		export: { pageBg: "pageBgAlias", cardBg: "cardBgVar", infoBg: "infoBgVar" },
	};
	const recursive = {
		...dark,
		name: "custom-export-recursive",
		vars: { ...(dark.vars ?? {}), deepPageBg: "#abcdef", pageBgAlias: "deepPageBg", cardBgAnsi: 24 },
		export: { pageBg: "pageBgAlias", cardBg: "cardBgAnsi", infoBg: "" },
	};
	out.export_dark = getThemeExportColorsFor(dark);
	out.export_vars = getThemeExportColorsFor(withVars);
	out.export_recursive = getThemeExportColorsFor(recursive);
	out.export_none = getThemeExportColorsFor({ ...dark, export: undefined });
}

// 7. terminal theme detection.
{
	out.detect_env = [
		detectTerminalBackgroundFromEnv({ COLORFGBG: "0;15" }),
		detectTerminalBackgroundFromEnv({ COLORFGBG: "15;0" }),
		detectTerminalBackgroundFromEnv({ COLORFGBG: "0;7;15" }),
		detectTerminalBackgroundFromEnv({}),
		detectTerminalBackgroundFromEnv({ COLORFGBG: "" }),
		detectTerminalBackgroundFromEnv({ COLORFGBG: "15;bad;300" }),
		detectTerminalBackgroundFromEnv({ COLORFGBG: "15;bad" }),
	];
	out.rgb_themes = [
		getThemeForRgbColor({ r: 8, g: 8, b: 8 }),
		getThemeForRgbColor({ r: 250, g: 250, b: 250 }),
		getThemeForRgbColor({ r: 128, g: 128, b: 128 }),
		getThemeForRgbColor({ r: 0, g: 0, b: 0 }),
		getThemeForRgbColor({ r: 255, g: 255, b: 255 }),
	];
	out.ansi_luminance_themes = Array.from({ length: 256 }, (_, i) =>
		getAnsiColorLuminance(i) >= 0.5 ? "light" : "dark",
	);
}

// 8. theme setting helpers (upstream test cases plus extras).
{
	const auto = [
		"light/dark",
		" my-light / my-dark ",
		"light/dark/extra",
		"light/",
		"/dark",
		"plain",
		"",
		undefined,
		"a/b/c",
	];
	out.auto = auto.map(parseAutoThemeSetting);
	const settings = ["dark", "light/dark", "light/dark/extra", undefined];
	const terminals = ["light", "dark"];
	out.resolve_setting = settings.map((s) => terminals.map((t) => resolveThemeSetting(s, t)));
}

// 9. language table.
{
	const paths = [
		"a.ts", "B.TSX", "x.js", "y.mjs", "z.cjs", "p.py", "q.rb", "main.rs", "m.go",
		"F.java", "a.kt", "b.swift", "c.c", "d.h", "e.cpp", "f.cc", "g.cxx", "h.hpp",
		"i.cs", "j.php", "k.sh", "l.bash", "m.zsh", "n.fish", "o.ps1", "p.sql",
		"q.html", "r.htm", "s.css", "t.scss", "u.sass", "v.less", "w.json",
		"x.yaml", "y.yml", "z.toml", "a.xml", "b.md", "c.markdown", "Dockerfile",
		"Makefile", "CMakeLists.txt".toLowerCase(), "a.lua", "b.perl", "c.r",
		"d.scala", "e.clj", "f.ex", "g.exs", "h.erl", "i.hs", "j.ml", "k.vim",
		"l.graphql", "m.proto", "n.tf", "o.hcl", "no-ext", "", "a.",
	];
	out.languages = paths.map(getLanguageFromPath);
}

// 10. Theme ANSI tables for the built-in themes in both color modes
//     (mirrors Theme's constructor: bg keys routed to bgAnsi, fallbacks applied).
{
	const dark = JSON.parse(readFileSync(new URL("./dark.json", import.meta.url), "utf-8"));
	const light = JSON.parse(readFileSync(new URL("./light.json", import.meta.url), "utf-8"));
	const bgColorKeys = new Set([
		"selectedBg",
		"searchMatchBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
	]);
	const themeTable = (themeJson, mode) => {
		const resolved = resolveThemeColors(withThemeColorFallbacks(themeJson.colors), themeJson.vars);
		const fg = {};
		const bg = {};
		for (const [key, value] of Object.entries(resolved)) {
			if (bgColorKeys.has(key)) bg[key] = bgAnsi(value, mode);
			else fg[key] = fgAnsi(value, mode);
		}
		return { fg, bg };
	};
	out.theme_dark_truecolor = themeTable(dark, "truecolor");
	out.theme_dark_256 = themeTable(dark, "256color");
	out.theme_light_truecolor = themeTable(light, "truecolor");
	out.theme_light_256 = themeTable(light, "256color");
}

writeFileSync(new URL("./theme_oracle.json", import.meta.url), JSON.stringify(out, null, "\t"));
console.log("wrote theme_oracle.json");
