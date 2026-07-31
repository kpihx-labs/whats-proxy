/**
 * whats-proxy — Background daemon.
 *
 * Owns the Baileys socket + Store (session continuity, WhatsApp ≠ Telegram)
 * and serves JSON-RPC 2.0 over a local Unix socket. `whats-proxy do` is a
 * thin client that auto-spawns this daemon detached when it is not running.
 *
 * Protocol: newline-delimited JSON over the Unix socket.
 *   → {"jsonrpc":"2.0","id":1,"method":"dispatch","params":{"action":"...","args":{...}}}
 *   ← {"jsonrpc":"2.0","id":1,"result":{"meta":{...},"data":{...}}}
 *
 * Methods: ping | connection-info | dispatch | reconnect | shutdown.
 */

import {
  default as makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  ALL_WA_PATCH_NAMES,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode";
import { createServer, type Socket } from "node:net";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, type AppConfig, statePaths, ensureDirs } from "./config.ts";
import { Store } from "./store.ts";
import { Logger, rotateLogFile } from "./logger.ts";
import { okResult, errResult } from "./helpers.ts";
import { WhatsProxyError } from "./exceptions.ts";
import { REGISTRY } from "./actions/registry.ts";
import type { ActionContext } from "./actions/types.ts";
import type { ConnectionInfo, Output } from "./types.ts";

// ── State ────────────────────────────────────────────────────────────────────

let sock: WASocket | null = null;
let store: Store | null = null;
let config: AppConfig | null = null;
let log: Logger;
let connectionState: "disconnected" | "connecting" | "open" | "closing" = "disconnected";
let reconnectAttempts = 0;
let reconnecting = false;
let persistStoreTimer: ReturnType<typeof setTimeout> | null = null;

// ── Connection info (mirrors whats-mcp getConnectionInfo) ───────────────────

export function getConnectionInfo(): ConnectionInfo {
  return {
    state: connectionState,
    user: sock?.user
      ? {
          id: sock.user.id,
          name: sock.user.name || sock.user.verifiedName || undefined,
          phone: sock.user.id?.split(":")[0] || undefined,
        }
      : null,
    store_stats: store?.stats() || null,
    reconnect_attempts: reconnectAttempts,
  };
}

/** Build the runtime context handed to action handlers. */
function buildContext(): ActionContext {
  if (!sock || !store || !config) {
    throw new WhatsProxyError("Daemon is not initialized yet.", "WA_NOT_INITIALIZED");
  }
  return {
    sock,
    store,
    config,
    connectionInfo: getConnectionInfo,
    registry: REGISTRY,
  };
}

// ── Baileys connection (port of whats-mcp connection.js) ────────────────────

function cleanupSocket() {
  if (sock) {
    try {
      (sock.ev as unknown as { removeAllListeners: () => void }).removeAllListeners();
      sock.end(undefined);
    } catch {
      /* socket may already be dead */
    }
    sock = null;
  }
}

