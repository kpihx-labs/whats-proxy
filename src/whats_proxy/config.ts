/**
 * whats-proxy — Configuration loader.
 *
 * Load order (mirrors whats-mcp config.js):
 *   1. Built-in defaults
 *   2. ~/.config/whats-proxy/.env (optional, only sets unset vars)
 *   3. Process environment (WHATS_PROXY_*)
 *
 * No secrets live here — auth artifacts are session files under state/.
 */

import { VERSION } from "./version.ts";

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AppConfig {
  state_directory: string;
  server: {
    name: string;
    version: string;
  };
  daemon: {
    /** Minutes of RPC inactivity before the daemon exits (0 = never). */
    max_idle_minutes: number;
  };
  connection: {
    print_qr_in_terminal: boolean;
    reconnect_interval_ms: number;
    max_reconnect_attempts: number;
    mark_online_on_connect: boolean;
    sync_full_history: boolean;
    refresh_app_state: boolean;
  };
  store: {
    max_messages_per_chat: number;
    max_chats: number;
    persist: boolean;
  };
  watchlists: Record<string, string[]>;
}

const DEFAULTS: AppConfig = {
  state_directory: "~/.config/whats-proxy",
  server: {
    name: "whats-proxy",
    version: VERSION,
  },
  daemon: {
    max_idle_minutes: 0,
  },
  connection: {
    print_qr_in_terminal: true,
    reconnect_interval_ms: 3000,
    max_reconnect_attempts: 10,
    mark_online_on_connect: false,
    sync_full_history: true,
    refresh_app_state: true,
  },
  store: {
    max_messages_per_chat: 5000,
    max_chats: 1000,
    persist: true,
  },
  watchlists: {},
};

/** Expand a leading `~` to the home directory. */
export function expandHome(p: string): string {
  return p.replace(/^~(?=$|[/\\])/, homedir());
}

/** Resolve the config directory (default ~/.config/whats-proxy). */
export function configDir(): string {
  return expandHome(process.env.WHATS_PROXY_CONFIG_DIR || DEFAULTS.state_directory);
}

/**
 * Resolve the state directory, defaulting to the configured proxy directory.
 *
 * Args:
 *   cfg: Fully loaded application configuration.
 *
 * Returns:
 *   Expanded absolute state directory path.
 *
 * Examples:
 *   stateDir({ state_directory: "$HOME/.config/whats-proxy" } as AppConfig)
 *   // => "/home/example/.config/whats-proxy"
 *   stateDir({ state_directory: "/tmp/whats-state" } as AppConfig)
 *   // => "/tmp/whats-state"
 *   stateDir({ state_directory: "~/state" } as AppConfig)
 *   // => "/home/example/state"
 */
export function stateDir(cfg: AppConfig): string {
  return expandHome(cfg.state_directory);
}

/**
 * Build all canonical paths inside the configured proxy state directory.
 *
 * Args:
 *   cfg: Fully loaded application configuration.
 *
 * Returns:
 *   Directory, auth, Store, PID, socket, lock, and autosave paths.
 *
 * Examples:
 *   statePaths({ state_directory: "/tmp/ws" } as AppConfig).sockFile
 *   // => "/tmp/ws/whats-proxy.sock"
 *   statePaths({ state_directory: "/tmp/ws" } as AppConfig).auth
 *   // => "/tmp/ws/state"
 *   statePaths({ state_directory: "/tmp/ws" } as AppConfig).lockFile
 *   // => "/tmp/ws/whats-proxy.lock"
 */
export function statePaths(cfg: AppConfig) {
  const dir = stateDir(cfg);
  return {
    dir,
    auth: join(dir, "state"),
    storeFile: join(dir, "store.json"),
    pidFile: join(dir, "whats-proxy.pid"),
    sockFile: join(dir, "whats-proxy.sock"),
    lockFile: join(dir, "whats-proxy.lock"),
    autosaveDir: "/tmp/whats-proxy-autosave",
  };
}

/**
 * Create the required state, auth, and autosave directories idempotently.
 *
 * Args:
 *   cfg: Fully loaded application configuration.
 *
 * Returns:
 *   The same canonical path object used by callers after directories exist.
 *
 * Examples:
 *   ensureDirs({ state_directory: "/tmp/ws" } as AppConfig).dir
 *   // => "/tmp/ws"
 *   ensureDirs({ state_directory: "/tmp/ws" } as AppConfig).auth
 *   // => "/tmp/ws/state"
 *   ensureDirs({ state_directory: "/tmp/ws" } as AppConfig).autosaveDir
 *   // => "/tmp/whats-proxy-autosave"
 */
export function ensureDirs(cfg: AppConfig) {
  const p = statePaths(cfg);
  mkdirSync(p.dir, { recursive: true });
  mkdirSync(p.auth, { recursive: true });
  mkdirSync(p.autosaveDir, { recursive: true });
  return p;
}

function _loadEnvFile(dir: string) {
  const envFile = join(dir, ".env");
  if (!existsSync(envFile)) return;
  const raw = readFileSync(envFile, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    if (!process.env[key]) process.env[key] = value;
  }
}

/** Load and return the merged configuration. */
export function loadConfig(): AppConfig {
  _loadEnvFile(configDir());

  const config = JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
  const bool = (name: string, current: boolean): boolean => process.env[name] === undefined ? current : process.env[name] !== "false";
  const number = (name: string, current: number): number => {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : current;
  };

  // Environment overrides — one documented .env file, no config.json layer.
  if (process.env.WHATS_PROXY_STATE_DIR) {
    config.state_directory = process.env.WHATS_PROXY_STATE_DIR;
  }
  config.daemon.max_idle_minutes = number("WHATS_PROXY_MAX_IDLE_MINUTES", config.daemon.max_idle_minutes);
  config.connection.reconnect_interval_ms = number("WHATS_PROXY_RECONNECT_INTERVAL_MS", config.connection.reconnect_interval_ms);
  config.connection.max_reconnect_attempts = number("WHATS_PROXY_MAX_RECONNECT", config.connection.max_reconnect_attempts);
  config.connection.print_qr_in_terminal = bool("WHATS_PROXY_PRINT_QR", config.connection.print_qr_in_terminal);
  config.connection.sync_full_history = bool("WHATS_PROXY_SYNC_FULL_HISTORY", config.connection.sync_full_history);
  config.connection.refresh_app_state = bool("WHATS_PROXY_REFRESH_APP_STATE", config.connection.refresh_app_state);
  config.connection.mark_online_on_connect = bool("WHATS_PROXY_MARK_ONLINE", config.connection.mark_online_on_connect);
  config.store.persist = bool("WHATS_PROXY_PERSIST_STORE", config.store.persist);
  config.store.max_messages_per_chat = number("WHATS_PROXY_MAX_MESSAGES_PER_CHAT", config.store.max_messages_per_chat);
  config.store.max_chats = number("WHATS_PROXY_MAX_CHATS", config.store.max_chats);

  // Normalise state_directory to absolute
  config.state_directory = resolve(expandHome(config.state_directory));

  return config;
}
