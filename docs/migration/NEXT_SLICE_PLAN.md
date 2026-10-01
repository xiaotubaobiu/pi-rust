# Next slice plan — upstream delta v0.99.1 (updated 2026-09-30 late)

This file supersedes the previous plan. The v0.1.1 release closed the
baseline migration; the open work is the upstream delta
`590144609..2bbfcca43` (pi v0.86.0-era -> v0.99.1, ~45k production TS lines).

## Landed (committed, CI to confirm)

- `10e260c` repo restructure: scratch/ -> tests/fixtures/ (225 refs), stale
  handoff docs deleted, dead fixture harnesses removed.
- `0fdc492` tui delta (colors/oklab/wheel-scroll/OSC queries/CJK autocomplete/
  latex scripts; 8 oracle families, 561 tests) + ai delta non-oauth (System
  One classifiers, catalog flatten, image-model restructure; 11 oracle
  tests, 1351 ai tests).
- `4a05813` ai oauth (shared callback-server, chatgpt/meta flows, refactors
  of the four existing flows; 270 tests incl. dead-agent test repairs) +
  chord delta (tracker/diff/validator split, services; 55 tests).
- `1ea5c87` system-theme solver (byte-exact oracle: 42 generation scenarios +
  grids; key finding: upstream quantizes colors to integer RGB; js_cbrt ->
  libm::cbrt = V8 bit parity).
- `363b30e` crash-log module (+ real iso8601 :59-second parse fix).
- `4041db8` mcp-servers config validation + registry (5 tests).

## Remaining, in dependency order

1. **theme slice tail** (~1.6k): theme.ts rewrite wiring (+300/-375 — 256-
   quantizer moved out to tui, system theme tier), theme-json appearance key
   + theme-schema, theme-controller delta, dark/light.json okhsl data
   (byte-copy), interactive-mode Theme consumer updates. system_theme.rs
   solver is ready; wire `generateSystemThemeColors` into theme.rs behind a
   TerminalColors seam (see src/tui/terminal_colors.rs + T1's
   queryTerminalColors port).
2. **core modules** (~2.2k): nested-tool-calls (261 — needs agent-core
   AgentToolCall/ToolCallOutcome + usage-totals combineUsage), virtual-models
   (238 — ModelRuntime routing + session custom-entry state), cache-warmer
   (453 — agent-session idle pre-warm), bug-report (375 + interactive
   bug-report.ts 298), model-runtime wiring (+282/-48).
3. **core modifications** (~5k): agent-session (+1118/-444 — nested calls,
   executeTool context, mcp registry hookup, cache-warmer idle), session-
   manager (+374/-147), resource-loader (+224/-46), provider-composer
   (+192/-64), compaction (+180/-88), sdk (+108/-57), settings-manager,
   prompt-templates, package-manager, model-registry, remote-catalog-
   provider, output-accumulator, crash-log surfacing (cli/interactive).
4. **interactive + components** (~1.1k): interactive-mode (+494/-238),
   12 components (session-selector, footer, settings-selector, themed-text,
   pi-logo, tool-execution, ...), rpc (+37), cli (+61).
5. **extensions** (~1.2k): core/extensions types (+445) + runner (+272),
   tool-search (288), llama (117), export-html (+82).
6. **pi-mcp package** (18 files / 3.1k) + extensions/mcp (~2.6k: index,
   cli, runtime, oauth, resources, tools, ui) + mcp.json loading.
7. **pi-codemode package** (10 files / 1.6k) + extensions/codemode (~1.1k)
   + tool.ts — JS execution engine decision needed (upstream quickjs-wasi;
   Rust candidates: rquickjs, wasmi host of the same wasm, or deno_core-like
   embed; offline crate availability decides).
8. **pi-durable package** (57 files / 16.6k, ZERO upstream consumers —
   library port, last; no product behavior depends on it).
9. Close-out: four gates serial double-run + WSL clippy/test + CI double
   green + version bump (0.2.0) + tag + 4-platform release + README touch.

## Facts for the next session

- Subagent quota resets 2026-10-06 17:46; until then main-thread only (2
  agents died to "Weekly/Monthly Limit Exhausted" mid-run — their leftover
  states were rescued and landed: chord delta in wave-2, oauth files in
  wave-2).
- The oracle technique template lives in
  tests/fixtures/ai_delta_oracle/capture_ai_delta.mjs and
  tests/fixtures/coding_agent_theme_delta_oracle/oracle/capture.mjs
  (node --experimental-strip-types + register/loader resolve hook; sources
  SHA-pinned; use C:/Users/13063/anaconda3/node.exe, NOT the PATH node).
- Transcendental parity: UCRT (Rust std) pow/cos/sin/atan2 match V8 on all
  pinned inputs; musl libm does NOT (verified empirically). Only cbrt needs
  libm.
- Upstream Color model is INTEGER-quantized (linearSrgbToRgb Math.rounds).
  Any new color math must run on tui's u8 pipeline, not floats.
- NO_PROXY=127.0.0.1,localhost for any wiremock/loopback test on Windows.
- Toolchain: rustc/cargo 1.94.1 local; CI pinned 1.98.1.
