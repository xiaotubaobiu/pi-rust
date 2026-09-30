// Oracle stub for upstream `utils/paths.ts` (resolvePath): path resolution
// relative to the process cwd, matching the upstream helper's contract for
// absolute inputs (the only form the oracle exercises).
import { resolve } from "node:path";
export function resolvePath(input) {
  return resolve(input);
}
