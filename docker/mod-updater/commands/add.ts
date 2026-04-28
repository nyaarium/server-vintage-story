import type { ModConfigEntry, ModsConfig } from "../lib/config";
import { modIdFromUrl, normalizeUrl, readConfig, writeConfig } from "../lib/config";
import { ConfigError } from "../lib/errors";
import { downloadZip, zipExistsFor } from "../lib/downloader";
import type { Lockfile } from "../lib/lockfile";
import { emptyLockfile, readLockfile, upsertMod, writeLockfile } from "../lib/lockfile";
import { log } from "../lib/logger";
import type { ResolvedDep } from "../lib/resolver";
import { buildLockEntry, resolveVersion } from "../lib/resolver";
import { fetchModPage } from "../lib/scraper";

export interface AddOptions {
	url: string;
	gameVersion: string;
	lockToVersion?: string;
}

export interface AddResult {
	id: string;
	title: string;
	version: string;
	wasAlreadyInLock: boolean;
}

export async function runAdd(opts: AddOptions): Promise<AddResult> {
	const url = normalizeUrl(opts.url);
	if (!/^https?:\/\//.test(url)) {
		throw new ConfigError(`URL must start with http:// or https:// — got "${opts.url}"`);
	}

	const id = modIdFromUrl(url);

	const config = readConfig();
	if (config[id]) {
		throw new ConfigError(`Mod "${id}" is already in config (url: ${config[id].url})`);
	}

	const oldLock = readLockfile();
	const lock: Lockfile = oldLock
		? { ...oldLock, _gameVersion: opts.gameVersion, _resolvedAt: new Date().toISOString() }
		: emptyLockfile(opts.gameVersion);

	log.section(`Adding ${id}`);
	log.info(`  url: ${url}`);
	if (opts.lockToVersion) log.info(`  pin: ${opts.lockToVersion}`);

	const page = await fetchModPage(url);
	log.info(`  title: ${page.title}`);

	const dep: ResolvedDep = {
		id,
		url,
		lockToVersion: opts.lockToVersion,
		addedBy: "user",
		requiredBy: oldLock?.mods[id]?.requiredBy ?? [],
	};

	const prior = oldLock?.mods[id];
	const wasAlreadyInLock = !!prior;
	const resolved = resolveVersion({
		dep,
		page,
		gameVersion: opts.gameVersion,
		existingLock: prior,
	});

	if (resolved.warning) {
		log.warn(`  ${resolved.warning}`);
	}

	const entry = buildLockEntry(dep, resolved, page);
	log.info(`  resolved: ${entry.version} (${resolved.matchKind})`);

	const versionChanged = !prior || prior.version !== entry.version;
	const zipMissing = !zipExistsFor(id);
	if (versionChanged || zipMissing) {
		log.info(`  ⇣ downloading ${entry.version}`);
		await downloadZip(id, entry.downloadUrl);
	} else {
		log.info(`  zip on disk; skipping download`);
	}

	const newConfigEntry: ModConfigEntry = { url };
	if (opts.lockToVersion) newConfigEntry.lockToVersion = opts.lockToVersion;
	const newConfig: ModsConfig = { ...config, [id]: newConfigEntry };
	writeConfig(newConfig);

	upsertMod(lock, id, entry);
	writeLockfile(lock);

	log.section("Done");
	log.ok(`${page.title} (${id}) @ ${entry.version}`);

	return { id, title: page.title, version: entry.version, wasAlreadyInLock };
}
