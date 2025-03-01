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
