// ORACLE PARTIAL COPY of upstream `src/core/system-prompt.ts` (sha256 at
// migration time, full file: see port report). The verbatim exports
// `normalizeBuildSystemPromptOptions` and `buildSystemPromptState` are copied
// unchanged below. `buildSystemPrompt` is a disclosed shim: upstream renders
// full prompt sections through pi-ai `getSystemMessageText` plus config/skills
// file loads, which the oracle tree does not vendor. The shim keeps the exact
// forceSystemPrompt contract (`buildSystemPromptState` short-circuit) and
// renders a deterministic stand-in for the section path so runner chaining
// scenarios stay byte-stable. Runner logic (the thing under capture) is the
// verbatim `runner.ts` copy.
import * as fs from "node:fs";

export interface BuildSystemPromptOptions {
	customPrompt?: string;
	forceSystemPrompt?: string;
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	toolGuidelines?: Record<string, string[]>;
	promptGuidelines?: string[];
	appendSystemPrompt?: string;
	sections?: Record<string, string>;
	cwd: string;
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Array<{ name: string; path: string }>;
}

export type NormalizedBuildSystemPromptOptions = Required<
	Pick<BuildSystemPromptOptions, "selectedTools" | "toolSnippets" | "toolGuidelines" | "promptGuidelines" | "appendSystemPrompt" | "sections" | "cwd" | "contextFiles" | "skills">
> &
	BuildSystemPromptOptions;

export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? ["read", "bash", "edit", "write"])],
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		sections: { ...(input.sections ?? {}) },
		cwd: input.cwd,
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		skills: (input.skills ?? []).map((skill) => ({ ...skill })),
	};
}

export function buildSystemPromptState(input: BuildSystemPromptOptions): {
	content: string;
	sections?: Record<string, string>;
} {
	if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
	// Disclosed shim for the section path (see header): deterministic marker,
	// no fs/pi-ai involvement.
	return {
		content: [
			"ORACLE-SHIM(base)",
			`customPrompt=${input.customPrompt ?? ""}`,
			`selectedTools=${(input.selectedTools ?? ["read", "bash", "edit", "write"]).join(",")}`,
			`appendSystemPrompt=${input.appendSystemPrompt ?? ""}`,
		].join("\n"),
	};
}

/** Disclosed shim (see header): force path is verbatim; section path renders the marker. */
export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
	return buildSystemPromptState(input).content;
}

// Keep fs referenced so the copy mirrors the upstream module shape (upstream
// reads context files here); the shim performs no IO.
void fs;
