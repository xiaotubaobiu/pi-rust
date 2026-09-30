// Oracle capture: upstream coding-agent src/core/resource-loader.ts (+ its
// real settings-manager / package-manager / extensions-loader dependencies)
// under node (type stripping). Sources under ./src are verbatim upstream
// copies except the documented oracle stubs:
//   - src/index.ts (empty barrel; extensions loader virtual-module value)
//   - src/utils/child-process.ts (scripted spawn seam from the pm oracle)
//   - src/core/output-guard.ts (isStdoutTakenOver => false)
//   - node_modules/{jiti,typebox,@earendil-works,cross-spawn,proper-lockfile}
//   - src/modes/interactive/theme/theme.ts (loadThemeFromPath subset)
// Pins resource-loader deterministic surfaces: context-file discovery order,
// skills/prompts/themes discovery + sourceInfo assignment, system-prompt and
// append-system-prompt discovery, dedupe/collision diagnostics, overrides,
// extendResources metadata plumbing, and extension load order/conflicts
// (through the jiti factory registry, which the Rust port mirrors with its
// ExtensionModuleLoader seam). Fixture roots are replaced by "<root>".
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const { DefaultResourceLoader, loadProjectContextFiles } = await import(
  new URL("./src/core/resource-loader.ts", import.meta.url)
);
const { SettingsManager } = await import(new URL("./src/core/settings-manager.ts", import.meta.url));
const { createSyntheticSourceInfo } = await import(new URL("./src/core/source-info.ts", import.meta.url));

const rootReal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-oracle-"));
const rootFwd = rootReal.replaceAll("\\", "/");
globalThis.__extFactoryRegistry = {};
globalThis.__pmSpawnLog = [];

const deepRel = (v) => {
  if (typeof v === "string") return v.split(rootReal).join("<root>").split(rootFwd).join("<root>").replaceAll("\\", "/");
  if (Array.isArray(v)) return v.map(deepRel);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, deepRel(val)]));
  return v;
};
// Path separators are normalized to "/" so captures are platform-neutral;
// the Rust tests apply the same normalization to their native paths.
const normalizeStrings = true;
const json = (v) => JSON.parse(JSON.stringify(v ?? null, (_k, val) => (val instanceof Map ? Object.fromEntries(val) : val)));

