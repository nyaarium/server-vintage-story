import fs from "node:fs";
import { Client, GatewayIntentBits } from "discord.js";
import JSON5 from "json5";
import { log } from "./logger";
import { DISCORD_CONFIG_PATH } from "./paths";

interface DiscordConfig {
	secretKey: string;
	broadcastChannels: Array<{ guildId: string; channelId: string }>;
}

interface ChannelState {
	guildId: string;
	channelId: string;
	channel: any;
	failed: boolean;
}

const TITLE = "# Vintage Story Server Mod Updates";

// Discord hard-caps messages at 2000 characters. Leave headroom for safety.
export const MAX_MESSAGE_LEN = 1900;

function isHeader(block: string): boolean {
	return /^#{1,6} /.test(block);
}

// Last-resort split for a single block that is itself larger than the limit
// (e.g. a mod with an enormous changelog). Split on line boundaries first,
// hard-cutting only an individual line that still overflows.
function splitOversized(block: string, limit: number): string[] {
	const pieces: string[] = [];
	let cur = "";
	for (const line of block.split("\n")) {
		if (line.length > limit) {
			if (cur) {
				pieces.push(cur);
				cur = "";
			}
			for (let i = 0; i < line.length; i += limit) {
				pieces.push(line.slice(i, i + limit));
			}
			continue;
		}
		if (cur && cur.length + 1 + line.length > limit) {
			pieces.push(cur);
			cur = line;
		} else {
			cur = cur ? `${cur}\n${line}` : line;
		}
	}
	if (cur) pieces.push(cur);
	return pieces;
}

// Pack atomic blocks (section headers + individual entries) into messages no
// larger than `limit`, cutting only at block boundaries. A header is never left
// stranded as the last line of a message - if its following entry wouldn't also
// fit, the header starts a fresh message instead.
export function packBlocks(blocks: string[], limit: number = MAX_MESSAGE_LEN): string[] {
	const messages: string[] = [];
	let cur = "";
	const flush = () => {
		if (cur) {
			messages.push(cur);
			cur = "";
		}
	};

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];

		if (block.length > limit) {
			flush();
			for (const piece of splitOversized(block, limit)) messages.push(piece);
			continue;
		}

		if (!cur) {
			cur = block;
			continue;
		}

		if (cur.length + 1 + block.length > limit) {
			flush();
			cur = block;
			continue;
		}

		// Header fits, but don't strand it: if its first entry won't also fit,
		// push the header to the next message so it leads its section.
		if (isHeader(block)) {
			const next = blocks[i + 1];
			const nextLen = next && next.length <= limit ? 1 + next.length : 0;
			if (cur.length + 1 + block.length + nextLen > limit) {
				flush();
				cur = block;
				continue;
			}
		}

		cur = `${cur}\n${block}`;
	}
	flush();
	return messages;
}

export interface DiscordNotifierOptions {
	title?: string;
	configPath?: string;
}

// Generic error notice used by the CLI's top-level handler so any command's
// failure reaches Discord, not just stdout/stderr.
export function buildErrorBlocks(command: string, reason: string): string[] {
	return ["## ⚠️ Error", `\`${command || "(no command)"}\` failed:\n${reason}`];
}

export class DiscordNotifier {
	private config: DiscordConfig | null = null;
	private queue: string[] = [];
	private title: string;

	constructor(opts: DiscordNotifierOptions = {}) {
		this.title = opts.title ?? TITLE;
		const configPath = opts.configPath ?? DISCORD_CONFIG_PATH;
		if (!fs.existsSync(configPath)) return;
		try {
			const cfg = JSON5.parse(fs.readFileSync(configPath, "utf8")) as Partial<DiscordConfig>;
			if (
				typeof cfg?.secretKey === "string" &&
				cfg.secretKey.length > 0 &&
				Array.isArray(cfg?.broadcastChannels) &&
				cfg.broadcastChannels.length > 0
			) {
				this.config = cfg as DiscordConfig;
			} else {
				log.warn("[discord] Config present but missing secretKey or broadcastChannels - notifier disabled.");
			}
		} catch (err) {
			log.warn(`[discord] Failed to parse ${configPath}: ${(err as Error).message} - notifier disabled.`);
		}
	}

	get enabled(): boolean {
		return this.config !== null;
	}

	post(message: string): void {
		if (!this.config) return;
		this.queue.push(message);
	}

	async finalize(): Promise<void> {
		if (!this.config || this.queue.length === 0) return;

		const client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
			],
		});

		try {
			log.info("[discord] Logging in...");
			await client.login(this.config.secretKey);

			const channels = await this.fetchChannels(client);
			if (channels.length === 0) {
				log.warn("[discord] No usable channels - discarding queued messages.");
				return;
			}

			const messages = packBlocks([this.title, ...this.queue]);
			for (const msg of messages) {
				await this.broadcast(channels, msg);
			}
			this.queue = [];

			const failed = channels.filter((c) => c.failed).length;
			if (failed > 0) {
				log.warn(`[discord] ${failed} of ${channels.length} channels had send errors.`);
			} else {
				log.info(`[discord] Posted to ${channels.length} channel(s).`);
			}
		} catch (err) {
			log.warn(`[discord] Notification flow failed: ${(err as Error).message}`);
		} finally {
			try {
				await client.destroy();
			} catch {
				// best effort cleanup
			}
		}
	}

	private async fetchChannels(client: Client): Promise<ChannelState[]> {
		const states: ChannelState[] = [];
		if (!this.config) return states;

		for (const ref of this.config.broadcastChannels) {
			try {
				const guild = await client.guilds.fetch(ref.guildId);
				const channel = await guild.channels.fetch(ref.channelId);
				if (!channel || typeof (channel as any).isTextBased !== "function" || !(channel as any).isTextBased()) {
					log.warn(`[discord] Channel ${ref.channelId} is not a text channel - skipping.`);
					continue;
				}
				states.push({ guildId: ref.guildId, channelId: ref.channelId, channel, failed: false });
			} catch (err) {
				log.warn(`[discord] Failed to fetch ${ref.guildId}/${ref.channelId}: ${(err as Error).message}`);
			}
		}

		return states;
	}

	private async broadcast(channels: ChannelState[], message: string): Promise<void> {
		for (const state of channels) {
			if (state.failed) continue;
			try {
				await state.channel.send(message);
			} catch (err) {
				log.warn(`[discord] Send to ${state.channelId} failed: ${(err as Error).message}`);
				state.failed = true;
			}
		}
	}
}
