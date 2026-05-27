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
	disabledAtVersion?: string;
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
			disabledAtVersion: entry.disabledAtVersion,
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
		fetchedAt: new Date().toISOString(),
	};
}

// Mods are re-resolved against the mod DB on every run. To be kind to the site,
// skip the page fetch for a mod whose locked entry is recent, still matches its
// config (same url and pin state), and whose zip is already on disk.
export const REFETCH_TTL_MS = 60 * 60 * 1000; // 1 hour

// A mod marked disabledAtVersion stays disabled while the best resolvable version is
// still that known-bad version or older; it re-enables the moment a newer one ships.
// Note compareVersions ignores pre-release suffixes, so a "-pre"/"-rc" bump to the same
// major.minor.patch does not count as newer.
export function isDisabledAtVersion(disabledAtVersion: string | undefined, resolvedVersion: string): boolean {
	if (!disabledAtVersion) return false;
	return compareVersions(resolvedVersion, disabledAtVersion) <= 0;
}

// A disabled mod stops contributing its requires. Returns the auto-dep ids now wanted
// only by disabled mods (every parent is disabled), so they can be uninstalled. Mods
// added directly by the user (addedBy "user") are never returned.
export function depsOrphanedByDisable(deps: Record<string, ResolvedDep>, disabled: Set<string>): string[] {
	const orphaned = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const [id, d] of Object.entries(deps)) {
			if (d.addedBy === "user" || orphaned.has(id)) continue;
			// A parent is gone if it is a disabled mod or a dep already orphaned this
			// pass, so a chain of deps collapses once the user mod at its root is disabled.
			if (d.requiredBy.length > 0 && d.requiredBy.every((parent) => disabled.has(parent) || orphaned.has(parent))) {
				orphaned.add(id);
				changed = true;
			}
		}
	}
	return [...orphaned];
}

export function isLockEntryFresh(
	dep: ResolvedDep,
	prior: LockMod | undefined,
	zipPresent: boolean,
	now: number,
): boolean {
	if (!prior || !prior.fetchedAt) return false;
	if (prior.url !== dep.url) return false;
	// Only cache settled matches. A "below"/"any" fallback means no build for the
	// current game version exists yet, so re-check every run: that is exactly the
	// state we poll for, and caching it would hide a newly published compatible
	// build for up to an hour.
	if (prior.matchKind !== "exact" && prior.matchKind !== "pinned") return false;
	// A pin added, removed, or retargeted (including an unsatisfied pin still on its
	// fallback version) must force a re-resolve so we keep chasing the wanted version.
	const lockedPin = prior.pinned ? prior.version : null;
	if ((dep.lockToVersion ?? null) !== lockedPin) return false;
	if (!zipPresent) return false;
	const age = now - Date.parse(prior.fetchedAt);
	return age >= 0 && age < REFETCH_TTL_MS;
}
