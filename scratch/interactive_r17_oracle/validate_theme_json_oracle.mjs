// r17 oracle for `theme-json.ts` validateThemeJson
// (sha256 144a2c1e6b9a92c5f31ecc8cd37d979e473309716439aca57c7e6a542ad20f73).
//
// SEAM (disclosed in interactive/mod.rs): the upstream validator delegates the
// structural check to typebox `Compile(ThemeJsonSchema).Check/Errors`, and
// typebox is not installable in this offline workspace (pi/ has no
// node_modules). The schema semantics (required /colors keys, ColorValue =
// string | 0..255 integer, optional keys) are re-stated here and the upstream
// error-ASSEMBLY body is copied verbatim. Scenarios are restricted to the
// paths whose output is fully determined by the schema semantics
// (required-missing lists, name rule, accept) and are therefore byte-exact;
// typebox's "Other errors" message wording is NOT exercised by the oracle and
// is a disclosed divergence (D3).
import { readFileSync, writeFileSync } from "node:fs";

// Upstream ThemeJsonSchema required "colors" keys in declaration order.
const REQUIRED_COLORS = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
	"muted", "dim", "text", "thinkingText", "selectedBg", "userMessageBg",
	"customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg",
	"toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink",
	"mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
	"mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
	"syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
	"syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff",
	"thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
	"bashMode",
];
const OPTIONAL_COLORS = ["scrollbarTrack", "scrollbarThumb", "searchMatchBg", "searchMatchText", "thinkingMax"];

const isColorValue = (value) =>
	typeof value === "string" || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255);

// Mirrors compiledThemeSchema.Check(json) for the object shapes the oracle
// exercises (top-level object, colors map, export map).
function check(json) {
	const missing = new Set();
	if (typeof json !== "object" || json === null || Array.isArray(json)) return false;
	if (typeof json.name !== "string") return false;
	if (json.$schema !== undefined && typeof json.$schema !== "string") return false;
	if (json.vars !== undefined) {
		if (typeof json.vars !== "object" || json.vars === null || Array.isArray(json.vars)) return false;
		for (const value of Object.values(json.vars)) if (!isColorValue(value)) return false;
	}
	if (typeof json.colors !== "object" || json.colors === null || Array.isArray(json.colors)) return false;
	for (const key of REQUIRED_COLORS) {
		if (!(key in json.colors)) missing.add(key);
		else if (!isColorValue(json.colors[key])) return false;
	}
	if (json.export !== undefined) {
		if (typeof json.export !== "object" || json.export === null || Array.isArray(json.export)) return false;
		for (const value of Object.values(json.export)) if (!isColorValue(value)) return false;
	}
	return missing.size === 0;
}

// Mirrors compiledThemeSchema.Errors(json) for the missing-color path.
function requiredErrors(json) {
	const errors = [];
	if (typeof json !== "object" || json === null) return errors;
	if (typeof json.colors !== "object" || json.colors === null) {
		errors.push({ keyword: "required", instancePath: "/colors", params: { requiredProperties: [...REQUIRED_COLORS] } });
		return errors;
	}
	const missing = REQUIRED_COLORS.filter((key) => !(key in json.colors));
	if (missing.length > 0) errors.push({ keyword: "required", instancePath: "/colors", params: { requiredProperties: missing } });
	return errors;
}

// ---- verbatim theme-json.ts: validateThemeJson message assembly ---------
function validateThemeJson(label, json) {
	if (!check(json)) {
		const errors = requiredErrors(json);
		const missingColors = new Set();
		const otherErrors = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = error.params?.requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.size > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	if (json.name.includes("/")) {
		throw new Error(
			`Invalid theme name "${json.name}": theme names cannot contain "/" because it is reserved for automatic light/dark theme settings.`,
		);
	}
	return json;
}

// ---- driver ---------------------------------------------------------
const dark = JSON.parse(readFileSync(new URL("./dark.json", import.meta.url), "utf-8"));
const out = {};

out.valid_dark_name = validateThemeJson("dark.json", dark).name;

{
	const broken = JSON.parse(JSON.stringify(dark));
	delete broken.colors.accent;
	delete broken.colors.thinkingXhigh;
	delete broken.colors.bashMode;
	delete broken.colors.userMessageBg;
	out.missing_four = (() => {
		try {
			validateThemeJson("broken.json", broken);
			return null;
		} catch (e) {
			return e.message;
		}
	})();
}

{
	const noColors = JSON.parse(JSON.stringify(dark));
	delete noColors.colors;
	out.colors_absent = (() => {
		try {
			validateThemeJson("nocolors.json", noColors);
			return null;
		} catch (e) {
			return e.message;
		}
	})();
}

out.name_slash = (() => {
	try {
		validateThemeJson("pair.json", { ...dark, name: "light/dark" });
		return null;
	} catch (e) {
		return e.message;
	}
})();

// A minimal-but-complete custom theme is accepted.
out.valid_minimal = validateThemeJson("minimal.json", {
	name: "minimal",
	vars: { ink: "#010203" },
	colors: Object.fromEntries(REQUIRED_COLORS.map((key) => [key, key === "accent" ? "ink" : "#0a0b0c"])),
	scrollbarTrack: 24,
	searchMatchText: "",
}).name;

writeFileSync(new URL("./theme_json_oracle.json", import.meta.url), JSON.stringify(out, null, "\t"));
console.log("wrote theme_json_oracle.json");
