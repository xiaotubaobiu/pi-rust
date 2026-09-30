// Oracle-only stand-in for `http-dispatcher.ts` (the real module imports
// `undici`, which is not installed in this offline environment). Only the
// two members `settings-manager.ts` consumes are reproduced, verbatim from
// upstream: the `DEFAULT_HTTP_IDLE_TIMEOUT_MS` constant and the pure
// `parseHttpIdleTimeoutMs` function.

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}
