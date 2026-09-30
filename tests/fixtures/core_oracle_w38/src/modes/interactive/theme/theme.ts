// ORACLE STUB (not upstream source): faithful subset of upstream
// `src/modes/interactive/theme/theme.ts` (sha256 of the upstream file is
// registered in the port report) — only the surface `resource-loader.ts`
// observes is modeled:
//   - `loadThemeFromPath(themePath)`: read → `JSON.parse(stripBom(...))` →
//     default (validator-less) `parseThemeJson` shape check → theme record.
//   - The two authored error strings (`Failed to parse theme …` /
//     `Invalid theme "…": expected an object with a "colors" map.`).
// The `JSON.parse` prose is V8-owned and NOT pinned by the Rust tests (same
// policy as the frontmatter YAML scanner prose). Color resolution, fallbacks,
// modes, watchers and highlighters are not observable through the resource
// loader and are dropped.
import * as fs from "node:fs";
import { stripBom } from "../../../utils/text.ts";

export interface Theme {
	name?: unknown;
	sourcePath?: string;
	sourceInfo?: unknown;
}

function parseThemeJson(label: string, json: unknown): Record<string, unknown> {
	if (typeof json !== "object" || json === null || !("colors" in json)) {
		throw new Error(`Invalid theme "${label}": expected an object with a "colors" map.`);
	}
	return json as Record<string, unknown>;
}

function parseThemeJsonContent(label: string, content: string): Record<string, unknown> {
	let json: unknown;
	try {
		json = JSON.parse(stripBom(content));
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	return parseThemeJson(label, json);
}

export function loadThemeFromPath(themePath: string): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	const themeJson = parseThemeJsonContent(themePath, content);
	return {
		name: themeJson.name,
		sourcePath: themePath,
	};
}

export type ColorMode = "truecolor" | "256color" | "16color" | "ansi";
