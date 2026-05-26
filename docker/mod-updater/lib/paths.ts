export const DATA_DIR = "/data";
export const MOD_CONFIGS_DIR = `${DATA_DIR}/mod-configs`;
export const HOST_CONFIGS_DIR = `${DATA_DIR}/host-configs`;
export const MODS_DIR = `${DATA_DIR}/Mods`;
export const CONFIG_PATH = `${MOD_CONFIGS_DIR}/mods.json5`;
export const LOCKFILE_PATH = `${MOD_CONFIGS_DIR}/mods-lock.json5`;
// Discord config holds a secret token — kept in host-configs (host-side, not the shareable mod list).
export const DISCORD_CONFIG_PATH = `${HOST_CONFIGS_DIR}/discord-config.json5`;

export const MOD_DB_BASE = "https://mods.vintagestory.at";
