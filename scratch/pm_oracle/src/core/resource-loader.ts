// Oracle stub for upstream `src/core/resource-loader.ts` (not ported here):
// trust-extension preloading is disabled in the capture harness.
export class DefaultResourceLoader {
	constructor(_options) {}
	async loadProjectTrustExtensions() {
		return { errors: [] };
	}
}
