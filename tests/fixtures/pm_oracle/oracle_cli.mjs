// CLI oracle capture for `package-manager-cli.ts` (byte-identical upstream
// copy) driving the exported `handlePackageCommand` / `handleConfigCommand`
// under node with:
//   - the scriptable child-process stub (no real npm/git spawns)
//   - the stubbed version-check (no network; `__pmLatestRelease` scriptable)
//   - the stubbed settings manager reading plain settings.json files
//   - process.exit stubbed to a sentinel so `handleConfigCommand` returns
// Writes cli.oracle.json with temp paths normalized to "$T" and the harness
// script path to "$SCRIPT".
//
// chalk runs with a non-TTY stdout/stderr (piped), so all captured text is
// the plain (colorless) rendering — that is the byte-exactness target.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { handlePackageCommand, handleConfigCommand } = await import(
	new URL("./src/package-manager-cli.ts", import.meta.url)
);

const root = mkdtempSync(join(tmpdir(), "pm-cli-oracle-"));
const scriptPath = new URL("./oracle_cli.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function norm(value) {
	if (typeof value === "string") return value.split(root).join("$T").split(scriptPath).join("$SCRIPT");
	if (Array.isArray(value)) return value.map(norm);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = norm(v);
		return out;
	}
	return value;
}

// ---------------------------------------------------------------------------
// Environment / IO capture harness
// ---------------------------------------------------------------------------

const previousEnv = { HOME: process.env.HOME };
const results = {};

function capture(name, fn) {
	const stdout = [];
	const stderr = [];
	const origLog = console.log;
	const origError = console.error;
	const origWrite = process.stdout.write;
	const origExit = process.exit;
	let exitCode = process.exitCode;
	process.exitCode = 0;
	let exitCalled;
	console.log = (...args) => stdout.push(args.map(String).join(" "));
	console.error = (...args) => stderr.push(args.map(String).join(" "));
	process.stdout.write = (chunk) => {
		stdout.push(String(chunk));
		return true;
	};
	process.exit = (code) => {
		throw { __exit: code ?? 0 };
	};
	try {
		const value = fn();
		if (value && typeof value.then === "function") {
			throw new Error("capture() received a promise; use captureAsync");
		}
		results[name] = norm({ handled: value, exitCode: process.exitCode, exitCalled, stdout, stderr });
	} catch (error) {
		if (error && typeof error === "object" && "__exit" in error) {
			exitCalled = error.__exit;
			results[name] = norm({ handled: true, exitCode: process.exitCode, exitCalled: error.__exit, stdout, stderr });
		} else {
			results[name] = norm({ threw: error && error.message ? error.message : String(error), stdout, stderr });
		}
	} finally {
		console.log = origLog;
		console.error = origError;
		process.stdout.write = origWrite;
		process.exit = origExit;
		process.exitCode = exitCode;
	}
}

function captureAsync(name, fn) {
	capture(name, () => {
		throw { __async: fn };
	});
	// Rerun properly as async below.
}

// eslint-disable-next-line no-inner-declarations
async function acapture(name, fn) {
	const stdout = [];
	const stderr = [];
	const origLog = console.log;
	const origError = console.error;
	const origWrite = process.stdout.write;
	const origExit = process.exit;
	const savedExitCode = process.exitCode;
	process.exitCode = 0;
	console.log = (...args) => stdout.push(args.map(String).join(" "));
	console.error = (...args) => stderr.push(args.map(String).join(" "));
	process.stdout.write = (chunk) => {
		stdout.push(String(chunk));
		return true;
	};
	process.exit = (code) => {
		throw { __exit: code ?? 0 };
	};
	try {
		let value;
		try {
			value = await fn();
		} catch (error) {
			if (error && typeof error === "object" && "__exit" in error) {
				results[name] = norm({ handled: true, exitCode: process.exitCode, exitCalled: error.__exit, stdout, stderr });
				return;
			}
			results[name] = norm({ threw: error && error.message ? error.message : String(error), stdout, stderr });
			return;
		}
		results[name] = norm({ handled: value, exitCode: process.exitCode, exitCalled: null, stdout, stderr });
	} finally {
		console.log = origLog;
		console.error = origError;
		process.stdout.write = origWrite;
		process.exit = origExit;
		process.exitCode = savedExitCode;
	}
}