const out = { scenarios: [] };
const add = (name, observed) => out.scenarios.push({ name, observed: deepRel(observed) });
const write = (rel, content) => {
  const target = path.join(rootReal, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};
const mkdir = (rel) => fs.mkdirSync(path.join(rootReal, rel), { recursive: true });

let scenarioIndex = 0;
const freshDirs = () => {
  scenarioIndex += 1;
  const tag = `s${String(scenarioIndex).padStart(2, "0")}`;
  mkdir(`${tag}/agent`);
  mkdir(`${tag}/project`);
  return {
    tag,
    agentDir: path.join(rootReal, tag, "agent"),
    cwd: path.join(rootReal, tag, "project"),
  };
};

const themeJson = (name) => JSON.stringify({ name, colors: { text: "#000000", accent: "#00ff00" } });

const loaderSnapshot = (loader) => {
  const extensions = loader.getExtensions();
  const skills = loader.getSkills();
  const prompts = loader.getPrompts();
  const themes = loader.getThemes();
  return {
    extensions: {
      extensions: json(extensions.extensions.map((e) => ({
        path: e.path,
        hidden: e.hidden,
        commands: [...e.commands.keys()],
        tools: [...e.tools.keys()],
      }))),
      errors: json(extensions.errors),
    },
    skills: { skills: json(skills.skills), diagnostics: json(skills.diagnostics) },
    prompts: { prompts: json(prompts.prompts), diagnostics: json(prompts.diagnostics) },
    themes: {
      themes: json(themes.themes.map((t) => ({ name: t.name ?? null, sourcePath: t.sourcePath ?? null, sourceInfo: t.sourceInfo ?? null }))),
      diagnostics: json(themes.diagnostics),
    },
    agentsFiles: json(loader.getAgentsFiles().agentsFiles),
    systemPrompt: json(loader.getSystemPrompt() ?? null),
    systemPromptSource: json(loader.getSystemPromptSource() ?? null),
    appendSystemPrompt: json(loader.getAppendSystemPrompt()),
    appendSystemPromptSources: json(loader.getAppendSystemPromptSources()),
  };
};

// ===========================================================================
// 1. State before reload
// ===========================================================================
{
  const { agentDir, cwd } = freshDirs();
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  const snapshot = loaderSnapshot(loader);
  add("init:before-reload", {
    extensions: snapshot.extensions.extensions,
    skills: snapshot.skills.skills,
    prompts: snapshot.prompts.prompts,
    themes: snapshot.themes.themes,
  });
}

// ===========================================================================
// 2. Discovery from agentDir
// ===========================================================================
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/agent/skills/test-skill.md`, "---\nname: test-skill\ndescription: A test skill\n---\nSkill content here.");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  add("discover:skill-from-agent-dir", loaderSnapshot(loader).skills);
}
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/agent/skills/pi-skills/browser-tools/SKILL.md`, "---\nname: browser-tools\ndescription: Browser tools\n---\nSkill content here.");
  write(`${tag}/agent/skills/pi-skills/browser-tools/EFFICIENCY.md`, "No frontmatter here");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  add("discover:extra-md-ignored-in-skill-dir", loaderSnapshot(loader).skills);
}
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/agent/prompts/test-prompt.md`, "---\ndescription: A test prompt\n---\nPrompt content.");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  add("discover:prompt-from-agent-dir", loaderSnapshot(loader).prompts);
}

// ===========================================================================
// 3. Project resources win collisions
// ===========================================================================
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/agent/prompts/commit.md`, "User prompt");
  write(`${tag}/project/.pi/prompts/commit.md`, "Project prompt");
  write(`${tag}/agent/skills/collision-skill/SKILL.md`, "---\nname: collision-skill\ndescription: user\n---\nUser skill");
  write(`${tag}/project/.pi/skills/collision-skill/SKILL.md`, "---\nname: collision-skill\ndescription: project\n---\nProject skill");
  write(`${tag}/agent/themes/collision.json`, themeJson("collision-theme"));
  write(`${tag}/project/.pi/themes/collision.json`, themeJson("collision-theme"));
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("collision:project-wins", {
    prompts: snapshot.prompts,
    skills: snapshot.skills,
    themes: snapshot.themes,
  });
}

// ===========================================================================
// 4. Settings-disable overrides
// ===========================================================================
{
  const { tag, agentDir, cwd } = freshDirs();
  const settingsManager = SettingsManager.inMemory();
  settingsManager.setExtensionPaths(["-extensions/disabled.ts"]);
  settingsManager.setSkillPaths(["-skills/skip-skill"]);
  settingsManager.setPromptTemplatePaths(["-prompts/skip.md"]);
  settingsManager.setThemePaths(["-themes/skip.json"]);
  write(`${tag}/agent/extensions/disabled.ts`, "export default function() {}");
  write(`${tag}/agent/skills/skip-skill/SKILL.md`, "---\nname: skip-skill\ndescription: Skip me\n---\nContent");
  write(`${tag}/agent/prompts/skip.md`, "Skip prompt");
  write(`${tag}/agent/themes/skip.json`, "{}");
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();
  add("settings:disabled-entries", loaderSnapshot(loader));
}

// ===========================================================================
// 5. Context files
// ===========================================================================
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/project/AGENTS.md`, "# Project Guidelines\n\nBe helpful.");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  add("context:agents-md", loaderSnapshot(loader).agentsFiles);
}
{
  const { tag, agentDir } = freshDirs();
  mkdir(`${tag}/project/service`);
  write(`${tag}/agent/AGENTS.md`, "global instructions");
  write(`${tag}/agent/AGENTS.override.md`, "global override");
  write(`${tag}/project/AGENTS.md`, "project instructions");
  write(`${tag}/project/service/AGENTS.md`, "service instructions");
  write(`${tag}/project/service/AGENTS.override.md`, "service override");
  const loader = new DefaultResourceLoader({ cwd: path.join(rootReal, tag, "project", "service"), agentDir });
  await loader.reload();
  add("context:override-preference", loaderSnapshot(loader).agentsFiles);
}
{
  const { tag, agentDir, cwd } = freshDirs();
  mkdir(`${tag}/project/AGENTS.override.md`);
  mkdir(`${tag}/project/AGENTS.md`);
  write(`${tag}/project/CLAUDE.md`, "Fallback instructions");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  add("context:directory-candidates-ignored", loaderSnapshot(loader).agentsFiles);
}
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/project/AGENTS.override.md`, "# Override Guidelines\n\nBe helpful.");
  write(`${tag}/project/AGENTS.md`, "# Project Guidelines\n\nBe helpful.");
  write(`${tag}/project/CLAUDE.md`, "# Claude Guidelines\n\nBe helpful.");
  const loader = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
  await loader.reload();
  add("context:no-context-files", loaderSnapshot(loader).agentsFiles);
}

