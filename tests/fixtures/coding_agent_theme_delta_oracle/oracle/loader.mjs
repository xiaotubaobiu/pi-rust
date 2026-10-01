import { pathToFileURL } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-tui") {
    return { url: pathToFileURL("pi-tui.ts", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
