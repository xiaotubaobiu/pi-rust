// r20 oracle scenarios (tree-selector + session-selector). Every scenario is
// deterministic: the global clock is FakeDate (FIXED_NOW) and the keybinding
// registry is reset per scenario. Rendered lines are captured verbatim (ANSI
// included); the Rust tests compare against these bytes.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
	type AnyRec,
	mkEntriesHelpers,
	flushPromises,
	existsSync,
} from "./scenario_helpers.ts";

const { userMessage, assistantMessage, toolCallOnlyAssistant, modelChange, buildTree, stripAnsi } =
	mkEntriesHelpers();

import { setKeybindings } from "./deps.ts";
import {
	KeybindingsManager,
	TreeSelectorComponent,
	SessionSelectorComponent,
	type SessionTreeNode,
	type SessionInfo,
} from "./components.ts";
export { FIXED_NOW } from "./deps.ts";

type ScenarioFn = () => unknown | Promise<unknown>;
const SCENARIOS: Record<string, ScenarioFn> = {};
function scenario(name: string, run: ScenarioFn): void {
	SCENARIOS[name] = run;
}

function fresh(): void {
	setKeybindings(new KeybindingsManager());
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const CTRL_LEFT = "\x1b[1;5D";
const CTRL_RIGHT = "\x1b[1;5C";
const ALT_LEFT = "\x1b[1;3D";
const ALT_RIGHT = "\x1b[1;3C";
// Raw keystrokes for the tree filter bindings (upstream test style: raw control
// bytes; kitty CSI-u for shift+ctrl+o).
const RAW_FILTER_KEYS: Record<string, string> = {
	"app.tree.filter.default": "\x04",
	"app.tree.filter.noTools": "\x14",
	"app.tree.filter.userOnly": "\x15",
	"app.tree.filter.labeledOnly": "\x0c",
	"app.tree.filter.all": "\x01",
	"app.tree.filter.cycleForward": "\x0f",
	"app.tree.filter.cycleBackward": "\x1b[111;6u",
};

// Deterministic scratch directory under this oracle folder (wiped on entry).
function oracleTmpDir(name: string): string {
	const root = decodeURIComponent(new URL("tmp/" + name + "/", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	return root;
}
const CTRL_U = "\x15";
const CTRL_D = "\x04";
const CTRL_L = "\x0c";
const CTRL_X = "\x18";
const CTRL_R = "\x1b[114;5u";
const CTRL_BACKSPACE = "\x1b[127;5u";
const ENTER = "\r";
const ESC = "\x1b";

function selectedId(selector: { getTreeList(): { getSelectedNode(): { entry: { id: string } } | undefined } }): string | null {
	const node = selector.getTreeList().getSelectedNode();
	return node ? node.entry.id : null;
}

// ---------------------------------------------------------------------------
// Tree selector
// ---------------------------------------------------------------------------

scenario("tree_initial_selection", () => {
	fresh();
	const out: AnyRec = {};
	{
		const entries = [
			userMessage("user-1", null, "hello"),
			assistantMessage("asst-1", "user-1", "hi"),
			userMessage("user-2", "asst-1", "active branch"),
			modelChange("model-1", "user-2"),
			userMessage("user-3", "asst-1", "sibling branch"),
		];
		const tree = buildTree(entries);
		const selector = new TreeSelectorComponent(tree, "model-1", 24, () => {}, () => {});
		out.modelChangeLeaf = selectedId(selector);
	}
	{
		const entries = [
			userMessage("user-1", null, "hello"),
			assistantMessage("asst-1", "user-1", "hi"),
			userMessage("user-2", "asst-1", "active branch"),
			{
				type: "thinking_level_change" as const,
				id: "thinking-1",
				parentId: "user-2",
				timestamp: new Date().toISOString(),
				thinkingLevel: "high",
			},
			userMessage("user-3", "asst-1", "sibling branch"),
		];
		const tree = buildTree(entries as SessionTreeNode[]);
		const selector = new TreeSelectorComponent(tree, "thinking-1", 24, () => {}, () => {});
		out.thinkingLeaf = selectedId(selector);
	}
	return out;
});

scenario("tree_filter_parent_traversal", () => {
	fresh();
	const entries = [
		userMessage("user-1", null, "hello"),
		assistantMessage("asst-1", "user-1", "hi"),
		userMessage("user-2", "asst-1", "active branch"),
		assistantMessage("asst-2", "user-2", "response"),
		userMessage("user-3", "asst-1", "sibling branch"),
	];
	const tree = buildTree(entries);
	const selector = new TreeSelectorComponent(tree, "asst-2", 24, () => {}, () => {});
	const steps: Array<{ key: string; selected: string | null }> = [];
	steps.push({ key: "init", selected: selectedId(selector) });
	selector.handleInput(CTRL_U);
	steps.push({ key: "ctrl+u", selected: selectedId(selector) });
	selector.handleInput(CTRL_D);
	steps.push({ key: "ctrl+d", selected: selectedId(selector) });
	return { steps };
});

scenario("tree_help", () => {
	fresh();
	const tree = buildTree([userMessage("user-1", null, "hello"), assistantMessage("asst-1", "user-1", "hi")]);
	const selector = new TreeSelectorComponent(tree, "asst-1", 24, () => {}, () => {});
	const raw = selector.render(30);
	return { raw, plain: raw.map((l: string) => stripAnsi(l)) };
});

scenario("tree_copy", () => {
	fresh();
	const message = `${"long message ".repeat(30)}\nsecond line`;
	const tree = buildTree([userMessage("user-1", null, "hello"), assistantMessage("asst-1", "user-1", message)]);
	const selector = new TreeSelectorComponent(tree, "asst-1", 24, () => {}, () => {});
	let copied: string | undefined | null = null;
	(selector as AnyRec).onCopy = (text: string | undefined) => {
		copied = text;
	};
	selector.handleInput(CTRL_X);
	return { copied };
});

scenario("tree_label_timestamps", () => {
	fresh();
	const entries = [userMessage("user-1", null, "hello"), assistantMessage("asst-1", "user-1", "hi")];
	const tree = buildTree(entries);
	tree[0]!.label = "checkpoint";
	tree[0]!.labelTimestamp = "2026-03-28T14:32:00.000Z";
	const selector = new TreeSelectorComponent(tree, "asst-1", 24, () => {}, () => {});
	const list = selector.getTreeList();
	const before = list.render(200);
	selector.handleInput("T");
	const after = list.render(200);
	return { before, after };
});

scenario("tree_empty_filter_preservation", () => {
	fresh();
	const out: AnyRec = {};
	{
		const entries = [
			userMessage("user-1", null, "hello"),
			assistantMessage("asst-1", "user-1", "hi"),
			userMessage("user-2", "asst-1", "bye"),
			assistantMessage("asst-2", "user-2", "goodbye"),
		];
		const tree = buildTree(entries);
		const selector = new TreeSelectorComponent(tree, "asst-2", 24, () => {}, () => {});
		const steps: Array<{ key: string; selected: string | null }> = [
			{ key: "init", selected: selectedId(selector) },
		];
		selector.handleInput(CTRL_L);
		steps.push({ key: "ctrl+l", selected: selectedId(selector) });
		selector.handleInput(CTRL_D);
		steps.push({ key: "ctrl+d", selected: selectedId(selector) });
		out.first = steps;
	}
	{
		const entries = [userMessage("user-1", null, "hello"), assistantMessage("asst-1", "user-1", "hi")];
		const tree = buildTree(entries);
		const selector = new TreeSelectorComponent(tree, "asst-1", 24, () => {}, () => {});
		const steps: Array<{ key: string; selected: string | null }> = [
			{ key: "init", selected: selectedId(selector) },
		];
		selector.handleInput(CTRL_L);
		steps.push({ key: "ctrl+l", selected: selectedId(selector) });
		selector.handleInput(CTRL_L);
		steps.push({ key: "ctrl+l", selected: selectedId(selector) });
		selector.handleInput(CTRL_L);
		steps.push({ key: "ctrl+l", selected: selectedId(selector) });
		selector.handleInput(CTRL_D);
		steps.push({ key: "ctrl+d", selected: selectedId(selector) });
		out.second = steps;
	}
	return out;
});

function buildBranchingTree(): SessionTreeNode[] {
	const entries = [
		userMessage("user-1", null, "first message"),
		assistantMessage("asst-1", "user-1", "response 1"),
		userMessage("user-2", "asst-1", "second message"),
		assistantMessage("asst-2", "user-2", "response 2"),
		userMessage("user-3a", "asst-2", "branch A start"),
		assistantMessage("asst-3a", "user-3a", "branch A response"),
		userMessage("user-4a", "asst-3a", "branch A deep"),
		assistantMessage("asst-4a", "user-4a", "branch A leaf"),
		userMessage("user-3b", "asst-2", "branch B start"),
		assistantMessage("asst-3b", "user-3b", "branch B response"),
		userMessage("user-4b", "asst-3b", "branch B deep"),
	];
	return buildTree(entries);
}

function driveKeys(
	tree: SessionTreeNode[],
	leafId: string,
	keys: string[],
): Array<{ key: string; selected: string | null }> {
	const selector = new TreeSelectorComponent(tree, leafId, 24, () => {}, () => {});
	const steps: Array<{ key: string; selected: string | null }> = [
		{ key: "init", selected: selectedId(selector) },
	];
	for (const key of keys) {
		selector.handleInput(key);
		steps.push({ key, selected: selectedId(selector) });
	}
	return steps;
}

scenario("tree_branch_navigation", () => {
	fresh();
	const out: AnyRec = {};
	out.ctrl = driveKeys(
		buildBranchingTree(),
		"asst-4a",
		[CTRL_LEFT, CTRL_LEFT, DOWN, UP, CTRL_RIGHT, DOWN, CTRL_LEFT, CTRL_RIGHT],
	);
	out.alt = driveKeys(buildBranchingTree(), "asst-4a", [ALT_LEFT, ALT_LEFT, ALT_RIGHT, ALT_RIGHT]);
	out.foldRoot = driveKeys(
		buildBranchingTree(),
		"asst-4a",
		[CTRL_LEFT, CTRL_LEFT, CTRL_LEFT, CTRL_LEFT, DOWN, CTRL_RIGHT, CTRL_RIGHT, DOWN],
	);
	{
		const selector = new TreeSelectorComponent(buildBranchingTree(), "asst-4a", 24, () => {}, () => {});
		const list = selector.getTreeList();
		const steps: Array<{ key: string; selected: string | null }> = [];
		let found = false;
		for (let i = 0; i < 20; i++) {
			selector.handleInput(DOWN);
			const id = selectedId(selector);
			steps.push({ key: "down", selected: id });
			if (id === "user-3b") {
				found = true;
				break;
			}
		}
		for (const key of [CTRL_RIGHT, CTRL_LEFT, CTRL_LEFT, CTRL_LEFT]) {
			selector.handleInput(key);
			steps.push({ key, selected: selectedId(selector) });
		}
		out.nonActiveBranch = { found, steps };
	}
	out.multipleRoots = driveKeys(
		buildTree([
			userMessage("user-1", null, "first root"),
			assistantMessage("asst-1", "user-1", "response 1"),
			userMessage("user-2", null, "second root"),
			assistantMessage("asst-2", "user-2", "response 2"),
		]),
		"asst-1",
		[CTRL_LEFT, CTRL_LEFT, DOWN, CTRL_RIGHT, CTRL_LEFT, CTRL_LEFT, CTRL_LEFT],
	);
	out.filteredIntermediate = driveKeys(
		buildTree([
			userMessage("user-1", null, "hello"),
			toolCallOnlyAssistant("tool-asst-1", "user-1"),
			userMessage("user-2", "tool-asst-1", "follow up"),
			assistantMessage("asst-2", "user-2", "response"),
		]),
		"asst-2",
		[CTRL_LEFT, CTRL_LEFT, DOWN],
	);
	{
		const selector = new TreeSelectorComponent(buildBranchingTree(), "asst-4a", 24, () => {}, () => {});
		selector.handleInput(CTRL_LEFT);
		selector.handleInput(CTRL_LEFT);
		selector.handleInput(DOWN);
		const afterFold = selectedId(selector);
		selector.handleInput("b");
		selector.handleInput(ESC);
		const steps: Array<{ key: string; selected: string | null }> = [
			{ key: "afterFold", selected: afterFold },
		];
		let currentId = "";
		for (let i = 0; i < 20; i++) {
			selector.handleInput(DOWN);
			currentId = selectedId(selector) ?? "";
			steps.push({ key: "down", selected: currentId });
			if (currentId === "user-3a") break;
		}
		selector.handleInput(DOWN);
		steps.push({ key: "down", selected: selectedId(selector) });
		out.searchResetsFold = steps;
	}
	{
		const selector = new TreeSelectorComponent(buildBranchingTree(), "asst-4a", 24, () => {}, () => {});
		selector.handleInput(CTRL_LEFT);
		selector.handleInput(CTRL_LEFT);
		selector.handleInput(CTRL_U);
		selector.handleInput(CTRL_D);
		const steps: Array<{ key: string; selected: string | null }> = [];
		let currentId = "";
		for (let i = 0; i < 20; i++) {
			selector.handleInput(DOWN);
			currentId = selectedId(selector) ?? "";
			steps.push({ key: "down", selected: currentId });
			if (currentId === "user-3a") break;
		}
		selector.handleInput(DOWN);
		steps.push({ key: "down", selected: selectedId(selector) });
		out.filterResetsFold = steps;
	}
	return out;
});

scenario("tree_render_matrix", () => {
	fresh();
	const entries: AnyRec[] = [
		userMessage("u1", null, "plan the rollout"),
		assistantMessage("a1", "u1", "Starting the rollout"),
		toolCallOnlyAssistant("t1", "a1"),
		{
			...userMessage("u2", "t1", "follow up question"),
			label: "milestone",
			labelTimestamp: "2026-03-28T14:32:00.000Z",
		} as SessionTreeNode,
		assistantMessage("a2", "u2", "done \n with newlines"),
	];
	const compaction: SessionTreeNode = {
		entry: {
			type: "compaction",
			id: "c1",
			parentId: "a2",
			timestamp: new Date().toISOString(),
			summary: "compacted summary",
			tokensBefore: 123456,
		},
		children: [],
	};
	const branch: SessionTreeNode = {
		entry: {
			type: "branch_summary",
			id: "b1",
			parentId: "c1",
			timestamp: new Date().toISOString(),
			fromId: "a2",
			summary: "branch\nsummary text",
		},
		children: [],
	};
	const title: SessionTreeNode = {
		entry: {
			type: "session_info",
			id: "s1",
			parentId: "b1",
			timestamp: new Date().toISOString(),
			name: "my session",
		},
		children: [],
	};
	const noTitle: SessionTreeNode = {
		entry: {
			type: "session_info",
			id: "s2",
			parentId: "s1",
			timestamp: new Date().toISOString(),
		},
		children: [],
	};
	const modelChangeEntry: SessionTreeNode = {
		entry: {
			type: "model_change",
			id: "m1",
			parentId: "s2",
			timestamp: new Date().toISOString(),
			provider: "anthropic",
			modelId: "claude-sonnet-4",
		},
		children: [],
	};
	const thinking: SessionTreeNode = {
		entry: {
			type: "thinking_level_change",
			id: "th1",
			parentId: "m1",
			timestamp: new Date().toISOString(),
			thinkingLevel: "high",
		},
		children: [],
	};
	const custom: SessionTreeNode = {
		entry: {
			type: "custom",
			id: "cu1",
			parentId: "th1",
			timestamp: new Date().toISOString(),
			customType: "my-extension",
		},
		children: [],
	};
	const customMessage: SessionTreeNode = {
		entry: {
			type: "custom_message",
			id: "cm1",
			parentId: "cu1",
			timestamp: new Date().toISOString(),
			customType: "announcement",
			content: "custom text",
			display: true,
		},
		children: [],
	};
	const customMessageBlocks: SessionTreeNode = {
		entry: {
			type: "custom_message",
			id: "cm2",
			parentId: "cm1",
			timestamp: new Date().toISOString(),
			customType: "notes",
			content: [{ type: "text", text: "block content" }],
			display: true,
		},
		children: [],
	};
	const bash: SessionTreeNode = {
		entry: {
			type: "message",
			id: "bash1",
			parentId: "cm2",
			timestamp: new Date().toISOString(),
			message: { role: "bashExecution", command: "echo hi\nthere", timestamp: Date.now() },
		},
		children: [],
	};
	const toolResult: SessionTreeNode = {
		entry: {
			type: "message",
			id: "tr1",
			parentId: "bash1",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "tc-t1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: Date.now(),
			},
		},
		children: [],
	};
	const toolResultOrphan: SessionTreeNode = {
		entry: {
			type: "message",
			id: "tr2",
			parentId: "tr1",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "missing-id",
				toolName: "grep",
				content: [{ type: "text", text: "nope" }],
				isError: false,
				timestamp: Date.now(),
			},
		},
		children: [],
	};
	const aborted: SessionTreeNode = {
		entry: {
			type: "message",
			id: "ab1",
			parentId: "tr2",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4",
				usage: {},
				stopReason: "aborted",
				timestamp: Date.now(),
			},
		},
		children: [],
	};
	const errored: SessionTreeNode = {
		entry: {
			type: "message",
			id: "er1",
			parentId: "ab1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4",
				usage: {},
				stopReason: "error",
				errorMessage: "rate limited\nbad",
				timestamp: Date.now(),
			},
		},
		children: [],
	};
	const emptyAssistant: SessionTreeNode = {
		entry: {
			type: "message",
			id: "ea1",
			parentId: "er1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4",
				usage: {},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		},
		children: [],
	};
	const tree = [
		...entries.map((entry) => ({ entry, children: [] })),
		compaction,
		branch,
		title,
		noTitle,
		modelChangeEntry,
		thinking,
		custom,
		customMessage,
		customMessageBlocks,
		bash,
		toolResult,
		toolResultOrphan,
		aborted,
		errored,
		emptyAssistant,
	];
	// buildTree-style parent linking over the flat list
	const byId = new Map<string, SessionTreeNode>();
	for (const node of tree) byId.set((node.entry as AnyRec).id as string, node);
	const roots: SessionTreeNode[] = [];
	for (const node of tree) {
		const parentId = (node.entry as AnyRec).parentId as string | null;
		if (parentId === null) roots.push(node);
		else byId.get(parentId)!.children.push(node);
	}

	const out: AnyRec = {};
	for (const width of [80, 200]) {
		for (const filterMode of [undefined, "user-only", "no-tools", "labeled-only", "all"] as const) {
			const selector = new TreeSelectorComponent(
				structuredClone(roots),
				"tr1",
				24,
				undefined,
				undefined,
				undefined,
				undefined,
				filterMode as never,
			);
			out[`render_${width}_${filterMode ?? "default"}`] = selector.render(width);
		}
	}
	{
		const selector = new TreeSelectorComponent(structuredClone(roots), "tr1", 24, () => {}, () => {});
		for (const ch of "roll") selector.handleInput(ch);
		out.searchRoll = selector.render(80);
		out.searchLine = selector.getTreeList().getSearchQuery();
		selector.handleInput("\x7f");
		out.searchRol = selector.render(80);
		selector.handleInput(ESC);
		out.searchCleared = selector.render(80);
	}
	{
		// horizontal viewport: long message forces anchor panning at narrow width
		const longTree = buildTree([
			userMessage("u1", null, `${"very long user message content ".repeat(6)}end`),
			assistantMessage("a1", "u1", "ok"),
		]);
		const selector = new TreeSelectorComponent(longTree, "a1", 24, () => {}, () => {});
		selector.handleInput(UP);
		out.hscroll40 = selector.render(40);
		out.hscroll20 = selector.render(20);
	}
	{
		// empty filtered list rendering
		const selector = new TreeSelectorComponent(
			buildTree([userMessage("u1", null, "hello")]),
			"u1",
			24,
			undefined,
			undefined,
			undefined,
			undefined,
			"labeled-only" as never,
		);
		out.emptyLabeled = selector.render(80);
	}
	return out;
});

