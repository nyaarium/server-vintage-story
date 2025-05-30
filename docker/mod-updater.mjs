import * as cheerio from "cheerio";
import { Client, GatewayIntentBits } from "discord.js";
import fs from "fs";
import JSON5 from "json5";
import moment from "moment-timezone";
import fetch from "node-fetch";

const GAME_VERSION = process.env.GAME_VERSION;
const MODS_DIR = "/data/Mods";
const MODS_JSON_PATH = "/data/mods.json5";
const DISCORD_CONFIG_PATH = "/data/discord-config.json5";

const MOST_RECENT_ENTRIES_COUNT = 20;

const CACHE_TIME_HOURS = 4;

let discordClient = null;
let discordChannels = [];
let hasPostedTitle = false;

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
			console.log(`[${modConfig.id}] Cache age: ${diff} hours`);
			if (diff < CACHE_TIME_HOURS - 1) {
				console.log(
					`[${modConfig.id}] Using cached mod info (${CACHE_TIME_HOURS - 1 - diff} hours until expiry)`,
				);
				modInfos[modConfig.id] = modConfig;
				continue;
			}
			console.log(`[${modConfig.id}] Cache expired, fetching fresh data...`);
		} else {
			console.log(`[${modConfig.id}] No cache data, fetching for first time...`);
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

		const resolved = resolveBestVersions(resolvedDependencies[modId], modInfo);
		resolvedVersionInfo[modId] = resolved;

		let logStr = `${modInfo.title} (${modId})    `;
		logStr += `Current: ${resolvedDependencies[modId].currentVersion || "Not installed"}    `;
		if (resolved.lockToVersion) logStr += `🔒 `;
		logStr += `Online: ${resolved.targetVersion?.version || "Not found"}    `;
		console.log(logStr);
	}

	console.log(`\n\n`);

	await performUpdates(modsConfig, resolvedVersionInfo);
	modsConfig = readModsConfig();

	reportQuestionableVersions(modsConfig);
}

function reportQuestionableVersions(modsConfig) {
	const lockedMods = {};
	const nonMinorMatches = {};
	const nonExactMatches = {};

	for (const id in modsConfig) {
		const modConfig = modsConfig[id];
		const gameVersions = modConfig.gameVersion?.split(", ") || [];

		// Check for locked versions
		if (modConfig.lockToVersion) {
			lockedMods[id] = modConfig;
		}

		// Check for version mismatches
		const versionMinorMatches = gameVersions.some(isVersionMinorMatch);
		const versionExactMatches = gameVersions.some(isVersionExactMatch);

		if (!versionMinorMatches) {
			nonMinorMatches[id] = modConfig;
		} else if (!versionExactMatches) {
			nonExactMatches[id] = modConfig;
		}
	}

	if (Object.keys(lockedMods).length) {
		console.log(`\n🔒 Version locked mods:`);
		for (const id in lockedMods) {
			const modConfig = lockedMods[id];
			console.log(`- ${modConfig.title} (${id})    Version: ${modConfig.lockToVersion}`);
		}
	}

	if (Object.keys(nonMinorMatches).length) {
		console.log(`\n🚫 Version major/minor mismatch:`);
		for (const id in nonMinorMatches) {
			const modConfig = nonMinorMatches[id];
			console.log(
				`- ${modConfig.title} (${id})    Version: ${modConfig.version}    Supported: ${modConfig.gameVersion}`,
			);
		}
	}

	if (Object.keys(nonExactMatches).length) {
		console.log(`\n⚠️  Version patch mismatch:`);
		for (const id in nonExactMatches) {
			const modConfig = nonExactMatches[id];
			console.log(
				`- ${modConfig.title} (${id})    Version: ${modConfig.version}    Supported: ${modConfig.gameVersion}`,
			);
		}
	}
}