// ---------------------------------------------------------------------------
// Spawn stub hook (core child-process stub reads these globals)
// ---------------------------------------------------------------------------
globalThis.__pmSpawnLog = [];
globalThis.__pmSpawnScript = undefined;
globalThis.__pmLatestRelease = undefined;

// ---------------------------------------------------------------------------
// Help battery
// ---------------------------------------------------------------------------

for (const command of ["install", "remove", "update", "list"]) {
	await acapture(`help/${command}`, () => handlePackageCommand([command, "--help"]));
	await acapture(`help/${command}-h`, () => handlePackageCommand([command, "-h"]));
}
await acapture("help/config", () => handleConfigCommand(["config", "--help"]));
await acapture("help/config-h", () => handleConfigCommand(["config", "-h"]));

// ---------------------------------------------------------------------------
// Argument-error battery (no fs/env dependencies beyond cwd/agentDir)
// ---------------------------------------------------------------------------

const env = join(root, "batteries");
const agentDir = join(env, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.HOME = env;
process.env.PI_CODING_AGENT_DIR = agentDir;

const ERROR_CASES = [
	["install"],
	["install", "--bogus"],
	["install", "-x"],
	["install", "--extension"],
	["install", "a", "b"],
	["remove"],
	["remove", "--all"],
	["remove", "--self"],
	["remove", "--models"],
	["remove", "npm:x", "npm:y"],
	["remove", "--extension"],
	["remove", "--extension", "value"],
	["list", "--force"],
	["list", "extra"],
	["update", "-l"],
	["update", "--local"],
	["update", "--all", "--self"],
	["update", "--all", "--extensions"],
	["update", "--all", "--models"],
	["update", "--all", "--extension", "x"],
	["update", "--all", "positional"],
	["update", "--models", "--self"],
	["update", "--models", "--extensions"],
	["update", "--models", "--all"],
	["update", "--models", "--extension", "x"],
	["update", "--models", "positional"],
	["update", "--extension"],
	["update", "--extension", "-x"],
	["update", "--extension", "a", "--extension", "b"],
	["update", "--extension", "a", "--self"],
	["update", "--extension", "a", "--extensions"],
	["update", "--extension", "a", "--all"],
	["update", "--extension", "a", "positional"],
	["update", "src", "--self"],
	["update", "src", "--extensions"],
	["update", "src", "--all"],
	["uninstall"],
];
for (const args of ERROR_CASES) {
	await acapture(`errors/${args.join(" ")}`, () => handlePackageCommand(args));
}
await acapture("errors/config-unknown-option", () => handleConfigCommand(["config", "--bogus"]));
await acapture("errors/config-unknown-short", () => handleConfigCommand(["config", "-z"]));
await acapture("errors/config-unexpected-argument", () => handleConfigCommand(["config", "positional"]));
await acapture("unhandled/bogus-command", () => handlePackageCommand(["bogus"]));
await acapture("unhandled/empty", () => handlePackageCommand([]));

// ---------------------------------------------------------------------------
// Flow scenarios
// ---------------------------------------------------------------------------

function scenarioDir(name) {
	const dir = join(root, name.replace(/[^a-zA-Z0-9-]+/g, "-"));
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.HOME = dir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_OFFLINE;
	delete process.env.PI_MANAGED_INSTALL_ROOT;
	delete process.env.PI_PACKAGE_DIR;
	globalThis.__pmSpawnLog = [];
	globalThis.__pmSpawnScript = undefined;
	globalThis.__pmLatestRelease = undefined;
	return { dir, agentDir };
}

await acapture("flow/list-empty", () => handlePackageCommand(["list"]));

{
	const { dir, agentDir } = scenarioDir("flow-list-packages");
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: ["npm:user-pkg", { source: "npm:filtered-pkg", extensions: [] }, "git:github.com/user/repo", "./missing-local"] }),
	);
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:project-pkg"] }));
	mkdirSync(join(agentDir, "npm", "node_modules", "user-pkg"), { recursive: true });
	writeFileSync(join(agentDir, "npm", "node_modules", "user-pkg", "package.json"), JSON.stringify({ name: "user-pkg", version: "1.0.0" }));
	globalThis.__pmSpawnScript = (_command, args) => {
		if (args[0] === "root") return { stdout: `${join(dir, "npm-legacy-root")}\n` };
		if (args[0] === "list") return { stdout: "[]" };
		throw new Error(`unexpected spawn ${args.join(" ")}`);
	};
	await acapture("flow/list-packages", () => handlePackageCommand(["list", "--approve"]));
}