// ===========================================================================
// 6. System prompts
// ===========================================================================
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/project/.pi/SYSTEM.md`, "You are a helpful assistant.");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("system:project-md", { systemPrompt: snapshot.systemPrompt, systemPromptSource: snapshot.systemPromptSource });
}
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/agent/SYSTEM.md`, "Global system prompt.");
  write(`${tag}/project/.pi/SYSTEM.md`, "Project system prompt.");
  write(`${tag}/agent/AGENTS.md`, "Global instructions");
  write(`${tag}/project/AGENTS.md`, "Project instructions");
  write(`${tag}/project/.pi/extensions/project.ts`, 'throw new Error("should not load");');
  write(`${tag}/project/.pi/skills/project-skill/SKILL.md`, "---\nname: project-skill\ndescription: Project skill\n---\nProject skill content");
  write(`${tag}/project/.pi/prompts/project.md`, "Project prompt");
  write(`${tag}/project/.pi/themes/project.json`, themeJson("project-theme"));
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();
  add("system:untrusted-project", loaderSnapshot(loader));
}
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/project/.pi/APPEND_SYSTEM.md`, "Additional instructions.");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("system:append-md", { appendSystemPrompt: snapshot.appendSystemPrompt, appendSystemPromptSources: snapshot.appendSystemPromptSources });
}
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/project/.pi/SYSTEM.md`, "Project system prompt.");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("system:source-project", { systemPrompt: snapshot.systemPrompt, systemPromptSource: snapshot.systemPromptSource });
}
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/agent/SYSTEM.md`, "Global system prompt.");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("system:source-global", { systemPrompt: snapshot.systemPrompt, systemPromptSource: snapshot.systemPromptSource });
}
{
  const { agentDir, cwd } = freshDirs();
  const loader = new DefaultResourceLoader({ cwd, agentDir, systemPrompt: "Literal system prompt." });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("system:source-literal", { systemPrompt: snapshot.systemPrompt, systemPromptSource: snapshot.systemPromptSource });
}
{
  const { tag, agentDir, cwd } = freshDirs();
  const systemPromptPath = path.join(rootReal, tag, "custom-system.md");
  write(`${tag}/custom-system.md`, "Custom system prompt.");
  const loader = new DefaultResourceLoader({ cwd, agentDir, systemPrompt: systemPromptPath });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("system:source-file-option", { systemPrompt: snapshot.systemPrompt, systemPromptSource: snapshot.systemPromptSource });
}
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/project/.pi/APPEND_SYSTEM.md`, "Project append prompt.");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("system:append-source", { appendSystemPrompt: snapshot.appendSystemPrompt, appendSystemPromptSources: snapshot.appendSystemPromptSources });
}
{
  const { agentDir, cwd } = freshDirs();
  const loader = new DefaultResourceLoader({ cwd, agentDir, appendSystemPrompt: ["Literal append prompt."] });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("system:append-source-literal", { appendSystemPrompt: snapshot.appendSystemPrompt, appendSystemPromptSources: snapshot.appendSystemPromptSources });
}
{
  const { tag, agentDir, cwd } = freshDirs();
  const appendSystemPromptPath = path.join(rootReal, tag, "custom-append.md");
  write(`${tag}/custom-append.md`, "Custom append prompt.");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    appendSystemPrompt: [appendSystemPromptPath, "Literal append prompt."],
  });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("system:append-source-mixed", { appendSystemPrompt: snapshot.appendSystemPrompt, appendSystemPromptSources: snapshot.appendSystemPromptSources });
}

