import { readConfig } from "../lib/config";
import { DiscordNotifier, modLabel } from "../lib/discord";
import { isModUpdaterError } from "../lib/errors";
import { listExistingZipIds, sleep, zipExistsFor } from "../lib/downloader";
import { readLockfile } from "../lib/lockfile";
import { log } from "../lib/logger";
import { buildDepTree, depsOrphanedByDisable, findAutoDepsToPrune, isDisabledAtVersion, isLockEntryFresh, resolveVersion } from "../lib/resolver";
import { fetchModPage } from "../lib/scraper";

export interface OutdatedOptions {
	gameVersion: string;
	force?: boolean; // bypass the 1h refetch cache and re-check every mod
}

export interface PlannedChange {
	id: string;
	title: string;
	from: string | null;
	to: string;
	matchKind: string;
}

export interface OutdatedSummary {
	wouldInstall: PlannedChange[];
	wouldUpdate: PlannedChange[];
	unchanged: string[];
	wouldAutoRemove: string[];
	wouldOrphanPrune: string[];
	warnings: Array<{ id: string; message: string }>;
	hasChanges: boolean;
}

export async function runOutdated(opts: OutdatedOptions): Promise<OutdatedSummary> {
	const config = readConfig();
	const oldLock = readLockfile();
	const deps = buildDepTree(config);
	const depIds = Object.keys(deps).sort();

	const summary: OutdatedSummary = {
		wouldInstall: [],
		wouldUpdate: [],
		unchanged: [],
		wouldAutoRemove: [],
		wouldOrphanPrune: [],
		warnings: [],
		hasChanges: false,
	};

	log.section(`Checking ${depIds.length} mods against ${opts.gameVersion}...`);

	// Same 1h refetch skip as `update`: avoid re-checking a mod whose locked entry is
	// recent, still matches its config, and whose zip is on disk. `outdated` does not
	// write the lockfile, so freshness here reflects the last `update` run.
	const cacheUsable = !opts.force && oldLock !== null && oldLock._gameVersion === opts.gameVersion;
	const now = Date.now();
	const skipped: string[] = [];
	const disabledUserMods = new Set<string>();

	let fetchCount = 0;
	for (const id of depIds) {
		const dep = deps[id];
		const prior = oldLock?.mods[id];

		if (cacheUsable && isLockEntryFresh(dep, prior, zipExistsFor(id), now)) {
			skipped.push(id);
			continue;
		}

		if (fetchCount > 0) await sleep(1000);
		fetchCount++;

		try {
			const page = await fetchModPage(dep.url);
			const resolved = resolveVersion({
				dep,
				page,
				gameVersion: opts.gameVersion,
				existingLock: prior,
			});

			if (resolved.warning) {
				summary.warnings.push({ id, message: resolved.warning });
			}

			if (isDisabledAtVersion(dep.disabledAtVersion, resolved.targetVersion.version)) {
				disabledUserMods.add(id);
				continue;
			}

			if (!prior) {
				summary.wouldInstall.push({
					id,
					title: page.title,
					from: null,
					to: resolved.targetVersion.version,
					matchKind: resolved.matchKind,
				});
			} else if (prior.version !== resolved.targetVersion.version) {
				summary.wouldUpdate.push({
					id,
					title: page.title,
					from: prior.version,
					to: resolved.targetVersion.version,
					matchKind: resolved.matchKind,
				});
			} else {
				summary.unchanged.push(id);
			}
		} catch (err) {
			const msg = isModUpdaterError(err) ? `${err.name}: ${err.message}` : String(err);
			summary.warnings.push({ id, message: `fetch/resolve failed: ${msg}` });
		}
	}

	// Disabled mods, and any auto-dep now wanted only by them, are withheld from every
	// preview section so nothing about a still-disabled mod reaches the channel.
	const orphanedByDisable = new Set(depsOrphanedByDisable(deps, disabledUserMods));
	const withheld = new Set<string>([...disabledUserMods, ...orphanedByDisable]);
	for (const id of orphanedByDisable) delete deps[id];
	summary.wouldInstall = summary.wouldInstall.filter((c) => !withheld.has(c.id));
	summary.wouldUpdate = summary.wouldUpdate.filter((c) => !withheld.has(c.id));
	summary.unchanged = summary.unchanged.filter((id) => !withheld.has(id));
	// Drop withheld mods' warnings too: a disabled mod's "below-current" note must not
	// inflate the fallback count, and a fetch failure on one must not flip hasFailures.
	summary.warnings = summary.warnings.filter((w) => !withheld.has(w.id));

	if (oldLock) {
		summary.wouldAutoRemove = findAutoDepsToPrune(oldLock, deps).filter((id) => !withheld.has(id));
	}

	const trackedIds = new Set<string>(depIds);
	if (oldLock) {
		for (const id of Object.keys(oldLock.mods)) trackedIds.add(id);
	}
	for (const removeId of summary.wouldAutoRemove) {
		trackedIds.delete(removeId);
	}
	for (const zipId of listExistingZipIds()) {
		if (!trackedIds.has(zipId)) {
			summary.wouldOrphanPrune.push(zipId);
		}
	}

	summary.hasChanges =
		summary.wouldInstall.length > 0 ||
		summary.wouldUpdate.length > 0 ||
		summary.wouldAutoRemove.length > 0 ||
		summary.wouldOrphanPrune.length > 0;

	printReport(summary, opts.gameVersion, skipped.length, disabledUserMods.size);

	// Post when a valid discord-config.json5 is present and there is something
	// worth reporting: pending changes, or fetch/resolve failures (errors).
	// Routine below-current warnings alone do not trigger a notification.
	const hasFailures = summary.warnings.some((w) => /failed/i.test(w.message));
	const notifier = new DiscordNotifier({ title: "# Vintage Story - Updates Available" });
	if (notifier.enabled && (summary.hasChanges || hasFailures)) {
		for (const block of buildOutdatedBlocks(summary, (id) => oldLock?.mods[id]?.title)) notifier.post(block);
		await notifier.finalize();
	}

	return summary;
}