async function performUpdates(modsConfig, resolvedVersionInfo) {
	const newModsConfig = {};
	const disabledMods = {};
	const installedEntries = [];
	const uninstalledEntries = [];
	const deletedEntries = [];
	let hasPostedUpdateHeader = false;

	const now = moment();
	const currentTime = new Date().toISOString();

	const sortedVersionInfo = Object.values(resolvedVersionInfo).sort((a, b) => {
		const titleA = a.title?.toLowerCase() ?? "";
		const titleB = b.title?.toLowerCase() ?? "";
		return titleA.localeCompare(titleB);
	});

	for (const modInfo of sortedVersionInfo) {
		if (modInfo.disabled) {
			disabledMods[modInfo.id] = modInfo;

			newModsConfig[modInfo.id] = {
				...modsConfig[modInfo.id],
			};

			delete newModsConfig[modInfo.id].version;
			delete newModsConfig[modInfo.id].gameVersion;

			continue;
		}

		if (modInfo.lastUpdated) {
			const lastUpdated = moment(modInfo.lastUpdated);
			const diff = now.diff(lastUpdated, "hours");
			if (diff < CACHE_TIME_HOURS) {
				// Copy over and continue, but update lastUpdated
				newModsConfig[modInfo.id] = {
					...modsConfig[modInfo.id],
					lastUpdated: currentTime,
				};
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

			await fs.promises.writeFile(downloadPath, Buffer.from(zipFile));

			if (modInfo.currentVersion) {
				if (!hasPostedUpdateHeader) {
					// Post update header if not done yet
					await discordPost("✅ **Updated:**");
					hasPostedUpdateHeader = true;
				}

				// Post individual update
				let message = `**${modInfo.title}**  (\`${modInfo.id}\`)  **${modInfo.currentVersion}**  ->  **${modInfo.targetVersion.version}**\n`;
				if (modInfo.changeLog) {
					message += "> " + modInfo.changeLog.replace(/\n/gs, "\n> ") + "\n";
				}
				await discordPost(message);
			} else {
				installedEntries.push(`${modInfo.title} (${modInfo.id})  ${modInfo.targetVersion.version}`);
			}

			// Pause for 5 seconds out of kindness for CDN
			await new Promise((resolve) => setTimeout(resolve, 5000));

			// If manually specified, save the new version to the config
			newModsConfig[modInfo.id] = {
				...(modInfo.disabled ? { disabled: true } : {}),
				title: modInfo.title,
				url: modInfo.url,
				lockToVersion: modInfo.lockToVersion,
				version: modInfo.targetVersion.version,
				gameVersion: modInfo.targetVersion.gameVersions.join(", "),
				requires: modInfo.requires,
				lastUpdated: currentTime,
				auto: modInfo.auto,
			};
		} else if (modInfo.action === "up-to-date") {
			newModsConfig[modInfo.id] = {
				...(modInfo.disabled ? { disabled: true } : {}),
				title: modInfo.title,
				url: modInfo.url,
				lockToVersion: modInfo.lockToVersion,
				version: modInfo.currentVersion,
				gameVersion: modInfo.targetVersion?.gameVersions.join(", ") || modInfo.gameVersion,
				requires: modInfo.requires,
				lastUpdated: currentTime,
				auto: modInfo.auto,
			};
		}
	}

	fs.readdirSync(MODS_DIR).forEach((file) => {
		const modId = file.split(".")[0];
		if (disabledMods[modId]) {
			fs.unlinkSync(`${MODS_DIR}/${modId}.zip`);

			console.log(`Uninstalling ${newModsConfig[modId].title} (${modId})`);
			uninstalledEntries.push(`${newModsConfig[modId].title} (${modId})`);
		}
	});

	// Scan dir for modIds of non-existing mods to delete
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
		deletedEntries.push(`${modId}`);
	}

	// Write the updated config
	fs.writeFileSync(MODS_JSON_PATH, JSON5.stringify(newModsConfig, null, 4).replace(/ {4}/g, "\t"));

	// Post collected entries if any
	if (installedEntries.length) {
		await discordPost("\n**✅ Newly installed:**\n- " + installedEntries.join("\n- "));
	}

	if (uninstalledEntries.length) {
		await discordPost("\n**❌ Uninstalled:**\n- " + uninstalledEntries.join("\n- "));
	}

	if (deletedEntries.length) {
		await discordPost("\n**❌ Deleted:**\n- " + deletedEntries.join("\n- "));
	}

	if (discordClient) {
		await discordClient.destroy();
	}

	console.log("Done!");
}

