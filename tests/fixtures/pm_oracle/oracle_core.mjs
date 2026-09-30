// Oracle capture for the coding-agent package-manager slice (M5 W3.9).
//
// Drives the byte-identical upstream sources in ./src under node (type
// stripping) with:
//   - real npm `semver` 7.8.5, `minimatch` 10.2.6, `ignore` 7.0.8,
//     `hosted-git-info` 9.0.3 (pinned to the upstream package.json versions)
//   - every spawn routed through the scriptable child-process stub
//     (src/utils/child-process.ts)
//   - an in-memory SettingsManager stub (used surface only)
// and writes core.oracle.json with all temp paths normalized to "$T".
//
// Usage: node --experimental-strip-types oracle_core.mjs

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { minimatch } from "minimatch";
import { gt, maxSatisfying, rcompare, satisfies, valid, validRange } from "semver";
import ignoreFactory from "ignore";

const { DefaultPackageManager } = await import(new URL("./src/core/package-manager.ts", import.meta.url));
const { SettingsManager } = await import(new URL("./src/core/settings-manager.ts", import.meta.url));

const root = mkdtempSync(join(tmpdir(), "pm-oracle-"));
const previousHome = process.env.HOME;

function norm(value) {
	if (typeof value === "string") return value.split(root).join("$T");
	if (Array.isArray(value)) return value.map(norm);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = norm(v);
		return out;
	}
	return value;
}

const results = {};
const posix = (p) => p.split("\\").join("/");
const relTo = (dir, p) => (p === undefined ? undefined : posix(relative(dir, p)));
let spawnLog = [];

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------

function resetSpawn() {
	spawnLog = [];
	globalThis.__pmSpawnLog = spawnLog;
	globalThis.__pmSpawnScript = undefined;
}

function script(fn) {
	globalThis.__pmSpawnScript = fn;
}

const JS = `export default function() {}`;
const SKILL = (name) => `---\nname: ${name}\ndescription: ${name}\n---\nContent`;

function makeCtx(dir) {
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	return {
		dir,
		agentDir,
		write(p, c) {
			const full = join(dir, p);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, c);
		},
		mkdir(p) {
			mkdirSync(join(dir, p), { recursive: true });
		},
		link(target, linkPath) {
			mkdirSync(join(dir, linkPath, ".."), { recursive: true });
			symlinkSync(join(dir, target), join(dir, linkPath), "junction");
		},
		sm(settings = {}) {
			return SettingsManager.inMemory(structuredClone(settings));
		},
		pm(settingsManager, opts = {}) {
			return new DefaultPackageManager({
				cwd: opts.cwd ?? dir,
				agentDir: opts.agentDir ?? agentDir,
				settingsManager,
			});
		},
	};
}

// Render ResolvedPaths with scenario-relative paths.
function render(resolved, dir) {
	const renderList = (entries) =>
		entries.map((e) => ({
			rel: relTo(dir, e.path),
			enabled: e.enabled,
			metadata: {
				source: e.metadata.source,
				scope: e.metadata.scope,
				origin: e.metadata.origin,
				baseDir: e.metadata.baseDir === undefined ? undefined : relTo(dir, e.metadata.baseDir),
			},
		}));
	return {
		extensions: renderList(resolved.extensions),
		skills: renderList(resolved.skills),
		prompts: renderList(resolved.prompts),
		themes: renderList(resolved.themes),
	};
}

async function scenario(name, fn) {
	const dir = join(root, name.replace(/[^a-zA-Z0-9-]+/g, "-"));
	resetSpawn();
	mkdirSync(dir, { recursive: true });
	process.env.HOME = dir;
	const ctx = makeCtx(dir);
	try {
		const value = await fn(ctx);
		const record =
			value && typeof value === "object" && !Array.isArray(value) ? value : { value };
		if (record.__noSpawnLog === true) {
			delete record.__noSpawnLog;
		} else if (spawnLog.length > 0) {
			record.spawnLog = structuredClone(spawnLog);
		}
		results[name] = norm(record);
	} catch (error) {
		results[name] = { error: error && error.message ? error.message : String(error) };
	}
}

// ---------------------------------------------------------------------------
// 1. Library batteries (vendored, upstream-pinned versions)
// ---------------------------------------------------------------------------

const SEMVER_VERSIONS = [
	"1.2.3", "1.2.3-alpha.1", "1.2.3+build.1", "1.2.3-rc.2+meta", "0.0.1",
	"10.20.30", "1.2", "v1.2.4", "not-a-version", "", "1.2.3.4",
];
const SEMVER_RANGES = [
	"^1.0.0", "~1.2.0", ">=1.0.0", ">=1.2.3 <2.0.0", "1.2.3", "1.x", "*",
	">=0.85.0 <0.86.0", "^0.85.1", "not a range",
];
const semverBattery = { valid: [], validRange: [], gt: [], maxSatisfying: [], satisfies: [], rcompare: [], sortDesc: [] };
for (const v of SEMVER_VERSIONS) semverBattery.valid.push([v, valid(v ?? "")]);
for (const r of SEMVER_RANGES) semverBattery.validRange.push([r, validRange(r) ?? null]);
for (const r of SEMVER_RANGES) semverBattery.satisfies.push([["1.2.3", r], satisfies("1.2.3", r)]);
semverBattery.gt.push([["1.2.3", "1.2.2"], gt("1.2.3", "1.2.2")]);
semverBattery.gt.push([["1.2.3", "1.2.3"], gt("1.2.3", "1.2.3")]);
semverBattery.gt.push([["1.2.3-alpha.1", "1.2.3"], gt("1.2.3-alpha.1", "1.2.3")]);
semverBattery.gt.push([["2.0.0", "1.9.9"], gt("2.0.0", "1.9.9")]);
semverBattery.maxSatisfying.push([["1.0.0|1.2.0", "^1.0.0"], maxSatisfying(["1.0.0", "1.2.0"], "^1.0.0")]);
semverBattery.maxSatisfying.push([["1.0.0|1.2.0|2.0.0", "^1.0.0"], maxSatisfying(["1.0.0", "1.2.0", "2.0.0"], "^1.0.0")]);
semverBattery.maxSatisfying.push([["1.0.0|1.2.0|2.0.0", "*"], maxSatisfying(["1.0.0", "1.2.0", "2.0.0"], "*")]);
semverBattery.maxSatisfying.push([["1.0.0|0.9.0", "^1.0.0"], maxSatisfying(["1.0.0", "0.9.0"], "^1.0.0")]);
semverBattery.maxSatisfying.push([["1.0.0|1.2.0", ">=1.1.0 <2.0.0"], maxSatisfying(["1.0.0", "1.2.0"], ">=1.1.0 <2.0.0")]);
semverBattery.rcompare.push([["1.0.0", "2.0.0"], rcompare("1.0.0", "2.0.0")]);
semverBattery.rcompare.push([["1.0.0", "1.0.0"], rcompare("1.0.0", "1.0.0")]);
semverBattery.rcompare.push([["1.2.3-alpha.1", "1.2.3"], rcompare("1.2.3-alpha.1", "1.2.3")]);
semverBattery.sortDesc.push([["1.0.0|2.0.0|1.2.3-alpha.1|1.2.3|0.9.0"], ["1.0.0", "2.0.0", "1.2.3-alpha.1", "1.2.3", "0.9.0"].sort(rcompare).join("|")]);
results["lib/semver"] = semverBattery;

// npm `ignore` battery: pattern semantics exactly as `addIgnoreRules` feeds
// them (rules prefixed with the posix relative dir of the ignore file).
const ignoreCases = [
	{ rules: ["venv"], paths: ["venv", "venv/", "venv/SKILL.md", "venv/sub/SKILL.md", "good/SKILL.md", "venv2/SKILL.md"] },
	{ rules: ["sub/venv"], paths: ["sub/venv/SKILL.md", "venv/SKILL.md", "sub/venv", "sub/venv/"] },
	{ rules: ["*.log"], paths: ["a.log", "sub/a.log", "a.md"] },
	{ rules: ["!keep.md", "*.md"], paths: ["keep.md", "drop.md"] },
	{ rules: ["**/deps"], paths: ["a/deps/SKILL.md", "deps/SKILL.md"] },
	{ rules: ["dir/"], paths: ["dir", "dir/", "dir/file.md", "dirfile.md"] },
	{ rules: ["/rooted"], paths: ["rooted", "a/rooted"] },
	{ rules: ["a*b"], paths: ["axb", "a/b", "axxb"] },
	{ rules: ["docs/", "!docs/keep.md"], paths: ["docs/drop.md", "docs/keep.md"] },
];
results["lib/ignore"] = ignoreCases.map(({ rules, paths }) => {
	const ig = ignoreFactory();
	for (const rule of rules) ig.add(rule);
	return { rules, paths, results: paths.map((p) => ig.ignores(p)) };
});

