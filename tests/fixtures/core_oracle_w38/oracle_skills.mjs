// Oracle capture: upstream coding-agent src/core/skills.ts under node
// (type stripping). Sources are verbatim upstream copies (see ./src); the
// `ignore` npm package is vendored under ./node_modules. Pins:
// - loadSkillsFromDir results over the upstream test fixtures (skill records
//   with insertion-order, warning/collision diagnostics with exact texts),
// - loadSkills path resolution / defaults / collision handling,
// - formatSkillsForPrompt exact bytes (XML escaping, intro lines, read/bash
//   variants, disableModelInvocation filtering),
// - ignore-file (.gitignore) scoped-rule handling.
// Fixture roots are replaced by "<fixtures>" and temp roots by "<root>" so
// captures are machine-independent.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const { loadSkills, loadSkillsFromDir, formatSkillsForPrompt } = await import(
  new URL("./src/core/skills.ts", import.meta.url)
);
const { createSyntheticSourceInfo } = await import(new URL("./src/core/source-info.ts", import.meta.url));

const upstreamFixtures = "C:/Users/13063/Desktop/code/agent work/pi/packages/coding-agent/test/fixtures";
const fixturesReal = path.resolve(upstreamFixtures);
const skillsReal = path.join(fixturesReal, "skills");
const collisionReal = path.join(fixturesReal, "skills-collision");
const rootReal = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-oracle-"));
const rootFwd = rootReal.replaceAll("\\", "/");
const fixturesFwd = fixturesReal.replaceAll("\\", "/");

const deepRel = (v) => {
  if (typeof v === "string")
    return v.split(rootReal).join("<root>").split(rootFwd).join("<root>")
            .split(fixturesReal).join("<fixtures>").split(fixturesFwd).join("<fixtures>").replaceAll("\\", "/");
  if (Array.isArray(v)) return v.map(deepRel);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, deepRel(val)]));
  return v;
};
// Path separators are normalized to "/" so captures are platform-neutral;
// the Rust tests apply the same normalization to their native paths.
const normalizeStrings = true;
const json = (v) => JSON.parse(JSON.stringify(v ?? null));

