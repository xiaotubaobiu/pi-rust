// Oracle stub for upstream `src/core/trust-manager.ts` (not ported here).
export function hasTrustRequiringProjectResources(_cwd) {
	return false;
}

export class ProjectTrustStore {
	constructor(_agentDir) {}
	get(_cwd) {
		return false;
	}
}
