import type { ModsConfig } from "./config";
import { modIdFromUrl } from "./config";
import { PinFailureError, ResolutionError } from "./errors";
import type { Lockfile, LockMod, MatchKind } from "./lockfile";
import type { ModPage, ModPageVersion } from "./scraper";
import { compareVersions, isVersionBelow, matchesExactly } from "./version";

export interface ResolvedDep {
	id: string;
	url: string;
	lockToVersion?: string;
	addedBy: string;
	requiredBy: string[];
}

export function buildDepTree(config: ModsConfig): Record<string, ResolvedDep> {
	const deps: Record<string, ResolvedDep> = {};

	for (const [id, entry] of Object.entries(config)) {
		deps[id] = {
			id,
			url: entry.url,
			lockToVersion: entry.lockToVersion,
			addedBy: "user",
			requiredBy: [],
		};
	}

	for (const [parentId, entry] of Object.entries(config)) {
		if (!entry.requires) continue;
		for (const depUrl of entry.requires) {
			const depId = modIdFromUrl(depUrl);
			const existing = deps[depId];
			if (existing) {
				if (!existing.requiredBy.includes(parentId)) {
					existing.requiredBy.push(parentId);
				}
			} else {
				deps[depId] = {
					id: depId,
					url: depUrl,
					addedBy: `dep-of:${parentId}`,
					requiredBy: [parentId],
				};
			}
		}
	}

	return deps;
}

export interface ResolveArgs {
	dep: ResolvedDep;
	page: ModPage;
	gameVersion: string;
	existingLock?: LockMod;
}

export interface ResolveResult {
	id: string;
	targetVersion: ModPageVersion;
	matchKind: MatchKind;
	warning: string | null;
}

export function resolveVersion(args: ResolveArgs): ResolveResult {
	const { dep, page, gameVersion, existingLock } = args;

	if (dep.lockToVersion) {
		const pinned = page.versions.find((v) => v.version === dep.lockToVersion);
		if (pinned) {
			return { id: dep.id, targetVersion: pinned, matchKind: "pinned", warning: null };
		}

		if (existingLock) {
			return {
				id: dep.id,
				targetVersion: {
					version: existingLock.version,
					gameVersions: existingLock.gameVersions,
					releaseDate: "",
					changelog: "",
					downloadUrl: existingLock.downloadUrl,
				},
				matchKind: "pinned",
				warning: `lockToVersion "${dep.lockToVersion}" not found on page; keeping currently installed ${existingLock.version}`,
			};
		}

		throw new PinFailureError(
			`lockToVersion "${dep.lockToVersion}" not found on page and no currently-installed version to fall back to`,
			dep.id,
		);
	}

	let candidates = page.versions.filter((v) => v.gameVersions.some((gv) => matchesExactly(gv, gameVersion)));
	let matchKind: MatchKind = "exact";
	let warning: string | null = null;

	if (!candidates.length) {
		candidates = page.versions.filter((v) => v.gameVersions.some((gv) => isVersionBelow(gv, gameVersion)));
		if (candidates.length) {
			matchKind = "below";
			warning = `No ${gameVersion} version available; using best-below-current`;
		}
	}

	if (!candidates.length) {
		candidates = page.versions.slice();
		if (candidates.length) {
			matchKind = "any";
			warning = `No ${gameVersion}-or-below version; using best available (may be newer or incompatible)`;
		}
	}

	if (!candidates.length) {
		throw new ResolutionError(`No versions found for mod`, dep.id);
	}

	candidates.sort((a, b) => -compareVersions(a.version, b.version));
	const target = candidates[0];

	if (!target.downloadUrl) {
		throw new ResolutionError(`Selected version ${target.version} has no download URL`, dep.id);
	}

	return { id: dep.id, targetVersion: target, matchKind, warning };
}

export function findAutoDepsToPrune(
	oldLock: Lockfile,
	newDeps: Record<string, ResolvedDep>,
): string[] {
	const prune: string[] = [];
	for (const [id, mod] of Object.entries(oldLock.mods)) {
		if (mod.addedBy === "user") continue;
		if (!newDeps[id]) {
			prune.push(id);
		}
	}
	return prune;
}

export function buildLockEntry(
	dep: ResolvedDep,
	resolved: ResolveResult,
	page: ModPage,
): LockMod {
	const { targetVersion, matchKind } = resolved;
	if (!targetVersion.downloadUrl) {
		throw new ResolutionError(`No downloadUrl for ${dep.id}@${targetVersion.version}`, dep.id);
	}
	return {
		title: page.title,
		url: dep.url,
		version: targetVersion.version,
		gameVersions: targetVersion.gameVersions,
		downloadUrl: targetVersion.downloadUrl,
		addedBy: dep.addedBy,
		requiredBy: dep.requiredBy.slice().sort(),
		pinned: !!dep.lockToVersion,
		matchKind,
	};
}
