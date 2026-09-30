// Oracle capture for the agent-session slice (W3.11, upstream agent-session.ts
// upper half). The pure upstream functions exercised by the slice's tests are
// copied VERBATIM from the pi workspace sources below (direct module imports
// would pull npm dependencies that are not installed in this checkout); each
// copy names its source file and line range. Everything else is executed from
// the real upstream files (packages/ai/src/utils/text.ts via file URL).
//
// Run: node --experimental-strip-types capture_oracle.mjs > oracle.json
// (requires PI_PACKAGE_DIR set to an absolute path; see the runner .cmd)

import { contentText, getSystemMessageText } from "../../../pi/packages/ai/src/utils/text.ts";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/agent-session.ts:139-148
// ---------------------------------------------------------------------------
/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
function parseSkillBlock(text) {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/config.ts:389-394 (env branch
// only; the node package-dir discovery is irrelevant under PI_PACKAGE_DIR)
// ---------------------------------------------------------------------------
function getPackageDir() {
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}
	throw new Error("PI_PACKAGE_DIR must be set for the oracle run");
}
function normalizePath(p) {
	// VERBATIM COPY of pi/packages/coding-agent/src/utils/paths.ts normalizePath
	// (posix-only branch behavior for absolute inputs is irrelevant here; the
	// oracle always passes a Windows absolute path, which round-trips).
	return p.replace(/\\/g, "/");
}

// VERBATIM COPY: pi/packages/coding-agent/src/config.ts:440-452
function getReadmePath() {
	return resolve(join(getPackageDir(), "README.md"));
}
function getDocsPath() {
	return resolve(join(getPackageDir(), "docs"));
}
function getExamplesPath() {
	return resolve(join(getPackageDir(), "examples"));
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/system-prompt.ts:55-216
// (whole public surface; `Skill` and `formatSkillsForPrompt` are supplied by
// the verbatim copy from skills.ts below)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
function normalizeBuildSystemPromptOptions(input) {
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

function renderProjectContext(contextFiles) {
	return [
		"Project-specific instructions and guidelines:",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
	].join("\n\n");
}

function buildRules(selectedTools, toolGuidelines, promptGuidelines) {
	const rules = [];
	const seen = new Set();
	const addRule = (rule) => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	const hasBash = selectedTools.includes("bash");
	const hasPowerShell = selectedTools.includes("powershell");
	const hasGrep = selectedTools.includes("grep");
	const hasFind = selectedTools.includes("find");
	const hasLs = selectedTools.includes("ls");

	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addRule("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addRule("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addRule("Use bash for file operations like ls, rg, find");
		}
	}

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	for (const rule of promptGuidelines) addRule(rule);
	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

function buildSystemPromptSections(input) {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		sections: customSections,
		cwd,
		contextFiles,
		skills,
	} = options;

	for (const name of Object.keys(customSections)) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
	}

	const promptSections = {};
	if (customPrompt) {
		promptSections.preamble = customPrompt;
	} else {
		promptSections.preamble =
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
		const visibleTools = selectedTools.filter((name) => !!toolSnippets[name]);
		const tools =
			visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
		promptSections.tools = `${tools}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
		promptSections.rules = buildRules(selectedTools, toolGuidelines, promptGuidelines);
		promptSections.docs = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
	}

	if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt;
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);
	const skillFileReadTool = ["read", "bash"].find((tool) => selectedTools.includes(tool));
	if (skillFileReadTool && skills.length > 0) {
		const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}
	promptSections.cwd = cwd.replace(/\\/g, "/");
	for (const [name, content] of Object.entries(customSections)) {
		if (content) promptSections[name] = content;
	}

	const sections = { preamble: promptSections.preamble };
	for (const [name, content] of Object.entries(promptSections)) {
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}
	return sections;
}

function buildSystemPromptState(input) {
	if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
	return { content: "", sections: buildSystemPromptSections(input) };
}

function buildSystemPrompt(input) {
	return getSystemMessageText({ role: "system", ...buildSystemPromptState(input), timestamp: 0 });
}

function diffSystemPromptSections(previous, current) {
	const patch = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/skills.ts:347-393
// (formatSkillsForPrompt + escapeXml; the module cannot be imported because it
// pulls the npm `ignore` package)
// ---------------------------------------------------------------------------
function formatSkillsForPrompt(skills, fileReadTool = "read") {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		fileReadTool === "read"
			? "Use the read tool to load a skill's file when the task matches its description."
			: "Use bash to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

function escapeXml(str) {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// VERBATIM COPY: pi/packages/coding-agent/src/core/prompt-templates.ts:26-67,
// 70-124, 269-285 (parseCommandArgs, substituteArgs, expandPromptTemplate; the
// module cannot be imported because config.ts -> child-process.ts pulls the
// npm `cross-spawn` package). substituteArgs bodies: lines 70-124 hold the
// four sequential replaces; the copied body below is the verbatim function.
// ---------------------------------------------------------------------------
function parseCommandArgs(argsString) {
	const args = [];
	let current = "";
	let inQuote = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

function substituteArgs(content, args) {
	let result = content;

	// Replace positional arguments $1, $2, ...
	result = result.replace(/\$(\d+)/g, (match, num) => {
		const index = parseInt(num, 10) - 1;
		return index < args.length ? args[index] : match;
	});

	// Replace argument ranges ${@:start:length}
	result = result.replace(/\$\{@:(\d+):(\d+)\}/g, (match, start, length) => {
		const startIndex = parseInt(start, 10) - 1;
		return args.slice(startIndex, startIndex + parseInt(length, 10)).join(" ");
	});

	// Replace $ARGUMENTS with all args
	result = result.replace(/\$ARGUMENTS/g, args.join(" "));

	// Replace $@ with all args
	result = result.replace(/\$@/g, args.join(" "));

	return result;
}

function expandPromptTemplate(text, templates) {
	if (!text.startsWith("/")) return text;

	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;

	const templateName = match[1];
	const argsString = match[2] ?? "";

	const template = templates.find((t) => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		return substituteArgs(template.content, args);
	}

	return text;
}

// ---------------------------------------------------------------------------
// Scenario capture
// ---------------------------------------------------------------------------
const skill_block_cases = [
	'<skill name="commit" location="/home/u/.pi/agent/skills/commit/SKILL.md">\nCommit the staged changes.\n</skill>',
	'<skill name="review" location="/r/SKILL.md">\nReview it.\n\nPlease review my diff',
	'<skill name="bad name" location="/x">\nbody\n</skill>',
	"no skill here",
	'<skill name="a" location="/b">\nline1\nline2\n</skill>\n\n  trimmed user msg  \nwith second line',
];

const sections_cases = [
	{
		name: "default_with_bash_read",
		input: {
			cwd: "C:\\work\\demo",
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "Read files from disk." },
			toolGuidelines: { bash: ["Use bash carefully", " Use bash carefully ", "  "] },
			promptGuidelines: ["Extra rule"],
			appendSystemPrompt: "APPEND TEXT",
			contextFiles: [{ path: "AGENTS.md", content: "Be nice" }],
			skills: [],
			sections: { custom_section: "CUSTOM CONTENT" },
		},
	},
	{
		name: "custom_prompt_overrides",
		input: { cwd: "/a/b", customPrompt: "My custom prompt", selectedTools: [] },
	},
	{
		name: "skills_present",
		input: {
			cwd: "/w",
			selectedTools: ["bash", "read"],
			skills: [
				{
					name: "commit",
					description: "Commits & pushes <stuff>",
					filePath: "/s/commit/SKILL.md",
					baseDir: "/s/commit",
					sourceInfo: { source: "user", scope: "permanent", origin: "top-level" },
					disableModelInvocation: false,
				},
				{
					name: "hidden",
					description: "Hidden skill",
					filePath: "/s/hidden/SKILL.md",
					baseDir: "/s/hidden",
					sourceInfo: { source: "user", scope: "permanent", origin: "top-level" },
					disableModelInvocation: true,
				},
			],
		},
	},
];

const diff_cases = [
	{
		name: "changed_and_removed",
		previous: { preamble: "old preamble", removed_section: "gone", same: "same" },
		previous_source: "sections_default_with_bash_read",
	},
];

const expand_cases = [
	{ text: "/deploy prod --fast", templates: [{ name: "deploy", content: "Deploy to $1 with $ARGUMENTS and $@" }] },
	{ text: "/deploy", templates: [{ name: "deploy", content: "Args: [$1] [$2] [${@:2:2}]" }] },
	{ text: "/missing args", templates: [{ name: "other", content: "x" }] },
	{ text: "no slash", templates: [{ name: "deploy", content: "x" }] },
	{ text: "/deploy 'a b' \"c d\" plain", templates: [{ name: "deploy", content: "$ARGUMENTS | $@" }] },
];

const prompt_state_cases = [{ name: "forced", input: { cwd: "/a/b", forceSystemPrompt: "FORCED PROMPT" } }];

const result = {
	skill_block: skill_block_cases.map((text) => parseSkillBlock(text)),
	sections: sections_cases.map(({ name, input }) => {
		try {
			return { name, sections: buildSystemPromptSections(input) };
		} catch (error) {
			return { name, error: error.message };
		}
	}),
	diff: diff_cases.map(({ name, previous, previous_source }) => ({
		name,
		patch: diffSystemPromptSections(previous, buildSystemPromptSections(sections_cases.find((c) => `sections_${c.name}` === previous_source).input)),
	})),
	prompt: prompt_state_cases.map(({ name, input }) => ({ name, text: buildSystemPrompt(input) })),
	prompt_full: sections_cases.map(({ name, input }) => ({ name, text: buildSystemPrompt(input) })),
	expand: expand_cases.map(({ text, templates }) => expandPromptTemplate(text, templates)),
	parse_command_args: [
		parseCommandArgs("a 'b c' \"d e\" plain"),
		parseCommandArgs(""),
		parseCommandArgs("   "),
		parseCommandArgs("'unterminated"),
	],
};

process.stdout.write(JSON.stringify(result, null, 2));
