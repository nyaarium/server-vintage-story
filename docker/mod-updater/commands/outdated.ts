import { readConfig } from "../lib/config";
import { DiscordNotifier } from "../lib/discord";
import { isModUpdaterError } from "../lib/errors";
import { listExistingZipIds, sleep } from "../lib/downloader";
import { readLockfile } from "../lib/lockfile";
import { log } from "../lib/logger";
import { buildDepTree, findAutoDepsToPrune, resolveVersion } from "../lib/resolver";
import { fetchModPage } from "../lib/scraper";

export interface OutdatedOptions {
	gameVersion: string;
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

	let fetchCount = 0;
	for (const id of depIds) {
		const dep = deps[id];
		if (fetchCount > 0) await sleep(1000);
		fetchCount++;

		try {
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

	if (oldLock) {
		summary.wouldAutoRemove = findAutoDepsToPrune(oldLock, deps);
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

	printReport(summary, opts.gameVersion);

	// Always post when a valid discord-config.json5 is present, but only when
	// there is something pending — routine below-current warnings alone (which
	// are not part of hasChanges) never trigger a notification.
	const notifier = new DiscordNotifier({ title: "# Vintage Story — Updates Available" });
	if (notifier.enabled && summary.hasChanges) {
		for (const block of buildOutdatedBlocks(summary)) notifier.post(block);
		await notifier.finalize();
	}

	return summary;
}

// Builds atomic blocks (section headers + one bullet per entry) for the
// "updates available" preview. Bullets use "• " so a list split across messages
// keeps its formatting. matchKind is tagged when not an exact game-version match.
export function buildOutdatedBlocks(summary: OutdatedSummary): string[] {
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
		for (const id of summary.wouldAutoRemove) blocks.push(`• ${id}`);
	}
	if (summary.wouldOrphanPrune.length) {
		blocks.push("## 🗑️ Would delete orphan zips");
		for (const id of summary.wouldOrphanPrune) blocks.push(`• ${id}.zip`);
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

function printReport(summary: OutdatedSummary, gameVersion: string): void {
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
	log.info(`  auto-remove:  ${summary.wouldAutoRemove.length}`);
	log.info(`  orphan-prune: ${summary.wouldOrphanPrune.length}`);
	log.info(`  warnings:     ${summary.warnings.length}`);
	log.blank();

	if (summary.hasChanges) {
		log.info("Changes pending. Run `update` to apply.");
	} else {
		log.info("Up to date — nothing to do.");
	}
}
