// Oracle capture for the clipboard port (M4 native-clipboard subprocess slice).
//
// Drives the vendored, byte-identical upstream sources
//   pi/packages/coding-agent/src/utils/clipboard.ts
//   pi/packages/coding-agent/src/utils/clipboard-command.ts
// (sha256 at capture time, see scratch/clipboard_oracle/ORACLE_README.md)
// under node --experimental-strip-types and records the port's equivalence
// targets as JSON:
//
//   - runClipboardCommand real-subprocess semantics (binary passthrough, empty
//     success vs failure, missing program, Unicode stdin round-trip, timeout,
//     max-buffer rejection, stdout-ignore-when-input)
//   - copyToClipboard / readClipboardText flows with `process.platform` faked
//     per scenario, spawn scripted per command name (argv + options recorded),
//     the native module stubbed (same condition as the port: no native layer),
//     and OSC 52 stdout writes captured byte-exactly.
//
// Run: node --require ./preload_spawn_recorder.cjs capture_clipboard_oracle.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const results = [];
const oscWrites = [];

function b64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function installOsc52Capture() {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function patchedWrite(chunk, ...rest) {
    let bytes = null;
    if (typeof chunk === "string") bytes = Buffer.from(chunk, "utf8");
    else if (Buffer.isBuffer(chunk)) bytes = chunk;
    if (bytes !== null && bytes.slice(0, 7).toString("utf8") === "\x1b]52;c;") {
      oscWrites.push(bytes.toString("base64"));
      return true;
    }
    return originalWrite(chunk, ...rest);
  };
}

const ENV_KEYS = [
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "MOSH_CONNECTION",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "TERMUX_VERSION",
];

function setScenarioEnv(env) {
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }
}

