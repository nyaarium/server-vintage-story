import { describe, expect, test } from "bun:test";
import type { ModsConfig } from "../lib/config";
import { PinFailureError, ResolutionError } from "../lib/errors";
import type { Lockfile, LockMod } from "../lib/lockfile";
import type { ModPage, ModPageVersion } from "../lib/scraper";
import {
	buildDepTree,
	buildLockEntry,
	findAutoDepsToPrune,
	resolveVersion,
	type ResolvedDep,
} from "../lib/resolver";

function ver(version: string, gameVersions: string[], downloadUrl?: string | null): ModPageVersion {
	return {
		version,
		gameVersions,
		releaseDate: "2026-01-01",
		changelog: "",
		downloadUrl: downloadUrl === undefined ? `https://cdn.example/${version}.zip` : downloadUrl,
	};
}

function page(title: string, versions: ModPageVersion[]): ModPage {
	return { title, versions };
}

function dep(id: string, url: string, extra: Partial<ResolvedDep> = {}): ResolvedDep {
	return { id, url, addedBy: "user", requiredBy: [], ...extra };
}

function lockMod(overrides: Partial<LockMod> = {}): LockMod {
	return {
		title: "X",
		url: "https://mods.vintagestory.at/x",
		version: "1.0.0",
		gameVersions: ["1.22.0"],
		downloadUrl: "https://cdn.example/x.zip",
		addedBy: "user",
		requiredBy: [],
		pinned: false,
		matchKind: "exact",
		...overrides,
	};
}

describe("buildDepTree", () => {
	test("user-only mods have empty requiredBy and addedBy=user", () => {
		const config: ModsConfig = {
			alpha: { url: "https://mods.vintagestory.at/alpha" },
			beta: { url: "https://mods.vintagestory.at/beta" },
		};
		const tree = buildDepTree(config);
		expect(Object.keys(tree).sort()).toEqual(["alpha", "beta"]);
		expect(tree.alpha.addedBy).toBe("user");
		expect(tree.alpha.requiredBy).toEqual([]);
		expect(tree.beta.addedBy).toBe("user");
	});

	test("mod with requires adds dep as auto-dep with requiredBy pointing back", () => {
		const config: ModsConfig = {
			parent: {
				url: "https://mods.vintagestory.at/parent",
				requires: ["https://mods.vintagestory.at/lib"],
			},
		};
		const tree = buildDepTree(config);
		expect(tree.lib).toBeDefined();
		expect(tree.lib.addedBy).toBe("dep-of:parent");
		expect(tree.lib.requiredBy).toEqual(["parent"]);
		expect(tree.parent.requiredBy).toEqual([]);
	});

	test("two mods requiring the same lib merge into one requiredBy list", () => {
		const config: ModsConfig = {
			a: {
				url: "https://mods.vintagestory.at/a",
				requires: ["https://mods.vintagestory.at/lib"],
			},
			b: {
				url: "https://mods.vintagestory.at/b",
				requires: ["https://mods.vintagestory.at/lib"],
			},
		};
		const tree = buildDepTree(config);
		expect(tree.lib.requiredBy.sort()).toEqual(["a", "b"]);
	});

	test("manually listed mod stays addedBy=user even when required by another", () => {
		const config: ModsConfig = {
			lib: { url: "https://mods.vintagestory.at/lib" },
			parent: {
				url: "https://mods.vintagestory.at/parent",
				requires: ["https://mods.vintagestory.at/lib"],
			},
		};
		const tree = buildDepTree(config);
		expect(tree.lib.addedBy).toBe("user");
		expect(tree.lib.requiredBy).toEqual(["parent"]);
	});

	test("derives numeric ids for /show/mod/N URLs", () => {
		const config: ModsConfig = {
			"7966": { url: "https://mods.vintagestory.at/show/mod/7966" },
		};
		const tree = buildDepTree(config);
		expect(tree["7966"]).toBeDefined();
		expect(tree["7966"].addedBy).toBe("user");
	});

	test("auto-dep does not inherit lockToVersion from parent", () => {
		const config: ModsConfig = {
			parent: {
				url: "https://mods.vintagestory.at/parent",
				lockToVersion: "1.0.0",
				requires: ["https://mods.vintagestory.at/lib"],
			},
		};
		const tree = buildDepTree(config);
		expect(tree.parent.lockToVersion).toBe("1.0.0");
		expect(tree.lib.lockToVersion).toBeUndefined();
	});
});