// minimatch battery: the exact call shapes `matchesAnyPattern` uses
// (relative path, basename, full posix path) plus skill-parent shapes.
const mmCases = [
	["extensions/remove.ts", "**/remove.ts"],
	["extensions/remove.ts", "remove.ts"],
	["extensions/remove.ts", "extensions/remove.ts"],
	["funky.json", "funky.json"],
	["skills/bad-skill/SKILL.md", "**/bad-skill"],
	["bad-skill", "**/bad-skill"],
	["bad-skill/SKILL.md", "**/bad-skill"],
	["extension-files/a.ts", "extension-files/*.ts"],
	["a.ts", "extensions/*.ts"],
	["extensions/force-back.ts", "extensions/force-back.ts"],
	["skills/skill-a/SKILL.md", "skills/skill-a"],
	["skills/skill-a", "skills/skill-a"],
	["deep/nested/file.md", "deep/**/*.md"],
	["file.md", "**/*.md"],
	["x.txt", "*.md"],
	["extensions/one.ts", "extensions/one.ts"],
	["sub/dir/file.ts", "**/file.ts"],
	["alpha.ts", "**/alpha.ts"],
];
results["lib/minimatch"] = mmCases.map(([p, pat]) => [p, pat, minimatch(p, pat)]);

// ---------------------------------------------------------------------------
// 2. Pure-method batteries on the PM instance (TS `private` is erased)
// ---------------------------------------------------------------------------

{
	const ctx = makeCtx(join(root, "pure-parsing"));
	const pm = ctx.pm(ctx.sm());
	const sources = [
		"npm:@scope/pkg@1.2.3", "npm:@scope/pkg@^1.2.3", "npm:pkg", "npm:pkg@1.2.3",
		"npm:@scope/pkg", "npm:", "git:github.com/user/repo", "git:git@github.com:user/repo",
		"git:git@github.com:user/repo@v1.0.0", "git:github.com/user/repo@v1",
		"https://github.com/user/repo", "https://github.com/user/repo.git",
		"https://github.com/user/repo@v1.2.3", "https://github.com/user/repo@main",
		"https://github.com/user/repo@feature/branch", "https://gitlab.com/user/repo",
		"https://bitbucket.org/user/repo", "https://codeberg.org/user/repo",
		"ssh://git@github.com/user/repo", "ssh://git@github.com/user/repo@v1",
		"git:https://github.com/user/repo", "git@github.com:user/repo",
		"github.com/user/repo", "/absolute/path/to/package",
		"./relative/path/to/package", "../relative/path/to/package",
		"./packages/agent-timers", "../packages/agent-timers",
	];
	results["pure/sourceParsing"] = norm({
		parseSource: sources.map((s) => ({ source: s, parsed: pm.parseSource(s) })),
		identity: sources.map((s) => [s, pm.getPackageIdentity(s)]),
		identityWithScope: [
			["./relative/path/to/package", "user", pm.getPackageIdentity("./relative/path/to/package", "user")],
			["./relative/path/to/package", "project", pm.getPackageIdentity("./relative/path/to/package", "project")],
		],
	});
}

// ---------------------------------------------------------------------------
// 3. resolve / resolveExtensionSources scenarios (fs-backed)
// ---------------------------------------------------------------------------

await scenario("resolve-empty", async (c) => render(await c.pm(c.sm()).resolve(), c.dir));

