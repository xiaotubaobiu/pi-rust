/**
 * Oracle stub for upstream `utils/shell.ts` `killTrackedDetachedChildren`
 * (that module is a separate upstream slice).
 */

export const killedPids: number[] = [];

export function killTrackedDetachedChildren(): void {
	// No detached children are ever tracked in the oracle drivers.
}
