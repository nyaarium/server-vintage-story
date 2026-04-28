import { LockfileError } from "../lib/errors";
import { downloadZip, pruneOrphans, sleep, zipExistsFor } from "../lib/downloader";
import { readLockfile } from "../lib/lockfile";
import { log } from "../lib/logger";

export interface InstallOptions {
	gameVersion: string;
}

export interface InstallSummary {
	downloaded: string[];
	trusted: string[];
	deletedZips: string[];
}

export async function runInstall(opts: InstallOptions): Promise<InstallSummary> {
	const lock = readLockfile();
	if (!lock) {
		throw new LockfileError(
			`No lockfile found. Run \`bun run cli.ts update\` first to resolve mods.`,
		);
	}

	if (lock._gameVersion !== opts.gameVersion) {
		log.warn(
			`Lockfile was resolved against ${lock._gameVersion}, but current game version is ${opts.gameVersion}.`,
		);
		log.warn(`Installing from lock as-is. Run 'update' to re-resolve for ${opts.gameVersion}.`);
	}

	const summary: InstallSummary = { downloaded: [], trusted: [], deletedZips: [] };
	const ids = Object.keys(lock.mods).sort();

	log.section(`Installing ${ids.length} mods from lockfile...`);

	let downloadsThisRun = 0;
	for (const id of ids) {
		const mod = lock.mods[id];
		if (zipExistsFor(id)) {
			summary.trusted.push(id);
			continue;
		}
		if (!mod.downloadUrl) {
			throw new LockfileError(
				`Mod '${id}' has no downloadUrl in lockfile. Run \`bun run cli.ts update\` to resolve.`,
				id,
			);
		}
		if (downloadsThisRun > 0) await sleep(5000);
		log.info(`⇣ ${id} ${mod.version}`);
		await downloadZip(id, mod.downloadUrl);
		summary.downloaded.push(id);
		downloadsThisRun++;
	}

	const keepIds = new Set(ids);
	const pruned = pruneOrphans(keepIds);
	summary.deletedZips = pruned.deleted;

	log.section("Summary");
	log.info(`  downloaded:  ${summary.downloaded.length}`);
	log.info(`  trusted:     ${summary.trusted.length}`);
	log.info(`  orphan zips: ${summary.deletedZips.length}`);

	return summary;
}
