// ORACLE STUB (not upstream source): runner.ts only reads the `theme` module
// binding for noOpUIContext's `get theme()`; the real theme module loads
// chalk/watchers/highlighters that the oracle tree does not vendor. Disclosed
// in the extensions port report (seam O-2).
export const theme = { name: "oracle-theme-stub" };
export type Theme = Record<string, unknown>;
