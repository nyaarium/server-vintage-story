import { readConfig } from "../lib/config";
import { DiscordNotifier } from "../lib/discord";
import { isModUpdaterError } from "../lib/errors";
import { downloadZip, pruneOrphans, sleep, zipExistsFor } from "../lib/downloader";
import type { Lockfile, LockMod } from "../lib/lockfile";
import { emptyLockfile, readLockfile, removeMod, upsertMod, writeLockfile } from "../lib/lockfile";
import { log } from "../lib/logger";
import { buildDepTree, buildLockEntry, resolveVersion } from "../lib/resolver";
import { fetchModPage } from "../lib/scraper";
import { matchesExactly, matchesMinor } from "../lib/version";

interface RunSummary {
	installed: Array<{ id: string; title: string; version: string }>;
	updated: Array<{ id: string; title: string; from: string; to: string; changelog: string }>;
	unchanged: string[];
	autoAdded: string[];
	autoRemoved: string[];
	warnings: Array<{ id: string; message: string }>;
	deletedZips: string[];
}

export interface UpdateOptions {
	gameVersion: string;
}

export async function runUpdate(opts: UpdateOptions): Promise<RunSummary> {
	const config = readConfig();
	const oldLock = readLockfile();
	const newLock: Lockfile = oldLock
		? { ...oldLock, _gameVersion: opts.gameVersion, _resolvedAt: new Date().toISOString() }
		: emptyLockfile(opts.gameVersion);

	const deps = buildDepTree(config);
	const depIds = Object.keys(deps).sort();

	const notifier = new DiscordNotifier({ title: "## Vintage Story — Mod Update" });
	const summary: RunSummary = {
		installed: [],
		updated: [],
		unchanged: [],
		autoAdded: [],
		autoRemoved: [],
		warnings: [],
		deletedZips: [],
	};

	log.section(`Resolving ${depIds.length} mods for game ${opts.gameVersion}...`);

	let fetchCount = 0;
	let downloadCount = 0;
	try {
		for (const id of depIds) {
			const dep = deps[id];
			if (fetchCount > 0) await sleep(1000);
			fetchCount++;

			log.info(`→ ${dep.id}`);

			const page = await fetchModPage(dep.url);
			const prior = oldLock?.mods[id];
			const resolved = resolveVersion({
				dep,
				page,
				gameVersion: opts.gameVersion,
				existingLock: prior,
			});

			if (resolved.warning) {
				summary.warnings.push({ id, message: resolved.warning });
				log.warn(`  ${resolved.warning}`);
			}

			const entry: LockMod = buildLockEntry(dep, resolved, page);

			const versionChanged = !prior || prior.version !== entry.version;
			const zipMissing = !zipExistsFor(id);

			if (versionChanged || zipMissing) {
				if (downloadCount > 0) await sleep(5000);
				log.info(`  ⇣ downloading ${entry.version}`);
				await downloadZip(id, entry.downloadUrl);
				downloadCount++;
			}

			if (!prior) {
				if (dep.addedBy === "user") {
					summary.installed.push({ id, title: entry.title, version: entry.version });
				} else {
					summary.autoAdded.push(id);
				}
			} else if (prior.version !== entry.version) {
				summary.updated.push({
					id,
					title: entry.title,
					from: prior.version,
					to: entry.version,
					changelog: resolved.targetVersion.changelog,
				});
			} else {
				summary.unchanged.push(id);
			}

			upsertMod(newLock, id, entry);
			writeLockfile(newLock);
		}

		for (const id of Object.keys(newLock.mods)) {
			if (!deps[id]) {
				const removed = newLock.mods[id];
				if (removed.addedBy !== "user") {
					summary.autoRemoved.push(id);
				}
				removeMod(newLock, id);
			}
		}
		writeLockfile(newLock);

		const keepIds = new Set(Object.keys(newLock.mods));
		const pruned = pruneOrphans(keepIds);
		summary.deletedZips = pruned.deleted;
	} catch (err) {
		const reason = isModUpdaterError(err)
			? `${err.name}${err.modId ? ` [${err.modId}]` : ""}: ${err.message}`
			: String(err);
		log.err(reason);
		log.warn("Aborted. Lockfile saved with partial progress; rerun to resume.");

		// Notify Discord of the abort — partial progress is already persisted, so
		// admins should know the run stopped and where.
		notifier.post("## ⚠️ Update aborted");
		notifier.post(`Stopped at \`${isModUpdaterError(err) && err.modId ? err.modId : "?"}\`: ${reason}`);
		notifier.post(`Applied before abort: ${summary.updated.length} updated, ${summary.installed.length} installed`);
		try {
			await notifier.finalize();
		} catch {
			// best effort — never mask the original error
		}
		throw err;
	}

	for (const block of buildUpdateBlocks(summary)) notifier.post(block);
	await notifier.finalize();
	printSummary(summary, opts.gameVersion, newLock);

	return summary;
}

