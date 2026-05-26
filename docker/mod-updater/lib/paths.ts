export const DATA_DIR = "/data";
// Mod-updater config dirs are mounted at the container root, NOT under /data.
// /data is the game's dataPath (bind-mounted from ./data/saves); nesting these
// under it makes Docker create empty stub dirs inside the save folder that leak
// onto the host and persist after the container stops. Keep them out of /data.
export const MOD_CONFIGS_DIR = "/mod-configs";
export const HOST_CONFIGS_DIR = "/host-configs";
export const MODS_DIR = `${DATA_DIR}/Mods`;
export const CONFIG_PATH = `${MOD_CONFIGS_DIR}/mods.json5`;
export const LOCKFILE_PATH = `${MOD_CONFIGS_DIR}/mods-lock.json5`;
// Discord config holds a secret token - kept in host-configs (host-side, not the shareable mod list).
export const DISCORD_CONFIG_PATH = `${HOST_CONFIGS_DIR}/discord-config.json5`;

export const MOD_DB_BASE = "https://mods.vintagestory.at";
