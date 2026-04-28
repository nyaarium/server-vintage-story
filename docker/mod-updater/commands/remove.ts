import { readConfig, writeConfig } from "../lib/config";
import { ConfigError, LockfileError } from "../lib/errors";
import { deleteZip } from "../lib/downloader";
import type { Lockfile } from "../lib/lockfile";
import { readLockfile, removeMod, writeLockfile } from "../lib/lockfile";
import { log } from "../lib/logger";
import { buildDepTree, findAutoDepsToPrune } from "../lib/resolver";

export interface RemoveOptions {
	id: string;
	gameVersion: string;
}

export interface RemoveResult {
	removed: string[];
	deletedZips: string[];
	staleRequiredByUpdated: number;
}

export async function runRemove(opts: RemoveOptions): Promise<RemoveResult> {
	const config = readConfig();
	if (!config[opts.id]) {
		throw new ConfigError(
			`Mod "${opts.id}" is not in config. (Auto-installed dependencies cannot be removed directly — remove their parent mod instead.)`,
		);
	}

	const oldLock = readLockfile();
	if (!oldLock) {
		throw new LockfileError(
			`No lockfile present. Edit mods.json5 directly to remove the entry, or run \`update\` first.`,
		);
	}

	const newConfig = { ...config };
	delete newConfig[opts.id];

	const newDeps = buildDepTree(newConfig);
	const newLock: Lockfile = {
		...oldLock,
		_gameVersion: opts.gameVersion,
		_resolvedAt: new Date().toISOString(),
		mods: { ...oldLock.mods },
	};

	const cascading = findAutoDepsToPrune(oldLock, newDeps);
	const allToRemove = [opts.id, ...cascading];

	log.section(`Removing ${opts.id}`);
	if (cascading.length) {
		log.info(`  Cascading removals (no longer required by anything):`);
		for (const c of cascading) log.info(`    - ${c}`);
	}

	const deletedZips: string[] = [];
	for (const id of allToRemove) {
		removeMod(newLock, id);
		if (deleteZip(id)) {
			deletedZips.push(id);
		}
	}

	let refreshed = 0;
	for (const [keptId, mod] of Object.entries(newLock.mods)) {
		const dep = newDeps[keptId];
		if (!dep) continue;
		const newReqBy = dep.requiredBy.slice().sort();
		if (newReqBy.length !== mod.requiredBy.length || newReqBy.some((v, i) => v !== mod.requiredBy[i])) {
			mod.requiredBy = newReqBy;
			refreshed++;
		}
	}

	writeConfig(newConfig);
	writeLockfile(newLock);

	log.section("Done");
	log.ok(`Removed ${allToRemove.length} mod(s); deleted ${deletedZips.length} zip(s).`);
	if (refreshed) log.info(`  Refreshed requiredBy on ${refreshed} surviving lock entries.`);

	return {
		removed: allToRemove,
		deletedZips,
		staleRequiredByUpdated: refreshed,
	};
}