// ===========================================================================
// 7. extendResources
// ===========================================================================
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/extra-skills/extra-skill/SKILL.md`, "---\nname: extra-skill\ndescription: Extra skill\n---\nExtra content");
  write(`${tag}/extra-prompts/extra.md`, "---\ndescription: Extra prompt\n---\nExtra prompt content");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const skillDir = path.join(rootReal, tag, "extra-skills", "extra-skill");
  const promptDir = path.join(rootReal, tag, "extra-prompts");
  loader.extendResources({
    skillPaths: [{ path: skillDir, metadata: { source: "extension:extra", scope: "temporary", origin: "top-level", baseDir: skillDir } }],
    promptPaths: [{ path: promptDir, metadata: { source: "extension:extra", scope: "temporary", origin: "top-level", baseDir: promptDir } }],
  });
  const snapshot = loaderSnapshot(loader);
  add("extend:metadata", { skills: snapshot.skills, prompts: snapshot.prompts });
}
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/extra skills/file-url-skill/SKILL.md`, "---\nname: file-url-skill\ndescription: File URL skill\n---\nExtra content");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const skillDir = path.join(rootReal, tag, "extra skills", "file-url-skill");
  loader.extendResources({
    skillPaths: [{ path: pathToFileURL(skillDir).href, metadata: { source: "extension:file-url", scope: "temporary", origin: "top-level", baseDir: skillDir } }],
  });
  const snapshot = loaderSnapshot(loader);
  add("extend:file-url", { skills: snapshot.skills });
}
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/agent/npm/node_modules/metadata-pkg/package.json`, JSON.stringify({ name: "metadata-pkg", version: "1.0.0" }));
  write(`${tag}/agent/npm/node_modules/metadata-pkg/skills/package-skill/SKILL.md`, "---\nname: package-skill\ndescription: Package skill\n---\nPackage skill content");
  write(`${tag}/agent/npm/node_modules/metadata-pkg/prompts/package-prompt.md`, "---\ndescription: Package prompt\n---\nPackage prompt content");
  write(`${tag}/agent/npm/node_modules/metadata-pkg/themes/package-theme.json`, themeJson("package-theme"));
  write(`${tag}/extension-resources/extension-skill/SKILL.md`, "---\nname: extension-skill\ndescription: Extension skill\n---\nExtension skill content");
  write(`${tag}/extension-resources/prompts/extension-prompt.md`, "---\ndescription: Extension prompt\n---\nExtension prompt content");
  write(`${tag}/extension-resources/themes/extension.json`, themeJson("extension-theme"));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({ packages: ["npm:metadata-pkg"] }),
  });
  await loader.reload();
  const extensionMetadata = { source: "extension:discovery", scope: "temporary", origin: "top-level" };
  loader.extendResources({
    skillPaths: [{ path: path.join(rootReal, tag, "extension-resources", "extension-skill"), metadata: extensionMetadata }],
    promptPaths: [{ path: path.join(rootReal, tag, "extension-resources", "prompts"), metadata: extensionMetadata }],
    themePaths: [{ path: path.join(rootReal, tag, "extension-resources", "themes"), metadata: extensionMetadata }],
  });
  const snapshot = loaderSnapshot(loader);
  add("extend:package-metadata", {
    skills: snapshot.skills,
    prompts: snapshot.prompts,
    themes: snapshot.themes,
    spawns: globalThis.__pmSpawnLog,
  });
}

// ===========================================================================
// 8. noSkills
// ===========================================================================
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/agent/skills/test-skill.md`, "---\nname: test-skill\ndescription: A test skill\n---\nContent");
  const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
  await loader.reload();
  add("noskills:skip-discovery", loaderSnapshot(loader).skills);
}
{
  const { tag, agentDir, cwd } = freshDirs();
  write(`${tag}/custom-skills/custom.md`, "---\nname: custom\ndescription: Custom skill\n---\nContent");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noSkills: true,
    additionalSkillPaths: [path.join(rootReal, tag, "custom-skills")],
  });
  await loader.reload();
  add("noskills:additional-paths", loaderSnapshot(loader).skills);
}

