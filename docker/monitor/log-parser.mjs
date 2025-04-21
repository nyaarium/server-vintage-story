import fs from "fs";
import moment from "moment-timezone";
import path from "path";

const regexServerReady = /\[Server Event\] Dedicated Server now running/g;
const regexPlayerConnected = /\[Server Event\] .* joins\./g;
const regexPlayerDisconnected = /\[Server Event\] Player .* left\.|\[Server Event\] Player .* got removed\./g;

/**
 * Fixes date format from Vintage Story server logs
 * @param {string} str - Date string in format "day.month.year time"
 * @returns {string} Date string in format "month/day/year time"
 */
function fixDate(str) {
	// Ex: 2.5.2023 21:33:53
	const [p1, p2, p3] = str.split(".");
	return [p2, p1, p3].join("/");
}

// Store last read positions for different log files
const logPositions = new Map();
const logStats = new Map();

/**
 * Reads and parses the server log file
 * @param {string} logFilePath - Path to the server log file
 * @returns {Object} Server status object
 */
export function readServerLog(logFilePath) {
	try {
		// Check if file exists
		if (!fs.existsSync(logFilePath)) {
			console.log("⚠️ Log file does not exist:", logFilePath);
			return { status: "unknown", uptime: null };
		}

		// Get file stats
		const stats = fs.statSync(logFilePath);
		const key = path.resolve(logFilePath);

		// Check if file was modified (truncated or rotated)
		const previousStats = logStats.get(key);
		if (previousStats && stats.size < previousStats.size) {
			logPositions.delete(key);
		}

		// Update stored stats
		logStats.set(key, stats);

		// Get last position or start at beginning
		let position = logPositions.get(key) || 0;

		let newContent = "";

		if (!logStats.has(`${key}-status`)) {
			try {
				newContent = fs.readFileSync(logFilePath, { encoding: "utf8", flag: "rs" });

				// Set position for next read
				position = stats.size;
				logPositions.set(key, position);
			} catch (readError) {
				console.error("⚠️ Error reading log file:", readError);
			}
		} else if (position < stats.size) {
			try {
				// Open file for reading with explicit flags to handle shared access
				const fd = fs.openSync(logFilePath, "rs"); // 'rs' = open for reading in synchronous mode

				// Create buffer for reading
				const bufferSize = Math.min(64 * 1024, stats.size - position);
				const buffer = Buffer.alloc(bufferSize);

				// Read from the last position
				const bytesRead = fs.readSync(fd, buffer, 0, bufferSize, position);
				newContent = buffer.toString("utf8", 0, bytesRead);

				// Update position for next read
				position += bytesRead;
				logPositions.set(key, position);

				// Close the file
				fs.closeSync(fd);
			} catch (incrementalError) {
				// Continue with empty content as a fallback
			}
		}

		// Process the log content, using cached status on error
		const result = processLogContent(newContent, key);
		return result;
	} catch (error) {
		console.error("⚠️ Error reading server log:", error);
		return { status: "error", uptime: null, error: error.message };
	}
}

/**
 * Process log content and extract server status information
 * @param {string} content - Log content to process
 * @param {string} key - Unique identifier for the log file
 * @returns {Object} Server status object
 */
function processLogContent(content, key) {
	// Get existing status or create new one
	let currentStatus = logStats.get(`${key}-status`) || {
		status: "starting",
		uptime: Math.floor(Date.now() / 1000),
	};

	// Check if we have any meaningful content to process
	const hasContent = content && content.trim() !== "";

	// If no new content to process, just return current status
	if (!hasContent) {
		return currentStatus;
	}

	// Check if server is becoming ready
	if (regexServerReady.test(content)) {
		// If this is the first time we're detecting the server as running, update the uptime
		if (currentStatus.status !== "running") {
			console.log(`🔍 Server is ready`);
			currentStatus.status = "running";
			currentStatus.uptime = Math.floor(Date.now() / 1000);
		}
	}

	// Process player connections when server is running
	if (currentStatus.status === "running") {
		// Initialize player info if needed
		if (!currentStatus.info) currentStatus.info = { players: 0 };

		// Count player connects and disconnects in the new content using the predefined regexes
		const connects = (content.match(regexPlayerConnected) || []).length;
		const disconnects = (content.match(regexPlayerDisconnected) || []).length;

		// Only update and log if there's any player activity
		if (connects || disconnects) {
			const oldPlayerCount = currentStatus.info.players;
			currentStatus.info.players += connects;
			currentStatus.info.players = Math.max(0, currentStatus.info.players - disconnects);

			// Only log if the count actually changed
			if (oldPlayerCount !== currentStatus.info.players) {
				console.log(`🔍 Player count updated: ${oldPlayerCount} -> ${currentStatus.info.players}`);
			}
		}
	}

	// Store updated status
	logStats.set(`${key}-status`, currentStatus);

	return currentStatus;
}

/**
 * Sanitizes and processes server status JSON
 * @param {Object} json - Raw JSON object from server log
 * @returns {Object} Processed JSON with normalized uptime
 */
export function extractServerInfo(json) {
	// Process structure like:
	// {
	//   "status": "running",
	//   "uptime": {
	//     "iso":"2024-06-24T09:11:11Z",
	//   },
	//   "info": {
	//     "players": 0,
	//   },
	// }

	if (typeof json.uptime === "object") {
		let uptime = json.uptime;
		if (uptime) {
			if (uptime.date) {
				uptime = moment(new Date(fixDate(uptime.date))).unix();
			} else if (uptime.iso) {
				uptime = moment(fixDate(uptime.iso)).unix();
			} else if (uptime.unix) {
				uptime = Number(uptime.unix);
			}

			json.uptime = uptime;
		}
	}

	return json;
}