describe("resolveVersion — pinned", () => {
	test("pin hit returns that exact version with matchKind pinned, no warning", () => {
		const d = dep("m", "https://example/m", { lockToVersion: "1.2.0" });
		const p = page("M", [ver("1.3.0", ["1.22.0"]), ver("1.2.0", ["1.22.0"]), ver("1.1.0", ["1.22.0"])]);
		const r = resolveVersion({ dep: d, page: p, gameVersion: "1.22.0" });
		expect(r.targetVersion.version).toBe("1.2.0");
		expect(r.matchKind).toBe("pinned");
		expect(r.warning).toBeNull();
	});

	test("pin miss with existingLock falls back to installed version and sets warning", () => {
		const d = dep("m", "https://example/m", { lockToVersion: "1.2.0" });
		const p = page("M", [ver("1.3.0", ["1.22.0"]), ver("1.1.0", ["1.22.0"])]);
		const existingLock = lockMod({ version: "1.2.0", gameVersions: ["1.22.0"] });
		const r = resolveVersion({ dep: d, page: p, gameVersion: "1.22.0", existingLock });
		expect(r.targetVersion.version).toBe("1.2.0");
		expect(r.matchKind).toBe("pinned");
		expect(r.warning).not.toBeNull();
		expect(r.warning!).toContain("lockToVersion");
		expect(r.warning!).toContain("1.2.0");
	});

	test("pin miss with no existingLock throws PinFailureError", () => {
		const d = dep("m", "https://example/m", { lockToVersion: "9.9.9" });
		const p = page("M", [ver("1.0.0", ["1.22.0"])]);
		expect(() => resolveVersion({ dep: d, page: p, gameVersion: "1.22.0" })).toThrow(PinFailureError);
	});
});

describe("resolveVersion — fallback ladder", () => {
	test("picks highest exact-matching version when exact match exists", () => {
		const d = dep("m", "https://example/m");
		const p = page("M", [
			ver("2.0.0", ["1.22.0"]),
			ver("1.9.0", ["1.22.0"]),
			ver("1.8.0", ["1.20.0"]),
		]);
		const r = resolveVersion({ dep: d, page: p, gameVersion: "1.22.0" });
		expect(r.targetVersion.version).toBe("2.0.0");
		expect(r.matchKind).toBe("exact");
		expect(r.warning).toBeNull();
	});

	test("falls back to best-below-current when no exact match", () => {
		const d = dep("m", "https://example/m");
		const p = page("M", [
			ver("1.5.0", ["1.20.0"]),
			ver("1.4.0", ["1.19.0"]),
			ver("1.3.0", ["1.18.0"]),
		]);
		const r = resolveVersion({ dep: d, page: p, gameVersion: "1.22.0" });
		expect(r.targetVersion.version).toBe("1.5.0");
		expect(r.matchKind).toBe("below");
		expect(r.warning!).toContain("best-below-current");
	});

	test("falls back to any when no exact and no below", () => {
		const d = dep("m", "https://example/m");
		const p = page("M", [ver("2.0.0", ["1.23.0"]), ver("1.5.0", ["1.24.0"])]);
		const r = resolveVersion({ dep: d, page: p, gameVersion: "1.22.0" });
		expect(r.targetVersion.version).toBe("2.0.0");
		expect(r.matchKind).toBe("any");
		expect(r.warning!).toContain("best available");
	});

	test("handles version range gameVersions correctly", () => {
		const d = dep("m", "https://example/m");
		const p = page("M", [ver("1.0.0", ["1.22.0", "1.21.5"])]);
		const r = resolveVersion({ dep: d, page: p, gameVersion: "1.22.0" });
		expect(r.targetVersion.version).toBe("1.0.0");
		expect(r.matchKind).toBe("exact");
	});

	test("throws ResolutionError when page has no versions", () => {
		const d = dep("m", "https://example/m");
		const p = page("M", []);
		expect(() => resolveVersion({ dep: d, page: p, gameVersion: "1.22.0" })).toThrow(ResolutionError);
	});

	test("throws ResolutionError when selected version lacks downloadUrl", () => {
		const d = dep("m", "https://example/m");
		const p = page("M", [ver("1.0.0", ["1.22.0"], null)]);
		expect(() => resolveVersion({ dep: d, page: p, gameVersion: "1.22.0" })).toThrow(ResolutionError);
	});
});