// Builds one atomic block per unit so the notifier can pack/split cleanly at
// section and entry boundaries. Bullets use "• " (not markdown "- ") because a
// "- " list loses its formatting when a chunk boundary falls mid-list.
export function buildUpdateBlocks(summary: RunSummary): string[] {
	const blocks: string[] = [];
	if (summary.updated.length) {
		blocks.push("## ✅ Updated");
		for (const u of summary.updated) {
			let block = `**${u.title}** (\`${u.id}\`)  ${u.from} → ${u.to}`;
			if (u.changelog) {
				block += "\n" + u.changelog.split("\n").map((line) => `> ${line}`).join("\n");
			}
			blocks.push(block);
		}
	}
	if (summary.installed.length) {
		blocks.push("## ✅ Newly installed");
		for (const i of summary.installed) {
			blocks.push(`• ${i.title} (\`${i.id}\`)  ${i.version}`);
		}
	}
	if (summary.deletedZips.length) {
		blocks.push("## ❌ Deleted");
		for (const id of summary.deletedZips) {
			blocks.push(`• ${id}`);
		}
	}
	return blocks;
}

function printSummary(summary: RunSummary, gameVersion: string, lock: Lockfile): void {
	log.section("Summary");
	log.info(`  game version: ${gameVersion}`);
	log.info(`  mods tracked: ${Object.keys(lock.mods).length}`);
	log.info(`  installed:    ${summary.installed.length}`);
	log.info(`  updated:      ${summary.updated.length}`);
	log.info(`  unchanged:    ${summary.unchanged.length}`);
	log.info(`  auto-added:   ${summary.autoAdded.length}`);
	log.info(`  auto-removed: ${summary.autoRemoved.length}`);
	log.info(`  orphan zips:  ${summary.deletedZips.length}`);
	log.info(`  warnings:     ${summary.warnings.length}`);

	const pinned: string[] = [];
	const majorMismatch: Array<{ id: string; title: string; versions: string }> = [];
	const patchMismatch: Array<{ id: string; title: string; versions: string }> = [];

	for (const [id, mod] of Object.entries(lock.mods)) {
		if (mod.pinned) pinned.push(`${mod.title} (${id}) @ ${mod.version}`);
		const minorOk = mod.gameVersions.some((v) => matchesMinor(v, gameVersion));
		const exactOk = mod.gameVersions.some((v) => matchesExactly(v, gameVersion));
		if (!minorOk) {
			majorMismatch.push({ id, title: mod.title, versions: mod.gameVersions.join(", ") });
		} else if (!exactOk) {
			patchMismatch.push({ id, title: mod.title, versions: mod.gameVersions.join(", ") });
		}
	}

	if (pinned.length) {
		log.section("🔒 Pinned:");
		for (const p of pinned) log.info(`  - ${p}`);
	}
	if (majorMismatch.length) {
		log.section("🚫 Major/minor mismatch:");
		for (const m of majorMismatch) log.info(`  - ${m.title} (${m.id})  supports: ${m.versions}`);
	}
	if (patchMismatch.length) {
		log.section("⚠  Patch mismatch:");
		for (const m of patchMismatch) log.info(`  - ${m.title} (${m.id})  supports: ${m.versions}`);
	}
	if (summary.warnings.length) {
		log.section("Warnings during resolve:");
		for (const w of summary.warnings) log.info(`  - [${w.id}] ${w.message}`);
	}
}
