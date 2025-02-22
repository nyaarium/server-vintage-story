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
	let logUpToDate = "";
	let logInstalled = "";
	let logUpdated = "";
	let logDeleted = "";

	const now = moment();
	const currentTime = new Date().toISOString();

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

			if (modInfo.currentVersion) {
				logUpdated += `- ${modInfo.title} (${modInfo.id})  ${modInfo.currentVersion}  ->  ${modInfo.targetVersion.version}\n`;

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
				lockToVersion: modInfo.lockToVersion,
				version: modInfo.targetVersion.version,
				gameVersion: modInfo.targetVersion.gameVersions.join(", "),
				requires: modInfo.requires,
				lastUpdated: currentTime,
				auto: modInfo.auto,
			};
		} else if (modInfo.action === "up-to-date") {
			logUpToDate += `- ${modInfo.title} (${modInfo.id})\n`;

			newModsConfig[modInfo.id] = {
				title: modInfo.title,
				url: modInfo.url,
				lockToVersion: modInfo.lockToVersion,
				version: modInfo.currentVersion,
				gameVersion: modInfo.gameVersion,
				requires: modInfo.requires,
				lastUpdated: currentTime,
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
			modLookup[id].lockToVersion = modInfo.lockToVersion;
			modLookup[id].currentVersion = modInfo.version;
			modLookup[id].gameVersion = modInfo.gameVersion;
			modLookup[id].lastUpdated = modInfo.lastUpdated;
		} else {
			modLookup[id] = {
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

				const $gameVersionTags = $gameVersionCell.find(".tag");
				let gameVersions = [];
				$gameVersionTags.each((i, tag) => {
					const $tag = $(tag);
					const title = $tag.attr("title");
					if (title) {
						/*
						<td>
							<div class="tags">
								<a href="#" class="tag" style="background-color:#C9C9C9" title="v1.20.0, v1.20.1, v1.20.2, v1.20.3, v1.20.4">Various v1.20.x*</a>
							</div>
						</td>
						*/
						const versions = title.split(",").map((v) => v.trim().replace(/^[#v]*/, ""));
						gameVersions.push(...versions);
					} else {
						/*
						<td>
							<div class="tags">
								<a href="/list/mod/?gv[]=270" class="tag" style="background-color:#C9C9C9">#v1.20.4-rc.3</a>
								<a href="/list/mod/?gv[]=271" class="tag" style="background-color:#C9C9C9">#v1.20.4-rc.4</a>
							</div>
						</td>
						*/
						gameVersions.push(
							$tag
								.text()
								.trim()
								.replace(/^[#v]*/, ""),
						);
					}
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

	// If not, match major.minor and any patch versions
	if (!compatibleVersions.length) {
		compatibleVersions = modInfo.versions.filter((version) => {
			return version.gameVersions.some(isVersionMinorMatch);
		});
	}

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
