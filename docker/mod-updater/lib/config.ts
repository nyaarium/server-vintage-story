import fs from "node:fs";
import JSON5 from "json5";
import { ConfigError } from "./errors";
import { CONFIG_PATH } from "./paths";

export interface ModConfigEntry {
	url: string;
	requires?: string[];
	lockToVersion?: string;
}

export interface ModsConfig {
	[id: string]: ModConfigEntry;
}

export function normalizeUrl(url: string): string {
	return url.replace(/[?#].*$/, "").replace(/\/+$/, "");
}

export function modIdFromUrl(url: string): string {
	const clean = normalizeUrl(url);
	const segments = clean.split("/").filter(Boolean);
	const last = segments[segments.length - 1];
	if (!last) {
		throw new ConfigError(`Cannot derive mod id from URL: ${url}`);
	}
	return last;
}

function validateEntry(id: string, entry: unknown): ModConfigEntry {
	if (!entry || typeof entry !== "object") {
		throw new ConfigError(`[${id}] Entry must be an object`, id);
	}
	const e = entry as Record<string, unknown>;

	if (typeof e.url !== "string" || !e.url) {
		throw new ConfigError(`[${id}] Missing required 'url' field`, id);
	}

	if (e.requires !== undefined) {
		if (!Array.isArray(e.requires) || !e.requires.every((r) => typeof r === "string")) {
			throw new ConfigError(`[${id}] 'requires' must be an array of strings`, id);
		}
	}

	if (e.lockToVersion !== undefined && typeof e.lockToVersion !== "string") {
		throw new ConfigError(`[${id}] 'lockToVersion' must be a string`, id);
	}

	return {
		url: normalizeUrl(e.url),
		...(e.requires ? { requires: (e.requires as string[]).map(normalizeUrl) } : {}),
		...(e.lockToVersion ? { lockToVersion: e.lockToVersion as string } : {}),
	};
}

export function readConfig(path: string = CONFIG_PATH): ModsConfig {
	if (!fs.existsSync(path)) {
		throw new ConfigError(`Config file not found: ${path}`);
	}

	let raw: unknown;
	try {
		raw = JSON5.parse(fs.readFileSync(path, "utf8"));
	} catch (err) {
		throw new ConfigError(`Failed to parse ${path}: ${(err as Error).message}`);
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ConfigError(`Config must be an object at top level`);
	}

	const config: ModsConfig = {};
	for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
		config[id] = validateEntry(id, entry);
	}
	return config;
}

export function writeConfig(config: ModsConfig, path: string = CONFIG_PATH): void {
	const serialized = JSON5.stringify(config, { space: "\t", quote: '"' });
	fs.writeFileSync(path, serialized + "\n");
}

export function configEntryForUrl(config: ModsConfig, url: string): { id: string; entry: ModConfigEntry } | null {
	const targetUrl = normalizeUrl(url);
	for (const [id, entry] of Object.entries(config)) {
		if (entry.url === targetUrl) return { id, entry };
	}
	return null;
}
