/**
 * Oracle stub for upstream `core/output-guard.ts` (that module is a separate
 * upstream slice). Same exported names; writes are captured on
 * `globalThis.__oracleStdout` instead of a real pipe, so the drivers can
 * assert the exact bytes the modes hand to the raw stdout writer.
 */

const captured: string[] = [];

(globalThis as any).__oracleStdout = captured;
(globalThis as any).__oracleTakeOverCount = 0;

export function takeOverStdout(): void {
	(globalThis as any).__oracleTakeOverCount += 1;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	captured.push(text);
}

export async function waitForRawStdoutBackpressure(): Promise<void> {}

export async function flushRawStdout(): Promise<void> {
	(globalThis as any).__oracleFlushed = true;
}

export function flushRawStdoutSync(): void {
	(globalThis as any).__oracleFlushed = true;
}
