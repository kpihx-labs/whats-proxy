/**
 * whats-proxy — Configuration loader.
 *
 * Load order (mirrors whats-mcp config.js):
 *   1. Built-in defaults
 *   2. ~/.config/whats-proxy/config.json (deep merge)
 *   3. ~/.config/whats-proxy/.env (optional, only sets unset vars)
 *   4. Process environment (WHATS_PROXY_*)
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
  logging: {
    level: string;
  };
  watchlists: Record<string, string[]>;
}

const DEFAULTS: AppConfig = {
  state_directory: "~/.config/whats-proxy",
  server: {
    name: "whats-proxy",
    version: VERSION,
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
  logging: {
    level: "info",
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

/** Resolve the state directory (default = config dir). */
export function stateDir(cfg: AppConfig): string {
  return expandHome(cfg.state_directory);
}

/** Key paths inside the state directory. */
export function statePaths(cfg: AppConfig) {
  const dir = stateDir(cfg);
  return {
    dir,
    auth: join(dir, "state"),
    storeFile: join(dir, "store.json"),
    pidFile: join(dir, "whats-proxy.pid"),
    logFile: join(dir, "whats-proxy.log"),
    sockFile: join(dir, "whats-proxy.sock"),
    autosaveDir: "/tmp/whats-proxy-autosave",
  };
}

/** Ensure the config + state directories exist. */
export function ensureDirs(cfg: AppConfig) {
  const p = statePaths(cfg);
  mkdirSync(p.dir, { recursive: true });
  mkdirSync(p.auth, { recursive: true });
  mkdirSync(p.autosaveDir, { recursive: true });
  return p;
}

// ── Merge + env loading (ported from whats-mcp config.js) ───────────────────

function _merge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  for (const key of Object.keys(b)) {
    if (
      a[key] &&
      typeof a[key] === "object" &&
      !Array.isArray(a[key]) &&
      typeof b[key] === "object" &&
      !Array.isArray(b[key])
    ) {
      _merge(a[key], b[key]);
    } else {
      a[key] = b[key];
    }
  }
  return a;
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

  const configFile = join(configDir(), "config.json");
  if (existsSync(configFile)) {
    const fileConfig = JSON.parse(readFileSync(configFile, "utf-8"));
    _merge(config as unknown as Record<string, any>, fileConfig);
  }

  // Environment variable overrides
  if (process.env.WHATS_PROXY_STATE_DIR) {
    config.state_directory = process.env.WHATS_PROXY_STATE_DIR;
  }
  if (process.env.WHATS_PROXY_LOG_LEVEL) {
    config.logging.level = process.env.WHATS_PROXY_LOG_LEVEL;
  }
  if (process.env.WHATS_PROXY_MAX_RECONNECT) {
    config.connection.max_reconnect_attempts = parseInt(process.env.WHATS_PROXY_MAX_RECONNECT, 10);
  }
  if (process.env.WHATS_PROXY_PRINT_QR !== undefined) {
    config.connection.print_qr_in_terminal = process.env.WHATS_PROXY_PRINT_QR !== "false";
  }
  if (process.env.WHATS_PROXY_SYNC_FULL_HISTORY !== undefined) {
    config.connection.sync_full_history = process.env.WHATS_PROXY_SYNC_FULL_HISTORY !== "false";
  }
  if (process.env.WHATS_PROXY_REFRESH_APP_STATE !== undefined) {
    config.connection.refresh_app_state = process.env.WHATS_PROXY_REFRESH_APP_STATE !== "false";
  }
  if (process.env.WHATS_PROXY_MARK_ONLINE !== undefined) {
    config.connection.mark_online_on_connect = process.env.WHATS_PROXY_MARK_ONLINE !== "false";
  }
  if (process.env.WHATS_PROXY_PERSIST_STORE !== undefined) {
    config.store.persist = process.env.WHATS_PROXY_PERSIST_STORE !== "false";
  }
  if (process.env.WHATS_PROXY_MAX_MESSAGES_PER_CHAT) {
    config.store.max_messages_per_chat = parseInt(process.env.WHATS_PROXY_MAX_MESSAGES_PER_CHAT, 10);
  }
  if (process.env.WHATS_PROXY_MAX_CHATS) {
    config.store.max_chats = parseInt(process.env.WHATS_PROXY_MAX_CHATS, 10);
  }

  // Normalise state_directory to absolute
  config.state_directory = resolve(expandHome(config.state_directory));

  return config;
}
