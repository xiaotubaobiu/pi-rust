// Oracle capture: upstream coding-agent src/core/settings-manager.ts under
// node (--experimental-strip-types). Pins the deterministic outputs the Rust
// port must reproduce byte-for-byte:
// - settings.json file bytes after save()/flush() (JSON.stringify(…, null, 2)
//   key order: parse order + modified fields appended/updated in place),
// - migrations (queueMode/websockets/skills/retry.maxDelayMs) as visible in
//   rewritten file bytes and getter values,
// - validation error texts (compaction tokens, httpIdleTimeoutMs, untrusted
//   project writes) — fixed strings, JS `String(value)` rendering included,
// - getter default batteries and merge results,
// - drainErrors structure (scope + path presence; message text is V8 JSON
//   parse wording and intentionally NOT captured).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { SettingsManager, InMemorySettingsStorage } = await import(
  new URL("./src/core/settings-manager.ts", import.meta.url)
);

const out = { snapshots: {}, errors: {}, bytes: {}, values: {} };

// ---- shared fixture ------------------------------------------------------
const testDir = join(tmpdir(), `pi-oracle-w37-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const agentDir = join(testDir, "agent");
const projectDir = join(testDir, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(projectDir, ".pi"), { recursive: true });
const globalPath = join(agentDir, "settings.json");
const projectPath = join(projectDir, ".pi", "settings.json");

const bytes = (path) => readFileSync(path, "utf-8");

// ---- 1. migration: legacy keys, visible through rewritten file bytes ------
{
  writeFileSync(globalPath, JSON.stringify({
    queueMode: "all",
    websockets: true,
    skills: { enableSkillCommands: false, customDirectories: ["/a", "/b"] },
    retry: { maxDelayMs: 45000, enabled: true },
    theme: "dark",
  }));
  const manager = SettingsManager.create(projectDir, agentDir);
  out.values.migrated_steering = manager.getSteeringMode();
  out.values.migrated_transport = manager.getTransport();
  out.values.migrated_skills = manager.getSkillPaths();
  out.values.migrated_enable_skill_commands = manager.getEnableSkillCommands();
  out.values.migrated_provider_retry = manager.getProviderRetrySettings();
  manager.setDefaultThinkingLevel("high");
  await manager.flush();
  out.bytes.migrated_plus_write = bytes(globalPath);
}

// ---- 2. preserve externally added settings (bytes) ------------------------
{
  writeFileSync(globalPath, JSON.stringify({ theme: "dark", defaultModel: "claude-sonnet" }));
  const manager = SettingsManager.create(projectDir, agentDir);
  const current = JSON.parse(bytes(globalPath));
  current.enabledModels = ["claude-opus-4-5", "gpt-5.2-codex"];
  writeFileSync(globalPath, JSON.stringify(current, null, 2));
  manager.setDefaultThinkingLevel("high");
  await manager.flush();
  out.bytes.preserve_enabled_models = bytes(globalPath);
}
{
  writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
  const manager = SettingsManager.create(projectDir, agentDir);
  const current = JSON.parse(bytes(globalPath));
  current.defaultThinkingLevel = "low";
  writeFileSync(globalPath, JSON.stringify(current, null, 2));
  manager.setDefaultThinkingLevel("high");
  await manager.flush();
  out.bytes.in_memory_wins_same_key = bytes(globalPath);
}

// ---- 3. packages / extension paths ---------------------------------------
{
  writeFileSync(globalPath, JSON.stringify({
    packages: [
      "npm:simple-pkg",
      { source: "npm:shitty-extensions", extensions: ["extensions/oracle.ts"], skills: [] },
    ],
    extensions: ["/local/ext.ts", "./relative/ext.ts"],
  }));
  const manager = SettingsManager.create(projectDir, agentDir);
  out.values.packages = manager.getPackages();
  out.values.extension_paths = manager.getExtensionPaths();
}

// ---- 4. nested modified-field persistence bytes ---------------------------
{
  writeFileSync(globalPath, JSON.stringify({
    compaction: { enabled: true, reserveTokens: 1234, modelOverrides: { "p/m": { reserveTokens: 1 } } },
    theme: "dark",
  }));
  const manager = SettingsManager.create(projectDir, agentDir);
  manager.setCompactionEnabled(false);
  await manager.flush();
  out.bytes.nested_modified_persist = bytes(globalPath);
}

// ---- 5. unset-via-undefined drops the key (JSON.stringify semantics) ------
{
  writeFileSync(globalPath, JSON.stringify({ shellPath: "/bin/zsh", theme: "dark" }));
  const manager = SettingsManager.create(projectDir, agentDir);
  manager.setShellPath(undefined);
  manager.setDefaultThinkingLevel("low");
  await manager.flush();
  out.bytes.undefined_drops_key = bytes(globalPath);
}

// ---- 6. reload + error tracking ------------------------------------------
{
  writeFileSync(globalPath, JSON.stringify({ theme: "dark", extensions: ["/before.ts"] }));
  const manager = SettingsManager.create(projectDir, agentDir);
  writeFileSync(globalPath, JSON.stringify({ theme: "light", extensions: ["/after.ts"], defaultModel: "claude-sonnet" }));
  await manager.reload();
  out.values.reload_theme = manager.getTheme();
  out.values.reload_extensions = manager.getExtensionPaths();
  out.values.reload_default_model = manager.getDefaultModel();
}
{
  writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
  const manager = SettingsManager.create(projectDir, agentDir);
  writeFileSync(globalPath, "{ invalid json");
  await manager.reload();
  out.values.reload_keeps_theme = manager.getTheme();
  out.errors.reload_invalid = manager.drainErrors().map((e) => ({ scope: e.scope, hasPath: e.path !== undefined }));
}
{
  writeFileSync(globalPath, "{ invalid global json");
  writeFileSync(projectPath, "{ invalid project json");
  const manager = SettingsManager.create(projectDir, agentDir);
  const drained = manager.drainErrors();
  out.errors.initial_load = drained.map((e) => ({ scope: e.scope, hasPath: e.path !== undefined }));
  out.errors.second_drain_empty = manager.drainErrors().length === 0;
}
rmSync(globalPath, { force: true });
rmSync(projectPath, { force: true });

// ---- 7. theme setting split ----------------------------------------------
{
  writeFileSync(globalPath, JSON.stringify({ theme: "light/dark" }));
  const manager = SettingsManager.create(projectDir, agentDir);
  out.values.theme_slash_get = manager.getTheme() ?? null;
  out.values.theme_slash_setting = manager.getThemeSetting();
  manager.setTheme("solarized-light/tokyo-night");
  await manager.flush();
  out.bytes.theme_write = bytes(globalPath);
}

// ---- 8. project trust -----------------------------------------------------
{
  writeFileSync(globalPath, JSON.stringify({ theme: "global" }));
  writeFileSync(projectPath, JSON.stringify({ theme: "project" }));
  const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
  out.values.untrusted_theme = manager.getTheme();
  out.values.untrusted_project_settings = manager.getProjectSettings();
  out.values.untrusted_flag = manager.isProjectTrusted();
  manager.setProjectTrusted(true);
  out.values.trusted_after_flip_theme = manager.getTheme();
  out.values.trusted_after_flip_flag = manager.isProjectTrusted();
}
{
  writeFileSync(projectPath, JSON.stringify({ packages: ["npm:existing"] }));
  const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
  try {
    manager.setProjectPackages(["npm:new"]);
    out.errors.untrusted_write = null;
  } catch (error) {
    out.errors.untrusted_write = error.message;
  }
  await manager.flush();
  out.values.untrusted_write_project_settings = manager.getProjectSettings();
  out.bytes.untrusted_write_file = bytes(projectPath);
}
{
  writeFileSync(globalPath, JSON.stringify({ defaultProjectTrust: "always" }));
  writeFileSync(projectPath, JSON.stringify({ defaultProjectTrust: "never" }));
  const manager = SettingsManager.create(projectDir, agentDir);
  out.values.project_trust_global_only = manager.getDefaultProjectTrust();
}
{
  writeFileSync(globalPath, JSON.stringify({ defaultProjectTrust: "sometimes" }));
  const manager = SettingsManager.create(projectDir, agentDir);
  out.values.project_trust_invalid = manager.getDefaultProjectTrust();
}
rmSync(globalPath, { force: true });
rmSync(projectPath, { force: true });

// ---- 9. project settings directory creation -------------------------------
{
  writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
  rmSync(join(projectDir, ".pi"), { recursive: true });
  const manager = SettingsManager.create(projectDir, agentDir);
  out.values.read_does_not_create_pi = !existsSync(join(projectDir, ".pi"));
  out.values.read_global_theme = manager.getTheme();
  manager.setProjectPackages([{ source: "npm:test-pkg" }]);
  await manager.flush();
  out.values.write_creates_pi = existsSync(join(projectDir, ".pi"));
  out.values.write_creates_file = existsSync(projectPath);
  out.bytes.project_first_write = bytes(projectPath);
}

// ---- 10. terminal capability overrides ------------------------------------
{
  const getOverrides = (terminal) => SettingsManager.inMemory({ terminal }).getTerminalCapabilityOverrides();
  out.values.term_overrides_clear = getOverrides({ images: false, trueColor: false, hyperlinks: false });
  out.values.term_overrides_explicit = getOverrides({ images: "kitty", trueColor: true, hyperlinks: true });
  out.values.term_overrides_auto = getOverrides({ images: "auto", trueColor: "auto", hyperlinks: "auto" });
}

// ---- 11. retry / http timeout ---------------------------------------------
{
  const defaults = SettingsManager.inMemory().getRetrySettings();
  out.values.retry_defaults = defaults;
  out.values.retry_overrides = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 10, baseDelayMs: 500, maxAgentDelayMs: 5000 },
  }).getRetrySettings();
  writeFileSync(globalPath, JSON.stringify({ httpIdleTimeoutMs: 300000 }));
  writeFileSync(projectPath, JSON.stringify({ httpIdleTimeoutMs: 0 }));
  const manager = SettingsManager.create(projectDir, agentDir);
  out.values.http_idle_merged = manager.getHttpIdleTimeoutMs();
}
{
  rmSync(globalPath, { force: true });
  rmSync(projectPath, { force: true });
  writeFileSync(globalPath, JSON.stringify({ httpIdleTimeoutMs: -1 }));
  const manager = SettingsManager.create(projectDir, agentDir);
  try {
    manager.getHttpIdleTimeoutMs();
    out.errors.http_idle_invalid = null;
  } catch (error) {
    out.errors.http_idle_invalid = error.message;
  }
}
{
  const manager = SettingsManager.inMemory();
  for (const value of [NaN, -2.5]) {
    try {
      manager.setHttpIdleTimeoutMs(value);
      out.errors[`set_http_idle_${value}`] = null;
    } catch (error) {
      out.errors[`set_http_idle_${value}`] = error.message;
    }
  }
}
rmSync(globalPath, { force: true });
rmSync(projectPath, { force: true });

// ---- 12. external editor --------------------------------------------------
{
  const originalVisual = process.env.VISUAL;
  const originalEditor = process.env.EDITOR;
  const setEnv = (visual, editor) => {
    if (visual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = visual;
    if (editor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = editor;
  };
  setEnv("vim", "nano");
  out.values.editor_configured_setting = SettingsManager.inMemory({ externalEditor: "code --wait" }).getExternalEditorCommand();
  out.values.editor_env_visual = SettingsManager.inMemory().getExternalEditorCommand();
  setEnv(undefined, "emacs");
  out.values.editor_env_editor = SettingsManager.inMemory().getExternalEditorCommand();
  setEnv(undefined, undefined);
  out.values.editor_platform_default = SettingsManager.inMemory().getExternalEditorCommand();
  setEnv(originalVisual, originalEditor);
}

// ---- 13. TUI / fullscreen / outputPad / mermaid ---------------------------
{
  const dir = join(testDir, "tui");
  mkdirSync(dir, { recursive: true });
  const agent = join(dir, "agent");
  const project = join(dir, "project");
  mkdirSync(join(project, ".pi"), { recursive: true });
  const g = join(agent, "settings.json");
  const manager = SettingsManager.create(project, agent);
  out.values.tui_default = manager.getTuiMode();
  manager.setTuiMode("fullscreen");
  await manager.flush();
  out.values.tui_persisted = manager.getTuiMode();
  out.values.tui_file = JSON.parse(bytes(g)).tuiMode;

  writeFileSync(g, JSON.stringify({ tuiMode: "other" }));
  out.values.tui_invalid = SettingsManager.create(project, agent).getTuiMode();
  writeFileSync(g, JSON.stringify({ uiMode: "fullscreen" }));
  out.values.tui_legacy_uimode = SettingsManager.create(project, agent).getTuiMode();

  const manager2 = SettingsManager.create(project, agent);
  out.values.fullscreen_defaults = [
    manager2.getFullscreenExitOutput(),
    manager2.getFullscreenScrollbar(),
    manager2.getFullscreenCopyOnSelect(),
  ];
  manager2.setFullscreenExitOutput("resume-hint");
  manager2.setFullscreenScrollbar("hidden");
  manager2.setFullscreenCopyOnSelect(false);
  await manager2.flush();
  out.bytes.fullscreen_write = bytes(g);
  writeFileSync(g, JSON.stringify({ fullscreenExitOutput: "nothing", fullscreenScrollbar: "sometimes" }));
  const reloaded = SettingsManager.create(project, agent);
  out.values.fullscreen_invalid = [
    reloaded.getFullscreenExitOutput(),
    reloaded.getFullscreenScrollbar(),
    reloaded.getFullscreenCopyOnSelect(),
  ];

  const manager3 = SettingsManager.create(project, agent);
  out.values.output_pad_default = manager3.getOutputPad();
  manager3.setOutputPad(0);
  await manager3.flush();
  out.values.output_pad_zero = manager3.getOutputPad();
  out.bytes.output_pad_write = bytes(g);
  writeFileSync(g, JSON.stringify({ outputPad: 2 }));
  out.values.output_pad_invalid = SettingsManager.create(project, agent).getOutputPad();

  const manager4 = SettingsManager.create(project, agent);
  out.values.mermaid_default = manager4.getMermaidRenderingMode();
  manager4.setMermaidRenderingMode("final");
  await manager4.flush();
  out.values.mermaid_persisted = manager4.getMermaidRenderingMode();
  out.bytes.mermaid_write = bytes(g);
  writeFileSync(g, JSON.stringify({ markdown: { mermaid: "sometimes" } }));
  out.values.mermaid_invalid = SettingsManager.create(project, agent).getMermaidRenderingMode();
}

// ---- 14. shellCommandPrefix / defaultTools / npmCommand -------------------
{
  writeFileSync(globalPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));
  const manager = SettingsManager.create(projectDir, agentDir);
  out.values.shell_prefix = manager.getShellCommandPrefix();
  manager.setTheme("light");
  await manager.flush();
  out.bytes.shell_prefix_preserved = bytes(globalPath);
}
{
  writeFileSync(globalPath, JSON.stringify({ defaultTools: ["read", "bash"] }));
  out.values.default_tools_global = SettingsManager.create(projectDir, agentDir).getDefaultTools();
  writeFileSync(projectPath, JSON.stringify({ defaultTools: ["grep"] }));
  out.values.default_tools_project = SettingsManager.create(projectDir, agentDir).getDefaultTools();
  out.values.default_tools_empty = SettingsManager.inMemory({ defaultTools: [] }).getDefaultTools();
  out.values.default_tools_absent = SettingsManager.inMemory().getDefaultTools() ?? null;
}

// ---- 15. compaction battery (test/settings-manager-compaction.test.ts) ----
{
  const model = { provider: "provider", id: "family/model" };
  const modelKey = "provider/family/model";
  const defaults = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
  const manager = SettingsManager.inMemory();
  out.values.compaction_defaults_plain = manager.getCompactionSettings();
  out.values.compaction_defaults_model = manager.getCompactionSettings(model);

  const manager2 = SettingsManager.inMemory({
    compaction: {
      reserveTokens: 8192,
      keepRecentTokens: 10000,
      modelOverrides: { [modelKey]: { reserveTokens: 400000 } },
    },
  });
  out.values.compaction_per_field = manager2.getCompactionSettings(model);
  out.values.compaction_reserve_model = manager2.getCompactionReserveTokens(model);
  out.values.compaction_keep_model = manager2.getCompactionKeepRecentTokens(model);
  out.values.compaction_no_model = manager2.getCompactionSettings();
  manager2.applyOverrides({ compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: 30000 } } } });
  out.values.compaction_after_override_keep = manager2.getCompactionKeepRecentTokens(model);
  out.values.compaction_after_override_reserve = manager2.getCompactionReserveTokens(model);

  const manager3 = SettingsManager.inMemory({
    compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: 1024 } } },
  });
  out.values.compaction_partial_override = manager3.getCompactionSettings(model);

  const manager4 = SettingsManager.inMemory({
    compaction: {
      modelOverrides: {
        [modelKey]: { reserveTokens: 400000 },
        "provider/*": { reserveTokens: 1 },
        "family/model": { reserveTokens: 2 },
      },
    },
  });
  out.values.compaction_exact_match = manager4.getCompactionReserveTokens(model);
  out.values.compaction_other_provider = manager4.getCompactionSettings({ provider: "other", id: model.id });
  out.values.compaction_other_id = manager4.getCompactionSettings({ provider: model.provider, id: "other" });
  out.values.compaction_case_id = manager4.getCompactionSettings({ provider: model.provider, id: "family/Model" });

  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () =>
    JSON.stringify({
      compaction: {
        reserveTokens: 8192,
        modelOverrides: {
          [modelKey]: { reserveTokens: 400000, keepRecentTokens: 30000 },
          "provider/other": { keepRecentTokens: 4096 },
        },
      },
    }),
  );
  storage.withLock("project", () =>
    JSON.stringify({
      compaction: { reserveTokens: 1024, modelOverrides: { [modelKey]: { keepRecentTokens: 2000 } } },
    }),
  );
  const manager5 = SettingsManager.fromStorage(storage);
  out.values.compaction_project_merge = manager5.getCompactionSettings(model);
  out.values.compaction_project_merge_other = manager5.getCompactionSettings({ provider: "provider", id: "other" });
  await manager5.reload();
  out.values.compaction_after_reload_keep = manager5.getCompactionKeepRecentTokens(model);
  manager5.setProjectTrusted(false);
  out.values.compaction_untrusted_keep = manager5.getCompactionKeepRecentTokens(model);

  const storage6 = new InMemorySettingsStorage();
  storage6.withLock("global", () =>
    JSON.stringify({
      compaction: { modelOverrides: { [modelKey]: { enabled: false, reserveTokens: 400000 } } },
    }),
  );
  const manager6 = SettingsManager.fromStorage(storage6);
  out.values.compaction_toggle_keeps_enabled = manager6.getCompactionSettings(model).enabled;
  manager6.setCompactionEnabled(false);
  await manager6.flush();
  await manager6.reload();
  out.values.compaction_after_toggle = manager6.getCompactionSettings(model);

  // Invalid-value battery (model override fields + ordinary fields + entries).
  const invalidValues = [null, -1, 1.5, "400000", true, {}, [], 9007199254740992];
  for (const field of ["reserveTokens", "keepRecentTokens"]) {
    for (const value of invalidValues) {
      const s = new InMemorySettingsStorage();
      s.withLock("global", () => JSON.stringify({
        compaction: { modelOverrides: { [modelKey]: { [field]: value } } },
      }));
      try {
        SettingsManager.fromStorage(s).getCompactionSettings(model);
        out.errors[`override_${field}_${JSON.stringify(value)}`] = null;
      } catch (error) {
        out.errors[`override_${field}_${JSON.stringify(value)}`] = error.message;
      }
      const s2 = new InMemorySettingsStorage();
      s2.withLock("global", () => JSON.stringify({
        compaction: { [field]: value, modelOverrides: { [modelKey]: { [field]: 4096 } } },
      }));
      try {
        SettingsManager.fromStorage(s2).getCompactionSettings(model);
        out.errors[`ordinary_${field}_${JSON.stringify(value)}`] = null;
      } catch (error) {
        out.errors[`ordinary_${field}_${JSON.stringify(value)}`] = error.message;
      }
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      const m = SettingsManager.inMemory();
      m.applyOverrides({ compaction: { modelOverrides: { [modelKey]: { [field]: value } } } });
      try {
        m.getCompactionSettings(model);
        out.errors[`runtime_override_${field}_${String(value)}`] = null;
      } catch (error) {
        out.errors[`runtime_override_${field}_${String(value)}`] = error.message;
      }
      const m2 = SettingsManager.inMemory();
      m2.applyOverrides({ compaction: { [field]: value } });
      try {
        m2.getCompactionSettings();
        out.errors[`runtime_ordinary_${field}_${String(value)}`] = null;
      } catch (error) {
        out.errors[`runtime_ordinary_${field}_${String(value)}`] = error.message;
      }
    }
  }
  for (const entry of [null, false, 42, "invalid", []]) {
    const s = new InMemorySettingsStorage();
    s.withLock("global", () => JSON.stringify({ compaction: { modelOverrides: { [modelKey]: entry } } }));
    try {
      SettingsManager.fromStorage(s).getCompactionSettings(model);
      out.errors[`entry_${JSON.stringify(entry)}`] = null;
    } catch (error) {
      out.errors[`entry_${JSON.stringify(entry)}`] = error.message;
    }
  }

  const manager7 = SettingsManager.inMemory({
    compaction: { reserveTokens: 0, keepRecentTokens: 0 },
  });
  out.values.compaction_zero = manager7.getCompactionSettings(model);
  manager7.applyOverrides({
    compaction: {
      reserveTokens: 1000,
      keepRecentTokens: 1000,
      modelOverrides: { [modelKey]: { reserveTokens: 0, keepRecentTokens: 0 } },
    },
  });
  out.values.compaction_zero_override = manager7.getCompactionSettings(model);
}

// ---- 16. misc getter battery on an empty manager --------------------------
{
  const manager = SettingsManager.inMemory();
  out.values.empty_battery = {
    last_changelog_version: manager.getLastChangelogVersion() ?? null,
    session_dir: manager.getSessionDir() ?? null,
    default_provider: manager.getDefaultProvider() ?? null,
    default_model: manager.getDefaultModel() ?? null,
    steering: manager.getSteeringMode(),
    follow_up: manager.getFollowUpMode(),
    theme: manager.getTheme() ?? null,
    theme_setting: manager.getThemeSetting() ?? null,
    transport: manager.getTransport(),
    compaction_enabled: manager.getCompactionEnabled(),
    compaction_reserve: manager.getCompactionReserveTokens(),
    compaction_keep: manager.getCompactionKeepRecentTokens(),
    branch_summary: manager.getBranchSummarySettings(),
    branch_summary_skip: manager.getBranchSummarySkipPrompt(),
    retry_enabled: manager.getRetryEnabled(),
    retry_settings: manager.getRetrySettings(),
    provider_retry: manager.getProviderRetrySettings(),
    http_idle: manager.getHttpIdleTimeoutMs(),
    websocket_connect: manager.getWebSocketConnectTimeoutMs() ?? null,
    hide_thinking_block: manager.getHideThinkingBlock(),
    show_cache_miss: manager.getShowCacheMissNotices(),
    quiet_startup: manager.getQuietStartup(),
    default_project_trust: manager.getDefaultProjectTrust(),
    shell_prefix: manager.getShellCommandPrefix() ?? null,
    npm_command: manager.getNpmCommand() ?? null,
    collapse_changelog: manager.getCollapseChangelog(),
    install_telemetry: manager.getEnableInstallTelemetry(),
    analytics: manager.getEnableAnalytics(),
    tracking_id: manager.getTrackingId() ?? null,
    packages: manager.getPackages(),
    extensions: manager.getExtensionPaths(),
    skills: manager.getSkillPaths(),
    prompts: manager.getPromptTemplatePaths(),
    themes: manager.getThemePaths(),
    skill_commands: manager.getEnableSkillCommands(),
    thinking_budgets: manager.getThinkingBudgets() ?? null,
    show_images: manager.getShowImages(),
    image_width_cells: manager.getImageWidthCells(),
    clear_on_shrink: manager.getClearOnShrink(),
    show_terminal_progress: manager.getShowTerminalProgress(),
    tui_mode: manager.getTuiMode(),
    fullscreen_exit: manager.getFullscreenExitOutput(),
    fullscreen_scrollbar: manager.getFullscreenScrollbar(),
    fullscreen_copy_on_select: manager.getFullscreenCopyOnSelect(),
    image_auto_resize: manager.getImageAutoResize(),
    block_images: manager.getBlockImages(),
    enabled_models: manager.getEnabledModels() ?? null,
    default_tools: manager.getDefaultTools() ?? null,
    double_escape: manager.getDoubleEscapeAction(),
    tree_filter: manager.getTreeFilterMode(),
    show_hardware_cursor: manager.getShowHardwareCursor(),
    editor_padding_x: manager.getEditorPaddingX(),
    output_pad: manager.getOutputPad(),
    autocomplete_max_visible: manager.getAutocompleteMaxVisible(),
    code_block_indent: manager.getCodeBlockIndent(),
    mermaid: manager.getMermaidRenderingMode(),
    warnings: manager.getWarnings(),
    model_thinking_levels: manager.getAllModelThinkingLevels(),
    model_thinking_level: manager.getModelThinkingLevel("p", "m") ?? null,
    terminal_overrides: manager.getTerminalCapabilityOverrides(),
  };

  // Analytics toggle generates a tracking id (format pinned, value random).
  manager.setEnableAnalytics(true);
  out.values.analytics_tracking_id_shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    manager.getTrackingId(),
  );
  out.values.analytics_enabled = manager.getEnableAnalytics();
}

// ---- 17. warnings + npmCommand write bytes --------------------------------
{
  rmSync(globalPath, { force: true });
  const manager = SettingsManager.create(projectDir, agentDir);
  manager.setWarnings({ anthropicExtraUsage: false });
  manager.setNpmCommand(["mise", "exec", "node@20", "--", "npm"]);
  await manager.flush();
  out.bytes.warnings_npm_write = bytes(globalPath);
}

rmSync(testDir, { recursive: true, force: true });

const target = new URL("./settings_manager.oracle.json", import.meta.url);
writeFileSync(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
console.log("wrote", String(target));
