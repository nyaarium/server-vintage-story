import express from "express";
import fs from "fs";
import helmet from "helmet";
import http from "http";
import process from "process";
import { readServerLog, sanitizeServerStatus } from "./log-parser.mjs";

let LOG_FILE = `/app/output.log`;

// DEBUG
if (fs.existsSync(`./output.log`)) {
	console.log(`\n\n============================`);
	console.log(`DEBUG: Using ./output.log as the test log file`);
	console.log(`============================\n\n`);
	LOG_FILE = `./output.log`;
}

if (!fs.existsSync(LOG_FILE)) {
	fs.writeFileSync(LOG_FILE, "");
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

		lastStatus = await pollServer();

		setInterval(async () => {
			lastStatus = await pollServer();
		}, 30000);

		if (typeof process.send === "function") {
			process.send("ready");
		}
	});
} catch (error) {
	console.error(error);
	process.exit(1);
}

async function pollServer() {
	// Read and parse the server log directly using the new function
	const statusData = readServerLog(LOG_FILE);

	// Process and sanitize the server status
	return sanitizeServerStatus(statusData);
}

process.once("SIGINT", function (code) {
	console.log(`SIGINT received`);
	process.exit();
});

process.once("SIGTERM", function (code) {
	console.log(`SIGTERM received`);
	process.exit();
});
