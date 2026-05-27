import { readConfig } from "../lib/config";
import { DiscordNotifier, modLabel } from "../lib/discord";
import { isModUpdaterError } from "../lib/errors";
import { deleteZip, downloadZip, pruneOrphans, sleep, zipExistsFor } from "../lib/downloader";
import type { Lockfile, LockMod } from "../lib/lockfile";
import { emptyLockfile, readLockfile, removeMod, upsertMod, writeLockfile } from "../lib/lockfile";
import { log } from "../lib/logger";
import { buildDepTree, buildLockEntry, depsOrphanedByDisable, isDisabledAtVersion, isLockEntryFresh, resolveVersion } from "../lib/resolver";
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
	force?: boolean; // bypass the 1h refetch cache and re-resolve every mod
}

export async function runUpdate(opts: UpdateOptions): Promise<RunSummary> {
	const config = readConfig();
	const oldLock = readLockfile();
	// Clone the mods map rather than share oldLock's reference: pruning newLock below
	// must not mutate oldLock, which we still read afterward for removed-mod titles.
	const newLock: Lockfile = oldLock
		? {
				_lockVersion: oldLock._lockVersion,
				_gameVersion: opts.gameVersion,
				_resolvedAt: new Date().toISOString(),
				mods: { ...oldLock.mods },
			}
		: emptyLockfile(opts.gameVersion);

	const deps = buildDepTree(config);
	const depIds = Object.keys(deps).sort();

	const notifier = new DiscordNotifier({ title: "# Vintage Story - Mod Update" });
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

	// Re-resolving every mod hits the mod DB once per mod. Skip that fetch when the
	// locked entry is recent (< 1h), still matches its config, and its zip is present.
	// A game-version change or --force invalidates the whole cache.
	const cacheUsable = !opts.force && oldLock !== null && oldLock._gameVersion === opts.gameVersion;
	const now = Date.now();
	const skipped: string[] = [];
	const disabledUserMods = new Set<string>();

	let fetchCount = 0;
	let downloadCount = 0;
	try {
		for (const id of depIds) {
			const dep = deps[id];
			const prior = oldLock?.mods[id];

			if (cacheUsable && isLockEntryFresh(dep, prior, zipExistsFor(id), now)) {
				// requiredBy/addedBy can shift from edits to other mods, so refresh
				// them from the current dep tree even when reusing the locked version.
				newLock.mods[id] = { ...prior!, addedBy: dep.addedBy, requiredBy: dep.requiredBy.slice().sort() };
				skipped.push(id);
				continue;
			}

			if (fetchCount > 0) await sleep(1000);
			fetchCount++;

			log.info(`→ ${dep.id}`);

			const page = await fetchModPage(dep.url);
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

			if (isDisabledAtVersion(dep.disabledAtVersion, resolved.targetVersion.version)) {
				// Known-bad version still current: keep this mod disabled. Delete any
				// installed zip so the game cannot load it, drop it from the lockfile, and
				// stay silent. It re-enables (under "Newly installed") only once a newer
				// version resolves above disabledAtVersion.
				if (deleteZip(id)) log.info(`  removed ${id}.zip`);
				removeMod(newLock, id);
				writeLockfile(newLock);
				disabledUserMods.add(id);
				log.info(`  ${dep.id} disabled at ${dep.disabledAtVersion} (latest ${resolved.targetVersion.version})`);
				continue;
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

		// A disabled mod stops pulling its requires, so any auto-dep now wanted only by
		// disabled mods is uninstalled here, silently (same treatment as the disabled mod).
		const orphanedByDisable = depsOrphanedByDisable(deps, disabledUserMods);
		for (const id of orphanedByDisable) {
			if (deleteZip(id)) log.info(`  removed ${id}.zip (dep of disabled mod)`);
			if (newLock.mods[id]) {
				summary.autoRemoved.push(id);
				removeMod(newLock, id);
			}
			delete deps[id];
		}
		// Disabled mods and their orphaned deps must add no noise: drop their resolve warnings.
		const withheld = new Set<string>([...disabledUserMods, ...orphanedByDisable]);
		summary.warnings = summary.warnings.filter((w) => !withheld.has(w.id));

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

		// The CLI's top-level handler posts the failure to Discord. Attach the
		// partial-progress tally so that notice tells admins how far it got.
		if (err && typeof err === "object") {
			(err as { context?: string }).context =
				`Aborted after ${summary.updated.length} updated, ${summary.installed.length} installed (lockfile saved; rerun to resume)`;
		}
		throw err;
	}

	for (const block of buildUpdateBlocks(summary, (id) => oldLock?.mods[id]?.title)) notifier.post(block);
	await notifier.finalize();
	printSummary(summary, opts.gameVersion, newLock, skipped.length, disabledUserMods.size);

	return summary;
}

// Builds one atomic block per unit so the notifier can pack/split cleanly at
// section and entry boundaries. Bullets use "• " (not markdown "- ") because a
// "- " list loses its formatting when a chunk boundary falls mid-list.
export function buildUpdateBlocks(
	summary: RunSummary,
	titleOf: (id: string) => string | undefined = () => undefined,
): string[] {
	const blocks: string[] = [];
	if (summary.updated.length) {
		blocks.push("## Updated");
		for (const u of summary.updated) {
			let block = `**${u.title}** (\`${u.id}\`)  ${u.from} → ${u.to}`;
			if (u.changelog) {
				block += "\n" + u.changelog.split("\n").map((line) => `> ${line}`).join("\n");
			}
			blocks.push(block);
		}
	}
	if (summary.installed.length) {
		blocks.push("## Newly installed");
		for (const i of summary.installed) {
			blocks.push(`• ${i.title} (\`${i.id}\`)  ${i.version}`);
		}
	}
	if (summary.deletedZips.length) {
		blocks.push("## 🗑️ Deleted");
		for (const id of summary.deletedZips) {
			blocks.push(`• ${modLabel(id, titleOf(id))}`);
		}
	}
	return blocks;
}

function printSummary(summary: RunSummary, gameVersion: string, lock: Lockfile, skippedCount: number, disabledCount: number): void {
	log.section("Summary");
	log.info(`  game version: ${gameVersion}`);
	log.info(`  mods tracked: ${Object.keys(lock.mods).length}`);
	log.info(`  installed:    ${summary.installed.length}`);
	log.info(`  updated:      ${summary.updated.length}`);
	log.info(`  unchanged:    ${summary.unchanged.length}`);
	log.info(`  cached <1h:   ${skippedCount}`);
	log.info(`  auto-added:   ${summary.autoAdded.length}`);
	log.info(`  auto-removed: ${summary.autoRemoved.length}`);
	log.info(`  orphan zips:  ${summary.deletedZips.length}`);
	log.info(`  disabled:     ${disabledCount}`);
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
