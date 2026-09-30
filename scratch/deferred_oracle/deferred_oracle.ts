// Oracle for the deferred slice's deterministic serialization seams, captured
// by running the upstream pure functions with
// `node --experimental-strip-types` (the tools_oracle pattern).
//
// Sources (verbatim copies):
// - `configurationError` from
//   pi/packages/agent/src/harness/runtime/drive/deferred.ts:47-54 (the
//   `LaneConfiguration["model"]` identity parameter is structurally typed).
// - The `pollDeferred` waiting outcome literal from deferred.ts:186-194
//   (`{kind:"waiting", outcome:{kind:"waiting", operationId, reason:"deferred",
//   deferred}}`), with the deferred handle shaped by
//   packages/ai/src/types.ts DeferredHandle (camelCase wire fields).
// - The `publishPollIntent` turn id composition from deferred.ts:175:
//   `${next.stepId}:poll:${next.poll}`.

function configurationError(identity: { provider: string; modelId: string }) {
	return {
		code: "model_unavailable",
		message: "The configured model is unavailable in this process",
		details: identity,
	};
}

const identity = { provider: "faux", modelId: "faux-1" };
const handle = { provider: "faux", modelId: "faux-1", api: "faux", id: "deferred-job" };
const operationId = "01950000-0000-7000-8000-000000000001";
const waitingOutcome = {
	kind: "waiting",
	operationId,
	reason: "deferred",
	deferred: handle,
};
const turnId = `${"step"}:poll:${1}`;

console.log(JSON.stringify(configurationError(identity)));
console.log(JSON.stringify(waitingOutcome));
console.log(turnId);
console.log(JSON.stringify(handle));
