#!/usr/bin/env bun
import { runAdd } from "./commands/add";
import { runInstall } from "./commands/install";
import { runMigrate } from "./commands/migrate";
import { runOutdated } from "./commands/outdated";
import { runRemove } from "./commands/remove";
import { runUpdate } from "./commands/update";
import { isModUpdaterError } from "./lib/errors";
import { log } from "./lib/logger";

const USAGE = `Usage: bun cli.ts <command> [args]

Commands:
  update               Re-resolve all mods, download changes, write lockfile
  install              Apply lockfile to disk (download missing zips, prune orphans)
  outdated             Show pending changes without writing anything (exit 1 if changes)
  add <url>            Add a mod to config and install it
                         --lock-to <version>   Pin to a specific version
  remove <id>          Remove a mod from config; cascades unused auto-deps
  migrate              Convert old-format mods.json5 → new config + lockfile

Environment:
  GAME_VERSION         Current game version (required for all commands)`;

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		log.err(`Missing required env var: ${name}`);
		process.exit(2);
	}
	return v;
}

function parseFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1) return undefined;
	const value = args[idx + 1];
	if (!value || value.startsWith("--")) {
		log.err(`Flag ${flag} requires a value`);
		process.exit(2);
	}
	args.splice(idx, 2);
	return value;
}

async function main(): Promise<void> {
	const [, , command, ...rest] = process.argv;

	if (!command || command === "--help" || command === "-h" || command === "help") {
		console.log(USAGE);
		process.exit(command ? 0 : 2);
	}

	const gameVersion = requireEnv("GAME_VERSION");

	switch (command) {
		case "update": {
			await runUpdate({ gameVersion });
			break;
		}
		case "install": {
			await runInstall({ gameVersion });
			break;
		}
		case "outdated": {
			const result = await runOutdated({ gameVersion });
			if (result.hasChanges) process.exitCode = 1;
			break;
		}
		case "add": {
			const args = [...rest];
			const lockToVersion = parseFlag(args, "--lock-to");
			const url = args[0];
			if (!url) {
				log.err("add: missing <url>");
				console.log(USAGE);
				process.exit(2);
			}
			await runAdd({ url, gameVersion, lockToVersion });
			break;
		}
		case "remove": {
			const id = rest[0];
			if (!id) {
				log.err("remove: missing <id>");
				console.log(USAGE);
				process.exit(2);
			}
			await runRemove({ id, gameVersion });
			break;
		}
		case "migrate": {
			runMigrate({ gameVersion });
			break;
		}
		default: {
			log.err(`Unknown command: ${command}`);
			console.log(USAGE);
			process.exit(2);
		}
	}
}

main().catch((err) => {
	if (isModUpdaterError(err)) {
		const prefix = err.modId ? `[${err.modId}] ` : "";
		log.err(`${err.name}: ${prefix}${err.message}`);
		process.exit(1);
	}
	console.error(err);
	process.exit(1);
});