describe("findAutoDepsToPrune", () => {
	test("auto-dep not in new tree gets pruned", () => {
		const oldLock: Lockfile = {
			_lockVersion: 1,
			_gameVersion: "1.22.0",
			_resolvedAt: "2026-04-21T00:00:00Z",
			mods: {
				oldDep: lockMod({ addedBy: "dep-of:removed", requiredBy: ["removed"] }),
			},
		};
		const newDeps: Record<string, ResolvedDep> = {};
		expect(findAutoDepsToPrune(oldLock, newDeps)).toEqual(["oldDep"]);
	});

	test("user-added mod not in new tree does NOT get pruned", () => {
		const oldLock: Lockfile = {
			_lockVersion: 1,
			_gameVersion: "1.22.0",
			_resolvedAt: "2026-04-21T00:00:00Z",
			mods: {
				userMod: lockMod({ addedBy: "user" }),
			},
		};
		const newDeps: Record<string, ResolvedDep> = {};
		expect(findAutoDepsToPrune(oldLock, newDeps)).toEqual([]);
	});

	test("auto-dep still in new tree is NOT pruned", () => {
		const oldLock: Lockfile = {
			_lockVersion: 1,
			_gameVersion: "1.22.0",
			_resolvedAt: "2026-04-21T00:00:00Z",
			mods: {
				lib: lockMod({ addedBy: "dep-of:parent", requiredBy: ["parent"] }),
			},
		};
		const newDeps: Record<string, ResolvedDep> = {
			lib: dep("lib", "https://example/lib", { addedBy: "dep-of:parent", requiredBy: ["parent"] }),
		};
		expect(findAutoDepsToPrune(oldLock, newDeps)).toEqual([]);
	});
});

describe("buildLockEntry", () => {
	test("populates all fields from dep + resolved + page", () => {
		const d = dep("m", "https://mods.vintagestory.at/m", { requiredBy: ["c", "a", "b"] });
		const target = ver("1.5.0", ["1.22.0", "1.21.0"]);
		const p = page("My Mod", [target]);
		const entry = buildLockEntry(d, { id: "m", targetVersion: target, matchKind: "exact", warning: null }, p);
		expect(entry.title).toBe("My Mod");
		expect(entry.url).toBe("https://mods.vintagestory.at/m");
		expect(entry.version).toBe("1.5.0");
		expect(entry.gameVersions).toEqual(["1.22.0", "1.21.0"]);
		expect(entry.downloadUrl).toBe(target.downloadUrl!);
		expect(entry.addedBy).toBe("user");
		expect(entry.requiredBy).toEqual(["a", "b", "c"]);
		expect(entry.pinned).toBe(false);
		expect(entry.matchKind).toBe("exact");
	});

	test("pinned flag reflects dep.lockToVersion presence", () => {
		const d = dep("m", "https://example/m", { lockToVersion: "1.0.0" });
		const target = ver("1.0.0", ["1.22.0"]);
		const p = page("M", [target]);
		const entry = buildLockEntry(d, { id: "m", targetVersion: target, matchKind: "pinned", warning: null }, p);
		expect(entry.pinned).toBe(true);
	});

	test("throws if target has no downloadUrl", () => {
		const d = dep("m", "https://example/m");
		const target = ver("1.0.0", ["1.22.0"], null);
		const p = page("M", [target]);
		expect(() =>
			buildLockEntry(d, { id: "m", targetVersion: target, matchKind: "exact", warning: null }, p),
		).toThrow();
	});
});
