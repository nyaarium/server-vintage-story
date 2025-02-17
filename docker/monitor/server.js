const JSON5 = require("json5");
const fs = require("fs");
const path = require("path");
const moment = require("moment");
const http = require("http");
const express = require("express");
const helmet = require("helmet");
const spawn = require("cross-spawn");

////////////////////////////////////////////////////////////////
// In case certain apps return a stupid date format.
// Adjust this date fixer per game service.
//
function fixDate(str) {
	// Ex: 2.5.2023 21:33:53
	const [p1, p2, p3] = str.split(".");
	return [p2, p1, p3].join("/");
	// return str;
}
//
////////////////////////////////////////////////////////////////

let LOG_FILE = `/app/output.log`;

// DEBUG
if (fs.existsSync(`./output.log`)) {
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
	const res = await run(path.join(process.cwd(), `poll-log.sh`));
	const json = JSON5.parse(res.stdout);

	// {
	// 	"status": "running",
	// 	"uptime": {
	// 		"date":"2024-06-24 09:11:11",
	// 	},
	// 	"info": {
	// 		"players": 0,
	// 	},
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

async function run(script, params = []) {
	let log = ""; //  Both out/err in the order they appeared in
	let stdout = "";
	let stderr = "";

	const pr = createPromise();

	const child = spawn(script, params);
	child.on("exit", (code) => {
		const data = {
			log,
			stdout,
			stderr,
		};

		if (code === 0) {
			pr.resolve(data);
		} else {
			console.log(log);
			pr.reject();
		}
	});

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");

	child.stdout.on("data", function (data) {
		stdout += data;
		log += data;
	});

	child.stderr.on("data", function (data) {
		stderr += data;
		log += data;
	});

	return pr.promise;
}

function createPromise() {
	let resolve, reject;
	let promise = new Promise((rs, rj) => {
		resolve = rs;
		reject = rj;
	});
	return {
		promise,
		resolve,
		reject,
	};
}

process.once("SIGINT", function (code) {
	console.log(`SIGINT received`);
	process.exit();
});

process.once("SIGTERM", function (code) {
	console.log(`SIGTERM received`);
	process.exit();
});
