// Oracle stub for upstream `src/core/output-guard.ts`: stdout is never taken
// over in the capture harness, so inherited-stdio spawns behave as plain
// `"inherit"`.
export function isStdoutTakenOver(): boolean {
	return false;
}
