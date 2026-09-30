// Oracle stub for upstream `src/cli/config-selector.ts` (interactive TUI,
// not ported in this slice).
export async function selectConfig(options) {
	globalThis.__pmSelectConfigCalls = globalThis.__pmSelectConfigCalls ?? [];
	globalThis.__pmSelectConfigCalls.push({
		writeScope: options.writeScope,
		projectModeAvailable: options.projectModeAvailable,
	});
}
