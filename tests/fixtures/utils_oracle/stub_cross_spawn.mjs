// Stub for the bare "cross-spawn" specifier that paths.ts -> child-process.ts
// imports. The oracle only exercises the pure functions of paths.ts, so the
// spawn helpers are never called; the stub just satisfies module resolution
// offline (no network fetch of the real package).
const spawn = () => {
  throw new Error("cross-spawn stub: not available in oracle");
};
spawn.sync = () => {
  throw new Error("cross-spawn stub: not available in oracle");
};
export default spawn;