await scenario("resolve-local-extension-paths", async (c) => {
	c.write("agent/extensions/my-extension.ts", JS);
	const sm = c.sm();
	sm.setExtensionPaths(["extensions/my-extension.ts"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("resolve-skill-paths", async (c) => {
	c.write("agent/skills/my-skill/SKILL.md", SKILL("test-skill"));
	const sm = c.sm();
	sm.setSkillPaths(["skills"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("resolve-root-markdown-skill", async (c) => {
	c.write("agent/skills/single-file.md", SKILL("single-file"));
	return render(await c.pm(c.sm()).resolve(), c.dir);
});

await scenario("resolve-project-paths-relative-pi", async (c) => {
	c.write(".pi/extensions/project-ext.ts", JS);
	const sm = c.sm();
	sm.setProjectExtensionPaths(["extensions/project-ext.ts"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("resolve-user-prompt-overrides", async (c) => {
	c.write("agent/prompts/auto.md", "Auto prompt");
	const sm = c.sm();
	sm.setPromptTemplatePaths(["!prompts/auto.md"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("resolve-symlinked-resources-once", async (c) => {
	c.write("shared-resources/extensions/shared.ts", JS);
	c.write("shared-resources/skills/shared-skill/SKILL.md", SKILL("shared-skill"));
	c.write("shared-resources/prompts/shared.md", "Shared prompt");
	c.write("shared-resources/themes/shared.json", JSON.stringify({ name: "shared-theme" }));
	c.link("shared-resources/extensions", "agent/extensions");
	c.link("shared-resources/skills", "agent/skills");
	c.link("shared-resources/prompts", "agent/prompts");
	c.link("shared-resources/themes", "agent/themes");
	c.link("shared-resources/extensions", ".pi/extensions");
	c.link("shared-resources/skills", ".pi/skills");
	c.link("shared-resources/prompts", ".pi/prompts");
	c.link("shared-resources/themes", ".pi/themes");
	return render(await c.pm(c.sm()).resolve(), c.dir);
});

await scenario("resolve-project-prompt-overrides", async (c) => {
	c.write(".pi/prompts/is.md", "Is prompt");
	const sm = c.sm();
	sm.setProjectPromptTemplatePaths(["!prompts/is.md"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("resolve-manifest-in-extensions-setting", async (c) => {
	c.write("my-extensions-pkg/package.json", JSON.stringify({ name: "my-extensions-pkg", pi: { extensions: ["./extensions/clip.ts", "./extensions/cost.ts"] } }));
	c.write("my-extensions-pkg/extensions/clip.ts", JS);
	c.write("my-extensions-pkg/extensions/cost.ts", JS);
	c.write("my-extensions-pkg/extensions/helper.ts", "export const x = 1;");
	const sm = c.sm();
	sm.setExtensionPaths([join(c.dir, "my-extensions-pkg")]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("skill-metadata-basedirs", async (c) => {
	c.write("agent/skills/user-pi/SKILL.md", SKILL("user-pi"));
	c.write(".pi/skills/project-pi/SKILL.md", SKILL("project-pi"));
	c.write(".agents/skills/user-agents/SKILL.md", SKILL("user-agents"));
	return render(await c.pm(c.sm()).resolve(), c.dir);
});

await scenario("project-agents-basedirs", async (c) => {
	c.mkdir("repo/.git");
	c.mkdir("repo/packages/feature");
	c.write("repo/.agents/skills/repo/SKILL.md", SKILL("repo"));
	c.write("repo/packages/.agents/skills/package/SKILL.md", SKILL("package"));
	const pm = c.pm(c.sm(), { cwd: join(c.dir, "repo", "packages", "feature") });
	return render(await pm.resolve(), c.dir);
});

await scenario("agents-scan-git-bounded", async (c) => {
	c.mkdir("repo/.git");
	c.mkdir("repo/packages/feature");
	c.write(".agents/skills/above-repo/SKILL.md", SKILL("above-repo"));
	c.write("repo/.agents/skills/repo-root/SKILL.md", SKILL("repo-root"));
	c.write("repo/packages/.agents/skills/nested/SKILL.md", SKILL("nested"));
	const pm = c.pm(c.sm(), { cwd: join(c.dir, "repo", "packages", "feature") });
	return render(await pm.resolve(), c.dir);
});

await scenario("agents-scan-no-repo", async (c) => {
	c.mkdir("non-repo/a/b");
	c.write("non-repo/.agents/skills/root/SKILL.md", SKILL("root"));
	c.write("non-repo/a/.agents/skills/middle/SKILL.md", SKILL("middle"));
	const pm = c.pm(c.sm(), { cwd: join(c.dir, "non-repo", "a", "b") });
	return render(await pm.resolve(), c.dir);
});

await scenario("agents-scan-root-md-ignored", async (c) => {
	c.write(".agents/skills/nested-skill/SKILL.md", SKILL("nested-skill"));
	c.write(".agents/skills/third-party/vendor/pack/deep-skill.md", SKILL("deep-skill"));
	c.write(".agents/skills/root-file.md", SKILL("root-file"));
	c.write(".agents/skills/third-party/child-skill.md", SKILL("child-skill"));
	c.mkdir("work");
	const pm = c.pm(c.sm(), { cwd: join(c.dir, "work") });
	return render(await pm.resolve(), c.dir);
});

await scenario("agents-home-user-scoped", async (c) => {
	const cwd = join(c.dir, "scratch", "nested");
	const localAgentDir = join(c.dir, ".pi", "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(localAgentDir, { recursive: true });
	c.write(".agents/skills/home-skill/SKILL.md", SKILL("home-skill"));
	const pm = c.pm(c.sm(), { cwd, agentDir: localAgentDir });
	return render(await pm.resolve(), c.dir);
});

await scenario("agents-junction-dedupe", async (c) => {
	c.link(".agents/skills", "agent/skills");
	c.write(".agents/skills/foo/SKILL.md", SKILL("foo"));
	return render(await c.pm(c.sm()).resolve(), c.dir);
});

await scenario("ignore-in-skill-dirs", async (c) => {
	c.write("agent/skills/.gitignore", "venv\n__pycache__\n");
	c.write("agent/skills/good-skill/SKILL.md", SKILL("good-skill"));
	c.write("agent/skills/venv/bad-skill/SKILL.md", SKILL("bad-skill"));
	const sm = c.sm();
	sm.setSkillPaths(["skills"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("parent-gitignore-not-applied", async (c) => {
	c.write(".gitignore", ".pi\n");
	c.write(".pi/skills/auto-skill/SKILL.md", SKILL("auto-skill"));
	return render(await c.pm(c.sm()).resolve(), c.dir);
});

await scenario("resolve-extension-sources-local", async (c) => {
	c.write("ext.ts", JS);
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "ext.ts")]), c.dir);
});

await scenario("resolve-extension-sources-manifest", async (c) => {
	c.write("my-package/package.json", JSON.stringify({ name: "my-package", pi: { extensions: ["./src/index.ts"], skills: ["./skills"] } }));
	c.write("my-package/src/index.ts", JS);
	c.write("my-package/skills/my-skill/SKILL.md", SKILL("my-skill"));
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "my-package")]), c.dir);
});

await scenario("resolve-extension-sources-tilde-manifest", async (c) => {
	c.write("tilde-manifest-package/~extensions/main.ts", JS);
	c.write("tilde-manifest-package/~/extensions/alt.ts", JS);
	c.write("tilde-manifest-package/~skills/direct-skill/SKILL.md", SKILL("direct-skill"));
	c.write("tilde-manifest-package/~/skills/slash-skill/SKILL.md", SKILL("slash-skill"));
	c.write("tilde-manifest-package/package.json", JSON.stringify({ name: "tilde-manifest-package", pi: { extensions: ["~extensions/main.ts", "~/extensions/alt.ts"], skills: ["~skills", "~/skills"] } }));
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "tilde-manifest-package")]), c.dir);
});

await scenario("resolve-extension-sources-auto-layout", async (c) => {
	c.write("auto-pkg/extensions/main.ts", JS);
	c.write("auto-pkg/themes/dark.json", "{}");
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "auto-pkg")]), c.dir);
});

await scenario("resolve-skill-root-stop", async (c) => {
	c.write("skill-root-pkg/skills/root-skill/SKILL.md", SKILL("root-skill"));
	c.write("skill-root-pkg/skills/root-skill/nested-skill/SKILL.md", SKILL("nested-skill"));
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "skill-root-pkg")]), c.dir);
});

await scenario("manifest-glob-extensions", async (c) => {
	c.write("manifest-pkg/extensions/local.ts", JS);
	c.write("manifest-pkg/node_modules/dep/extensions/remote.ts", JS);
	c.write("manifest-pkg/node_modules/dep/extensions/skip.ts", JS);
	c.write("manifest-pkg/package.json", JSON.stringify({ name: "manifest-pkg", pi: { extensions: ["extensions", "node_modules/dep/extensions", "!**/skip.ts"] } }));
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "manifest-pkg")]), c.dir);
});

await scenario("manifest-glob-skills", async (c) => {
	c.write("skill-manifest-pkg/skills/good-skill/SKILL.md", SKILL("good-skill"));
	c.write("skill-manifest-pkg/skills/bad-skill/SKILL.md", SKILL("bad-skill"));
	c.write("skill-manifest-pkg/package.json", JSON.stringify({ name: "skill-manifest-pkg", pi: { skills: ["skills", "!**/bad-skill"] } }));
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "skill-manifest-pkg")]), c.dir);
});

await scenario("manifest-glob-positive-expansion", async (c) => {
	c.write("skill-manifest-glob-pkg/plugins/pdf-to-markdown/skills/pdf-to-markdown/SKILL.md", SKILL("pdf-to-markdown"));
	c.write("skill-manifest-glob-pkg/plugins/nutrient-dws/skills/document-processor-api/SKILL.md", SKILL("document-processor-api"));
	c.write("skill-manifest-glob-pkg/package.json", JSON.stringify({ name: "skill-manifest-glob-pkg", pi: { skills: ["./plugins/*/skills"] } }));
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "skill-manifest-glob-pkg")]), c.dir);
});

await scenario("manifest-glob-semantics", async (c) => {
	c.write("manifest-glob-semantics-pkg/extension-files/z.ts", JS);
	c.write("manifest-glob-semantics-pkg/extension-files/a.ts", JS);
	c.write("manifest-glob-semantics-pkg/extension-files/.ignored.ts", JS);
	c.write("manifest-glob-semantics-pkg/extension-files/nested/.hidden.ts", JS);
	c.write("manifest-glob-semantics-pkg/extension-groups/group/index.ts", JS);
	c.write("manifest-glob-semantics-pkg/plugins/local/skills/local-skill/SKILL.md", SKILL("local-skill"));
	c.write("linked-plugin-source/skills/linked-skill/SKILL.md", SKILL("linked-skill"));
	c.link("linked-plugin-source", "manifest-glob-semantics-pkg/plugins/linked");
	c.write("manifest-glob-semantics-pkg/package.json", JSON.stringify({
		name: "manifest-glob-semantics-pkg",
		pi: {
			extensions: ["./extension-files/*.ts", "./extension-files/**/.ignored.ts", "./extension-files/nested/.hidden.ts", "./extension-groups/*/"],
			skills: ["./plugins/*/skills", "./plugins/linked/skills"],
		},
	}));
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "manifest-glob-semantics-pkg")]), c.dir);
});