scenario("tree_nav_keys", () => {
	fresh();
	const tree = buildTree([
		userMessage("u1", null, "one"),
		assistantMessage("a1", "u1", "two"),
		userMessage("u2", "a1", "three"),
		assistantMessage("a2", "u2", "four"),
		userMessage("u3", "a2", "five"),
	]);
	const out: AnyRec = {};
	{
		const selector = new TreeSelectorComponent(structuredClone(tree), "u3", 24, () => {}, () => {});
		const steps: Array<{ key: string; selected: string | null }> = [];
		for (const key of [UP, UP, UP, UP, DOWN, DOWN, DOWN, DOWN]) {
			selector.handleInput(key);
			steps.push({ key, selected: selectedId(selector) });
		}
		out.wrap = steps;
	}
	{
		const selector = new TreeSelectorComponent(structuredClone(tree), "u3", 24, () => {}, () => {});
		const steps: Array<{ key: string; selected: string | null }> = [];
		for (const key of ["\x1b[1;5D", "\x1b[1;5C", "\x1b[5~", "\x1b[6~", "\x1b[5~", "\x1b[6~"]) {
			selector.handleInput(key);
			steps.push({ key, selected: selectedId(selector) });
		}
		out.pages = steps;
	}
	{
		const selected: string[] = [];
		let cancelled = 0;
		const selector = new TreeSelectorComponent(
			structuredClone(tree),
			"u3",
			24,
			(entryId: string) => selected.push(entryId),
			() => {
				cancelled += 1;
			},
		);
		selector.handleInput(ENTER);
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		selector.handleInput(ESC);
		out.confirm = { selected, cancelled };
	}
	{
		// cancel with an active search clears the query instead of cancelling
		const selected: string[] = [];
		let cancelled = 0;
		const selector = new TreeSelectorComponent(
			structuredClone(tree),
			"u3",
			24,
			(entryId: string) => selected.push(entryId),
			() => {
				cancelled += 1;
			},
		);
		selector.handleInput("one");
		selector.handleInput(ESC);
		const afterClear = selectedId(selector);
		selector.handleInput(ESC);
		out.cancelSearch = { selected, cancelled, afterClear };
	}
	{
		// filter keys: default + toggles + cycle forward/backward
		const key = (id: string): string => RAW_FILTER_KEYS[id]!;
		const selector = new TreeSelectorComponent(structuredClone(tree), "u3", 24, () => {}, () => {});
		const statusLines: string[] = [];
		for (const id of [
			"app.tree.filter.noTools",
			"app.tree.filter.noTools",
			"app.tree.filter.userOnly",
			"app.tree.filter.labeledOnly",
			"app.tree.filter.all",
			"app.tree.filter.all",
			"app.tree.filter.cycleForward",
			"app.tree.filter.cycleForward",
			"app.tree.filter.cycleBackward",
			"app.tree.filter.cycleBackward",
			"app.tree.filter.default",
		]) {
			selector.handleInput(key(id));
			const rendered = selector.render(200).map((l: string) => stripAnsi(l));
			statusLines.push(rendered.findLast((l: string) => /\(\d+\/\d+\)/.test(l)) ?? "");
		}
		out.filterStatusLines = statusLines;
	}
	return out;
});