async function createSocket(authPath: string, cfg: AppConfig) {
  if (reconnecting) return;
  reconnecting = true;

  try {
    connectionState = "connecting";

    // Clean up old socket FIRST to avoid 440 (connectionReplaced)
    cleanupSocket();

    // Fetch latest WA Web version to avoid 405 errors
    const { version } = await fetchLatestBaileysVersion();
    log.info(`Using WA Web version: ${version.join(".")}`);

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const silent = pino({ level: "silent" });

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silent),
      },
      browser: Browsers.ubuntu("Chrome"),
      logger: silent,
      markOnlineOnConnect: cfg.connection?.mark_online_on_connect ?? false,
      generateHighQualityLinkPreview: true,
      syncFullHistory: cfg.connection?.sync_full_history ?? true,
    });

    store!.bind(sock);
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.info("Scan this QR code with WhatsApp (Linked Devices):");
        qrcode.toString(qr, { type: "terminal", small: true }, (err, code) => {
          // QR goes to the log file / stderr — never to stdout (JSON-only)
          log.info(`${err ? "QR render error: " + err.message : "\n" + code}`);
        });
      }

      if (connection === "open") {
        connectionState = "open";
        reconnectAttempts = 0;
        log.info(`Connected as ${sock?.user?.name || "?"} (${sock?.user?.id || "?"})`);

        try {
          if (cfg.connection?.refresh_app_state ?? true) {
            await sock!.resyncAppState(ALL_WA_PATCH_NAMES, true);
            const lastAccountSyncTimestamp = sock!.authState?.creds?.lastAccountSyncTimestamp;
            if (lastAccountSyncTimestamp) {
              await sock!.cleanDirtyBits("account_sync", lastAccountSyncTimestamp);
            }
            log.info("App state refreshed on open.");
          }

          const groups = await sock!.groupFetchAllParticipating();
          for (const meta of Object.values(groups || {})) {
            if (meta?.id) store!.setGroupMeta(meta.id, meta);
          }
          log.info(`Preloaded ${Object.keys(groups || {}).length} groups into store.`);
        } catch (err) {
          log.warn(`Failed to preload groups after connect: ${(err as Error).message}`);
        }
      }

      if (connection === "close") {
        connectionState = "disconnected";
        const disconnectErr = lastDisconnect?.error;
        const statusCode = (disconnectErr as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const maxAttempts = cfg.connection?.max_reconnect_attempts ?? 10;

        // 440 = connectionReplaced — another session took over, don't fight it
        // 401 = loggedOut — need re-pairing
        const noReconnectCodes = new Set<DisconnectReason>([
          DisconnectReason.loggedOut,
          DisconnectReason.connectionReplaced,
        ]);
        const shouldReconnect = !noReconnectCodes.has(statusCode as DisconnectReason);

        log.warn(
          `Disconnected (code=${statusCode}). ` +
            (shouldReconnect
              ? "Will reconnect..."
              : statusCode === DisconnectReason.loggedOut
                ? "Logged out — run 'whats-proxy admin setup' to re-pair."
                : "Connection replaced by another session."),
        );

        if (shouldReconnect && reconnectAttempts < maxAttempts) {
          reconnectAttempts++;
          const delay = Math.min(
            (cfg.connection?.reconnect_interval_ms || 3000) * Math.pow(1.5, reconnectAttempts - 1),
            30000,
          );
          log.info(`Reconnect attempt ${reconnectAttempts}/${maxAttempts} in ${Math.round(delay)}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          await createSocket(authPath, cfg);
        } else if (shouldReconnect) {
          log.warn("Max reconnect attempts reached. Run 'whats-proxy admin status' to inspect.");
        }
      }
    });
  } finally {
    reconnecting = false;
  }
}

// ── Store persistence ────────────────────────────────────────────────────────

function schedulePersist() {
  if (!store || !config || config.store?.persist === false) return;
  if (persistStoreTimer) clearTimeout(persistStoreTimer);
  persistStoreTimer = setTimeout(() => {
    try {
      store!.saveSnapshot(statePaths(config!).storeFile);
    } catch (err) {
      log.warn(`Failed to persist store snapshot: ${(err as Error).message}`);
    }
  }, 500);
}

// ── JSON-RPC dispatch ────────────────────────────────────────────────────────

interface RpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

function rpcError(id: number, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRequest(req: RpcRequest): Promise<unknown> {
  const { id, method, params = {} } = req;

  switch (method) {
    case "ping":
      return { jsonrpc: "2.0", id, result: { pong: true, pid: process.pid, version: config?.server?.version } };

    case "connection-info":
      return { jsonrpc: "2.0", id, result: getConnectionInfo() };

    case "shutdown":
      log.info("Shutdown requested via RPC.");
      schedulePersist();
      setTimeout(() => process.exit(0), 100);
      return { jsonrpc: "2.0", id, result: { shutting_down: true } };

    case "dispatch": {
      const action = String(params.action || "");
      const args = (params.args as Record<string, unknown>) || {};
      const def = REGISTRY[action];
      if (!def) {
        return rpcError(id, -32601, `Unknown action: ${action}. Run 'whats-proxy do --help' for the catalog.`);
      }
      try {
        const output = await def.handler(args, buildContext());
        schedulePersist();
        return { jsonrpc: "2.0", id, result: output };
      } catch (err) {
        if (err instanceof WhatsProxyError) {
          return rpcError(id, -32000, err.message);
        }
        return rpcError(id, -32000, (err as Error).message || String(err));
      }
    }

    default:
      return rpcError(id, -32601, `Unknown method: ${method}`);
  }
}

// ── Unix socket server ───────────────────────────────────────────────────────

async function serveSocket(cfg: AppConfig, paths: ReturnType<typeof statePaths>) {
  // Remove stale socket file (left over from a crashed daemon)
  if (existsSync(paths.sockFile)) unlinkSync(paths.sockFile);

  const server = createServer((client: Socket) => {
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete tail
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req: RpcRequest;
        try {
          req = JSON.parse(trimmed) as RpcRequest;
        } catch {
          client.write(JSON.stringify(rpcError(0, -32700, "Parse error")) + "\n");
          continue;
        }
        handleRequest(req).then((resp) => {
          client.write(JSON.stringify(resp) + "\n");
        });
      }
    });
    client.on("error", () => { /* client went away */ });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(paths.sockFile, () => resolve());
  });

  return server;
}

// ── Daemon lifecycle ─────────────────────────────────────────────────────────

export async function startDaemon(): Promise<void> {
  config = loadConfig();
  const paths = ensureDirs(config);
  rotateLogFile(paths.logFile);
  log = new Logger((config.logging?.level as never) || "info", paths.logFile);

  // PID lifecycle
  writeFileSync(paths.pidFile, String(process.pid));
  const clearPid = () => {
    try {
      const current = readFileSync(paths.pidFile, "utf-8").trim();
      if (current === String(process.pid)) unlinkSync(paths.pidFile);
    } catch {
      /* ignore */
    }
  };
  const shutdown = () => {
    log.info("Daemon stopping; persisting store snapshot...");
    schedulePersist();
    try {
      if (sock) {
        (sock.ev as unknown as { removeAllListeners: () => void }).removeAllListeners();
        sock.end(undefined);
      }
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 250);
  };
  process.on("exit", clearPid);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  log.info(`whats-proxy daemon ${config.server?.version} starting (pid ${process.pid})`);
  log.info(`State directory: ${paths.dir}`);

  // Store: restore snapshot, seed watchlists from config
  store = new Store({
    ...(config.store || {}),
    onChange: () => schedulePersist(),
  });
  if (config.store?.persist !== false) {
    try {
      if (store.loadSnapshot(paths.storeFile)) {
        log.info(`Restored store snapshot from ${paths.storeFile}`);
      }
    } catch (err) {
      log.warn(`Failed to restore store snapshot: ${(err as Error).message}`);
    }
  }
  if (config.watchlists && Object.keys(config.watchlists).length > 0) {
    const imported = store.importWatchlistsFromConfig(config.watchlists);
    if (imported > 0) log.info(`Seeded ${imported} watchlist(s) from config into store`);
  }

  // Connect WhatsApp FIRST (QR or existing auth) so that by the time the
  // socket server is up, `sock` is assigned and dispatch never races init.
  mkdirSync(paths.auth, { recursive: true });
  await createSocket(paths.auth, config);

  // Socket server after init: ping only answers once the daemon is truly ready.
  await serveSocket(config, paths);
  log.info(`Unix socket ready: ${paths.sockFile}`);

  log.info("Daemon ready. Use 'whats-proxy do <action>' or 'whats-proxy admin status'.");
}

// ── Default (exported for reuse by the CLI) ─────────────────────────────────

export function daemonStatePaths(cfg: AppConfig): ReturnType<typeof statePaths> {
  return statePaths(cfg);
}