function setScenarioPlatform(platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

// native: { text, getTextFails, setTextFails } — records every native call.
let nativeLog = [];
function setScenarioNative(native) {
  if (!native) {
    globalThis.__nativeClipboard = undefined;
    return;
  }
  nativeLog = [];
  globalThis.__nativeClipboard = {
    getText: async () => {
      nativeLog.push("getText");
      if (native.getTextFails) throw new Error("native getText failed");
      return native.text ?? null;
    },
    getImage: async () => undefined,
    setText: async (text) => {
      nativeLog.push(`setText:${text}`);
      if (native.setTextFails) throw new Error("native setText failed");
    },
  };
}

async function scenario(id, { platform, env, native, script, action }) {
  globalThis.__spawnCalls = [];
  globalThis.__stdinEnds = [];
  globalThis.__spawnHandler = script
    ? (command, args, options, originalSpawn) => {
        const outcome = script(command, args, options);
        if (outcome === "passthrough") return originalSpawn(command, args, options);
        if (outcome === "fail") return globalThis.__makeFakeChild([], null, true);
        if (outcome === "exit1") return globalThis.__makeFakeChild([], 1, false);
        return globalThis.__makeFakeChild([outcome.text ?? ""], 0, false);
      }
    : null;
  setScenarioPlatform(platform);
  setScenarioEnv(env);
  setScenarioNative(native);
  let outcome;
  try {
    const value = await action();
    outcome = { status: "ok", value: value === null ? null : value };
  } catch (error) {
    outcome = { status: "throw", message: error.message };
  }
  results.push({
    id,
    platform,
    env,
    calls: globalThis.__spawnCalls,
    stdinEnds: globalThis.__stdinEnds,
    nativeCalls: native ? nativeLog.slice() : undefined,
    osc52: oscWrites.splice(0),
    outcome,
  });
}

const ok = (text) => ({ text });
const FAIL = "fail";
const EXIT1 = "exit1";
const never = () => FAIL;

async function main() {
  installOsc52Capture();

  // ------------------------------------------------------------------
  // Part A: real-subprocess semantics of runClipboardCommand
  // (spawn passes through the recorder to the real child_process).
  // ------------------------------------------------------------------
  const { runClipboardCommand } = await import("./vendor/clipboard-command.ts");
  const execPath = process.execPath;
  const realCases = [
    ["binary-passthrough", ["-e", "process.stdout.write(Buffer.from([0, 255, 10]))"], {}],
    ["empty-success", ["-e", ""], {}],
    ["nonzero-exit", ["-e", "process.exit(1)"], {}],
    ["missing-program", null, {}],
    [
      "unicode-input",
      [
        "-e",
        "let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => text += c); process.stdin.on('end', () => process.exit(text === 'café 日本語' ? 0 : 1));",
      ],
      { input: "café 日本語" },
    ],
    ["stdout-ignored-when-input-given", ["-e", "process.stdout.write('ignored'); process.exit(0)"], { input: "x" }],
  ];
  for (const [id, args, options] of realCases) {
    const started = Date.now();
    const value = await runClipboardCommand(
      id === "missing-program" ? "pi-clipboard-command-does-not-exist" : execPath,
      args ?? [],
      options,
    );
    results.push({
      id: `run:${id}`,
      outcome: { status: "ok", value: value === undefined ? undefined : value.toString("base64") },
      elapsedMs: Date.now() - started,
    });
  }
  {
    const started = Date.now();
    const value = await runClipboardCommand(execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 200 });
    results.push({
      id: "run:timeout-explicit",
      outcome: { status: "ok", value: value === undefined ? undefined : value.toString("base64") },
      elapsedMs: Date.now() - started,
    });
  }
  {
    const started = Date.now();
    const value = await runClipboardCommand(execPath, ["-e", "process.stdout.write(Buffer.alloc(1024))"], {
      maxBufferBytes: 16,
    });
    results.push({
      id: "run:max-buffer",
      outcome: { status: "ok", value: value === undefined ? undefined : value.toString("base64") },
      elapsedMs: Date.now() - started,
    });
  }

  // ------------------------------------------------------------------
  // Part B: copyToClipboard / readClipboardText flows.
  // ------------------------------------------------------------------
  const clipboard = await import("./vendor/clipboard.ts");

  // readClipboardText -------------------------------------------------
  await scenario("read:darwin-native", {
    platform: "darwin",
    env: {},
    native: { text: "clipboard text" },
    script: never,
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:darwin-native-null", {
    platform: "darwin",
    env: {},
    native: { text: null },
    script: never,
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:linux-termux-ok", {
    platform: "linux",
    env: { TERMUX_VERSION: "1" },
    native: { text: "native text" },
    script: (command) => (command === "termux-clipboard-get" ? ok("clipboard text") : FAIL),
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:linux-termux-empty-stops", {
    platform: "linux",
    env: { TERMUX_VERSION: "1" },
    native: { text: "native text" },
    script: (command) => (command === "termux-clipboard-get" ? ok("") : FAIL),
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:linux-wayland-ok", {
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0" },
    native: { text: "native text" },
    script: (command) => (command === "wl-paste" ? ok("wayland text") : FAIL),
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:linux-wayland-empty-stops", {
    // Regression capture for upstream #7248: empty Wayland content must not
    // fall through to stale X11 clipboard contents.
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    native: { text: "native text" },
    script: (command) => (command === "wl-paste" ? ok("") : FAIL),
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:linux-xclip-ok", {
    platform: "linux",
    env: { DISPLAY: ":0" },
    native: { text: "native text" },
    script: (command) => (command === "xclip" ? ok("x11 text") : FAIL),
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:linux-xclip-empty-stops", {
    platform: "linux",
    env: { DISPLAY: ":0" },
    native: { text: "native text" },
    script: (command) => (command === "xclip" ? ok("") : FAIL),
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:linux-xclip-fail-xsel-ok", {
    platform: "linux",
    env: { DISPLAY: ":0" },
    native: { text: "native text" },
    script: (command) => (command === "xsel" ? ok("X11 text") : FAIL),
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:linux-all-fail-native-fallback", {
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    native: { text: "native text" },
    script: never,
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:linux-all-fail-native-empty", {
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    native: { text: "" },
    script: never,
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:linux-all-fail-no-native", {
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    native: null,
    script: never,
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:linux-no-display-commands", {
    platform: "linux",
    env: {},
    native: null,
    script: never,
    action: () => clipboard.readClipboardText(),
  });
  await scenario("read:win32-native-only", {
    platform: "win32",
    env: { DISPLAY: ":0" },
    native: { text: "win text" },
    script: never,
    action: () => clipboard.readClipboardText(),
  });

  // copyToClipboard ---------------------------------------------------
  const hello = "hello";
  await scenario("copy:darwin-native-ok-remote-osc52", {
    platform: "darwin",
    env: { SSH_CONNECTION: "client server" },
    native: { text: null },
    script: never,
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:darwin-native-ok-local", {
    platform: "darwin",
    env: {},
    native: { text: null },
    script: never,
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:darwin-native-fail-pbcopy-ok", {
    platform: "darwin",
    env: {},
    native: { text: null, setTextFails: true },
    script: (command) => (command === "pbcopy" ? ok("") : FAIL),
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:darwin-native-fail-pbcopy-fail", {
    platform: "darwin",
    env: {},
    native: { text: null, setTextFails: true },
    script: never,
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:darwin-remote-osc52-oversize", {
    platform: "darwin",
    env: { SSH_CONNECTION: "client server" },
    native: { text: null, setTextFails: true },
    script: never,
    action: () => clipboard.copyToClipboard("x".repeat(80_000)),
  });
  await scenario("copy:darwin-remote-osc52-boundary-exact", {
    platform: "darwin",
    env: { SSH_CLIENT: "client" },
    native: { text: null, setTextFails: true },
    script: never,
    // 75_000 bytes → base64 length exactly 100_000 (allowed, ≤ limit).
    action: () => clipboard.copyToClipboard("a".repeat(75_000)),
  });
  await scenario("copy:darwin-remote-osc52-boundary-over", {
    platform: "darwin",
    env: { MOSH_CONNECTION: "client" },
    native: { text: null, setTextFails: true },
    script: never,
    // 75_001 bytes → base64 length 100_004 (rejected).
    action: () => clipboard.copyToClipboard("a".repeat(75_001)),
  });
  await scenario("copy:linux-xclip-ok", {
    platform: "linux",
    env: { DISPLAY: ":0" },
    native: { text: null },
    script: (command) => (command === "xclip" ? ok("") : FAIL),
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:linux-wl-copy-fail-xsel-ok", {
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    native: { text: null },
    script: (command) => (command === "xsel" ? ok("") : FAIL),
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:linux-fail-x11-error", {
    platform: "linux",
    env: { DISPLAY: ":0" },
    native: { text: null },
    script: never,
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:linux-fail-wayland-error", {
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    native: { text: null },
    script: never,
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:linux-fail-termux-error", {
    platform: "linux",
    env: { TERMUX_VERSION: "1" },
    native: { text: null },
    script: never,
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:linux-fail-no-display-error", {
    platform: "linux",
    env: {},
    native: { text: null },
    script: never,
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:linux-fail-remote-osc52-saves", {
    platform: "linux",
    env: { DISPLAY: ":0", SSH_CONNECTION: "client server" },
    native: { text: null },
    script: never,
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:win32-clip-ok", {
    platform: "win32",
    env: {},
    native: { text: null, setTextFails: true },
    script: (command) => (command === "clip" ? ok("") : FAIL),
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:win32-fail-remote-osc52", {
    platform: "win32",
    env: { SSH_CONNECTION: "client server" },
    native: { text: null, setTextFails: true },
    script: never,
    action: () => clipboard.copyToClipboard(hello),
  });
  await scenario("copy:other-platform-generic-error", {
    platform: "freebsd",
    env: {},
    native: { text: null, setTextFails: true },
    script: never,
    action: () => clipboard.copyToClipboard(hello),
  });

  process.stdout.write = process.stdout.write; // keep capture installed until exit
  const outPath = path.join(__dirname, "clipboard.oracle.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
  // Pending 5s abort timers from scripted scenarios must not hold the process.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