// Builds atomic blocks (section headers + one bullet per entry) for the
// "updates available" preview. Bullets use "• " so a list split across messages
// keeps its formatting. matchKind is tagged when not an exact game-version match.
export function buildOutdatedBlocks(
	summary: OutdatedSummary,
	titleOf: (id: string) => string | undefined = () => undefined,
): string[] {
	const blocks: string[] = [];
	const tag = (kind: string) => (kind === "exact" ? "" : `  _(${kind})_`);

	if (summary.wouldUpdate.length) {
		blocks.push("## Updates available");
		for (const c of summary.wouldUpdate) {
			blocks.push(`• **${c.title}** (\`${c.id}\`)  ${c.from} → ${c.to}${tag(c.matchKind)}`);
		}
	}
	if (summary.wouldInstall.length) {
		blocks.push("## Would install");
		for (const c of summary.wouldInstall) {
			blocks.push(`• ${c.title} (\`${c.id}\`)  ${c.to}${tag(c.matchKind)}`);
		}
	}
	if (summary.wouldAutoRemove.length) {
		blocks.push("## Would remove (unused deps)");
		for (const id of summary.wouldAutoRemove) blocks.push(`• ${modLabel(id, titleOf(id))}`);
	}
	if (summary.wouldOrphanPrune.length) {
		blocks.push("## 🗑️ Would delete orphan zips");
		for (const id of summary.wouldOrphanPrune) {
			const title = titleOf(id);
			blocks.push(`• ${title ? modLabel(id, title) : `${id}.zip`}`);
		}
	}

	// Surface fetch/resolve failures explicitly (actionable); collapse the
	// routine "below-current fallback" warnings into a single count line.
	const failures = summary.warnings.filter((w) => /failed/i.test(w.message));
	const belowCount = summary.warnings.length - failures.length;
	if (failures.length) {
		blocks.push("## ⚠️ Failed to check");
		for (const w of failures) blocks.push(`• ${w.id}: ${w.message}`);
	}
	if (belowCount > 0) {
		blocks.push(`_${belowCount} mod(s) on below-current fallback_`);
	}

	return blocks;
}

function printReport(summary: OutdatedSummary, gameVersion: string, skippedCount: number, disabledCount: number): void {
	log.section(`Plan for game ${gameVersion}:`);

	if (summary.wouldInstall.length) {
		log.section(`Would install (${summary.wouldInstall.length}):`);
		for (const c of summary.wouldInstall) {
			const tag = c.matchKind === "exact" ? "" : `  [${c.matchKind}]`;
			log.info(`  + ${c.title} (${c.id}) → ${c.to}${tag}`);
		}
	}

	if (summary.wouldUpdate.length) {
		log.section(`Would update (${summary.wouldUpdate.length}):`);
		for (const c of summary.wouldUpdate) {
			const tag = c.matchKind === "exact" ? "" : `  [${c.matchKind}]`;
			log.info(`  ↻ ${c.title} (${c.id})  ${c.from} → ${c.to}${tag}`);
		}
	}

	if (summary.wouldAutoRemove.length) {
		log.section(`Would auto-remove unused deps (${summary.wouldAutoRemove.length}):`);
		for (const id of summary.wouldAutoRemove) log.info(`  - ${id}`);
	}

	if (summary.wouldOrphanPrune.length) {
		log.section(`Would delete orphan zips (${summary.wouldOrphanPrune.length}):`);
		for (const id of summary.wouldOrphanPrune) log.info(`  - ${id}.zip`);
	}

	if (summary.warnings.length) {
		log.section(`Warnings (${summary.warnings.length}):`);
		for (const w of summary.warnings) log.info(`  ⚠  [${w.id}] ${w.message}`);
	}

	log.section("Summary");
	log.info(`  install:      ${summary.wouldInstall.length}`);
	log.info(`  update:       ${summary.wouldUpdate.length}`);
	log.info(`  unchanged:    ${summary.unchanged.length}`);
	log.info(`  cached <1h:   ${skippedCount}`);
	log.info(`  disabled:     ${disabledCount}`);
	log.info(`  auto-remove:  ${summary.wouldAutoRemove.length}`);
	log.info(`  orphan-prune: ${summary.wouldOrphanPrune.length}`);
	log.info(`  warnings:     ${summary.warnings.length}`);
	log.blank();

	if (summary.hasChanges) {
		log.info("Changes pending. Run `update` to apply.");
	} else {
		log.info("Up to date - nothing to do.");
	}
}
