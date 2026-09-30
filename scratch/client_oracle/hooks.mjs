// Module resolve hook: maps the bare workspace specifiers used by the
// verbatim upstream client sources onto the vendored copies under vendor/
// (node refuses type-stripping inside a real node_modules directory, and the
// offline environment has no installed workspace links).
const here = new URL(".", import.meta.url).href;

const MAP = new Map(
  Object.entries({
    "@earendil-works/pi-protocol": `${here}vendor/pi-protocol/src/index.ts`,
    "@earendil-works/chord": `${here}vendor/chord/src/index.ts`,
    "@earendil-works/chord/context": `${here}vendor/chord/src/context/index.ts`,
    typebox: `${here}vendor/typebox/index.mjs`,
    "typebox/value": `${here}vendor/typebox/value.mjs`,
  }),
);

export async function resolve(specifier, context, next) {
  const mapped = MAP.get(specifier);
  if (mapped !== undefined) {
    return { url: mapped, shortCircuit: true };
  }
  return next(specifier, context);
}