// ===========================================================================
// 9. Override functions
// ===========================================================================
{
  const { agentDir, cwd } = freshDirs();
  const injectedSkill = {
    name: "injected",
    description: "Injected skill",
    filePath: "/fake/path",
    baseDir: "/fake",
    sourceInfo: createSyntheticSourceInfo("/fake/path", { source: "custom" }),
    disableModelInvocation: false,
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    skillsOverride: () => ({ skills: [injectedSkill], diagnostics: [] }),
  });
  await loader.reload();
  add("override:skills", loaderSnapshot(loader).skills);
}
{
  const { agentDir, cwd } = freshDirs();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPromptOverride: () => "Custom system prompt",
  });
  await loader.reload();
  add("override:system-prompt", { systemPrompt: loader.getSystemPrompt() });
}

// ===========================================================================
// 10. Extensions (through the jiti factory registry seam)
// ===========================================================================
{
  const { tag, agentDir, cwd } = freshDirs();
  const sharedDir = path.join(rootReal, tag, "shared-extensions");
  write(`${tag}/shared-extensions/shared.ts`, 'export default function(pi) { pi.registerCommand("shared", { description: "shared command", handler: async () => {} }); }');
  const sharedFactory = (pi) => {
    pi.registerCommand("shared", { description: "shared command", handler: async () => {} });
  };
  globalThis.__extFactoryRegistry[path.join(sharedDir, "shared.ts")] = sharedFactory;
  globalThis.__extFactoryRegistry[path.join(agentDir, "extensions", "shared.ts")] = sharedFactory;
  globalThis.__extFactoryRegistry[path.join(cwd, ".pi", "extensions", "shared.ts")] = sharedFactory;
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.symlinkSync(sharedDir, path.join(agentDir, "extensions"), "dir");
  fs.symlinkSync(sharedDir, path.join(cwd, ".pi", "extensions"), "dir");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("extensions:symlink-loaded-once", snapshot.extensions);
}
{
  const { tag, agentDir, cwd } = freshDirs();
  const userTs = path.join(agentDir, "extensions", "user.ts");
  const projectTs = path.join(cwd, ".pi", "extensions", "project.ts");
  write(`${tag}/agent/extensions/user.ts`, "export default function(pi) {}");
  write(`${tag}/project/.pi/extensions/project.ts`, "export default function(pi) {}");
  const counters = { user: 0, project: 0 };
  const wrap = (fn, key) => (pi) => {
    counters[key] += 1;
    return fn(pi);
  };
  globalThis.__extFactoryRegistry[userTs] = wrap((pi) => {
    pi.on("project_trust", () => ({ trusted: "yes" }));
    pi.registerCommand("user-trust", { description: "user trust", handler: async () => {} });
  }, "user");
  globalThis.__extFactoryRegistry[projectTs] = wrap((pi) => {
    pi.registerCommand("project-trusted", { description: "project trusted", handler: async () => {} });
  }, "project");
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  const preTrustPaths = [];
  await loader.reload({
    resolveProjectTrust: async ({ extensionsResult }) => {
      preTrustPaths.push(...extensionsResult.extensions.map((extension) => extension.path));
      return true;
    },
  });
  const snapshot = loaderSnapshot(loader);
  add("extensions:trust-preload", {
    preTrustPaths,
    final: snapshot.extensions,
    factoryCalls: counters,
  });
}
{
  const { tag, agentDir, cwd } = freshDirs();
  const userTs = path.join(agentDir, "extensions", "user.ts");
  const projectTs = path.join(cwd, ".pi", "extensions", "project.ts");
  write(`${tag}/agent/extensions/user.ts`, "export default function(pi) {}");
  write(`${tag}/project/.pi/extensions/project.ts`, "export default function(pi) {}");
  globalThis.__extFactoryRegistry[projectTs] = (pi) => {
    pi.registerCommand("deploy", { description: "project deploy", handler: async () => {} });
    pi.registerCommand("project-only", { description: "project only", handler: async () => {} });
  };
  globalThis.__extFactoryRegistry[userTs] = (pi) => {
    pi.registerCommand("deploy", { description: "user deploy", handler: async () => {} });
    pi.registerCommand("user-only", { description: "user only", handler: async () => {} });
  };
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("extensions:command-collision", snapshot.extensions);
}
{
  const { tag, agentDir, cwd } = freshDirs();
  const ext1 = path.join(agentDir, "extensions", "ext1", "index.ts");
  const ext2 = path.join(agentDir, "extensions", "ext2", "index.ts");
  write(`${tag}/agent/extensions/ext1/index.ts`, "export default function(pi) {}");
  write(`${tag}/agent/extensions/ext2/index.ts`, "export default function(pi) {}");
  globalThis.__extFactoryRegistry[ext1] = (pi) => {
    pi.registerTool({ name: "duplicate-tool", description: "First", parameters: {}, execute: async () => ({ result: "1" }) });
  };
  globalThis.__extFactoryRegistry[ext2] = (pi) => {
    pi.registerTool({ name: "duplicate-tool", description: "Second", parameters: {}, execute: async () => ({ result: "2" }) });
  };
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("extensions:tool-conflict", snapshot.extensions);
}
{
  const { tag, agentDir, cwd } = freshDirs();
  const globalTs = path.join(agentDir, "extensions", "global.ts");
  const explicitExtPath = path.join(rootReal, tag, "explicit-extension.ts");
  write(`${tag}/agent/extensions/global.ts`, "export default function(pi) {}");
  write(`${tag}/explicit-extension.ts`, "export default function(pi) {}");
  globalThis.__extFactoryRegistry[globalTs] = (pi) => {
    pi.registerTool({ name: "duplicate-tool", description: "global tool", parameters: {}, execute: async () => ({ result: "global" }) });
    pi.registerCommand("deploy", { description: "global command", handler: async () => {} });
  };
  globalThis.__extFactoryRegistry[explicitExtPath] = (pi) => {
    pi.registerTool({ name: "duplicate-tool", description: "explicit tool", parameters: {}, execute: async () => ({ result: "explicit" }) });
    pi.registerCommand("deploy", { description: "explicit command", handler: async () => {} });
  };
  const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [explicitExtPath] });
  await loader.reload();
  const snapshot = loaderSnapshot(loader);
  add("extensions:cli-preference", snapshot.extensions);
}

