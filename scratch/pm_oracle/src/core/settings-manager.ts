// Oracle stub for upstream `src/core/settings-manager.ts`.
//
// Only the surface consumed by `core/package-manager.ts` and
// `package-manager-cli.ts` is modeled, with in-memory storage mirroring
// `SettingsManager.inMemory()` / `SettingsManager.create()` semantics for
// that surface: global settings always load; project settings load only when
// project-trusted. `create()` reads plain `settings.json` files (no lock,
// no migration, no error collection — the real file-backed manager is a
// later slice; the Rust port consumes it through a trait seam).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_DIR_NAME = ".pi";

function readSettingsFile(path) {
	try {
		if (!existsSync(path)) return {};
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

export type PackageSource = string | Record<string, unknown>;

export class SettingsManager {
	constructor() {
		this.globalSettings = {};
		this.projectSettings = {};
		this.projectTrusted = true;
	}

	static inMemory(settings = {}, options = {}) {
		const manager = new SettingsManager();
		manager.globalSettings = structuredClone(settings);
		manager.projectTrusted = options.projectTrusted ?? true;
		return manager;
	}

	static create(cwd, agentDir, options = {}) {
		const manager = new SettingsManager();
		manager.globalSettings = readSettingsFile(join(agentDir, "settings.json"));
		manager.projectSettings = readSettingsFile(join(cwd, CONFIG_DIR_NAME, "settings.json"));
		manager.projectTrusted = options.projectTrusted ?? true;
		return manager;
	}

	getGlobalSettings() {
		return this.globalSettings;
	}

	getProjectSettings() {
		return this.projectTrusted ? this.projectSettings : {};
	}

	isProjectTrusted() {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted) {
		this.projectTrusted = trusted;
	}

	getNpmCommand() {
		return this.globalSettings.npmCommand ? [...this.globalSettings.npmCommand] : undefined;
	}

	setNpmCommand(command) {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
	}

	getPackages() {
		return [...(this.globalSettings.packages ?? [])];
	}

	setPackages(packages) {
		this.globalSettings.packages = structuredClone(packages);
	}

	setProjectPackages(packages) {
		this.projectSettings.packages = structuredClone(packages);
	}

	getExtensionPaths() {
		return [...(this.globalSettings.extensions ?? [])];
	}

	setExtensionPaths(paths) {
		this.globalSettings.extensions = [...paths];
	}

	setProjectExtensionPaths(paths) {
		this.projectSettings.extensions = [...paths];
	}

	getSkillPaths() {
		return [...(this.globalSettings.skills ?? [])];
	}

	setSkillPaths(paths) {
		this.globalSettings.skills = [...paths];
	}

	setProjectSkillPaths(paths) {
		this.projectSettings.skills = [...paths];
	}

	getPromptTemplatePaths() {
		return [...(this.globalSettings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths) {
		this.globalSettings.prompts = [...paths];
	}

	setProjectPromptTemplatePaths(paths) {
		this.projectSettings.prompts = [...paths];
	}

	getThemePaths() {
		return [...(this.globalSettings.themes ?? [])];
	}

	setThemePaths(paths) {
		this.globalSettings.themes = [...paths];
	}

	setProjectThemePaths(paths) {
		this.projectSettings.themes = [...paths];
	}

	getDefaultProjectTrust() {
		return this.globalSettings.defaultProjectTrust;
	}

	drainErrors() {
		return [];
	}
}
