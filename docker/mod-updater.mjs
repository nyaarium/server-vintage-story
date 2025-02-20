import * as cheerio from "cheerio";
import { Client, GatewayIntentBits } from "discord.js";
import fs from "fs";
import JSON5 from "json5";
import moment from "moment-timezone";
import fetch from "node-fetch";

const GAME_VERSION = process.env.GAME_VERSION;
const MODS_DIR = "/data/Mods";
const MODS_JSON_PATH = "/configs/mods.json5";
const DISCORD_CONFIG_PATH = "/configs/discord-config.json5";

const MOST_RECENT_ENTRIES_COUNT = 20;

const CACHE_TIME_HOURS = 4;

// Start the main function
main().catch((error) => {
	console.error("Mod updater failed:", error);
	process.exit(1);
});

// Main execution
async function main() {
	let modsConfig = readModsConfig();

	const resolvedDependencies = resolveDependencies(modsConfig);

	console.log(`\nFetching all mod info...\n`);

	const now = moment();

	// Fetch info for all mods including dependencies
	const modInfos = {};
	for (const modConfig of Object.values(resolvedDependencies)) {
		if (modConfig.lastUpdated) {
			const lastUpdated = moment(modConfig.lastUpdated);
			const diff = now.diff(lastUpdated, "hours");
			if (diff < CACHE_TIME_HOURS - 1) {
				modInfos[modConfig.id] = modConfig;
				continue;
			}
		}

		const modInfo = await fetchModInfo(modConfig);
		modInfos[modConfig.id] = modInfo;

		// Pause for 1 seconds out of kindness for CDN
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	console.log(`\nResolving best versions...\n`);

	const resolvedVersionInfo = {};
	for (const [modId, modInfo] of Object.entries(modInfos)) {
		if (modInfo.lastUpdated) {
			const lastUpdated = moment(modInfo.lastUpdated);
			const diff = now.diff(lastUpdated, "hours");
			if (diff < CACHE_TIME_HOURS - 1) {
				resolvedVersionInfo[modId] = modInfo;
				continue;
			}
		}

		resolvedVersionInfo[modId] = resolveBestVersions(resolvedDependencies[modId], modInfo);
	}

	console.log(`\n\n`);

	await performUpdates(modsConfig, resolvedVersionInfo);
	modsConfig = readModsConfig();

	reportNonVersionMatch(modsConfig);
}

function reportNonVersionMatch(modsConfig) {
	const nonMatches = {};

	for (const id in modsConfig) {
		const modConfig = modsConfig[id];
		const gameVersions = modConfig.gameVersion?.split(", ") || [];

		const hasMatch = gameVersions.some(isVersionSupported);

		if (!hasMatch) {
			nonMatches[id] = modConfig;
		}
	}

	let log = "";
	for (const id in nonMatches) {
		const modConfig = nonMatches[id];
		log += `- ${modConfig.title} (${id})\n`;
		log += `    Version: ${modConfig.version}\n`;
		log += `    Supported Versions: ${modConfig.gameVersion}\n`;
	}

	if (log) {
		console.log(`\nMods not declared for game version ${GAME_VERSION}:`);
		console.log(log);
	}
}

async function performUpdates(modsConfig, resolvedVersionInfo) {
	const newModsConfig = {};
	let logUpToDate = "";
	let logInstalled = "";
	let logUpdated = "";
	let logDeleted = "";

	const now = moment();

	// Download new mods
	const sortedVersionInfo = Object.values(resolvedVersionInfo).sort((a, b) => {
		const titleA = a.title?.toLowerCase() ?? "";
		const titleB = b.title?.toLowerCase() ?? "";
		return titleA.localeCompare(titleB);
	});
	for (const modInfo of sortedVersionInfo) {
		if (modInfo.lastUpdated) {
			const lastUpdated = moment(modInfo.lastUpdated);
			const diff = now.diff(lastUpdated, "hours");
			if (diff < CACHE_TIME_HOURS) {
				// Copy over and continue
				newModsConfig[modInfo.id] = modsConfig[modInfo.id];
				continue;
			}
		}

		if (modInfo.action === "update") {
			const url = modInfo.targetVersion?.downloadFile;
			if (!url) {
				console.error(`No download URL found for ${modInfo.title} (${modInfo.id})`);
				continue;
			}

			const downloadPath = `${MODS_DIR}/${modInfo.id}.zip`;

			console.log(`Downloading ${modInfo.title} (${modInfo.id})`);
			const response = await fetch(url);
			const zipFile = await response.arrayBuffer();

			if (modInfo.currentVersion) {
				logUpdated += `- ${modInfo.title} (${modInfo.id})  ${modInfo.currentVersion}  ->  ${modInfo.targetVersion.version}\n\n`;

				let changelog = modInfo.changeLog.trim();
				if (changelog) {
					changelog = "  > " + changelog.replace(/\n/gs, "\n  > ");
				}

				logUpdated += `${changelog}\n\n`;
			} else {
				logInstalled += `- ${modInfo.title} (${modInfo.id})  ${modInfo.targetVersion.version}\n`;
			}

			await fs.promises.writeFile(downloadPath, Buffer.from(zipFile));

			// Pause for 5 seconds out of kindness for CDN
			await new Promise((resolve) => setTimeout(resolve, 5000));

			// If manually specified, save the new version to the config
			newModsConfig[modInfo.id] = {
				title: modInfo.title,
				url: modInfo.url,
				version: modInfo.targetVersion.version,
				gameVersion: modInfo.targetVersion.gameVersions.join(", "),
				requires: modInfo.requires,
				lastUpdated: new Date().toISOString(),
				auto: modInfo.auto,
			};
		} else if (modInfo.action === "up-to-date") {
			logUpToDate += `- ${modInfo.title} (${modInfo.id})\n`;

			newModsConfig[modInfo.id] = {
				title: modInfo.title,
				url: modInfo.url,
				version: modInfo.currentVersion,
				gameVersion: modInfo.gameVersion,
				requires: modInfo.requires,
				lastUpdated: new Date().toISOString(),
				auto: modInfo.auto,
			};
		}
	}

	// Scan dir for modIds of mods to delete
	const unlistedMods = {};
	fs.readdirSync(MODS_DIR).forEach((file) => {
		const modId = file.split(".")[0];
		unlistedMods[modId] = resolvedVersionInfo[modId];
	});
	for (const modId in resolvedVersionInfo) {
		delete unlistedMods[modId];
	}
	for (const modId in unlistedMods) {
		const modInfo = unlistedMods[modId];
		if (!modInfo) continue;

		const usedRequires = modInfo.requiredBy?.filter((id) => resolvedVersionInfo[id]);
		if (!usedRequires?.length) {
			delete unlistedMods[modId];
		}
	}
	for (const modId in unlistedMods) {
		fs.unlinkSync(`${MODS_DIR}/${modId}.zip`);
		logDeleted += `- ${modId}\n`;
	}

	// Write the updated config
	fs.writeFileSync(MODS_JSON_PATH, JSON5.stringify(newModsConfig, null, 4).replace(/ {4}/g, "\t"));
	// console.log(JSON5.stringify(newModsConfig, null, 4).replace(/ {4}/g, "\t"));

	let log = "";

	if (logInstalled) {
		log += `\n\n✅ Newly installed:\n\n${logInstalled}`;
	}
	if (logUpdated) {
		log += `\n\n✅ Updated:\n\n${logUpdated}`;
	}
	if (logDeleted) {
		log += `\n\n❌ Deleted:\n\n${logDeleted}`;
	}

	console.log(logUpToDate ? `\n\n✅ Up to date:\n\n${logUpToDate}` : "" + log);

	// Send Discord notification if there are updates
	if (logInstalled || logUpdated || logDeleted) {
		console.log("\nAttempting Discord notification...");

		let discordConfig = null;
		try {
			if (fs.existsSync(DISCORD_CONFIG_PATH)) {
				discordConfig = JSON5.parse(fs.readFileSync(DISCORD_CONFIG_PATH, "utf8"));
				console.log("Discord config loaded:", {
					hasSecretKey: !!discordConfig.secretKey,
					channels: discordConfig.broadcastChannels?.length || 0,
				});
			}
		} catch (error) {
			console.error("Failed to load Discord config:", error);
		}

		if (discordConfig?.secretKey && discordConfig?.broadcastChannels?.length) {
			console.log("Creating Discord client...");
			const discordClient = new Client({
				intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
			});

			try {
				console.log("Attempting Discord login...");
				await discordClient.login(discordConfig.secretKey);

				// Send to all configured channels
				for (const channel of discordConfig.broadcastChannels) {
					try {
						console.log("Fetching guild...", channel.guildId);
						const guild = await discordClient.guilds.fetch(channel.guildId);
						console.log("Guild found:", guild.name);
						const textChannel = await guild.channels.fetch(channel.channelId);
						console.log("Channel found:", {
							name: textChannel?.name,
							type: textChannel?.type,
							isText: textChannel?.isTextBased(),
						});

						if (textChannel?.isTextBased()) {
							console.log("Channel is text based, sending message...");
							let message = "**Vintage Story Server Mod Updates**" + log;

							// Split message if it's too long (Discord has 2000 char limit)
							if (message.length > 1900) {
								message = message.substring(0, 1900) + "\n... (message truncated)";
							}

							await textChannel.send(message);
							console.log("Message sent successfully!");
						} else {
							console.log("Channel is not text based! Channel type:", textChannel?.type);
						}
					} catch (error) {
						console.error("Failed to send to channel. Error details:", error);
						if (error.code) console.error("Error code:", error.code);
						if (error.message) console.error("Error message:", error.message);
						if (error.httpStatus) console.error("HTTP status:", error.httpStatus);
					}
				}
			} catch (error) {
				console.error("Failed to send Discord notification. Error details:", error);
				if (error.code) console.error("Error code:", error.code);
				if (error.message) console.error("Error message:", error.message);
				if (error.httpStatus) console.error("HTTP status:", error.httpStatus);
			} finally {
				console.log("Cleaning up Discord client...");
				await discordClient.destroy();
				console.log("Discord client destroyed.");
			}
		} else {
			console.log("No Discord config found or missing required fields.");
		}
	} else {
		console.log("No updates to report to Discord.");
	}

	console.log("Done!");
}

function readModsConfig() {
	try {
		const modsConfigText = fs.readFileSync(MODS_JSON_PATH, "utf8");
		const modsConfig = JSON5.parse(modsConfigText);

		// Strip query params and hash
		for (const modInfo of Object.values(modsConfig)) {
			const url = modInfo.url.replace(/[?#].*$/, "");
			modInfo.url = url;

			if (modInfo.requires) {
				modInfo.requires = modInfo.requires.map((url) => url.replace(/[?#].*$/, ""));
			}
		}

		return modsConfig;
	} catch (error) {
		console.error("Failed to read or parse mods.json5:", error);
		throw error;
	}
}

function resolveDependencies(modConfig) {
	const modLookup = {};

	// Iterate through each manually installed mod in the config
	for (const modInfo of Object.values(modConfig)) {
		if (modInfo.auto) continue;

		const url = modInfo.url;
		const id = url.split("/").pop();

		if (modLookup[id]) {
			modLookup[id].currentVersion = modInfo.version;
			modLookup[id].gameVersion = modInfo.gameVersion;
			modLookup[id].lastUpdated = modInfo.lastUpdated;
		} else {
			modLookup[id] = {
				id,
				url,
				currentVersion: modInfo.version,
				gameVersion: modInfo.gameVersion,
				requires: modInfo.requires,
				lastUpdated: modInfo.lastUpdated,
			};
		}

		// Add requires if they exist
		if (modInfo.requires) {
			for (const requireUrl of modInfo.requires) {
				const requireId = requireUrl.split("/").pop();

				if (!modLookup[requireId]) {
					const reqConfig = modConfig[requireId];
					modLookup[requireId] = {
						id: requireId,
						url: requireUrl,
						currentVersion: reqConfig?.version,
						gameVersion: reqConfig?.gameVersion,
						requiredBy: [id],
						lastUpdated: reqConfig?.lastUpdated,
						auto: true,
					};
				} else {
					modLookup[requireId].requiredBy ??= [];
					modLookup[requireId].requiredBy.push(id);
				}
			}
		}
	}

	return modLookup;
}

async function fetchModInfo(modConfig) {
	try {
		console.log("Fetching mod info for:", modConfig.url);

		const response = await fetch(modConfig.url);
		const html = await response.text();

		const $ = cheerio.load(html);
		const title = $("span.title").eq(0).text().replace(/\s+/gs, " ").trim();
		const $table = $(`table[id="Connection types"]`);

		const versions = [];
		$table
			.find("tbody tr")
			.slice(0, MOST_RECENT_ENTRIES_COUNT)
			.each((i, row) => {
				const $row = $(row);
				const $versionCell = $row.find("td").eq(0);
				const $gameVersionCell = $row.find("td").eq(1);

				// Get version from first line of version cell and strip 'v' prefix
				const version = $versionCell.text().trim().split("\n")[0].trim().replace(/^v/, "");

				// Get changelog and clean up whitespace
				const changelog = $versionCell
					.find(".changelogtext")
					.text()
					.trim()
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line)
					.join("\n");

				// Get game versions - check for tooltip first, otherwise use text
				// Clean up game versions and remove any extra text/tabs
				const gameVersionTitle = $gameVersionCell.find(".tag");
				const gameVersions = gameVersionTitle.toArray().map((tag) => {
					return $(tag)
						.text()
						.trim()
						.replace(/^[#v]*/, "");
				});

				const releaseDate = $row.find("td").eq(3).text().trim();

				const downloadUrl = $row.find("td").eq(5).find("a.downloadbutton").attr("href");
				const downloadFile = downloadUrl ? `https://mods.vintagestory.at${downloadUrl}` : null;

				versions.push({
					version,
					gameVersions,
					releaseDate,
					changelog,
					downloadFile,
				});
			});

		// Print first entry as example with relative time
		if (versions.length) {
			console.log(title);
			for (const version of versions) {
				const gameVersionText = version.gameVersions.join(", ");
				console.log(`(${version.releaseDate}) ${version.version} - Supports: ${gameVersionText}`);
			}
			console.log(`\n`);
		} else {
			console.log(`No versions found???\n`);
		}

		return {
			title,
			id: modConfig.id,
			url: modConfig.url,
			versions,
			gameVersion: modConfig.gameVersion,
			lastUpdated: modConfig.lastUpdated,
		};
	} catch (error) {
		console.error("Failed to fetch mod info:", error);
		throw error;
	}
}

/* TODO: Some thoughts on how to improve the version selector.

Leave this dev note here for now until we confirm a working solution. Update this comment if you are revising the algorithms.

- Need a version splitter function.
  - Splits a version string into 4: major, minor, patch, and extra parts

- Need a version sort-comparator function. Old versionMinorMatches didnt really make the code clear. This comparator will be much better to understand.
  - Compares two versions (-1, 0, 1):
  - Major have highest rank
  - Minor next rank
  - Patch last rank (All "-" tags, like "-rc.4", are considered the same rank)

- bestModInfo should always be the newest version, but not exceeding the GAME_VERSION
  - If (!bestModInfo), pick the first one seen (implies the newest version available)
*/

function splitVersion(version) {
	// Split base version from extra tag
	const [base, ...extraParts] = version.split("-");
	const extra = extraParts.join("-"); // Rejoin in case there are multiple hyphens

	// Split base into major.minor.patch
	const [major = "0", minor = "0", patch = "0"] = base.split(".");

	return {
		major: parseInt(major, 10),
		minor: parseInt(minor, 10),
		patch: parseInt(patch, 10),
		extra: extra || null,
	};
}

function compareVersions(versionA, versionB) {
	const a = splitVersion(versionA);
	const b = splitVersion(versionB);

	// Compare major.minor.patch
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;

	// If one is a pre-release and the other isn't, stable comes first
	if (a.extra !== b.extra) {
		return a.extra ? -1 : 1;
	}

	// Versions are equal
	return 0;
}

function isVersionSupported(version) {
	const currentParts = splitVersion(GAME_VERSION);
	const versionParts = splitVersion(version);
	return (
		currentParts.major === versionParts.major &&
		currentParts.minor === versionParts.minor &&
		currentParts.patch === versionParts.patch
	);
}

function resolveBestVersions(modConfig, modInfo) {
	console.log(modInfo.title);
	console.log(`Current: ${modConfig.currentVersion || "Not installed"}`);

	// Filter versions that support our game version
	const compatibleVersions = modInfo.versions.filter((version) => {
		// At least one of the gameVersions must match our major.minor
		return version.gameVersions.some(isVersionSupported);
	});

	// Sort by version (highest first)
	compatibleVersions.sort((a, b) => -compareVersions(a.version, b.version));

	// Choose best version
	const bestVersion = compatibleVersions[0];
	let action = "up-to-date";
	let targetVersion = null;
	let changeLog = null;

	if (bestVersion) {
		console.log(`Online: ${bestVersion.version} - (${bestVersion.releaseDate})`);
		targetVersion = bestVersion;

		if (modConfig.currentVersion !== bestVersion.version) {
			action = "update";
			changeLog = compileChangeLog(modInfo.versions, modConfig.currentVersion, bestVersion.version);
		}
	} else if (modInfo.versions.length) {
		// No compatible version found, log all available versions
		console.log("No compatible version found. Available versions:");
		for (const v of modInfo.versions.slice(0, 3)) {
			console.log(`  ${v.version} - Supports: ${v.gameVersions.join(", ")}`);
		}
	} else {
		console.log("No versions found!");
	}

	return {
		id: modConfig.id,
		title: modInfo.title,
		url: modConfig.url,
		currentVersion: modConfig.currentVersion,
		gameVersion: modConfig.gameVersion,
		targetVersion,
		requires: modConfig.requires,
		action,
		changeLog,
		...(modConfig.auto ? { auto: true } : {}),
		lastUpdated: modConfig.lastUpdated,
	};
}

function compileChangeLog(versions, oldModVersion, newModVersion) {
	const changelogEntries = [];
	let startCollecting = false;

	for (const version of versions) {
		if (version.version === newModVersion) {
			startCollecting = true;
		}

		if (version.version === oldModVersion) {
			break;
		}

		if (startCollecting) {
			changelogEntries.push(`Version ${version.version}:\n${version.changelog}\n`);
		}
	}

	// Reverse the collected changelog entries to have the newest at the top
	return (
		changelogEntries
			.reverse()
			.join("\n")
			// Remove version headers
			.replace(/\n*Version \d+\.\d+\.\d+:\n/gs, "\n")
			.trim()
	);
}
