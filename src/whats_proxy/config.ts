/**
 * whats-proxy — Configuration loader + multi-account management.
 *
 * All defaults live here as a single source of truth. No .env file,
 * no config.json layer.
 *
 * Split layout (XDG-style):
 *   ~/.config/whats-proxy/              # CONFIG ONLY (light)
 *   ├── accounts.json                   # account registry + default
 *
 *   ~/.local/share/whats-proxy/         # HEAVY DATA (per-account)
 *   └── <phone>/
 *       ├── state/                      # Baileys auth
 *       ├── store.json                  # messages, contacts, chats
 *       ├── daemon.sock                 # daemon socket
 *       ├── daemon.lock                 # O_EXCL lock
 *       └── daemon.pid                  # daemon PID
 */

import { VERSION } from "./version.ts";

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

/** Resolve the share directory for heavy per-account data (default ~/.local/share/whats-proxy). */
export function shareDir(): string {
  return expandHome(process.env.WHATS_PROXY_SHARE_DIR || join(homedir(), ".local", "share", "whats-proxy"));
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

/** Build paths for a specific account: <base>/<phone>/... */
export function accountStatePaths(phone: string, cfg?: AppConfig) {
  const dir = accountDir(phone, cfg);
  return {
    dir,
    auth: join(dir, "state"),
    storeFile: join(dir, "store.json"),
    pidFile: join(dir, "daemon.pid"),
    sockFile: join(dir, "daemon.sock"),
    lockFile: join(dir, "daemon.lock"),
    autosaveDir: "/tmp/whats-proxy-autosave",
  };
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

// ── Multi-account management ──────────────────────────────────────────────────

export interface AccountInfo {
  alias: string | null;
  created: string;
  last_active: string | null;
}

interface AccountsFile {
  default: string | null;
  accounts: Record<string, AccountInfo>;
}

const ACCOUNTS_FILENAME = "accounts.json";

/** Read the accounts.json file. Returns empty registry if missing. */
export function readAccounts(_cfg?: AppConfig): AccountsFile {
  const filePath = join(configDir(), ACCOUNTS_FILENAME);
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as AccountsFile;
  } catch {
    return { default: null, accounts: {} };
  }
}

/** Write the accounts.json file. */
export function writeAccounts(data: AccountsFile, _cfg?: AppConfig): void {
  const base = configDir();
  const filePath = join(base, ACCOUNTS_FILENAME);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
}

/** Get the per-account directory path: <shareDir>/<phone>/ */
export function accountDir(phone: string, _cfg?: AppConfig): string {
  return join(shareDir(), canonicalPhone(phone));
}

/** Get the canonical phone number (digits only). */
export function canonicalPhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Get the default account phone, or null if none set. */
export function getDefaultAccount(cfg?: AppConfig): string | null {
  const data = readAccounts(cfg);
  return data.default;
}

/** Set the default account phone. */
export function setDefaultAccount(phone: string, cfg?: AppConfig): void {
  const data = readAccounts(cfg);
  data.default = canonicalPhone(phone);
  writeAccounts(data, cfg);
}

/** Register a new account in accounts.json. */
export function registerAccount(phone: string, alias: string | null, cfg?: AppConfig): void {
  const data = readAccounts(cfg);
  const cp = canonicalPhone(phone);
  if (!data.accounts[cp]) {
    data.accounts[cp] = {
      alias,
      created: new Date().toISOString(),
      last_active: null,
    };
    if (!data.default) data.default = cp;
    writeAccounts(data, cfg);
  }
}

/** Remove an account from accounts.json. Does NOT delete files. */
export function unregisterAccount(phone: string, cfg?: AppConfig): void {
  const data = readAccounts(cfg);
  const cp = canonicalPhone(phone);
  delete data.accounts[cp];
  if (data.default === cp) data.default = Object.keys(data.accounts)[0] || null;
  writeAccounts(data, cfg);
}

/** List all registered account phones. */
export function listAccounts(cfg?: AppConfig): string[] {
  return Object.keys(readAccounts(cfg).accounts);
}

/** Delete all files for an account (state, store, daemon artifacts). */
export function deleteAccountFiles(phone: string, cfg?: AppConfig): void {
  const dir = accountDir(phone, cfg);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}


