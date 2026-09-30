// Shared scenario helpers: the upstream test fixtures (copied verbatim from
// test/tree-selector.test.ts and test/session-selector-*.test.ts) plus ANSI
// stripping and a flushPromises.
import { stripVTControlCharacters } from "node:util";
import { existsSync } from "node:fs";
import type { SessionInfo, SessionTreeNode } from "./session_manager_types.ts";

export type AnyRec = Record<string, unknown>;

export function stripAnsi(text: string): string {
	return stripVTControlCharacters(text);
}

export async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

export { existsSync };

// Helper to create a user message entry (test/tree-selector.test.ts).
export function userMessage(id: string, parentId: string | null, content: string): AnyRec {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

// Helper to create an assistant message entry.
export function assistantMessage(id: string, parentId: string | null, text: string): AnyRec {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

// Helper to create a tool-call-only assistant message.
export function toolCallOnlyAssistant(id: string, parentId: string | null): AnyRec {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `tc-${id}`, name: "read", arguments: { path: "test.ts" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		},
	};
}

// Helper to create a model_change entry.
export function modelChange(id: string, parentId: string | null): AnyRec {
	return {
		type: "model_change",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		provider: "anthropic",
		modelId: "claude-sonnet-4",
	};
}

// Helper to build a tree from entries using parentId relationships.
export function buildTree(entries: AnyRec[]): SessionTreeNode[] {
	if (entries.length === 0) return [];

	const nodes = entries.map((entry) => ({
		entry,
		children: [],
	})) as SessionTreeNode[];

	const byId = new Map<string, SessionTreeNode>();
	for (const node of nodes) {
		byId.set((node.entry as AnyRec).id as string, node);
	}

	const roots: SessionTreeNode[] = [];
	for (const node of nodes) {
		if ((node.entry as AnyRec).parentId === null) {
			roots.push(node);
		} else {
			const parent = byId.get((node.entry as AnyRec).parentId as string);
			if (parent) {
				parent.children.push(node);
			}
		}
	}
	return roots;
}

export function mkEntriesHelpers() {
	return {
		userMessage,
		assistantMessage,
		toolCallOnlyAssistant,
		modelChange,
		buildTree,
		stripAnsi,
	};
}

export type { SessionInfo, SessionTreeNode };
