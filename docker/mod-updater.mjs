import * as cheerio from "cheerio";
import fs from "fs";
import JSON5 from "json5";
import moment from "moment-timezone";
import fetch from "node-fetch";

const GAME_VERSION = process.env.GAME_VERSION;
const MODS_DIR = "/data/Mods";
const MODS_JSON_PATH = "/configs/Mods.json5";

const MOST_RECENT_ENTRIES_COUNT = 10;

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
			if (diff < 23) {
				modInfos[modConfig.id] = modConfig;
				continue;
			}
		}

		console.log("\n");

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
			if (diff < 23) {
				resolvedVersionInfo[modId] = modInfo;
				continue;
			}
		}

		console.log("\n");

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
		const gameVersions = modConfig.gameVersion.split(", ");
		if (!gameVersions.some((version) => versionMinorMatches(GAME_VERSION, version))) {
			nonMatches[id] = modConfig;
		}
	}

	let log = "";
	for (const id in nonMatches) {
		const modConfig = nonMatches[id];
		log += `  - ${modConfig.title} (${id})\n`;
		log += `      Version: ${modConfig.version}\n`;
		log += `      Supported Versions: ${modConfig.gameVersion}\n`;
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
			if (diff < 24) {
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
				logUpdated += `  - ${modInfo.title} (${modInfo.id})  ${modInfo.currentVersion}  ->  ${modInfo.targetVersion.version}\n`;
			} else {
				logInstalled += `  - ${modInfo.title} (${modInfo.id})  ${modInfo.targetVersion.version}\n`;
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
			logUpToDate += `  - ${modInfo.title} (${modInfo.id})\n`;

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
		logDeleted += `  - ${modId}\n`;
	}

	// Write the updated config
	fs.writeFileSync(MODS_JSON_PATH, JSON5.stringify(newModsConfig, null, 4).replace(/ {4}/g, "\t"));
	// console.log(JSON5.stringify(newModsConfig, null, 4).replace(/ {4}/g, "\t"));

	let log = "";

	if (logUpToDate) {
		log += `\n✅ Up to date:\n${logUpToDate}`;
	}
	if (logInstalled) {
		log += `\n✅ Newly installed:\n${logInstalled}`;
	}
	if (logUpdated) {
		log += `\n✅ Updated:\n${logUpdated}`;
	}
	if (logDeleted) {
		log += `\n❌ Deleted:\n${logDeleted}`;
	}

	console.log(log);

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
		console.error("Failed to read or parse Mods.json5:", error);
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
				const gameVersionTitle = $gameVersionCell.find(".tag").attr("title");
				const gameVersions = gameVersionTitle
					? gameVersionTitle.split(", ").map((v) => v.trim().replace(/^v/, ""))
					: [
							$gameVersionCell
								.text()
								.trim()
								.replace(/^[#v]/, "")
								.split(/[\t\s]/)[0]
								.replace(/^v/, ""),
					  ];

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

function resolveBestVersions(modConfig, modInfo) {
	console.log(modInfo.title);

	const bestVersion = modInfo.versions.filter((version) =>
		version.gameVersions.some((supportedVersion) => versionMinorMatches(GAME_VERSION, supportedVersion)),
	)[0];

	let action = "up-to-date";
	let targetVersion = null;
	let changeLog = null;

	console.log(`Current: ${modConfig.currentVersion || "Not installed"}`);

	if (bestVersion) {
		console.log(`Online: ${bestVersion.version} - (${bestVersion.releaseDate})`);
		targetVersion = bestVersion;
	} else if (modInfo.versions.length) {
		const nextBestVersion = modInfo.versions[0];
		console.log(`Online: ${nextBestVersion.version} - (${nextBestVersion.releaseDate})`);
		targetVersion = nextBestVersion;
	} else if (!modConfig.downloadFile) {
		console.log("Online: No download link found!");
	} else {
		console.log("Online: No versions found!");
	}

	if (targetVersion) {
		if (modConfig.currentVersion === targetVersion.version) {
			action = "up-to-date";
		} else {
			action = "update";
			changeLog = compileChangeLog(modInfo.versions, modConfig.currentVersion, targetVersion.version);
		}
	} else {
		action = "up-to-date";
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

function versionMinorMatches(gameVersion, version) {
	const versionParts = version.split(".");
	const gameVersionParts = gameVersion.split(".");

	return versionParts[0] === gameVersionParts[0] && versionParts[1] === gameVersionParts[1];
}

function compileChangeLog(versions, oldModVersion, newModVersion) {
	const changelogEntries = [];
	let startCollecting = false;

	for (const version of versions) {
		if (version.version === newModVersion) {
			startCollecting = true;
		}

		if (startCollecting) {
			changelogEntries.push(`Version ${version.version}:\n${version.changelog}\n`);
		}

		if (version.version === oldModVersion) {
			break;
		}
	}

	// Reverse the collected changelog entries to have the newest at the top
	return (
		changelogEntries
			.reverse()
			.join("\n")
			// Remove version headers
			.replace(/\nVersion \d+\.\d+\.\d+:\n/gs, "\n")
	);
}
