// Resolve hook: route bare `crypto` imports (session-manager.ts imports
// randomUUID from it) to the deterministic stub for this oracle run only.


const STUB_URL = new URL("./crypto_stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "crypto") {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