async function discordPost(message) {
	try {
		// Skip if no Discord config
		if (!fs.existsSync(DISCORD_CONFIG_PATH)) {
			console.log("[Discord] No Discord config found, skipping notification");
			return;
		}

		// Initialize client if needed
		if (!discordClient) {
			try {
				const discordConfig = JSON5.parse(fs.readFileSync(DISCORD_CONFIG_PATH, "utf8"));
				if (!discordConfig?.secretKey || !discordConfig?.broadcastChannels?.length) {
					console.log("[Discord] Discord config is missing required fields");
					return;
				}

				console.log("[Discord] Initializing Discord client...");
				discordClient = new Client({
					intents: [
						GatewayIntentBits.Guilds,
						GatewayIntentBits.GuildMessages,
						GatewayIntentBits.MessageContent,
					],
				});

				await discordClient.login(discordConfig.secretKey);

				// Fetch all channels
				for (const channel of discordConfig.broadcastChannels) {
					try {
						const guild = await discordClient.guilds.fetch(channel.guildId);
						const textChannel = await guild.channels.fetch(channel.channelId);

						if (!textChannel?.isTextBased()) {
							console.log(`[Discord] Channel ${channel.channelId} is not a text channel, skipping`);
							continue;
						}

						// Store error state on the channel object
						textChannel.error = null;
						discordChannels.push(textChannel);
					} catch (channelError) {
						console.error(`[Discord] Failed to fetch channel ${channel.channelId}:`, channelError.message);
					}
				}

				if (!discordChannels.length) {
					throw new Error("[Discord] No valid channels found");
				}
			} catch (initError) {
				console.error("[Discord] Failed to initialize Discord client:", initError.message);

				// Cleanup on initialization failure
				if (discordClient) {
					await discordClient.destroy();
					discordClient = null;
				}
				discordChannels = [];
				return;
			}
		}

		if (!hasPostedTitle) {
			console.log("[Discord] Posting title...");
			for (const channel of discordChannels) {
				if (!channel.error) {
					try {
						await channel.send("## Vintage Story Server Mod Updates");
					} catch (sendError) {
						console.error(`[Discord] Failed to send title to channel ${channel.id}:`, sendError.message);
						channel.error = true;
					}
				}
			}
			hasPostedTitle = true;
		}

		// Send to all channels that haven't errored
		console.log("[Discord] Sending message to channels...");
		for (const channel of discordChannels) {
			if (!channel.error) {
				try {
					await channel.send(message);
					console.log(`[Discord] Message sent to channel ${channel.id}`);
				} catch (sendError) {
					console.error(`[Discord] Failed to send message to channel ${channel.id}:`, sendError.message);
					channel.error = true;
				}
			} else {
				console.log(`[Discord] Skipping errored channel ${channel.id}`);
			}
		}
	} catch (error) {
		console.error("[Discord] Unexpected error in discordPost:", error.message);

		// Cleanup on unexpected error
		if (discordClient) {
			await discordClient.destroy();
			discordClient = null;
		}
		discordChannels = [];
	}
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
			modLookup[id].disabled = modInfo.disabled;
			modLookup[id].lockToVersion = modInfo.lockToVersion;
			modLookup[id].currentVersion = modInfo.version;
			modLookup[id].gameVersion = modInfo.gameVersion;
			modLookup[id].lastUpdated = modInfo.lastUpdated;
		} else {
			modLookup[id] = {
				disabled: modInfo.disabled,
				id,
				url,
				lockToVersion: modInfo.lockToVersion,
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
						disabled: reqConfig?.disabled,
						id: requireId,
						url: requireUrl,
						lockToVersion: reqConfig?.lockToVersion,
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

		// Updated title extraction for new structure:
		// <h2><span class="assettype">...</span> / <span>QP's Chisel Tools</span></h2>
		const title = $("h2 > span").eq(1).text().replace(/\s+/gs, " ").trim();

		// Find the versions table - look for table with download buttons
		const $table = $("table.release-table");

		// Split rows into info rows and changelog rows
		const infoRows = [];
		const changelogRows = [];

		$table.find("tbody tr").each((i, row) => {
			const $row = $(row);
			if ($row.attr("data-assetid")) {
				// This is an info row
				infoRows.push($row);
			} else if ($row.find(".release-changelog").length > 0) {
				// This is a changelog row
				changelogRows.push($row);
			}
		});

		const versions = [];
		const maxVersions = Math.min(MOST_RECENT_ENTRIES_COUNT, infoRows.length);

		for (let i = 0; i < maxVersions; i++) {
			const $infoRow = infoRows[i];
			const $changelogRow = changelogRows[i]; // Corresponding changelog row

			// Version is in the first column of info row
			const version = $infoRow.find("td").eq(0).text().trim().replace(/^v/, "");

			// Parse game versions from new tag structure in second column
			const $gameVersionCell = $infoRow.find("td").eq(1);
			let gameVersions = [];

			// Check for single version links: <a href="/list/mod/?gv[]=1.20.10" class="tag" rel="tag">1.20.10</a>
			const $versionLinks = $gameVersionCell.find("a.tag[rel='tag']");
			$versionLinks.each((j, link) => {
				const version = $(link).text().trim();
				gameVersions.push(version);
			});

			// Check for version range spans: <span class="tag">1.20.6 - 1.20.7</span>
			const $versionSpans = $gameVersionCell.find("span.tag");
			$versionSpans.each((j, span) => {
				const versionText = $(span).text().trim();
				if (versionText.includes(" - ")) {
					// Parse range like "1.20.6 - 1.20.7" and expand to all versions in range
					const [start, end] = versionText.split(" - ").map((v) => v.trim());
					const expandedVersions = expandVersionRange(start, end);
					gameVersions.push(...expandedVersions);
				} else {
					gameVersions.push(versionText);
				}
			});

			// Release date from 4th column
			const releaseDate = $infoRow.find("td").eq(3).text().trim();

			// Download URL from 6th column (index 5)
			const downloadUrl = $infoRow.find("td").eq(5).find("a.mod-dl").attr("href");
			const downloadFile = downloadUrl ? `https://mods.vintagestory.at${downloadUrl}` : null;

			// Extract changelog from corresponding changelog row
			let changelog = "";
			if ($changelogRow && $changelogRow.length > 0) {
				const $changelogContent = $changelogRow.find(".release-changelog");
				if ($changelogContent.length > 0) {
					changelog = $changelogContent
						.text()
						.trim()
						// Remove the version number from the beginning (it's usually in bold)
						.replace(new RegExp(`^${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line)
						.join("\n")
						.replace(/-----BEGIN PGP SIGNATURE-----[\s\S]*?-----END PGP SIGNATURE-----/g, "")
						.trim();
				}
			}

			versions.push({
				version,
				gameVersions,
				releaseDate,
				changelog,
				downloadFile,
			});
		}

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

	// Do not care about extra tags. Whichever is newer is better.
	// if (a.extra !== b.extra) {
	// 	return a.extra ? -1 : 1;
	// }

	// Versions are equal
	return 0;
}

function isVersionExactMatch(version) {
	const currentParts = splitVersion(GAME_VERSION);
	const versionParts = splitVersion(version);
	return (
		currentParts.major === versionParts.major &&
		currentParts.minor === versionParts.minor &&
		currentParts.patch === versionParts.patch
	);
}

function isVersionMinorMatch(version) {
	const currentParts = splitVersion(GAME_VERSION);
	const versionParts = splitVersion(version);
	return currentParts.major === versionParts.major && currentParts.minor === versionParts.minor;
}

function isVersionBelow(version) {
	const currentParts = splitVersion(GAME_VERSION);
	const versionParts = splitVersion(version);

	if (versionParts.major !== currentParts.major) {
		return versionParts.major < currentParts.major;
	}
	if (versionParts.minor !== currentParts.minor) {
		return versionParts.minor < currentParts.minor;
	}
	return versionParts.patch < currentParts.patch;
}

function resolveBestVersions(modConfig, modInfo) {
	// If lockToVersion is specified, only look for that version
	if (modConfig.lockToVersion) {
		const lockedVersion = modInfo.versions.find((version) => version.version === modConfig.lockToVersion);

		if (!lockedVersion) {
			console.log(`⚠️ Warning: Locked version ${modConfig.lockToVersion} not found in available versions`);
			return {
				...(modConfig.disabled ? { disabled: true } : {}),
				id: modConfig.id,
				title: modInfo.title,
				url: modConfig.url,
				lockToVersion: modConfig.lockToVersion,
				currentVersion: modConfig.currentVersion,
				gameVersion: modConfig.gameVersion,
				targetVersion: null,
				requires: modConfig.requires,
				action: "up-to-date", // Can't update if locked version not found
				changeLog: null,
				...(modConfig.auto ? { auto: true } : {}),
				lastUpdated: modConfig.lastUpdated,
			};
		}

		return {
			...(modConfig.disabled ? { disabled: true } : {}),
			id: modConfig.id,
			title: modInfo.title,
			url: modConfig.url,
			lockToVersion: modConfig.lockToVersion,
			currentVersion: modConfig.currentVersion,
			gameVersion: modConfig.gameVersion,
			targetVersion: lockedVersion,
			requires: modConfig.requires,
			action: modConfig.currentVersion !== lockedVersion.version ? "update" : "up-to-date",
			changeLog:
				modConfig.currentVersion !== lockedVersion.version
					? compileChangeLog(modInfo.versions, modConfig.currentVersion, lockedVersion.version)
					: null,
			...(modConfig.auto ? { auto: true } : {}),
			lastUpdated: modConfig.lastUpdated,
		};
	}

	// Match exact version if possible
	let compatibleVersions = modInfo.versions.filter((version) => {
		return version.gameVersions.some(isVersionExactMatch);
	});

	// If not, match the first version below the current version
	if (!compatibleVersions.length) {
		compatibleVersions = modInfo.versions.filter((version) => {
			return version.gameVersions.some(isVersionBelow);
		});
	}

	// If not, use anything
	if (!compatibleVersions.length) {
		compatibleVersions = modInfo.versions;
	}

	// Sort by version (highest first)
	compatibleVersions.sort((a, b) => -compareVersions(a.version, b.version));

	// Choose best version
	let action = "up-to-date";
	let targetVersion = compatibleVersions[0];
	let changeLog = null;

	if (modConfig.currentVersion !== targetVersion.version) {
		action = "update";
		changeLog = compileChangeLog(modInfo.versions, modConfig.currentVersion, targetVersion.version);
	}

	return {
		...(modConfig.disabled ? { disabled: true } : {}),
		id: modConfig.id,
		title: modInfo.title,
		url: modConfig.url,
		lockToVersion: modConfig.lockToVersion,
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

function expandVersionRange(startVersion, endVersion) {
	const start = splitVersion(startVersion);
	const end = splitVersion(endVersion);
	const versions = [];

	// Only handle cases where major.minor are the same and only patch differs
	if (start.major === end.major && start.minor === end.minor) {
		for (let patch = start.patch; patch <= end.patch; patch++) {
			const versionStr = `${start.major}.${start.minor}.${patch}`;
			versions.push(versionStr);
		}
	} else {
		// For more complex ranges, just include start and end for now
		// TODO: Could implement more sophisticated range expansion if needed
		versions.push(startVersion, endVersion);
	}

	return versions;
}
