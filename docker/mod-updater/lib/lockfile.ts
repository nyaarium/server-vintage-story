import fs from "node:fs";
import JSON5 from "json5";
import { LockfileError } from "./errors";
import { LOCKFILE_PATH } from "./paths";

export const LOCKFILE_SCHEMA_VERSION = 1;

export type MatchKind = "exact" | "below" | "any" | "pinned";

export interface LockMod {
	title: string;
	url: string;
	version: string;
	gameVersions: string[];
	downloadUrl: string;
	addedBy: string;
	requiredBy: string[];
	pinned: boolean;
	matchKind: MatchKind;
}

export interface Lockfile {
	_lockVersion: number;
	_gameVersion: string;
	_resolvedAt: string;
	mods: Record<string, LockMod>;
}

export function emptyLockfile(gameVersion: string): Lockfile {
	return {
		_lockVersion: LOCKFILE_SCHEMA_VERSION,
		_gameVersion: gameVersion,
		_resolvedAt: new Date().toISOString(),
		mods: {},
	};
}

export function lockfileExists(path: string = LOCKFILE_PATH): boolean {
	return fs.existsSync(path);
}

export function readLockfile(path: string = LOCKFILE_PATH): Lockfile | null {
	if (!fs.existsSync(path)) return null;

	let raw: unknown;
	try {
		raw = JSON5.parse(fs.readFileSync(path, "utf8"));
	} catch (err) {
		throw new LockfileError(`Failed to parse ${path}: ${(err as Error).message}`);
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new LockfileError(`Lockfile must be an object at top level`);
	}

	const lock = raw as Partial<Lockfile>;

	if (typeof lock._lockVersion !== "number") {
		throw new LockfileError(`Lockfile missing '_lockVersion' field`);
	}
	if (lock._lockVersion > LOCKFILE_SCHEMA_VERSION) {
		throw new LockfileError(
			`Lockfile schema version ${lock._lockVersion} is newer than this tool supports (${LOCKFILE_SCHEMA_VERSION})`,
		);
	}
	if (typeof lock._gameVersion !== "string" || !lock._gameVersion) {
		throw new LockfileError(`Lockfile missing '_gameVersion' field`);
	}
	if (typeof lock._resolvedAt !== "string") {
		throw new LockfileError(`Lockfile missing '_resolvedAt' field`);
	}
	if (!lock.mods || typeof lock.mods !== "object") {
		throw new LockfileError(`Lockfile missing 'mods' object`);
	}

	return lock as Lockfile;
}

export function writeLockfile(lock: Lockfile, path: string = LOCKFILE_PATH): void {
	const sortedMods: Record<string, LockMod> = {};
	for (const id of Object.keys(lock.mods).sort()) {
		sortedMods[id] = lock.mods[id];
	}

	const toWrite: Lockfile = {
		_lockVersion: LOCKFILE_SCHEMA_VERSION,
		_gameVersion: lock._gameVersion,
		_resolvedAt: lock._resolvedAt,
		mods: sortedMods,
	};

	const serialized = JSON5.stringify(toWrite, { space: "\t", quote: '"' });
	const tmpPath = `${path}.tmp`;
	fs.writeFileSync(tmpPath, serialized + "\n");
	fs.renameSync(tmpPath, path);
}

export function upsertMod(lock: Lockfile, id: string, entry: LockMod): void {
	lock.mods[id] = entry;
	lock._resolvedAt = new Date().toISOString();
}

export function removeMod(lock: Lockfile, id: string): void {
	delete lock.mods[id];
	lock._resolvedAt = new Date().toISOString();
}