await scenario("package-filter-layered", async (c) => {
	c.write("layered-pkg/extensions/foo.ts", JS);
	c.write("layered-pkg/extensions/bar.ts", JS);
	c.write("layered-pkg/extensions/baz.ts", JS);
	c.write("layered-pkg/package.json", JSON.stringify({ name: "layered-pkg", pi: { extensions: ["extensions", "!**/baz.ts"] } }));
	const sm = c.sm();
	sm.setPackages([{ source: join(c.dir, "layered-pkg"), extensions: ["!**/bar.ts"], skills: [], prompts: [], themes: [] }]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("package-filter-exclude", async (c) => {
	c.write("pattern-pkg/extensions/foo.ts", JS);
	c.write("pattern-pkg/extensions/bar.ts", JS);
	c.write("pattern-pkg/extensions/baz.ts", JS);
	const sm = c.sm();
	sm.setPackages([{ source: join(c.dir, "pattern-pkg"), extensions: ["!**/baz.ts"], skills: [], prompts: [], themes: [] }]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("package-filter-themes", async (c) => {
	c.write("theme-pkg/themes/nice.json", "{}");
	c.write("theme-pkg/themes/ugly.json", "{}");
	const sm = c.sm();
	sm.setPackages([{ source: join(c.dir, "theme-pkg"), extensions: [], skills: [], prompts: [], themes: ["!ugly.json"] }]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("package-filter-combo", async (c) => {
	c.write("combo-pkg/extensions/alpha.ts", JS);
	c.write("combo-pkg/extensions/beta.ts", JS);
	c.write("combo-pkg/extensions/gamma.ts", JS);
	const sm = c.sm();
	sm.setPackages([{ source: join(c.dir, "combo-pkg"), extensions: ["**/alpha.ts", "**/beta.ts", "!**/beta.ts"], skills: [], prompts: [], themes: [] }]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("package-filter-direct-paths", async (c) => {
	c.write("direct-pkg/extensions/one.ts", JS);
	c.write("direct-pkg/extensions/two.ts", JS);
	const sm = c.sm();
	sm.setPackages([{ source: join(c.dir, "direct-pkg"), extensions: ["extensions/one.ts"], skills: [], prompts: [], themes: [] }]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("autoload-delta-over-global", async (c) => {
	c.write("agent/npm/node_modules/pi-tools/package.json", JSON.stringify({ name: "pi-tools", version: "1.0.0" }));
	c.write("agent/npm/node_modules/pi-tools/extensions/foo.ts", JS);
	c.write("agent/npm/node_modules/pi-tools/extensions/bar.ts", JS);
	const sm = c.sm();
	sm.setPackages(["npm:pi-tools"]);
	sm.setProjectPackages([{ source: "npm:pi-tools", autoload: false, extensions: ["-extensions/foo.ts"] }]);
	const resolved = await c.pm(sm).resolve();
	return { ...render(resolved, c.dir), spawnLog: structuredClone(spawnLog) };
});

await scenario("autoload-positive-only", async (c) => {
	c.write("positive-only-pkg/extensions/foo.ts", JS);
	c.write("positive-only-pkg/extensions/bar.ts", JS);
	c.write("positive-only-pkg/skills/foo/SKILL.md", "# Foo\n");
	const sm = c.sm();
	const source = posix(relative(join(c.dir, ".pi"), join(c.dir, "positive-only-pkg")));
	sm.setProjectPackages([{ source, autoload: false, extensions: ["+extensions/foo.ts"] }]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("top-level-include-exclude", async (c) => {
	c.write("agent/extensions/keep.ts", JS);
	c.write("agent/extensions/remove.ts", JS);
	const sm = c.sm();
	sm.setExtensionPaths(["extensions", "!**/remove.ts"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("top-level-theme-glob", async (c) => {
	c.write("agent/themes/dark.json", "{}");
	c.write("agent/themes/light.json", "{}");
	c.write("agent/themes/funky.json", "{}");
	const sm = c.sm();
	sm.setThemePaths(["themes", "!funky.json"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("top-level-skill-exclude", async (c) => {
	c.write("agent/skills/good-skill/SKILL.md", SKILL("good-skill"));
	c.write("agent/skills/bad-skill/SKILL.md", SKILL("bad-skill"));
	const sm = c.sm();
	sm.setSkillPaths(["skills", "!**/bad-skill"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("top-level-prompt-exclude", async (c) => {
	c.write("agent/prompts/review.md", "Review code");
	c.write("agent/prompts/explain.md", "Explain code");
	const sm = c.sm();
	sm.setPromptTemplatePaths(["prompts", "!explain.md"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("top-level-patternless", async (c) => {
	c.write("agent/extensions/my-ext.ts", JS);
	const sm = c.sm();
	sm.setExtensionPaths(["extensions/my-ext.ts"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("force-include-toplevel", async (c) => {
	c.write("agent/extensions/keep.ts", JS);
	c.write("agent/extensions/excluded.ts", JS);
	c.write("agent/extensions/force-back.ts", JS);
	const sm = c.sm();
	sm.setExtensionPaths(["extensions", "!extensions/*.ts", "+extensions/force-back.ts"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("force-include-package", async (c) => {
	c.write("force-pkg/extensions/alpha.ts", JS);
	c.write("force-pkg/extensions/beta.ts", JS);
	c.write("force-pkg/extensions/gamma.ts", JS);
	const sm = c.sm();
	sm.setPackages([{ source: join(c.dir, "force-pkg"), extensions: ["!**/*.ts", "+extensions/beta.ts"], skills: [], prompts: [], themes: [] }]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("force-include-multi-skills", async (c) => {
	c.write("multi-force-pkg/skills/skill-a/SKILL.md", SKILL("skill-a"));
	c.write("multi-force-pkg/skills/skill-b/SKILL.md", SKILL("skill-b"));
	c.write("multi-force-pkg/skills/skill-c/SKILL.md", SKILL("skill-c"));
	const sm = c.sm();
	sm.setPackages([{ source: join(c.dir, "multi-force-pkg"), extensions: [], skills: ["!**/*", "+skills/skill-a", "+skills/skill-c"], prompts: [], themes: [] }]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("force-include-after-specific-exclusion", async (c) => {
	c.write("agent/extensions/a.ts", JS);
	c.write("agent/extensions/b.ts", JS);
	const sm = c.sm();
	sm.setExtensionPaths(["extensions", "!extensions/b.ts", "+extensions/b.ts"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("force-include-manifest", async (c) => {
	c.write("manifest-force-pkg/extensions/one.ts", JS);
	c.write("manifest-force-pkg/extensions/two.ts", JS);
	c.write("manifest-force-pkg/extensions/three.ts", JS);
	c.write("manifest-force-pkg/package.json", JSON.stringify({ name: "manifest-force-pkg", pi: { extensions: ["extensions", "!**/two.ts", "+extensions/two.ts"] } }));
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "manifest-force-pkg")]), c.dir);
});

await scenario("force-include-themes-prompts", async (c) => {
	c.write("agent/themes/dark.json", "{}");
	c.write("agent/themes/light.json", "{}");
	c.write("agent/themes/special.json", "{}");
	c.write("agent/prompts/review.md", "Review");
	c.write("agent/prompts/explain.md", "Explain");
	c.write("agent/prompts/debug.md", "Debug");
	const sm = c.sm();
	sm.setThemePaths(["themes", "!themes/*.json", "+themes/special.json"]);
	sm.setPromptTemplatePaths(["prompts", "!prompts/*.md", "+prompts/debug.md"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("force-exclude-toplevel", async (c) => {
	c.write("agent/extensions/alpha.ts", JS);
	c.write("agent/extensions/beta.ts", JS);
	const sm = c.sm();
	sm.setExtensionPaths(["extensions", "+extensions/alpha.ts", "-extensions/alpha.ts"]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("force-exclude-package", async (c) => {
	c.write("force-exclude-pkg/extensions/alpha.ts", JS);
	c.write("force-exclude-pkg/extensions/beta.ts", JS);
	const sm = c.sm();
	sm.setPackages([{ source: join(c.dir, "force-exclude-pkg"), extensions: ["extensions/*.ts", "+extensions/alpha.ts", "-extensions/alpha.ts"], skills: [], prompts: [], themes: [] }]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("dedupe-local-project-wins", async (c) => {
	c.write("shared-pkg/extensions/shared.ts", JS);
	const sm = c.sm();
	sm.setPackages([join(c.dir, "shared-pkg")]);
	sm.setProjectPackages([join(c.dir, "shared-pkg")]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("dedupe-different-kept", async (c) => {
	c.write("pkg1/extensions/from-pkg1.ts", JS);
	c.write("pkg2/extensions/from-pkg2.ts", JS);
	const sm = c.sm();
	sm.setPackages([join(c.dir, "pkg1")]);
	sm.setProjectPackages([join(c.dir, "pkg2")]);
	return render(await c.pm(sm).resolve(), c.dir);
});

await scenario("multifile-subdir-index-only", async (c) => {
	c.write("multifile-pkg/extensions/subagent/index.ts", `import { helper } from "./agents.ts";\nexport default function(api) {}`);
	c.write("multifile-pkg/extensions/subagent/agents.ts", `export function helper() { return "helper"; }`);
	c.write("multifile-pkg/extensions/standalone.ts", JS);
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "multifile-pkg")]), c.dir);
});

await scenario("multifile-manifest-subdir", async (c) => {
	c.write("manifest-subdir-pkg/extensions/custom/package.json", JSON.stringify({ pi: { extensions: ["./main.ts"] } }));
	c.write("manifest-subdir-pkg/extensions/custom/main.ts", JS);
	c.write("manifest-subdir-pkg/extensions/custom/utils.ts", "export const util = 1;");
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "manifest-subdir-pkg")]), c.dir);
});

await scenario("multifile-mixed", async (c) => {
	c.write("mixed-pkg/extensions/simple.ts", JS);
	c.write("mixed-pkg/extensions/complex/index.ts", "import { a } from './a.ts'; export default function(api) {}");
	c.write("mixed-pkg/extensions/complex/a.ts", "export const a = 1;");
	c.write("mixed-pkg/extensions/complex/b.ts", "export const b = 2;");
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "mixed-pkg")]), c.dir);
});

await scenario("multifile-no-entry-skipped", async (c) => {
	c.write("no-entry-pkg/extensions/broken/helper.ts", "export const x = 1;");
	c.write("no-entry-pkg/extensions/broken/another.ts", "export const y = 2;");
	c.write("no-entry-pkg/extensions/valid.ts", JS);
	return render(await c.pm(c.sm()).resolveExtensionSources([join(c.dir, "no-entry-pkg")]), c.dir);
});

// ---------------------------------------------------------------------------
// 4. Settings normalization / install-path scenarios
// ---------------------------------------------------------------------------

await scenario("settings-normalize-global-local", async (c) => {
	c.mkdir("packages/local-global-pkg/extensions");
	c.write("packages/local-global-pkg/extensions/index.ts", JS);
	const sm = c.sm();
	const manager = c.pm(sm);
	const added = manager.addSourceToSettings("./packages/local-global-pkg");
	return { added, packages: sm.getGlobalSettings().packages };
});

await scenario("settings-normalize-project-local", async (c) => {
	c.write("project-local-pkg/extensions/index.ts", JS);
	const sm = c.sm();
	const added = c.pm(sm).addSourceToSettings("./project-local-pkg", { local: true });
	return { added, packages: sm.getProjectSettings().packages };
});

await scenario("settings-remove-equivalent-forms", async (c) => {
	c.write("remove-local-pkg/extensions/index.ts", JS);
	const sm = c.sm();
	const manager = c.pm(sm);
	manager.addSourceToSettings("./remove-local-pkg");
	const removed = manager.removeSourceFromSettings(`${join(c.dir, "remove-local-pkg")}/`);
	return { removed, packages: sm.getGlobalSettings().packages };
});

await scenario("settings-same-ref-noop", async (c) => {
	const sm = c.sm();
	const manager = c.pm(sm);
	const first = manager.addSourceToSettings("git:github.com/user/repo@v1");
	const second = manager.addSourceToSettings("git:github.com/user/repo@v1");
	return { first, second, packages: sm.getGlobalSettings().packages };
});

await scenario("settings-ref-update", async (c) => {
	const sm = c.sm();
	const manager = c.pm(sm);
	manager.addSourceToSettings("git:github.com/user/repo@v1");
	const updated = manager.addSourceToSettings("git:github.com/user/repo@v2");
	return { updated, packages: sm.getGlobalSettings().packages };
});

await scenario("settings-filter-preserving-ref-update", async (c) => {
	const sm = c.sm();
	sm.setPackages([{ source: "git:github.com/user/repo@v1", extensions: ["extensions/main.ts"], skills: [], prompts: ["prompts/review.md"], themes: ["themes/dark.json"] }]);
	const updated = c.pm(sm).addSourceToSettings("git:github.com/user/repo@v2");
	return { updated, packages: sm.getGlobalSettings().packages };
});

await scenario("git-install-path-traversal", async (c) => {
	const manager = c.pm(c.sm());
	const traversalSource = { type: "git", repo: "git@evil.example:../../victim/repo", host: "evil.example", path: "../../victim/repo", pinned: false };
	const out = {};
	for (const scope of ["user", "project", "temporary"]) {
		try {
			out[scope] = manager.getGitInstallPath(traversalSource, scope);
		} catch (error) {
			out[scope] = { error: error.message };
		}
	}
	return out;
});

await scenario("temporary-npm-path", async (c) => {
	const manager = c.pm(c.sm());
	const parsed = manager.parseSource("npm:left-pad");
	return {
		installPath: manager.getNpmInstallPath(parsed, "temporary"),
		tempRoot: join(c.agentDir, "tmp", "extensions"),
	};
});

await scenario("list-configured-packages", async (c) => {
	c.write("agent/npm/node_modules/user-pkg/package.json", JSON.stringify({ name: "user-pkg", version: "1.0.0" }));
	c.write("agent/npm/node_modules/user-pkg/extensions/index.ts", JS);
	c.write(".pi/npm/node_modules/project-pkg/package.json", JSON.stringify({ name: "project-pkg", version: "1.0.0" }));
	const sm = c.sm();
	sm.setPackages(["npm:user-pkg", { source: "npm:filtered-pkg", extensions: [] }, "local-missing"]);
	sm.setProjectPackages(["npm:project-pkg"]);
	script((_command, args) => {
		if (args[0] === "root") return { stdout: `${join(c.dir, "nowhere")}\n` };
		if (args[0] === "list") return { stdout: "[]" };
		throw new Error(`unexpected spawn ${args.join(" ")}`);
	});
	const manager = c.pm(sm);
	return manager.listConfiguredPackages().map((p) => ({
		source: p.source,
		scope: p.scope,
		filtered: p.filtered,
		installedPath: p.installedPath === undefined ? undefined : relTo(c.dir, p.installedPath),
	}));
});

// ---------------------------------------------------------------------------
// 5. Spawn-driven flows (npmCommand argv, git flows, update batching)
// ---------------------------------------------------------------------------

// Each `flow` scenario records the observed outcome plus the full spawn log
// (argv exactly as the upstream source issues it).

await scenario("flow-npm-install-default", async (c) => {
	await c.pm(c.sm()).install("npm:@scope/pkg");
	return {};
});

await scenario("flow-npm-install-mise-argv", async (c) => {
	const sm = c.sm({ npmCommand: ["mise", "exec", "node@20", "--", "npm"] });
	await c.pm(sm).install("npm:@scope/pkg");
	return {};
});

await scenario("flow-npm-remove-default", async (c) => {
	c.mkdir("agent/npm");
	await c.pm(c.sm()).remove("npm:@scope/pkg");
	return {};
});

await scenario("flow-npm-remove-bun-argv", async (c) => {
	c.mkdir("agent/npm");
	const sm = c.sm({ npmCommand: ["mise", "exec", "bun@1", "--", "bun"] });
	await c.pm(sm).remove("npm:@scope/pkg");
	return {};
});

await scenario("flow-npm-remove-pnpm-argv", async (c) => {
	c.mkdir("agent/npm");
	const sm = c.sm({ npmCommand: ["pnpm"] });
	await c.pm(sm).remove("npm:@scope/pkg");
	return {};
});

await scenario("flow-npm-install-bun-argv", async (c) => {
	const sm = c.sm({ npmCommand: ["mise", "exec", "bun@1", "--", "bun"] });
	await c.pm(sm).install("npm:@scope/pkg");
	return {};
});

await scenario("flow-npm-install-pnpm-argv", async (c) => {
	const sm = c.sm({ npmCommand: ["pnpm"] });
	await c.pm(sm).install("npm:@scope/pkg");
	return {};
});

await scenario("flow-git-install-success", async (c) => {
	script((command, args) => {
		if (command === "git" && args[0] === "clone") {
			mkdirSync(args[2], { recursive: true });
			writeFileSync(join(args[2], "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
		}
	});
	await c.pm(c.sm()).install("git:github.com/user/repo");
	return {};
});

await scenario("flow-git-install-clone-failure", async (c) => {
	script((command, args) => {
		if (command === "git" && args[0] === "clone") {
			mkdirSync(args[2], { recursive: true });
			throw new Error("simulated git clone failure");
		}
	});
	try {
		await c.pm(c.sm()).install("git:github.com/user/repo");
		return { outcome: "resolved" };
	} catch (error) {
		return { outcome: error.message };
	}
});

await scenario("flow-git-install-dependency-failure", async (c) => {
	script((command, args) => {
		if (command === "git" && args[0] === "clone") {
			mkdirSync(args[2], { recursive: true });
			writeFileSync(join(args[2], "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
		}
		if (command === "npm") {
			throw new Error("simulated dependency install failure");
		}
	});
	try {
		await c.pm(c.sm()).install("git:github.com/user/repo");
		return { outcome: "resolved" };
	} catch (error) {
		return { outcome: error.message };
	}
});

await scenario("flow-git-pinned-ref-reconcile", async (c) => {
	const targetDir = join(c.agentDir, "git", "github.com", "user", "repo");
	mkdirSync(targetDir, { recursive: true });
	writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
	script((_command, args) => {
		if (args[0] === "rev-parse") {
			if (args[1] === "HEAD") return { stdout: "old-head\n" };
			if (args[1] === "FETCH_HEAD^{commit}") return { stdout: "new-head\n" };
			throw new Error(`Unexpected capture: ${args.join(" ")}`);
		}
	});
	await c.pm(c.sm()).install("git:github.com/user/repo@v2");
	return {};
});

await scenario("flow-git-update-target-reconcile", async (c) => {
	const targetDir = join(c.agentDir, "git", "github.com", "user", "repo");
	mkdirSync(targetDir, { recursive: true });
	script((_command, args) => {
		if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}") {
			throw new Error("no upstream configured");
		}
		if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "old-head\n" };
		if (args[0] === "rev-parse" && args[1] === "origin/HEAD") return { stdout: "new-head\n" };
		if (args[0] === "rev-parse" && args[1] === "origin/HEAD^{commit}") return { stdout: "new-head\n" };
		if (args[0] === "symbolic-ref" && args[1] === "refs/remotes/origin/HEAD") return { stdout: "refs/remotes/origin/main\n" };
		if (args[0] === "rev-parse") throw new Error(`Unexpected capture: ${args.join(" ")}`);
	});
	await c.pm(c.sm()).install("git:github.com/user/repo");
	return {};
});

await scenario("flow-git-deps-plain-install-configured", async (c) => {
	script((command, args) => {
		if (command === "git" && args[0] === "clone") {
			mkdirSync(args[2], { recursive: true });
			writeFileSync(join(args[2], "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
		}
	});
	const sm = c.sm({ npmCommand: ["pnpm"] });
	await c.pm(sm).install("git:github.com/user/repo");
	return {};
});

await scenario("flow-git-update-deps-omit-dev", async (c) => {
	c.mkdir(".pi/git/github.com/user/repo");
	c.write(".pi/git/github.com/user/repo/package.json", JSON.stringify({ name: "repo", version: "1.0.0" }));
	script((_command, args) => {
		if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}") return { stdout: "origin/main\n" };
		if (args[0] === "rev-parse" && (args[1] === "@{upstream}" || args[1] === "@{upstream}^{commit}")) return { stdout: "remote-head\n" };
		if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "local-head\n" };
		if (args[0] === "rev-parse") throw new Error(`Unexpected capture: ${args.join(" ")}`);
	});
	const sm = c.sm();
	sm.setProjectPackages(["git:github.com/user/repo"]);
	await c.pm(sm).update("git:github.com/user/repo");
	return {};
});

await scenario("flow-git-repair-current-checkout", async (c) => {
	const targetDir = join(c.agentDir, "git", "github.com", "user", "repo");
	mkdirSync(targetDir, { recursive: true });
	writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0", dependencies: { dependency: "1.0.0" } }));
	script((_command, args) => {
		if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}") return { stdout: "origin/main\n" };
		if (args[0] === "rev-parse" && args[1] === "@{upstream}") return { stdout: "current-head\n" };
		if (args[0] === "rev-parse" && args[1] === "@{upstream}^{commit}") return { stdout: "current-head\n" };
		if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "current-head\n" };
		if (args[0] === "rev-parse") throw new Error(`Unexpected capture: ${args.join(" ")}`);
	});
	const sm = c.sm();
	sm.setPackages(["git:github.com/user/repo"]);
	await c.pm(sm).update("git:github.com/user/repo");
	return {};
});

await scenario("flow-git-clean-failure-repairs-deps", async (c) => {
	const targetDir = join(c.agentDir, "git", "github.com", "user", "repo");
	mkdirSync(targetDir, { recursive: true });
	writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0", dependencies: { dependency: "1.0.0" } }));
	script((command, args) => {
		if (command === "git" && args[0] === "clean") throw new Error("simulated clean failure");
		if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}") return { stdout: "origin/main\n" };
		if (args[0] === "rev-parse" && args[1] === "@{upstream}") return { stdout: "new-head\n" };
		if (args[0] === "rev-parse" && args[1] === "@{upstream}^{commit}") return { stdout: "new-head\n" };
		if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "old-head\n" };
		if (args[0] === 'rev-parse') throw new Error(`Unexpected capture: ${args.join(" ")}`);
	});
	const sm = c.sm();
	sm.setPackages(["git:github.com/user/repo"]);
	try {
		await c.pm(sm).update("git:github.com/user/repo");
		return { outcome: "resolved" };
	} catch (error) {
		return { outcome: error.message };
	}
});

await scenario("flow-git-update-mise-argv-deps", async (c) => {
	c.mkdir(".pi/git/github.com/user/repo");
	c.write(".pi/git/github.com/user/repo/package.json", JSON.stringify({ name: "repo", version: "1.0.0" }));
	script((_command, args) => {
		if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}") return { stdout: "origin/main\n" };
		if (args[0] === "rev-parse" && (args[1] === "@{upstream}" || args[1] === "@{upstream}^{commit}")) return { stdout: "remote-head\n" };
		if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "local-head\n" };
		if (args[0] === "rev-parse") throw new Error(`Unexpected capture: ${args.join(" ")}`);
	});
	const sm = c.sm({ npmCommand: ["mise", "exec", "node@20", "--", "pnpm"] });
	sm.setProjectPackages(["git:github.com/user/repo"]);
	await c.pm(sm).update("git:github.com/user/repo");
	return {};
});

await scenario("flow-update-npm-range-spec", async (c) => {
	c.mkdir(".pi/npm/node_modules/example");
	c.write(".pi/npm/node_modules/example/package.json", JSON.stringify({ name: "example", version: "1.0.0" }));
	script((_command, args) => (args[0] === "view" ? { stdout: '["1.0.0","1.2.0"]' } : { stdout: "" }));
	const sm = c.sm();
	sm.setProjectPackages(["npm:example@^1.0.0"]);
	await c.pm(sm).update("npm:example");
	return {};
});

await scenario("flow-update-npm-current-skip", async (c) => {
	c.mkdir(".pi/npm/node_modules/example");
	c.write(".pi/npm/node_modules/example/package.json", JSON.stringify({ name: "example", version: "1.3.1" }));
	script((_command, args) => (args[0] === "view" ? { stdout: '["1.0.0","1.3.1","1.0.2"]' } : { stdout: "" }));
	const sm = c.sm();
	sm.setProjectPackages(["npm:example@^1.0.0"]);
	await c.pm(sm).update("npm:example");
	return {};
});

await scenario("flow-update-npm-newer-installed-skip", async (c) => {
	c.mkdir(".pi/npm/node_modules/example");
	c.write(".pi/npm/node_modules/example/package.json", JSON.stringify({ name: "example", version: "2.0.0" }));
	script((_command, args) => (args[0] === "view" ? { stdout: '"1.9.0"' } : { stdout: "" }));
	const sm = c.sm();
	sm.setProjectPackages(["npm:example"]);
	await c.pm(sm).update("npm:example");
	return {};
});

await scenario("flow-update-migrate-legacy-user-install", async (c) => {
	const legacyRoot = join(c.dir, "legacy-global", "node_modules");
	const legacyPath = join(legacyRoot, "legacy-pkg");
	const managedPath = join(c.agentDir, "npm", "node_modules", "legacy-pkg");
	mkdirSync(legacyPath, { recursive: true });
	writeFileSync(join(legacyPath, "package.json"), JSON.stringify({ name: "legacy-pkg", version: "1.0.0" }));
	script((command, args) => {
		if (command === "npm" && args[0] === "root") return { stdout: `${legacyRoot}\n` };
		if (command === "npm" && args[0] === "install") {
			mkdirSync(managedPath, { recursive: true });
			writeFileSync(join(managedPath, "package.json"), JSON.stringify({ name: "legacy-pkg", version: "1.0.0" }));
			return { stdout: "" };
		}
		throw new Error(`Unexpected: ${command} ${args.join(" ")}`);
	});
	const sm = c.sm();
	sm.setPackages(["npm:legacy-pkg"]);
	const manager = c.pm(sm);
	const before = manager.getInstalledPath("npm:legacy-pkg", "user");
	await manager.update("npm:legacy-pkg");
	const after = manager.getInstalledPath("npm:legacy-pkg", "user");
	return {
		before: before === undefined ? undefined : relTo(c.dir, before),
		after: after === undefined ? undefined : relTo(c.dir, after),
	};
});

await scenario("flow-update-batch-per-scope", async (c) => {
	const paths = {
		"user-old": join(c.agentDir, "npm", "node_modules", "user-old"),
		"user-current": join(c.agentDir, "npm", "node_modules", "user-current"),
		"user-unknown": join(c.agentDir, "npm", "node_modules", "user-unknown"),
		"project-old": join(c.dir, ".pi", "npm", "node_modules", "project-old"),
		"project-current": join(c.dir, ".pi", "npm", "node_modules", "project-current"),
	};
	for (const [name, p] of Object.entries(paths)) {
		mkdirSync(p, { recursive: true });
		writeFileSync(join(p, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
	}
	script((command, args) => {
		if (args[0] === "view") {
			switch (args[1]) {
				case "user-old":
				case "project-old":
					return { stdout: '"2.0.0"' };
				case "user-current":
				case "project-current":
					return { stdout: '"1.0.0"' };
				case "user-unknown":
					throw new Error("registry unavailable");
				default:
					throw new Error(`Unexpected lookup: ${args[1]}`);
			}
		}
		if (command === "npm" && args[0] === "install") return { stdout: "" };
		if (command === "git" && args[0] === "clone") {
			mkdirSync(args[2], { recursive: true });
			return { stdout: "" };
		}
		if (command === "git" && args[0] === "checkout") return { stdout: "" };
		if (command === "git" && args[0] === "fetch") return { stdout: "" };
		if (command === "git" && args[0] === "reset") return { stdout: "" };
		if (command === "git" && args[0] === "clean") return { stdout: "" };
		if (command === "git" && args[0] === "rev-parse") return { stdout: "aaaa\n" };
		if (command === "git" && args[0] === "symbolic-ref") return { stdout: "refs/remotes/origin/main\n" };
		if (command === "git" && args[0] === "remote") return { stdout: "" };
		throw new Error(`Unexpected spawn: ${command} ${args.join(" ")}`);
	});
	const sm = c.sm();
	sm.setPackages([
		"npm:user-old",
		"npm:user-current",
		"npm:user-unknown",
		"npm:user-pinned@1.0.0",
		"git:github.com/example/user-repo-a",
		"git:github.com/example/user-repo-b",
		"git:github.com/example/user-repo-pinned@v1",
	]);
	sm.setProjectPackages(["npm:project-old", "npm:project-current", "npm:project-missing", "git:github.com/example/project-repo-a"]);
	await c.pm(sm).update();
	// Object keys are not masked by the value-level norm(); mask here.
	const key = (e) => `${e.command} ${e.args.join(" ")}`.split(root).join("$T");
	const uniq = [...new Set(spawnLog.map(key))].sort();
	const counts = {};
	for (const e of spawnLog) counts[key(e)] = (counts[key(e)] ?? 0) + 1;
	return { __noSpawnLog: true, spawns: uniq, counts };
});

await scenario("flow-update-suggest-npm-prefix", async (c) => {
	const sm = c.sm();
	sm.setProjectPackages(["npm:example"]);
	try {
		await c.pm(sm).update("example");
		return { outcome: "resolved" };
	} catch (error) {
		return { outcome: error.message };
	}
});

await scenario("flow-update-suggest-git-prefix", async (c) => {
	const sm = c.sm();
	sm.setProjectPackages(["git:github.com/example/repo"]);
	try {
		await c.pm(sm).update("github.com/example/repo");
		return { outcome: "resolved" };
	} catch (error) {
		return { outcome: error.message };
	}
});

await scenario("flow-offline-resolve-skips-install", async (c) => {
	process.env.PI_OFFLINE = "1";
	try {
		const sm = c.sm();
		sm.setProjectPackages(["npm:missing-package", "git:github.com/example/missing-repo"]);
		const resolved = await c.pm(sm).resolve();
		const all = [...resolved.extensions, ...resolved.skills, ...resolved.prompts, ...resolved.themes];
		return { packageOriginCount: all.filter((r) => r.metadata.origin === "package").length };
	} finally {
		delete process.env.PI_OFFLINE;
	}
});

await scenario("flow-offline-temp-git-skip-refresh", async (c) => {
	process.env.PI_OFFLINE = "1";
	try {
		const manager = c.pm(c.sm());
		const gitSource = "git:github.com/example/repo";
		const parsed = manager.parseSource(gitSource);
		const installedPath = manager.getGitInstallPath(parsed, "temporary");
		mkdirSync(join(installedPath, "extensions"), { recursive: true });
		writeFileSync(join(installedPath, "extensions", "index.ts"), `${JS};`);
		return render(await manager.resolveExtensionSources([gitSource], { temporary: true }), c.dir);
	} finally {
		delete process.env.PI_OFFLINE;
	}
});

await scenario("flow-offline-resolve-no-npm-view", async (c) => {
	process.env.PI_OFFLINE = "1";
	try {
		c.mkdir(".pi/npm/node_modules/example/extensions");
		c.write(".pi/npm/node_modules/example/package.json", JSON.stringify({ name: "example", version: "1.0.0" }));
		c.write(".pi/npm/node_modules/example/extensions/index.ts", `${JS};`);
		const sm = c.sm();
		sm.setProjectPackages(["npm:example@^1.0.0"]);
		return render(await c.pm(sm).resolve(), c.dir);
	} finally {
		delete process.env.PI_OFFLINE;
	}
});

await scenario("flow-resolve-pinned-mismatch-reinstalls", async (c) => {
	c.mkdir(".pi/npm/node_modules/example");
	c.write(".pi/npm/node_modules/example/package.json", JSON.stringify({ name: "example", version: "1.0.0" }));
	script((_command, args) => {
		if (args[0] === "install") {
			writeFileSync(join(c.dir, ".pi", "npm", "node_modules", "example", "package.json"), JSON.stringify({ name: "example", version: "2.0.0" }));
		}
	});
	const sm = c.sm();
	sm.setProjectPackages(["npm:example@2.0.0"]);
	const resolved = await c.pm(sm).resolve();
	return render(resolved, c.dir);
});

await scenario("flow-check-updates-offline-empty", async (c) => {
	process.env.PI_OFFLINE = "1";
	try {
		return await c.pm(c.sm()).checkForAvailableUpdates();
	} finally {
		delete process.env.PI_OFFLINE;
	}
});

await scenario("flow-check-updates-reports-npm", async (c) => {
	c.mkdir(".pi/npm/node_modules/example");
	c.write(".pi/npm/node_modules/example/package.json", JSON.stringify({ name: "example", version: "1.0.0" }));
	script(() => ({ stdout: '"1.2.3"' }));
	const sm = c.sm();
	sm.setProjectPackages(["npm:example"]);
	return await c.pm(sm).checkForAvailableUpdates();
});

await scenario("flow-check-updates-newer-installed-skip", async (c) => {
	c.mkdir(".pi/npm/node_modules/example");
	c.write(".pi/npm/node_modules/example/package.json", JSON.stringify({ name: "example", version: "2.0.0" }));
	script(() => ({ stdout: '"1.9.0"' }));
	const sm = c.sm();
	sm.setProjectPackages(["npm:example"]);
	return await c.pm(sm).checkForAvailableUpdates();
});

await scenario("flow-check-updates-pinned-skip", async (c) => {
	c.mkdir(".pi/npm/node_modules/example");
	c.write(".pi/npm/node_modules/example/package.json", JSON.stringify({ name: "example", version: "1.0.0" }));
	const sm = c.sm();
	const manager = c.pm(sm);
	const parsedGitSource = manager.parseSource("git:github.com/example/repo@v1");
	const installedGitPath = manager.getGitInstallPath(parsedGitSource, "project");
	mkdirSync(installedGitPath, { recursive: true });
	sm.setProjectPackages(["npm:example@1.0.0", "git:github.com/example/repo@v1"]);
	return await manager.checkForAvailableUpdates();
});

await scenario("flow-latest-npm-version", async (c) => {
	script(() => ({ stdout: '"1.2.3"' }));
	return await c.pm(c.sm()).getLatestNpmVersion("example");
});

await scenario("flow-latest-npm-version-mise-argv", async (c) => {
	script(() => ({ stdout: '"1.2.3"' }));
	return await c.pm(c.sm({ npmCommand: ["mise", "exec", "node@20", "--", "npm"] })).getLatestNpmVersion("@scope/pkg");
});

await scenario("flow-latest-npm-version-array-max", async (c) => {
	script(() => ({ stdout: '["1.0.0","1.2.0","0.9.0"]' }));
	const manager = c.pm(c.sm());
	return {
		noRange: await manager.getLatestNpmVersion("example"),
		withRange: await manager.getLatestNpmVersion("example", "^1.0.0"),
	};
});

await scenario("flow-latest-npm-version-errors", async (c) => {
	const manager = c.pm(c.sm());
	const out = {};
	script(() => ({ stdout: "" }));
	try {
		out.empty = await manager.getLatestNpmVersion("example");
	} catch (error) {
		out.empty = { error: error.message };
	}
	script(() => ({ code: 1, stderr: "registry down" }));
	try {
		out.registryError = await manager.getLatestNpmVersion("example");
	} catch (error) {
		out.registryError = { error: error.message };
	}
	script(() => ({ stdout: '{"weird": 1}' }));
	try {
		out.nonString = await manager.getLatestNpmVersion("example");
	} catch (error) {
		out.nonString = { error: error.message };
	}
	script(() => ({ stdout: '["", 42, "1.0.0"]' }));
	try {
		out.mixedArray = await manager.getLatestNpmVersion("example");
	} catch (error) {
		out.mixedArray = { error: error.message };
	}
	return out;
});

await scenario("flow-installed-path-legacy-roots", async (c) => {
	const root20 = join(c.dir, "node20", "lib", "node_modules");
	mkdirSync(join(root20, "@scope", "pkg"), { recursive: true });
	const root22 = join(c.dir, "node22", "lib", "node_modules");
	script((command, args) => {
		if (command !== "mise") throw new Error(`unexpected command ${command}`);
		if (args[1] === "node@20") return { stdout: `${root20}\n` };
		if (args[1] === "node@22") return { stdout: `${root22}\n` };
		throw new Error(`unexpected args ${args.join(" ")}`);
	});
	const sm = c.sm({ npmCommand: ["mise", "exec", "node@20", "--", "npm"] });
	const manager = c.pm(sm);
	const first = manager.getInstalledPath("npm:@scope/pkg", "user");
	sm.setNpmCommand(["mise", "exec", "node@22", "--", "npm"]);
	const second = manager.getInstalledPath("npm:@scope/pkg", "user");
	return {
		first: first === undefined ? undefined : relTo(c.dir, first),
		second: second === undefined ? undefined : relTo(c.dir, second),
	};
});

await scenario("flow-installed-path-pnpm-list-legacy", async (c) => {
	const pnpmRoot = join(c.dir, "pnpm", "global", "v11");
	const packagePath = join(pnpmRoot, "20-hash", "node_modules", "pnpm-pkg");
	mkdirSync(join(packagePath, "extensions"), { recursive: true });
	writeFileSync(join(packagePath, "package.json"), JSON.stringify({ name: "pnpm-pkg", version: "1.0.0" }));
	writeFileSync(join(packagePath, "extensions", "index.ts"), `${JS};`);
	script((command, args) => {
		if (command !== "pnpm") throw new Error(`unexpected command ${command}`);
		if (args.join(" ") === "list -g --depth 0 --json") {
			return { stdout: JSON.stringify([{ path: pnpmRoot, dependencies: { "pnpm-pkg": { version: "1.0.0", path: packagePath } } }]) };
		}
		throw new Error(`unexpected args ${args.join(" ")}`);
	});
	const sm = c.sm({ npmCommand: ["pnpm"] });
	sm.setPackages(["npm:pnpm-pkg"]);
	const manager = c.pm(sm);
	const resolved = await manager.resolve();
	return {
		...render(resolved, c.dir),
		installedPath: relTo(c.dir, manager.getInstalledPath("npm:pnpm-pkg", "user")),
	};
});

await scenario("flow-installed-path-pnpm-list-wrapped", async (c) => {
	const pnpmRoot = join(c.dir, "pnpm", "global", "v11");
	const packagePath = join(pnpmRoot, "20-hash", "node_modules", "pnpm-pkg");
	mkdirSync(packagePath, { recursive: true });
	script((command, args) => {
		if (command !== "mise") throw new Error(`unexpected command ${command}`);
		if (args.join(" ") === "exec node@20 -- pnpm list -g --depth 0 --json") {
			return { stdout: JSON.stringify([{ path: pnpmRoot, dependencies: { "pnpm-pkg": { path: packagePath } } }]) };
		}
		throw new Error(`unexpected args ${args.join(" ")}`);
	});
	const sm = c.sm({ npmCommand: ["mise", "exec", "node@20", "--", "pnpm"] });
	const manager = c.pm(sm);
	const installed = manager.getInstalledPath("npm:pnpm-pkg", "user");
	return { installedPath: installed === undefined ? undefined : relTo(c.dir, installed) };
});

await scenario("flow-installed-path-pnpm-list-malformed", async (c) => {
	script(() => ({ stdout: "not json" }));
	const sm = c.sm({ npmCommand: ["pnpm"] });
	const manager = c.pm(sm);
	const installed = manager.getInstalledPath("npm:pnpm-pkg", "user");
	return { installedPath: installed === undefined ? undefined : installed };
});

await scenario("flow-managed-install-wins-no-reinstall", async (c) => {
	const packagePath = join(c.agentDir, "npm", "node_modules", "pnpm-pkg");
	mkdirSync(join(packagePath, "extensions"), { recursive: true });
	writeFileSync(join(packagePath, "package.json"), JSON.stringify({ name: "pnpm-pkg", version: "1.0.0" }));
	writeFileSync(join(packagePath, "extensions", "index.ts"), `${JS};`);
	script((command, args) => {
		if (command === "pnpm" && args[0] === "install") return { stdout: "" };
		if (command === "pnpm" && args[0] === "list") return { stdout: "[]" };
		if (command === "pnpm") return { stdout: "" };
		throw new Error(`Unexpected: ${command} ${args.join(" ")}`);
	});
	const sm = c.sm({ npmCommand: ["pnpm"] });
	sm.setPackages(["npm:pnpm-pkg"]);
	const manager = c.pm(sm);
	await manager.resolve();
	const installsAfterFirst = spawnLog.filter((e) => e.command === "pnpm" && e.args[0] === "install").length;
	await manager.resolve();
	const installsAfterSecond = spawnLog.filter((e) => e.command === "pnpm" && e.args[0] === "install").length;
	return { installsAfterFirst, installsAfterSecond };
});

await scenario("flow-progress-events-install-failure", async (c) => {
	const manager = c.pm(c.sm());
	const events = [];
	manager.setProgressCallback((event) => events.push(event));
	script(() => {
		throw new Error("simulated npm install failure");
	});
	try {
		await manager.install("npm:nonexistent-package@1.0.0");
		return { events, outcome: "resolved" };
	} catch (error) {
		return { events, outcome: error.message };
	}
});

await scenario("flow-progress-local-no-events", async (c) => {
	const manager = c.pm(c.sm());
	const events = [];
	manager.setProgressCallback((event) => events.push(event));
	c.write("ext.ts", JS);
	await manager.resolveExtensionSources([join(c.dir, "ext.ts")]);
	return { events: events.length };
});

await scenario("flow-progress-github-clone-attempt", async (c) => {
	const manager = c.pm(c.sm());
	const events = [];
	manager.setProgressCallback((event) => events.push(event));
	script(() => {
		throw new Error("simulated git clone failure");
	});
	try {
		await manager.install("https://github.com/nonexistent/repo");
		return { events, outcome: "resolved" };
	} catch (error) {
		return { events, outcome: error.message };
	}
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

process.env.HOME = previousHome;
writeFileSync(new URL("./core.oracle.json", import.meta.url), `${JSON.stringify(results, null, "\t")}\n`);
rmSync(root, { recursive: true, force: true });
console.log(`core.oracle.json written (${Object.keys(results).length} entries)`);
