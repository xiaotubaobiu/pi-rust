// Captures WheelScrollAccelerator outputs from the REAL upstream
// wheel-scroll.ts (v0.99.1). Acceleration is forced explicitly, so the
// capture is platform-independent. Every scenario is a flat call list with
// the recorded outputs, replayed 1:1 by the Rust oracle test.
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WheelScrollAccelerator } from "./wheel-scroll.ts";

const out = { scenarios: [], provenance: {} };

function record(id, lines, accelerate, calls, mutate) {
  const accelerator = new WheelScrollAccelerator(lines, accelerate);
  const outputs = calls.map((call) => accelerator.next(call.direction, call.time));
  if (mutate) {
    mutate(accelerator, outputs);
  }
  out.scenarios.push({ id, lines, accelerate, calls, outputs });
}

const run = (times, direction = 1) => times.map((time) => ({ direction, time }));

record("fixed-3-fast-terminal", 3, true, run([0, 10, 20, 1000]));
{
  // setLines(0.5) then one event: fixed line counts floor to >= 1.
  const accelerator = new WheelScrollAccelerator(3, true);
  const outputs = run([0, 10, 20, 1000]).map((call) => accelerator.next(call.direction, call.time));
  accelerator.setLines(0.5);
  outputs.push(accelerator.next(1, 2000));
  out.scenarios.push({ id: "set-lines-0.5", lines: 3, accelerate: true, calls: [...run([0, 10, 20, 1000]), { direction: 1, time: 2000 }], outputs, reconfiguredAfter: 4, reconfiguredLines: 0.5 });
}
record("auto-no-accelerate", "auto", false, run([0, 10, 20, 30]));
record("auto-slow-150ms", "auto", true, run([0, 150, 300, 450]));
record("auto-medium-50ms", "auto", true, run([1000, 1050, 1100, 1150]));
record("auto-fast-20ms", "auto", true, run([2000, 2020, 2040, 2060]));
record("auto-very-fast-10ms", "auto", true, run([3000, 3010, 3020, 3030]));
record("burst-3ms", "auto", true, run([0, 3, 6, 9]));
record("direction-change", "auto", true, [
  ...run([0, 20, 40]),
  { direction: -1, time: 60 },
  ...run([500, 520]),
]);
record("carry-40ms", "auto", true, run([0, 40, 80, 120, 160]));
record("fixed-0", 0, true, run([0, 50]));
record("fixed-nan", NaN, true, run([0, 50]));
record("fixed-infinity", Infinity, true, run([0, 50]));
record("fixed-negative", -4, true, run([0, 50]));
{
  const accelerator = new WheelScrollAccelerator("auto", true);
  const calls = [...run([0, 20])];
  const outputs = calls.map((call) => accelerator.next(call.direction, call.time));
  accelerator.setLines("auto");
  const postCalls = run([40, 60]);
  outputs.push(...postCalls.map((call) => accelerator.next(call.direction, call.time)));
  out.scenarios.push({ id: "set-lines-resets-gesture", lines: "auto", accelerate: true, calls: [...calls, ...postCalls], outputs, reconfiguredAfter: 2, reconfiguredLines: "auto" });
}

out.provenance = {
  wheelScrollSha256: createHash("sha256").update(readFileSync(fileURLToPath(new URL("./wheel-scroll.ts", import.meta.url)))).digest("hex"),
  node: process.version,
  platform: process.platform,
};
const target = process.argv[2] ?? fileURLToPath(new URL("./wheel_oracle.json", import.meta.url));
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log("wheel scenarios:", out.scenarios.length, createHash("sha256").update(readFileSync(target)).digest("hex"));
