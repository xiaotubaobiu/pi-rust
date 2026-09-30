/**
 * Oracle stub for `modes/rpc/jsonl.ts`: keeps the verbatim
 * `serializeJsonLine` (re-exported from the real copy) so frames are
 * serialized by upstream code, while `attachJsonlLineReader` records the line
 * handler on a global for the driver (mirroring the upstream
 * rpc-prompt-response-semantics test's vi.mock).
 */
import { serializeJsonLine } from "../upstream/rpc/jsonl.ts";

export { serializeJsonLine };

export function attachJsonlLineReader(_stream, onLine) {
	(globalThis).__oracleLineHandler = onLine;
	return () => {
		(globalThis).__oracleLineHandler = undefined;
	};
}
