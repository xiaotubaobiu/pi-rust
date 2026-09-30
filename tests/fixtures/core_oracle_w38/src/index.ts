// ORACLE STUB (not upstream source): the real `src/index.ts` is the full
// coding-agent barrel. loader.ts only re-exposes it to extensions via
// virtualModules; no oracle scenario touches it, so an empty namespace stub
// stands in for the `import * as _bundledPiCodingAgent from "../../index.ts"`
// value import. Disclosed in the extensions port report (seam O-1).
const piCodingAgentStub: Record<string, unknown> = {};
export default piCodingAgentStub;
export { piCodingAgentStub };