{
	scenarioDir("flow-install-local-untrusted");
	await acapture("flow/install-local-untrusted", () => handlePackageCommand(["install", "./pkg", "-l"]));
}

{
	scenarioDir("flow-remove-local-untrusted");
	await acapture("flow/remove-local-untrusted", () => handlePackageCommand(["remove", "./pkg", "-l"]));
}

{
	const { dir } = scenarioDir("flow-remove-unknown-package");
	await acapture("flow/remove-unknown-package", () => handlePackageCommand(["remove", "npm:not-installed"]));
}

{
	const { dir, agentDir } = scenarioDir("flow-update-suggestion");
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:example"] }));
	await acapture("flow/update-suggestion-npm", () => handlePackageCommand(["update", "example", "--approve"]));
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ packages: ["git:github.com/example/repo"] }));
	await acapture("flow/update-suggestion-git", () => handlePackageCommand(["update", "github.com/example/repo", "--approve"]));
}

{
	scenarioDir("flow-update-models");
	await acapture("flow/update-models", () => handlePackageCommand(["update", "--models"]));
}

{
	scenarioDir("flow-update-self-uptodate");
	globalThis.__pmLatestRelease = { version: "0.85.1" };
	await acapture("flow/update-self-uptodate", () => handlePackageCommand(["update"]));
}

{
	scenarioDir("flow-update-self-uptodate-explicit");
	globalThis.__pmLatestRelease = { version: "0.85.1" };
	await acapture("flow/update-self-uptodate-explicit", () => handlePackageCommand(["update", "pi"]));
}

{
	scenarioDir("flow-update-self-older-release");
	globalThis.__pmLatestRelease = { version: "0.1.0" };
	await acapture("flow/update-self-older-release", () => handlePackageCommand(["update", "--self"]));
}

{
	scenarioDir("flow-update-self-newer-unmanaged");
	globalThis.__pmLatestRelease = { version: "0.86.0" };
	await acapture("flow/update-self-newer-unmanaged", () => handlePackageCommand(["update", "--self"]));
}

{
	scenarioDir("flow-update-self-newer-note");
	globalThis.__pmLatestRelease = { version: "0.86.0", note: "Release notes heading\n- bullet one" };
	await acapture("flow/update-self-newer-note", () => handlePackageCommand(["update", "--self"]));
}

{
	const { dir } = scenarioDir("flow-update-managed-marker-missing");
	const installRoot = join(dir, "install");
	const releaseDir = join(installRoot, "releases", "0.85.1", "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(releaseDir, { recursive: true });
	process.env.PI_MANAGED_INSTALL_ROOT = installRoot;
	process.env.PI_PACKAGE_DIR = releaseDir;
	await acapture("flow/update-managed-marker-missing", () => handlePackageCommand(["update", "--self"]));
}

{
	const { dir } = scenarioDir("flow-update-managed-force-rejected");
	const installRoot = join(dir, "install");
	const releaseDir = join(installRoot, "releases", "0.85.1", "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(releaseDir, { recursive: true });
	writeFileSync(join(installRoot, "managed-install.json"), JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }));
	process.env.PI_MANAGED_INSTALL_ROOT = installRoot;
	process.env.PI_PACKAGE_DIR = releaseDir;
	globalThis.__pmLatestRelease = { version: "0.86.0" };
	await acapture("flow/update-managed-force-rejected", () => handlePackageCommand(["update", "--self", "--force"]));
}

