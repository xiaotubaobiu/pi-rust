// Oracle stub for upstream `src/core/model-runtime.ts` (not ported in this
// slice): refresh() reports success without touching the network.
export class ModelRuntime {
	static async create(_options) {
		return new ModelRuntime();
	}
	async refresh(_options) {
		return { aborted: false, errors: new Map() };
	}
}
