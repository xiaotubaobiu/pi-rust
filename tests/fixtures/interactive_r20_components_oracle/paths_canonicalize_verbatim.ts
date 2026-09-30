// VERBATIM copy of upstream `canonicalizePath` (utils/paths.ts:28-36); the
// rest of paths.ts is not needed by the oracle and drags in cross-spawn.
import { realpathSync } from "node:fs";

/**
 * Resolve a path to its canonical (real) form, following symlinks.
 * Falls back to the raw path if resolution fails (e.g. the target does
 * not exist yet), so that callers never crash on missing filesystem
 * entries.
 */
export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
