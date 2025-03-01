import fs from "fs";
import moment from "moment-timezone";

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

/**
 * Reads and parses the server log file
 * @param {string} logFilePath - Path to the server log file
 * @returns {Object} Server status object
 */
export function readServerLog(logFilePath) {
	try {
		// Check if file exists
		if (!fs.existsSync(logFilePath)) {
			return { status: "unknown", uptime: null };
		}

		// Read the log file content
		const logContent = fs.readFileSync(logFilePath, "utf8");

		// If the first line is 'down', server is down
		if (logContent.trim().startsWith("down")) {
			return { status: "down", uptime: null };
		}

		// Find server running event line
		const serverRunningLine = logContent
			.split("\n")
			.find((line) => line.includes("[Server Event] Dedicated Server now running"));

		// Extract timestamp exactly as the shell script did (first two space-separated parts)
		let gameUptime = null;
		if (serverRunningLine) {
			const parts = serverRunningLine.split(" ");
			if (parts.length >= 2) {
				gameUptime = parts[0] + " " + parts[1];
			}
		}

		// Count player connects and disconnects
		const connects = (logContent.match(/\[Server Event\] .* joins\./g) || []).length;
		const disconnects = (
			logContent.match(/\[Server Event\] Player .* left\.|\[Server Event\] Player .* got removed\./g) || []
		).length;

		// Build status object
		if (!gameUptime) {
			return {
				status: "starting",
				uptime: Math.floor(Date.now() / 1000), // Current timestamp as fallback
			};
		} else {
			return {
				status: "running",
				uptime: { date: gameUptime },
				info: {
					players: Math.max(0, connects - disconnects),
				},
			};
		}
	} catch (error) {
		console.error("Error reading server log:", error);
		return { status: "error", uptime: null, error: error.message };
	}
}

/**
 * Sanitizes and processes server status JSON
 * @param {Object} json - Raw JSON object from server log
 * @returns {Object} Processed JSON with normalized uptime
 */
export function sanitizeServerStatus(json) {
	// Process structure like:
	// {
	//   "status": "running",
	//   "uptime": {
	//     "date":"2024-06-24 09:11:11",
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
