/**
 * whats-proxy — Configuration loader.
 *
 * All defaults live here as a single source of truth. No .env file,
 * no config.json layer. Auth artifacts are session files under state/.
 */

import { VERSION } from "./version.ts";

import { mkdirSync } from "node:fs";
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
    /** Minutes of RPC inactivity before the daemon exits (30 = default, 0 = never). */
    max_idle_minutes: 30,
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

/** Load and return the merged configuration. */
export function loadConfig(): AppConfig {
  const config = JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;

  // Single env overrides for test isolation and operational tuning.
  if (process.env.WHATS_PROXY_STATE_DIR) {
    config.state_directory = process.env.WHATS_PROXY_STATE_DIR;
  }
  if (process.env.WHATS_PROXY_MAX_IDLE_MINUTES !== undefined) {
    const parsed = Number(process.env.WHATS_PROXY_MAX_IDLE_MINUTES);
    if (Number.isFinite(parsed) && parsed >= 0) config.daemon.max_idle_minutes = parsed;
  }

  // Normalise state_directory to absolute
  config.state_directory = resolve(expandHome(config.state_directory));

  return config;
}
