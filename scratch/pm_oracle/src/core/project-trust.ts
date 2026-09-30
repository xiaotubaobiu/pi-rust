// Oracle stub for upstream `src/core/project-trust.ts` (not ported here):
// the CLI oracle scenarios pass --approve/--no-approve so the override short-
// circuits resolution.
export async function resolveProjectTrusted(options) {
	if (options.trustOverride !== undefined) return options.trustOverride;
	return false;
}
