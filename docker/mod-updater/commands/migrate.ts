import fs from "node:fs";
import JSON5 from "json5";
import type { ModConfigEntry, ModsConfig } from "../lib/config";
import { modIdFromUrl, normalizeUrl, writeConfig } from "../lib/config";
import { ConfigError } from "../lib/errors";
import type { Lockfile, LockMod } from "../lib/lockfile";
import { emptyLockfile, writeLockfile } from "../lib/lockfile";
import { log } from "../lib/logger";
import { CONFIG_PATH, LOCKFILE_PATH } from "../lib/paths";

type OldModEntry = {
	url: string;
	title?: string;
	version?: string;
	gameVersion?: string;
	lastUpdated?: string;
	requires?: string[];
	lockToVersion?: string;
	disabled?: boolean;
	auto?: boolean;
};

type OldModsConfig = Record<string, OldModEntry>;

const NEW_FIELDS = new Set(["url", "requires", "lockToVersion"]);

export interface MigrateOptions {
	gameVersion: string;
	configPath?: string;
	lockPath?: string;
}

export interface MigrateResult {
	renamed: Array<{ from: string; to: string }>;
	dropped: string[];
	lockSeededCount: number;
}

export function isOldFormat(config: unknown): boolean {
	if (!config || typeof config !== "object") return false;
	for (const entry of Object.values(config as Record<string, unknown>)) {
		if (!entry || typeof entry !== "object") continue;
		for (const key of Object.keys(entry as object)) {
			if (!NEW_FIELDS.has(key)) return true;
		}
	}
	return false;
}

export function runMigrate(opts: MigrateOptions): MigrateResult {
	const configPath = opts.configPath ?? CONFIG_PATH;
	const lockPath = opts.lockPath ?? LOCKFILE_PATH;

	if (!fs.existsSync(configPath)) {
		throw new ConfigError(`Config file not found: ${configPath}`);
	}

	const raw = JSON5.parse(fs.readFileSync(configPath, "utf8")) as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ConfigError(`Config must be an object at top level`);
	}
	const oldConfig = raw as OldModsConfig;

	if (!isOldFormat(oldConfig)) {
		log.info("Config is already in new format — nothing to migrate.");
		return { renamed: [], dropped: [], lockSeededCount: 0 };
	}

	const backupPath = `${configPath}.backup`;
	fs.copyFileSync(configPath, backupPath);
	log.info(`Backed up old config to ${backupPath}`);

	const renamed: Array<{ from: string; to: string }> = [];
	const dropped: string[] = [];

	const normalizedEntries: Array<{ oldKey: string; newId: string; entry: OldModEntry }> = [];
	for (const [oldKey, rawEntry] of Object.entries(oldConfig)) {
		if (!rawEntry?.url) {
			log.warn(`  skipping "${oldKey}": no url`);
			dropped.push(oldKey);
			continue;
		}
		if (rawEntry.disabled) {
			log.warn(`  dropping disabled mod "${oldKey}" (disabled flag removed)`);
			dropped.push(oldKey);
			continue;
		}
		const url = normalizeUrl(rawEntry.url);
		const newId = modIdFromUrl(url);
		if (newId !== oldKey) {
			renamed.push({ from: oldKey, to: newId });
		}
		normalizedEntries.push({ oldKey, newId, entry: { ...rawEntry, url } });
	}

	const newConfig: ModsConfig = {};
	for (const { newId, entry } of normalizedEntries) {
		if (entry.auto) continue;
		const cleanEntry: ModConfigEntry = { url: entry.url };
		if (entry.requires?.length) {
			cleanEntry.requires = entry.requires.map(normalizeUrl);
		}
		if (entry.lockToVersion) {
			cleanEntry.lockToVersion = entry.lockToVersion;
		}
		newConfig[newId] = cleanEntry;
	}

	const requiresMap: Record<string, string[]> = {};
	for (const { newId, entry } of normalizedEntries) {
		if (!entry.requires) continue;
		for (const reqUrl of entry.requires) {
			const reqId = modIdFromUrl(normalizeUrl(reqUrl));
			requiresMap[reqId] ??= [];
			if (!requiresMap[reqId].includes(newId)) {
				requiresMap[reqId].push(newId);
			}
		}
	}

	const lock: Lockfile = emptyLockfile(opts.gameVersion);
	let seeded = 0;
	for (const { newId, entry } of normalizedEntries) {
		if (!entry.version) continue;

		const isAuto = !!entry.auto;
		const parents = requiresMap[newId] ?? [];
		const addedBy = isAuto && parents.length > 0 ? `dep-of:${parents[0]}` : "user";

		const gameVersions = entry.gameVersion
			? entry.gameVersion
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: [];

		const lockEntry: LockMod = {
			title: entry.title ?? newId,
			url: entry.url,
			version: entry.version,
			gameVersions,
			downloadUrl: "",
			addedBy,
			requiredBy: parents.sort(),
			pinned: !!entry.lockToVersion,
			matchKind: entry.lockToVersion ? "pinned" : "exact",
		};
		lock.mods[newId] = lockEntry;
		seeded++;
	}

	writeConfig(newConfig, configPath);
	writeLockfile(lock, lockPath);

	log.section("Migration report");
	log.info(`  entries kept:     ${Object.keys(newConfig).length}`);
	log.info(`  lockfile seeded:  ${seeded}`);
	log.info(`  entries dropped:  ${dropped.length}`);
	log.info(`  keys renamed:     ${renamed.length}`);

	if (renamed.length) {
		log.section("Renamed keys:");
		for (const r of renamed) log.info(`  ${r.from}  →  ${r.to}`);
	}
	if (dropped.length) {
		log.section("Dropped entries:");
		for (const d of dropped) log.info(`  ${d}`);
	}

	log.blank();
	log.info("⚠  Lockfile is seeded but 'downloadUrl' fields are empty.");
	log.info("   Run `bun run cli.ts update` to fully resolve and enable install.");

	return { renamed, dropped, lockSeededCount: seeded };
}