const out = { scenarios: [] };
const add = (name, observed) => out.scenarios.push({ name, observed: deepRel(observed) });
const write = (rel, content) => {
  const target = path.join(rootReal, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

const skillNames = (result) => result.skills.map((s) => s.name);

// ---- 1. loadSkillsFromDir over the upstream test fixtures ------------------
const fixtureDirs = fs.readdirSync(skillsReal, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
for (const dir of fixtureDirs) {
  const result = loadSkillsFromDir({ dir: path.join(skillsReal, dir), source: "test" });
  add(`from_dir:${dir}`, { skills: json(result.skills), diagnostics: json(result.diagnostics) });
}
{
  const result = loadSkillsFromDir({ dir: skillsReal, source: "test" });
  add("from_dir:whole-fixtures-tree", { names: skillNames(result), diagnostics: json(result.diagnostics) });
}
{
  const result = loadSkillsFromDir({ dir: "/non/existent/path", source: "test" });
  add("from_dir:non-existent", { skills: json(result.skills), diagnostics: json(result.diagnostics) });
}

// ---- 2. loadSkillsFromDir over the collision fixtures ----------------------
{
  const first = loadSkillsFromDir({ dir: path.join(collisionReal, "first"), source: "first" });
  const second = loadSkillsFromDir({ dir: path.join(collisionReal, "second"), source: "second" });
  add("collision:from_dirs", { first: json(first), second: json(second) });
}

// ---- 3. loadSkills with explicit paths -------------------------------------
{
  const emptyAgent = path.join(rootReal, "empty-agent");
  const emptyCwd = path.join(rootReal, "empty-cwd");
  fs.mkdirSync(emptyAgent, { recursive: true });
  fs.mkdirSync(emptyCwd, { recursive: true });

  const explicit = loadSkills({
    agentDir: emptyAgent,
    cwd: emptyCwd,
    skillPaths: [path.join(skillsReal, "valid-skill")],
    includeDefaults: true,
  });
  add("load:explicit-path", { skills: json(explicit.skills), diagnostics: json(explicit.diagnostics) });

  const missing = loadSkills({
    agentDir: emptyAgent,
    cwd: emptyCwd,
    skillPaths: ["/non/existent/path"],
    includeDefaults: true,
  });
  add("load:missing-path", { skills: json(missing.skills), diagnostics: json(missing.diagnostics) });

  const file = loadSkills({
    agentDir: emptyAgent,
    cwd: emptyCwd,
    skillPaths: [path.join(skillsReal, "valid-skill", "SKILL.md")],
    includeDefaults: false,
  });
  add("load:explicit-md-file", { skills: json(file.skills), diagnostics: json(file.diagnostics) });

  const notMd = path.join(rootReal, "not-md", "notes.txt");
  fs.mkdirSync(path.dirname(notMd), { recursive: true });
  fs.writeFileSync(notMd, "not a skill");
  const nonMd = loadSkills({
    agentDir: emptyAgent,
    cwd: emptyCwd,
    skillPaths: [notMd],
    includeDefaults: false,
  });
  add("load:non-markdown-path", { skills: json(nonMd.skills), diagnostics: json(nonMd.diagnostics) });

  const rel = loadSkills({
    agentDir: emptyAgent,
    cwd: emptyCwd,
    skillPaths: [" ./rel-skills "],
    includeDefaults: false,
  });
  add("load:relative-trimmed-missing", { skills: json(rel.skills), diagnostics: json(rel.diagnostics) });
}

// ---- 4. loadSkills defaults: user/project trees and collisions -------------
{
  const agentDir = path.join(rootReal, "agent");
  const cwd = path.join(rootReal, "project");
  write("agent/skills/user-only/SKILL.md", "---\nname: user-only\ndescription: User only.\n---\nbody\n");
  write("agent/skills/dupe/SKILL.md", "---\nname: dupe\ndescription: User version.\n---\nbody\n");
  write("project/.pi/skills/dupe/SKILL.md", "---\nname: dupe\ndescription: Project version.\n---\nbody\n");
  write("project/.pi/skills/project-only/SKILL.md", "---\nname: project-only\ndescription: Project only.\n---\nbody\n");

  const withDefaults = loadSkills({ agentDir, cwd, skillPaths: [], includeDefaults: true });
  add("load:defaults-user-project", { skills: json(withDefaults.skills), diagnostics: json(withDefaults.diagnostics) });

  const noDefaults = loadSkills({ agentDir, cwd, skillPaths: [], includeDefaults: false });
  add("load:no-defaults", { skills: json(noDefaults.skills), diagnostics: json(noDefaults.diagnostics) });

  // Explicit path inside the user skills dir with defaults off → "user" source.
  const userScoped = loadSkills({
    agentDir,
    cwd,
    skillPaths: [path.join(agentDir, "skills", "user-only")],
    includeDefaults: false,
  });
  add("load:path-under-user-dir", { skills: json(userScoped.skills), diagnostics: json(userScoped.diagnostics) });

  const projectScoped = loadSkills({
    agentDir,
    cwd,
    skillPaths: [path.join(cwd, ".pi", "skills", "project-only")],
    includeDefaults: false,
  });
  add("load:path-under-project-dir", { skills: json(projectScoped.skills), diagnostics: json(projectScoped.diagnostics) });
}

// ---- 5. collision ordering across two explicit paths -----------------------
{
  const emptyAgent = path.join(rootReal, "empty-agent");
  const emptyCwd = path.join(rootReal, "empty-cwd");
  const colliding = loadSkills({
    agentDir: emptyAgent,
    cwd: emptyCwd,
    skillPaths: [
      path.join(collisionReal, "first"),
      path.join(collisionReal, "second"),
    ],
    includeDefaults: false,
  });
  add("load:collision-two-paths", { skills: json(colliding.skills), diagnostics: json(colliding.diagnostics) });

  // Symlink alias of an already-loaded file is skipped silently.
  const alias = path.join(rootReal, "alias-skill");
  try {
    fs.symlinkSync(path.join(collisionReal, "first"), alias, "dir");
    const aliasResult = loadSkills({
      agentDir: emptyAgent,
      cwd: emptyCwd,
      skillPaths: [
        path.join(collisionReal, "first"),
        alias,
      ],
      includeDefaults: false,
    });
    add("load:symlink-alias-skip", { skills: json(aliasResult.skills), diagnostics: json(aliasResult.diagnostics) });
  } catch {
    // symlink unavailable (no privilege) — scenario omitted.
  }
}

// ---- 6. ignore files --------------------------------------------------------
{
  const agentDir = path.join(rootReal, "ignore-agent");
  const cwd = path.join(rootReal, "ignore-cwd");
  write("ignore-agent/skills/.gitignore", "skipped/\n# comment line\nsecret.md\n");
  write("ignore-agent/skills/kept/SKILL.md", "---\nname: kept\ndescription: Kept.\n---\nbody\n");
  write("ignore-agent/skills/skipped/dropped/SKILL.md", "---\nname: dropped\ndescription: Dropped.\n---\nbody\n");
  write("ignore-agent/skills/secret.md", "---\nname: secret\ndescription: Secret.\n---\nbody\n");
  write("ignore-agent/skills/nested/.gitignore", "inner-hidden/\n");
  write("ignore-agent/skills/nested/inner-hidden/deep/SKILL.md", "---\nname: deep\ndescription: Deep hidden.\n---\nbody\n");
  write("ignore-agent/skills/nested/inner-kept/SKILL.md", "---\nname: inner-kept\ndescription: Inner kept.\n---\nbody\n");

  const result = loadSkills({ agentDir, cwd, skillPaths: [], includeDefaults: true });
  add("ignore:gitignore-rules", { skills: json(result.skills), diagnostics: json(result.diagnostics) });
}

// ---- 7. formatSkillsForPrompt ------------------------------------------------
const makeSkill = (options) => ({
  name: options.name,
  description: options.description,
  filePath: options.filePath,
  baseDir: options.baseDir,
  sourceInfo: createSyntheticSourceInfo(options.filePath, { source: options.source ?? "test" }),
  disableModelInvocation: options.disableModelInvocation ?? false,
});
{
  add("format:empty", { text: formatSkillsForPrompt([]) });
  add("format:single", {
    text: formatSkillsForPrompt([
      makeSkill({
        name: "test-skill",
        description: "A test skill.",
        filePath: "/path/to/skill/SKILL.md",
        baseDir: "/path/to/skill",
      }),
    ]),
  });
  add("format:escaping", {
    text: formatSkillsForPrompt([
      makeSkill({
        name: "test-skill",
        description: 'A skill with <special> & "characters".',
        filePath: "/path/to/skill/SKILL.md",
        baseDir: "/path/to/skill",
      }),
    ]),
  });
  add("format:multiple", {
    text: formatSkillsForPrompt([
      makeSkill({ name: "skill-one", description: "First skill.", filePath: "/path/one/SKILL.md", baseDir: "/path/one" }),
      makeSkill({ name: "skill-two", description: "Second skill.", filePath: "/path/two/SKILL.md", baseDir: "/path/two" }),
    ]),
  });
  add("format:disable-model-invocation", {
    text: formatSkillsForPrompt([
      makeSkill({ name: "visible-skill", description: "A visible skill.", filePath: "/path/visible/SKILL.md", baseDir: "/path/visible" }),
      makeSkill({ name: "hidden-skill", description: "A hidden skill.", filePath: "/path/hidden/SKILL.md", baseDir: "/path/hidden", disableModelInvocation: true }),
    ]),
  });
  add("format:all-hidden", {
    text: formatSkillsForPrompt([
      makeSkill({ name: "hidden-skill", description: "A hidden skill.", filePath: "/path/hidden/SKILL.md", baseDir: "/path/hidden", disableModelInvocation: true }),
    ]),
  });
  add("format:bash-tool", {
    text: formatSkillsForPrompt([
      makeSkill({ name: "bash-skill", description: "Loaded via bash.", filePath: "/path/bash/SKILL.md", baseDir: "/path/bash" }),
    ], "bash"),
  });
}

fs.rmSync(rootReal, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out, null, 2));
