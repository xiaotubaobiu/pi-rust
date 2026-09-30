// Oracle preload for the clipboard port (M4 native-clipboard subprocess slice).
//
// Installs a recording wrapper over `child_process.spawn` BEFORE the ESM graph
// (loaded via `node --require`), so the vendored upstream
// `src/utils/clipboard-command.ts` — which does `import { spawn } from
// "node:child_process"` — resolves the patched function (verified empirically:
// node's builtin ESM facade picks up the patched CJS export).
//
// Per-call behavior is delegated to `globalThis.__spawnHandler(command, args,
// options, originalSpawn)`; when no handler is installed the call passes
// through to the real spawn (used for the real-subprocess probes of
// runClipboardCommand itself).
"use strict";

const cp = require("node:child_process");
const { EventEmitter } = require("node:events");

const originalSpawn = cp.spawn;

cp.spawn = function patchedSpawn(command, args, options) {
  const calls = (globalThis.__spawnCalls = globalThis.__spawnCalls || []);
  calls.push({
    command,
    args: Array.from(args ?? []),
    options: options === undefined ? null : JSON.parse(JSON.stringify(options)),
  });
  const handler = globalThis.__spawnHandler;
  if (typeof handler === "function") {
    return handler(command, args, options, originalSpawn);
  }
  return originalSpawn(command, args, options);
};

// A child object exposing exactly the surface runClipboardCommand uses:
// `on("error"|"close")`, `stdout.on("data")` + optional `destroy()`,
// `stdin.on("error")` + `end(input)` (recorded), `kill()`. Events fire on a
// microtask so the caller's listeners are attached first.
globalThis.__makeFakeChild = function __makeFakeChild(stdoutChunks, exitCode, emitError) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.destroy = function destroy() {};
  child.stdin = {
    on: function on() {},
    end: function end(input) {
      const ends = (globalThis.__stdinEnds = globalThis.__stdinEnds || []);
      ends.push(input === undefined ? null : input);
    },
  };
  child.kill = function kill() {};
  queueMicrotask(() => {
    for (const chunk of stdoutChunks) {
      child.stdout.emit("data", Buffer.from(chunk, "utf8"));
    }
    if (emitError) {
      const error = new Error("spawn fake ENOENT");
      error.code = "ENOENT";
      child.emit("error", error);
    } else {
      child.emit("close", exitCode);
    }
  });
  return child;
};
