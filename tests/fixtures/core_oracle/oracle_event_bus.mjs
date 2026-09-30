// Oracle capture: upstream coding-agent src/core/event-bus.ts under node.
const { createEventBus } = await import(new URL("./src/core/event-bus.ts", import.meta.url));

const trace = [];
const errors = [];
const origError = console.error;
console.error = (...args) => {
  errors.push(
    args
      .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : JSON.stringify(a)))
      .join(" "),
  );
};

// 1. Registration-order dispatch per channel.
{
  const bus = createEventBus();
  const offA1 = bus.on("a", (d) => trace.push(`A1:${JSON.stringify(d)}`));
  bus.on("a", (d) => trace.push(`A2:${JSON.stringify(d)}`));
  bus.on("b", (d) => trace.push(`B1:${JSON.stringify(d)}`));
  bus.emit("a", { n: 1 });
  bus.emit("a", { n: 2 });
  bus.emit("b", "x");
  // 2. Unsubscribe removes only its own registration.
  offA1();
  bus.emit("a", { n: 3 });
  // Double unsubscribe is a no-op.
  offA1();
  bus.emit("a", { n: 4 });
  // 5. Same handler registered twice fires twice; one unsub removes one.
  const h = (d) => trace.push(`H:${JSON.stringify(d)}`);
  const off1 = bus.on("dup", h);
  bus.on("dup", h);
  bus.emit("dup", 7);
  off1();
  bus.emit("dup", 8);
}
// 3. Throwing handler: error captured, later listeners still run.
{
  const bus = createEventBus();
  bus.on("boom", () => {
    throw new Error("kaboom");
  });
  bus.on("boom", () => trace.push("after-boom"));
  bus.emit("boom", null);
  trace.push("errors>0: " + (errors.length > 0));
}
// 4. clear() removes all listeners.
{
  const bus = createEventBus();
  bus.on("c", () => trace.push("c1"));
  bus.on("c", () => trace.push("c2"));
  bus.clear();
  bus.emit("c", null);
  trace.push("clear-done");
}
// 6. Unknown channel emit with no listeners is a no-op.
{
  const bus = createEventBus();
  bus.emit("nobody", 1);
  trace.push("noop-done");
}
// 7. Async handlers are awaited before the catch applies.
{
  const bus = createEventBus();
  bus.on("async-err", async () => {
    throw new Error("async-kaboom");
  });
  bus.emit("async-err", null);
  trace.push("sync-after-emit");
  await new Promise((r) => setTimeout(r, 10));
  trace.push("errors-after-tick: " + errors.length);
}

console.error = origError;
const out = { trace, errors };
const target = new URL("./event_bus.oracle.json", import.meta.url);
const { writeFileSync } = await import("node:fs");
writeFileSync(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
console.log("wrote", target, "trace:", trace.length);
