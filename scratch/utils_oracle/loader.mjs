// Resolve-hook loader: maps the bare npm specifiers imported by the upstream
// coding-agent utils onto the vendored copies extracted from the local npm
// cache (see tgz/ and node_modules/). Node refuses to type-strip files under
// node_modules, but the vendored packages are plain JS; only the upstream
// .ts files (imported by absolute path) are type-stripped.
import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = import.meta.dirname;

const MAP = new Map([
  ["cross-spawn", "./stub_cross_spawn.mjs"],
  ["chalk", "./node_modules/chalk/source/index.js"],
  ["yaml", "./node_modules/yaml/dist/index.js"],
  ["hosted-git-info", "./node_modules/hosted-git-info/lib/index.js"],
]);

export async function resolve(specifier, context, next) {
  if (MAP.has(specifier)) {
    return {
      url: pathToFileURL(path.resolve(ROOT, MAP.get(specifier))).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
