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

const TITLE = "## Vintage Story Server Mod Updates";

export class DiscordNotifier {
	private config: DiscordConfig | null = null;
	private queue: string[] = [];

	constructor(configPath: string = DISCORD_CONFIG_PATH) {
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
				log.warn("[discord] Config present but missing secretKey or broadcastChannels — notifier disabled.");
			}
		} catch (err) {
			log.warn(`[discord] Failed to parse ${configPath}: ${(err as Error).message} — notifier disabled.`);
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
				log.warn("[discord] No usable channels — discarding queued messages.");
				return;
			}

			await this.broadcast(channels, TITLE);

			for (const msg of this.queue) {
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
					log.warn(`[discord] Channel ${ref.channelId} is not a text channel — skipping.`);
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