scenario("tree_label_edit", () => {
	fresh();
	const entries = [userMessage("u1", null, "one"), assistantMessage("a1", "u1", "two")];
	const tree = buildTree(entries);
	const changes: Array<{ id: string; label: string | undefined }> = [];
	const selector = new TreeSelectorComponent(
		tree,
		"a1",
		24,
		() => {},
		() => {},
		(id: string, label: string | undefined) => {
			changes.push({ id, label });
		},
	);
	const out: AnyRec = {};
	selector.handleInput(UP); // select u1
	selector.handleInput("L"); // app.tree.editLabel
	out.editOpen = selector.render(80);
	selector.handleInput("a");
	selector.handleInput("b");
	selector.handleInput(ENTER);
	out.changes = changes;
	out.afterSave = selector.render(80);
	out.listLabel = selector.getTreeList().render(200).join("\n").includes("[ab]");
	// clear label via empty submit
	selector.handleInput("L");
	selector.handleInput("\x7f");
	selector.handleInput(ENTER);
	out.changesAfterClear = changes;
	// cancel path
	selector.handleInput("L");
	selector.handleInput("z");
	selector.handleInput(ESC);
	out.afterCancel = selector.render(80);
	return out;
});

scenario("tree_select_initial", () => {
	fresh();
	const tree = buildTree([
		userMessage("u1", null, "one"),
		assistantMessage("a1", "u1", "two"),
		userMessage("u2", "a1", "three"),
	]);
	const selector = new TreeSelectorComponent(
		tree,
		"a1",
		24,
		() => {},
		() => {},
		undefined,
		"u2",
		"user-only",
	);
	return { selected: selectedId(selector), render: selector.render(120) };
});

