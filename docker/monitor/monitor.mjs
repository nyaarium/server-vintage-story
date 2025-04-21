import express from "express";
import fs from "fs";
import helmet from "helmet";
import http from "http";
import process from "process";
import { extractServerInfo, readServerLog } from "./log-parser.mjs";

let LOG_FILE = `/data/logs/output.log`;

// DEBUG
if (fs.existsSync(`./output.log`)) {
	console.log(`\n\n============================`);
	console.log(`DEBUG: Using ./output.log as the test log file`);
	console.log(`============================\n\n`);
	LOG_FILE = `./output.log`;
}

let lastStatus = null;
try {
	const expressApp = express();

	expressApp.use(helmet());

	expressApp.use(async (req, res) => {
		if (/^\/api\/check/.test(req.path)) {
			return res.status(200).json(lastStatus);
		} else {
			return req.socket.destroy();
		}
	});

	const webServer = http.createServer(expressApp);

	webServer.listen(8080, async (err) => {
		if (err) throw err;

		console.log("🔍 Log monitor server started on port 8080: /api/check");

		// Initial poll
		lastStatus = await pollServer();

		setInterval(async () => {
			lastStatus = await pollServer();
		}, 1000);

		if (typeof process.send === "function") {
			process.send("ready");
		}
	});
} catch (error) {
	console.error(error);
	process.exit(1);
}

async function pollServer() {
	const statusData = readServerLog(LOG_FILE);
	const processedStatus = extractServerInfo(statusData);
	return processedStatus;
}

process.once("SIGINT", function (code) {
	console.log(`SIGINT received`);
	process.exit();
});

process.once("SIGTERM", function (code) {
	console.log(`SIGTERM received`);
	process.exit();
});
