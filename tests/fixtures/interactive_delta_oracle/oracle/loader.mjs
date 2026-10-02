import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
const herePath = fileURLToPath(here);

// Bare specifier → local module.
const BARE = new Map([
	["@earendil-works/pi-tui", new URL("pi-tui.ts", here).href],
	["chalk", new URL("chalk-stub.mjs", here).href],
]);

// Upstream relative imports → harness seams, matched on the resolved path's
// file name.
const SEAMS = new Map([
	["config.ts", new URL("config-stub.mjs", here).href],
	["fs-watch.ts", new URL("fs-watch-stub.mjs", here).href],
	["syntax-highlight.ts", new URL("syntax-highlight-stub.mjs", here).href],
	["text.ts", new URL("text-stub.mjs", here).href],
	["experimental.ts", new URL("experimental-stub.ts", here).href],
	["usage-totals.ts", new URL("usage_totals_verbatim.ts", here).href],
]);

// Vendored sources queried imports may target (fresh module state per query).
const SOURCES = new Set([
	"theme.ts",
	"system-theme.ts",
	"theme-json.ts",
	"colors.ts",
	"oklab.ts",
	"terminal-colors.ts",
]);

export async function resolve(specifier, context, nextResolve) {
	const bare = BARE.get(specifier);
	if (bare) {
		return { url: bare, shortCircuit: true };
	}

	// `./theme.ts?g=<group>` style imports.
	const queryMatch = /^\.\/([a-z-]+\.ts)(\?.+)$/.exec(specifier);
	if (queryMatch && SOURCES.has(queryMatch[1])) {
		return { url: new URL(`${queryMatch[1]}${queryMatch[2]}`, here).href, shortCircuit: true };
	}

	if (specifier.startsWith(".") && context.parentURL) {
		const resolved = new URL(specifier, context.parentURL);
		const base = resolved.pathname.split("/").pop() ?? "";
		const seam = SEAMS.get(base);
		if (seam) {
			return { url: seam, shortCircuit: true };
		}
	}

	return nextResolve(specifier, context);
}
