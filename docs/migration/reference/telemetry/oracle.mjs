// Byte-level oracle for the harness telemetry slice.
//
// Executes the ACTUAL upstream sources (read-only) under Node
// --experimental-strip-types and prints three JSON lines:
//   1. {ai, harness, hooks, events} — JSON.stringify of the two schema
//      literals and the hook/event vocabularies from
//      packages/agent/src/harness/telemetry.ts
//   2. the in-memory backend scenario spans (nested spans, attribute merge,
//      explicit/automatic statuses) from packages/telemetry/src/memory.ts
//   3. the settled-parent delegation scenario spans
// The Rust port compares its serialization byte-for-byte against lines 1-3.
// Run: C:\Users\13063\anaconda3\node.exe --experimental-strip-types oracle.mjs

import {
  AI_TELEMETRY_SCHEMA,
  HARNESS_TELEMETRY_SCHEMA,
} from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/agent/src/harness/telemetry.ts";
import { InMemoryTelemetryContext } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/telemetry/src/memory.ts";

console.log(
  JSON.stringify({
    ai: AI_TELEMETRY_SCHEMA,
    harness: HARNESS_TELEMETRY_SCHEMA,
  }),
);

// Scenario A: nested spans, attribute merge, explicit/automatic statuses.
const scenarioA = new InMemoryTelemetryContext();
await scenarioA.startSpan(
  { name: "root", attributes: { a: "1", n: 2, b: true, arr: ["x", "y"] } },
  async (root) => {
    root.addEvent("evt", { k: "v" });
    root.setAttributes({ n: 9, extra: "e" });
    await root.startSpan({ name: "child" }, async (child) => {
      child.setStatus({ status: "error", error: { name: "AbortError", message: "stop" } });
      return "child-ok";
    });
    await root.startSpan({ name: "fail-child" }, async () => {
      throw new Error("boom");
    }).catch((error) => error.message);
    await root.startSpan({ name: "explicit-error" }, async (span) => {
      span.setStatus({ status: "error" });
      return "handled";
    });
    await root.startSpan({ name: "explicit-error-fail" }, async (span) => {
      span.setStatus({ status: "error", error: { name: "Handled", message: "known" } });
      throw new Error("boom2");
    }).catch((error) => error.message);
    return "root-ok";
  },
);
console.log(JSON.stringify(scenarioA.getSpans()));

// Scenario B: a child of a settled span delegates to the no-op context;
// post-settle mutations are ignored.
const scenarioB = new InMemoryTelemetryContext();
let settledRoot;
await scenarioB.startSpan({ name: "r" }, (root) => {
  settledRoot = root;
});
await settledRoot.startSpan({ name: "late-child" }, async () => "ignored");
settledRoot.addEvent("late-event", { x: 1 });
settledRoot.setAttributes({ late: "no" });
settledRoot.setStatus({ status: "error" });
console.log(JSON.stringify(scenarioB.getSpans()));
