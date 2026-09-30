// Oracle stub for upstream `src/utils/version-check.ts` (network surface):
// self-update version lookups are scripted through
// `globalThis.__pmLatestRelease`; the pure comparison helpers mirror the
// upstream implementations using the vendored semver.
import { compare, valid } from "semver";

export interface LatestPiRelease {}

export function formatVersionCheckError(error) {
	return error instanceof Error ? error.message : String(error);
}

export function comparePackageVersions(leftVersion, rightVersion) {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion, currentVersion) {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(_currentVersion, _options) {
	return globalThis.__pmLatestRelease;
}