scenario("tree_empty_auto_cancel", async () => {
	fresh();
	let cancelled = 0;
	new TreeSelectorComponent(
		[],
		null,
		24,
		() => {},
		() => {
			cancelled += 1;
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 150));
	return { cancelled };
});

// ---------------------------------------------------------------------------
// Session selector
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `C:\\tmp\\${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	} as SessionInfo;
}

scenario("session_selector_header_and_threaded", async () => {
	fresh();
	const sessions = [
		makeSession({
			id: "parent-one",
			name: "Parent one",
			modified: new Date("2026-01-02T00:00:00.000Z"),
		}),
		makeSession({
			id: "parent-two",
			name: "Parent two",
			modified: new Date("2026-01-01T00:00:00.000Z"),
		}),
		makeSession({
			id: "child-two",
			name: "Child two",
			parentSessionPath: "C:\\tmp\\parent-two.jsonl",
			modified: new Date("2026-01-03T00:00:00.000Z"),
		}),
		makeSession({ id: "plain", cwd: "C:\\work\\sub", modified: new Date("2025-12-15T10:00:00.000Z") }),
	];
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{ showRenameHint: true },
	);
	await flushPromises();
	const out: AnyRec = {};
	out.initial = selector.render(120);
	// sort cycles threaded -> recent -> relevance -> threaded
	(selector.getSessionList() as AnyRec).handleInput("\t"); // scope: current -> all (cwd shown)
	out.allScope = selector.render(120);
	(selector.getSessionList() as AnyRec).handleInput("\x13"); // ctrl+s: app.session.toggleSort
	out.afterSortKey = selector.render(120);
	return out;
});

scenario("session_selector_sort_and_named", async () => {
	fresh();
	const sessions = [
		makeSession({ id: "a", name: "Alpha", modified: new Date("2026-01-05T00:00:00.000Z") }),
		makeSession({ id: "b", modified: new Date("2026-01-04T00:00:00.000Z") }),
		makeSession({ id: "c", name: "Gamma", modified: new Date("2026-01-03T00:00:00.000Z") }),
	];
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => sessions,
		() => {},
		() => {},
		() => {},
		() => {},
		{ showRenameHint: true },
	);
	await flushPromises();
	const out: AnyRec = {};
	const toggleSort = "\x13"; // ctrl+s
	const toggleNamed = "\x0e"; // ctrl+n
	const list = selector.getSessionList();
	out.threaded = selector.render(120);
	list.handleInput(toggleSort);
	out.recent = selector.render(120);
	list.handleInput(toggleSort);
	out.relevance = selector.render(120);
	list.handleInput(toggleSort);
	out.threadedAgain = selector.render(120);
	list.handleInput(toggleNamed);
	out.named = selector.render(120);
	// empty named-filter empty state comes from a session set with no names
	const selector2 = new SessionSelectorComponent(
		async () => [makeSession({ id: "x" })],
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{},
	);
	await flushPromises();
	selector2.getSessionList().handleInput(toggleNamed);
	out.namedEmptyCurrent = selector2.render(120);
	// "all"-filter empty state
	selector2.getSessionList().handleInput("zzz");
	out.noMatches = selector2.render(120);
	// named + all scope empty state
	const selector3 = new SessionSelectorComponent(
		async () => [],
		async () => [makeSession({ id: "x" })],
		() => {},
		() => {},
		() => {},
		() => {},
		{},
	);
	await flushPromises();
	selector3.getSessionList().handleInput(toggleNamed);
	out.namedEmptyAll = selector3.render(120);
	return out;
});

scenario("session_selector_search_flow", async () => {
	fresh();
	const sessions = [
		makeSession({ id: "a", name: "Deploy fix", allMessagesText: "fix the deploy script" }),
		makeSession({ id: "b", allMessagesText: "review node cve" }),
		makeSession({ id: "c", name: "Rust notes", allMessagesText: "borrow checker" }),
	];
	const selected: string[] = [];
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => [],
		(sessionPath: string) => selected.push(sessionPath),
		() => {},
		() => {},
		() => {},
		{ showRenameHint: true },
	);
	await flushPromises();
	const list = selector.getSessionList();
	const out: AnyRec = {};
	for (const ch of "fix") list.handleInput(ch);
	out.filtered = selector.render(120);
	list.handleInput(DOWN);
	out.movedDown = list.getSelectedSessionPath();
	list.handleInput(UP);
	list.handleInput(ENTER);
	out.selected = selected;
	for (const ch of "zzz") list.handleInput(ch);
	out.noMatch = selector.render(120);
	for (let i = 0; i < 3; i++) list.handleInput("\x7f");
	list.handleInput(ESC);
	out.cleared = selector.render(120);
	return out;
});

scenario("session_selector_delete_flow", async () => {
	fresh();
	const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
		const baseDir = oracleTmpDir("del");
	const fileA = join(baseDir, "a.jsonl");
	const fileB = join(baseDir, "b.jsonl");
	writeFileSync(fileA, "a");
	writeFileSync(fileB, "b");
	const sessions = [
		makeSession({ id: "a", path: fileA, name: "A" }),
		makeSession({ id: "b", path: fileB, name: "B" }),
	];
	const loaderSessions = [...sessions];
	const selector = new SessionSelectorComponent(
		async () => [...loaderSessions],
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{ showRenameHint: true },
	);
	await flushPromises();
	const list = selector.getSessionList();
	const out: AnyRec = {};
	const confirmations: Array<string | null> = [];
	(list as AnyRec).onDeleteConfirmationChange = (p: string | null) => confirmations.push(p);
	// missing file: full error path (trash missing + unlink ENOENT)
	loaderSessions.push(makeSession({ id: "gone", path: join(baseDir, "gone.jsonl"), name: "G" }));
	list.setSessions([...loaderSessions], false);
	list.handleInput(DOWN);
	list.handleInput(DOWN);
	list.handleInput(CTRL_D);
	out.confirmationsGone = [...confirmations];
	list.handleInput(ENTER);
	await new Promise((resolve) => setTimeout(resolve, 30));
	out.errorRender = selector.render(120);
	loaderSessions.splice(loaderSessions.length - 1, 1);
	// real delete of fileB
	list.setSessions([...loaderSessions], false);
	while ((list.getSelectedSessionPath() ?? "").endsWith("b.jsonl") === false) {
		list.handleInput(DOWN);
	}
	list.handleInput(CTRL_D);
	list.handleInput(ENTER);
	await new Promise((resolve) => setTimeout(resolve, 30));
	out.deletedExists = FileExists(fileB);
	out.afterDeleteRender = selector.render(120);
	// ctrl+backspace with a non-empty query does not confirm
	list.handleInput("q");
	list.handleInput(CTRL_BACKSPACE);
	out.confirmationsAfterQuery = [...confirmations];
	// ctrl+backspace with empty query confirms; escape cancels
	list.handleInput("\x7f");
	list.handleInput(CTRL_BACKSPACE);
	out.confirmationsCtrlBackspace = [...confirmations];
	list.handleInput(ESC);
	out.confirmationsAfterCancel = [...confirmations];
	out.confirmRender = selector.render(120);
	// cleanup
	try {
		(await import("node:fs")).rmSync(baseDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
	return out;
});

function FileExists(path: string): boolean {
	return existsSync(path);
}

scenario("session_selector_current_protection", async () => {
	fresh();
	const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
		const baseDir = oracleTmpDir("cur");
	const realPath = join(baseDir, "self.jsonl");
	writeFileSync(realPath, "self");
	const aliasPath = join(baseDir, ".", "sub", "..", "self.jsonl");
	const sessions = [makeSession({ id: "self", path: realPath, name: "Self" })];
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{ showRenameHint: true },
		aliasPath,
	);
	await flushPromises();
	const list = selector.getSessionList();
	const out: AnyRec = {};
	const confirmations: Array<string | null> = [];
	let errorMessage: string | undefined;
	(list as AnyRec).onDeleteConfirmationChange = (p: string | null) => confirmations.push(p);
	(list as AnyRec).onError = (message: string) => {
		errorMessage = message;
	};
	list.handleInput(CTRL_D);
	out.confirmations = confirmations;
	out.errorMessage = errorMessage;
	out.render = selector.render(120);
	try {
		(await import("node:fs")).rmSync(baseDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
	return out;
});

scenario("session_selector_rename_flow", async () => {
	fresh();
	const sessions = [makeSession({ id: "a", name: "Old" })];
	const out: AnyRec = {};
	{
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: true },
		);
		await flushPromises();
		out.hintOn = selector.render(120);
	}
	{
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: false },
		);
		await flushPromises();
		out.hintOff = selector.render(120);
	}
	{
		const renameCalls: Array<[string, string | undefined]> = [];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{
				showRenameHint: true,
				renameSession: async (sessionPath: string, currentName: string | undefined) => {
					renameCalls.push([sessionPath, currentName]);
				},
			},
		);
		await flushPromises();
		const list = selector.getSessionList();
		list.handleInput(CTRL_R);
		out.renameMode = selector.render(120);
		selector.handleInput("X");
		selector.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 10));
		out.renameCalls = renameCalls;
		out.afterRename = selector.render(120);
		// escape cancels rename mode without calling renameSession
		list.handleInput(CTRL_R);
		selector.handleInput(ESC);
		out.afterEscape = selector.render(120);
		out.renameCallsAfterEscape = renameCalls.length;
		// empty submit stays in rename mode (nameless session -> empty initial value)
		const nameless = [makeSession({ id: "n" })];
		const selector2 = new SessionSelectorComponent(
			async () => nameless,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{
				showRenameHint: true,
				renameSession: async (sessionPath: string, currentName: string | undefined) => {
					renameCalls.push([sessionPath, currentName]);
				},
			},
		);
		await flushPromises();
		selector2.getSessionList().handleInput(CTRL_R);
		selector2.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 10));
		out.emptySubmitRender = selector2.render(120);
		out.renameCallsAfterEmpty = renameCalls.length;
		selector2.handleInput(ESC);
		out.emptySubmitExit = selector2.render(120);
	}
	return out;
});

scenario("session_selector_scope_deferred", async () => {
	fresh();
	const currentSessions = [makeSession({ id: "current", name: "Current" })];
	let allResolve: ((sessions: SessionInfo[]) => void) | null = null;
	let allLoadCalls = 0;
	const allPromise = () =>
		new Promise<SessionInfo[]>((resolve) => {
			allLoadCalls += 1;
			allResolve = resolve;
		});
	const selector = new SessionSelectorComponent(
		async () => currentSessions,
		() => allPromise(),
		() => {},
		() => {},
		() => {},
		() => {},
		{},
	);
	await flushPromises();
	const list = selector.getSessionList();
	const out: AnyRec = {};
	out.initial = selector.render(120);
	list.handleInput("\t"); // current -> all (load starts)
	out.loadingAll = selector.render(120);
	list.handleInput("\t"); // all -> current while load pending
	out.backToCurrent = selector.render(120);
	list.handleInput("\t"); // current -> all again: must NOT start a second load
	out.loadingAgain = selector.render(120);
	out.loadCalls = allLoadCalls;
	allResolve!([makeSession({ id: "all", cwd: "C:\\elsewhere" })]);
	await new Promise((resolve) => setTimeout(resolve, 10));
	out.resolvedStillCurrent = selector.render(120);
	list.handleInput("\t"); // current -> all (cached)
	out.cachedAll = selector.render(120);
	list.handleInput("\t"); // all -> current
	out.backAgain = selector.render(120);
	out.loadCallsFinal = allLoadCalls;
	return out;
});

scenario("session_selector_progress", async () => {
	fresh();
	const out: AnyRec = {};
	const sessions = [makeSession({ id: "a", name: "A" }), makeSession({ id: "b", name: "B" })];
	let progress: ((loaded: number, total: number) => void) | undefined;
	let resolveLoad: ((sessions: SessionInfo[]) => void) | null = null;
	const selector = new SessionSelectorComponent(
		(_onProgress?: unknown) => {
			progress = _onProgress as (loaded: number, total: number) => void;
			return new Promise<SessionInfo[]>((resolve) => {
				resolveLoad = resolve;
			});
		},
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{},
	);
	await flushPromises();
	out.loadingDots = selector.render(120);
	progress!(1, 2);
	out.progress12 = selector.render(120);
	progress!(2, 2);
	out.progress22 = selector.render(120);
	resolveLoad!(sessions);
	await new Promise((resolve) => setTimeout(resolve, 10));
	out.loaded = selector.render(120);
	return out;
});

scenario("session_selector_load_error", async () => {
	fresh();
	const selector = new SessionSelectorComponent(
		async () => {
			throw new Error("disk on fire");
		},
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{},
	);
	await new Promise((resolve) => setTimeout(resolve, 10));
	return { render: selector.render(120) };
});

scenario("session_selector_scroll_indicator", async () => {
	fresh();
	const sessions = Array.from({ length: 14 }, (_, i) =>
		makeSession({ id: `s${String(i).padStart(2, "0")}`, name: `Session ${i}` }),
	);
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{},
	);
	await flushPromises();
	const list = selector.getSessionList();
	const out: AnyRec = {};
	out.top = selector.render(100);
	for (let i = 0; i < 6; i++) list.handleInput(DOWN);
	out.middle = selector.render(100);
	for (let i = 0; i < 20; i++) list.handleInput(DOWN);
	out.bottom = selector.render(100);
	for (let i = 0; i < 20; i++) list.handleInput(UP);
	out.topAgain = selector.render(100);
	list.handleInput("\x1b[5~");
	out.pageUp = selector.render(100);
	list.handleInput("\x1b[6~");
	list.handleInput("\x1b[6~");
	out.pageDown = selector.render(100);
	return out;
});

// ---------------------------------------------------------------------------
export async function runAll(): Promise<void> {
	const out: AnyRec = { scenarios: [] as unknown[] };
	const failures: string[] = [];
	for (const [name, run] of Object.entries(SCENARIOS)) {
		try {
			const result = await run();
			(out.scenarios as unknown[]).push({ name, result });
		} catch (error) {
			failures.push(`${name}: ${(error as Error).stack ?? String(error)}`);
			(out.scenarios as unknown[]).push({ name, error: String(error), stack: (error as Error).stack });
		}
	}
	out.failures = failures;
	writeFileSync(
		new URL("./component_r20_oracle.json", import.meta.url),
		JSON.stringify(out, null, "\t"),
	);
	console.log(`scenarios=${(out.scenarios as unknown[]).length} failures=${failures.length}`);
	for (const f of failures) console.log(`FAIL ${f.split("\n")[0]}`);
}