{
	const { dir } = scenarioDir("flow-update-managed-uptodate");
	const installRoot = join(dir, "install");
	const releaseDir = join(installRoot, "releases", "0.85.1", "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(releaseDir, { recursive: true });
	writeFileSync(join(installRoot, "managed-install.json"), JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }));
	process.env.PI_MANAGED_INSTALL_ROOT = installRoot;
	process.env.PI_PACKAGE_DIR = releaseDir;
	globalThis.__pmLatestRelease = { version: "0.85.1" };
	await acapture("flow/update-managed-uptodate", () => handlePackageCommand(["update"]));
}

{
	const { dir } = scenarioDir("flow-update-managed-already-installed");
	const installRoot = join(dir, "install");
	const releaseDir = join(installRoot, "releases", "0.86.0", "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(releaseDir, { recursive: true });
	writeFileSync(join(releaseDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.86.0" }));
	writeFileSync(join(installRoot, "managed-install.json"), JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }));
	process.env.PI_MANAGED_INSTALL_ROOT = installRoot;
	process.env.PI_PACKAGE_DIR = releaseDir;
	globalThis.__pmLatestRelease = { version: "0.86.0" };
	await acapture("flow/update-managed-already-installed", () => handlePackageCommand(["update"]));
	await acapture("flow/update-managed-activate", () => handlePackageCommand(["update"]));
}

{
	const { dir } = scenarioDir("flow-update-managed-smoke-ok");
	const installRoot = join(dir, "install");
	const releaseDir = join(installRoot, "releases", "0.86.0", "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(releaseDir, { recursive: true });
	writeFileSync(join(releaseDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.86.0" }));
	writeFileSync(join(installRoot, "managed-install.json"), JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }));
	process.env.PI_MANAGED_INSTALL_ROOT = installRoot;
	process.env.PI_PACKAGE_DIR = releaseDir;
	globalThis.__pmLatestRelease = { version: "0.86.0" };
	globalThis.__pmSpawnScript = (command, args) => {
		if (args[0] === "--version") return { stdout: "0.86.0\n" };
		throw new Error(`unexpected spawn ${command} ${args.join(" ")}`);
	};
	await acapture("flow/update-managed-smoke-ok", () => handlePackageCommand(["update"]));
}

{
	const { dir, agentDir } = scenarioDir("flow-install-spawn-failure");
	globalThis.__pmSpawnScript = () => {
		throw new Error("simulated npm install failure");
	};
	await acapture("flow/install-spawn-failure", () => handlePackageCommand(["install", "npm:nonexistent@1.0.0"]));
}

{
	scenarioDir("flow-install-git-clone-failure");
	globalThis.__pmSpawnScript = (command, args) => {
		if (command === "git" && args[0] === "clone") {
			mkdirSync(args[2], { recursive: true });
			throw new Error("simulated git clone failure");
		}
	};
	await acapture("flow/install-git-clone-failure", () => handlePackageCommand(["install", "git:github.com/nonexistent/repo"]));
}

{
	scenarioDir("flow-offline-arguments");
	process.env.PI_OFFLINE = "1";
	await acapture("flow/offline-list", () => handlePackageCommand(["list"]));
	process.env.PI_OFFLINE = undefined;
}

await acapture("flow/config-untrusted-nonlocal", () => {
	const { dir } = scenarioDir("flow-config-untrusted-nonlocal");
	return handleConfigCommand(["config"]);
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

process.env.HOME = previousEnv.HOME;
writeFileSync(new URL("./cli.oracle.json", import.meta.url), `${JSON.stringify(results, null, "\t")}\n`);
rmSync(root, { recursive: true, force: true });
console.log(`cli.oracle.json written (${Object.keys(results).length} entries)`);
