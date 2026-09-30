// Oracle capture: upstream coding-agent src/core/keybindings.ts run under
// node with type stripping. Usage: node --experimental-strip-types
// oracle_keybindings.mjs <platform> <wsl DISTRO_NAME or ""> <wsl_interop or "">
// The prelude below patches process.platform/env BEFORE the module under test
// is dynamically imported (its KEYBINDINGS table is computed at module scope).
import { writeFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const platform = process.argv[2] ?? "win32";
const wslDistro = process.argv[3] ?? "";
const wslInterop = process.argv[4] ?? "";

delete process.env.WSL_DISTRO_NAME;
delete process.env.WSL_INTEROP;
if (wslDistro) process.env.WSL_DISTRO_NAME = wslDistro;
if (wslInterop) process.env.WSL_INTEROP = wslInterop;
Object.defineProperty(process, "platform", { value: platform });

const KEYBINDINGS_URL = new URL("./src/core/keybindings.ts", import.meta.url);
const mod = await import(KEYBINDINGS_URL);
const { KEYBINDINGS, useWindowsKeybindings, migrateKeybindingsConfig, KeybindingsManager } = mod;
const { TUI_KEYBINDINGS } = await import("@earendil-works/pi-tui");

const out = {
  platform,
  wslDistro,
  wslInterop,
  detected: useWindowsKeybindings(),
  keybinding_ids: Object.keys(KEYBINDINGS),
  keybindings: Object.entries(KEYBINDINGS).map(([id, def]) => ({
    id,
    defaultKeys: def.defaultKeys,
    description: def.description,
  })),
  tui_keybinding_ids: Object.keys(TUI_KEYBINDINGS),
  tui_overridden_kept_description: [
    "tui.editor.undo",
    "tui.altScreen.previousPrompt",
    "tui.altScreen.nextPrompt",
    "tui.altScreen.search",
  ].map((id) => ({ id, description: KEYBINDINGS[id].description })),
  use_windows_cases: [
    ["win32", {}],
    ["linux", {}],
    ["linux", { WSL_DISTRO_NAME: "Ubuntu" }],
    ["linux", { WSL_INTEROP: "/run/WSL/123_interop" }],
    ["linux", { WT_SESSION: "session" }],
    ["darwin", {}],
    ["sunos", {}],
  ].map(([p, env]) => ({ platform: p, env, result: useWindowsKeybindings(p, env) })),
  migration_cases: [
    { cursorUp: ["up", "ctrl+p"], expandTools: "ctrl+x" },
    { expandTools: "ctrl+x", "app.tools.expand": "ctrl+y" },
    { selectConfirm: "enter", interrupt: "ctrl+x" },
    { "zzz.custom": 1, "app.clear": "ctrl+c", "aaa.beta": true, undo: "ctrl+-" },
    { "app.clear": { nested: true }, "tui.input.submit": ["enter", 42], "tui.input.tab": null },
    {},
  ].map((rawConfig) => {
    const { config, migrated } = migrateKeybindingsConfig(rawConfig);
    return { rawConfig, config, migrated };
  }),
};

// Manager file-loading scenarios (fresh temp dirs per case).
const managerCases = [];
function runManagerCase(name, fileContent) {
  const dir = mkdtempSync(join(tmpdir(), "pi-kb-oracle-"));
  const configPath = join(dir, "keybindings.json");
  if (fileContent !== undefined) writeFileSync(configPath, fileContent, "utf-8");
  const manager = KeybindingsManager.create(dir);
  const before = {
    user: manager.getUserBindings(),
    effective: manager.getEffectiveConfig(),
  };
  let afterReload = null;
  if (fileContent !== undefined) {
    writeFileSync(configPath, JSON.stringify({ "app.clear": "ctrl+shift+c" }, null, 2) + "\n", "utf-8");
    manager.reload();
    afterReload = { effective: manager.getEffectiveConfig() };
  }
  manager.reload(); // reload again for stability
  managerCases.push({ name, before, afterReload, effectiveAfterSecondReload: manager.getEffectiveConfig() });
  rmSync(dir, { recursive: true, force: true });
}
runManagerCase("legacy_names", JSON.stringify({ cursorUp: ["up", "ctrl+p"], expandTools: "ctrl+x" }, null, 2) + "\n");
runManagerCase("namespaced_wins", JSON.stringify({ expandTools: "ctrl+x", "app.tools.expand": "ctrl+y" }, null, 2) + "\n");
runManagerCase("missing_file", undefined);
runManagerCase("invalid_json", "{ nope");
runManagerCase("not_an_object", JSON.stringify([1, 2]));
runManagerCase("array_values_dropped", JSON.stringify({ "app.clear": "ctrl+c", "tui.input.submit": ["enter", 42] }));
out.manager_cases = managerCases;

const target = new URL(`./keybindings_${platform}${wslDistro ? "_wsl" : ""}.oracle.json`, import.meta.url);
writeFileSync(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
console.log("wrote", target.pathname, "keys:", out.keybinding_ids.length);