// ===========================================================================
// 11. loadProjectContextFiles — nested worktree dedup
// ===========================================================================
const linkWorktree = (mainDir, worktreeDir, name) => {
  const gitDir = path.join(mainDir, ".git", "worktrees", name);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(mainDir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feat\n");
  fs.writeFileSync(path.join(gitDir, "commondir"), "../..");
  fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
};
const ctxAgentDir = path.join(rootReal, "ctx-agent");
fs.mkdirSync(ctxAgentDir, { recursive: true });
{
  const base = path.join(rootReal, "wt1");
  const main = path.join(base, "main");
  const worktree = path.join(main, "worktrees", "feat");
  const worktreeSrc = path.join(worktree, "src");
  fs.mkdirSync(worktreeSrc, { recursive: true });
  linkWorktree(main, worktree, "feat");
  fs.writeFileSync(path.join(main, "AGENTS.md"), "main repo instructions");
  fs.writeFileSync(path.join(worktree, "AGENTS.md"), "worktree instructions");
  add("ctx:worktree-skip-main-duplicate", loadProjectContextFiles({ cwd: worktreeSrc, agentDir: ctxAgentDir }));
}
{
  const base = path.join(rootReal, "wt2");
  const main = path.join(base, "main");
  const worktree = path.join(main, "worktrees", "feat");
  const worktreeSrc = path.join(worktree, "src");
  fs.mkdirSync(worktreeSrc, { recursive: true });
  linkWorktree(main, worktree, "feat");
  fs.writeFileSync(path.join(main, "AGENTS.md"), "main repo instructions");
  add("ctx:worktree-inherit", loadProjectContextFiles({ cwd: worktreeSrc, agentDir: ctxAgentDir }));
}
{
  const base = path.join(rootReal, "wt3");
  const main = path.join(base, "main");
  const worktree = path.join(main, "worktrees", "feat");
  const worktreeSrc = path.join(worktree, "src");
  fs.mkdirSync(worktreeSrc, { recursive: true });
  linkWorktree(main, worktree, "feat");
  fs.writeFileSync(path.join(main, "CLAUDE.md"), "main repo instructions");
  fs.writeFileSync(path.join(worktree, "AGENTS.md"), "worktree instructions");
  add("ctx:worktree-different-filename", loadProjectContextFiles({ cwd: worktreeSrc, agentDir: ctxAgentDir }));
}
{
  const proj = path.join(rootReal, "wt4", "proj");
  const bare = path.join(proj, ".bare");
  const worktree = path.join(proj, "main");
  const worktreeGitDir = path.join(bare, "worktrees", "main");
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..");
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
  fs.writeFileSync(path.join(proj, "AGENTS.md"), "container instructions");
  fs.writeFileSync(path.join(worktree, "AGENTS.md"), "worktree instructions");
  add("ctx:bare-layout", loadProjectContextFiles({ cwd: worktree, agentDir: ctxAgentDir }));
}
{
  const base = path.join(rootReal, "wt5");
  const main = path.join(base, "main");
  const worktree = path.join(main, "worktrees", "feat");
  const worktreeSrc = path.join(worktree, "src");
  fs.mkdirSync(worktreeSrc, { recursive: true });
  linkWorktree(main, worktree, "feat");
  fs.writeFileSync(path.join(base, "AGENTS.md"), "outer instructions");
  fs.writeFileSync(path.join(main, "AGENTS.md"), "main repo instructions");
  fs.writeFileSync(path.join(worktree, "AGENTS.md"), "worktree instructions");
  add("ctx:ancestors-above-main", loadProjectContextFiles({ cwd: worktreeSrc, agentDir: ctxAgentDir }));
}
{
  const base = path.join(rootReal, "wt6");
  const main = path.join(base, "main");
  const sib = path.join(base, "sib-feat");
  const sibSrc = path.join(sib, "src");
  fs.mkdirSync(sibSrc, { recursive: true });
  fs.mkdirSync(main, { recursive: true });
  fs.writeFileSync(path.join(base, "AGENTS.md"), "outer instructions");
  fs.writeFileSync(path.join(sib, "AGENTS.md"), "sibling worktree instructions");
  linkWorktree(main, sib, "sib");
  add("ctx:sibling-worktree", loadProjectContextFiles({ cwd: sibSrc, agentDir: ctxAgentDir }));
}
{
  const sup = path.join(rootReal, "wt7", "super");
  const sub = path.join(sup, "vendor", "lib");
  const subSrc = path.join(sub, "src");
  fs.mkdirSync(subSrc, { recursive: true });
  fs.writeFileSync(path.join(sup, "AGENTS.md"), "superproject instructions");
  fs.writeFileSync(path.join(sub, "AGENTS.md"), "submodule instructions");
  const subGitDir = path.join(sup, ".git", "modules", "vendor", "lib");
  fs.mkdirSync(subGitDir, { recursive: true });
  fs.writeFileSync(path.join(subGitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(sub, ".git"), `gitdir: ${subGitDir}\n`);
  add("ctx:submodule", loadProjectContextFiles({ cwd: subSrc, agentDir: ctxAgentDir }));
}
{
  const base = path.join(rootReal, "wt8");
  const repo = path.join(base, "repo");
  const leaf = path.join(repo, "src");
  fs.mkdirSync(leaf, { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(base, "AGENTS.md"), "outer instructions");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "repo instructions");
  fs.writeFileSync(path.join(leaf, "AGENTS.md"), "leaf instructions");
  add("ctx:ordinary-repo", loadProjectContextFiles({ cwd: leaf, agentDir: ctxAgentDir }));
}
{
  const repo = path.join(rootReal, "wt9", "corrupt");
  const src = path.join(repo, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(repo, ".git"), "gitdir: /nonexistent/path/worktrees/feat\n");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "repo instructions");
  fs.writeFileSync(path.join(src, "AGENTS.md"), "src instructions");
  add("ctx:missing-gitdir-target", loadProjectContextFiles({ cwd: src, agentDir: ctxAgentDir }));
}

fs.rmSync(rootReal, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out, null, 2));
