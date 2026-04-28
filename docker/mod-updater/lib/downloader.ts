import fs from "node:fs";
import path from "node:path";
import { DownloadError, NetworkError } from "./errors";
import { MODS_DIR } from "./paths";

export function ensureDir(dir: string = MODS_DIR): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function zipPathFor(id: string, dir: string = MODS_DIR): string {
	return path.join(dir, `${id}.zip`);
}

export function zipExistsFor(id: string, dir: string = MODS_DIR): boolean {
	return fs.existsSync(zipPathFor(id, dir));
}

export function listExistingZipIds(dir: string = MODS_DIR): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".zip"))
		.map((f) => f.slice(0, -4));
}

export async function downloadZip(
	id: string,
	downloadUrl: string,
	dir: string = MODS_DIR,
): Promise<void> {
	ensureDir(dir);
	const finalPath = zipPathFor(id, dir);
	const tmpPath = `${finalPath}.download.tmp`;

	let response: Response;
	try {
		response = await fetch(downloadUrl);
	} catch (err) {
		throw new NetworkError(`Failed to fetch ${downloadUrl}: ${(err as Error).message}`, id);
	}

	if (!response.ok) {
		throw new DownloadError(
			`Download ${downloadUrl} returned ${response.status} ${response.statusText}`,
			id,
		);
	}

	const buf = await response.arrayBuffer();
	if (buf.byteLength === 0) {
		throw new DownloadError(`Downloaded zip is empty (${downloadUrl})`, id);
	}

	fs.writeFileSync(tmpPath, Buffer.from(buf));
	fs.renameSync(tmpPath, finalPath);
}

export interface PruneResult {
	deleted: string[];
	kept: string[];
}

export function pruneOrphans(keepIds: Set<string>, dir: string = MODS_DIR): PruneResult {
	if (!fs.existsSync(dir)) return { deleted: [], kept: [] };

	const deleted: string[] = [];
	const kept: string[] = [];

	for (const id of listExistingZipIds(dir)) {
		if (keepIds.has(id)) {
			kept.push(id);
		} else {
			fs.unlinkSync(zipPathFor(id, dir));
			deleted.push(id);
		}
	}

	return { deleted, kept };
}

export function deleteZip(id: string, dir: string = MODS_DIR): boolean {
	const p = zipPathFor(id, dir);
	if (fs.existsSync(p)) {
		fs.unlinkSync(p);
		return true;
	}
	return false;
}

export async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
