// Type-only shim for `core/session-manager.ts` in the oracle (the verbatim
// component files use `import type`, erased at runtime).
export interface SessionTreeNode {
	entry: Record<string, unknown>;
	children: SessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type SessionListProgress = (loaded: number, total: number) => void;
