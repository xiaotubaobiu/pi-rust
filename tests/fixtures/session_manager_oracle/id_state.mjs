// Shared deterministic counters for the oracle stubs. The Rust port under
// test resets its seams per test scenario; the oracle script resets these at
// the top of each scenario block so the marker sequences line up.
let sessionCounter = 0;
let entryCounter = 0;

export function nextSessionId() {
  return `@u${++sessionCounter}`;
}

export function nextEntryId() {
  return String(++entryCounter).padStart(8, "0");
}

export function resetIdCounters() {
  sessionCounter = 0;
  entryCounter = 0;
}
