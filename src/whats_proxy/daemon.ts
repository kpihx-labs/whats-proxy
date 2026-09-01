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
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, type AppConfig, statePaths, accountStatePaths, ensureDirs } from "./config.ts";
import { Store } from "./store.ts";
import { Logger } from "./logger.ts";
import { okResult, errResult } from "./helpers.ts";
import { WhatsProxyError } from "./exceptions.ts";
import { REGISTRY } from "./actions/registry.ts";
import { validateRequiredArguments, type ActionContext } from "./actions/types.ts";
import type { ConnectionInfo, Output } from "./types.ts";

// ── State ────────────────────────────────────────────────────────────────────

let sock: WASocket | null = null;
let store: Store | null = null;
let config: AppConfig | null = null;
let phone: string | null = null;
let log: Logger;
let connectionState: "disconnected" | "connecting" | "open" | "closing" = "disconnected";
let reconnectAttempts = 0;
let reconnecting = false;
let persistStoreTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivity = Date.now();
let idleTimer: ReturnType<typeof setInterval> | null = null;

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

          // Populate LID↔PN mappings from Baileys auth state
          try {
            const authDir = phone ? accountStatePaths(phone, cfg!).auth : statePaths(cfg!).auth;
            const { readdirSync, readFileSync: readFile } = await import("node:fs");
            const lidFiles = readdirSync(authDir).filter((f: string) => f.startsWith("lid-mapping-") && f.endsWith("_reverse.json"));
            let lidCount = 0;
            for (const file of lidFiles) {
              try {
                const lidId = file.replace("lid-mapping-", "").replace("_reverse.json", "");
                const pn = JSON.parse(readFile(join(authDir, file), "utf-8"));
                const lidJid = `${lidId}@lid`;
                const pnJid = `${pn}@s.whatsapp.net`;
                store!.lidPnMap.set(lidJid, { pn: pnJid });
                lidCount++;
              } catch { /* skip corrupt file */ }
            }
            log.info(`Loaded ${lidCount} LID→PN mappings from auth state.`);
          } catch (err) {
            log.warn(`Failed to load LID mappings: ${(err as Error).message}`);
          }
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
                ? "Logged out — run 'whats-proxy admin auth login' to re-pair."
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
          log.warn("Max reconnect attempts reached. Run 'whats-proxy admin service status' to inspect.");
        }
      }
    });

    // Store message read receipts
    sock.ev.on("message-receipt.update", (updates) => {
      for (const { key, receipt } of updates) {
        try {
          if (receipt?.userJid && key?.id && store) {
            const receiptType = receipt.playedTimestamp
              ? "played"
              : receipt.readTimestamp
                ? "read"
                : "delivered";
            const ts = (receipt.readTimestamp || receipt.playedTimestamp || receipt.receiptTimestamp || Date.now()) as number;
            store.addReceipt(
              key.id,
              key.remoteJid || "",
              receipt.userJid,
              receiptType,
              ts,
            );
          }
        } catch {
          // Non-critical: receipt storage failure should not crash daemon
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
      const paths = phone ? accountStatePaths(phone, config!) : statePaths(config!);
      store!.saveSnapshot(paths.storeFile);
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
  // ping is a liveness probe (client keep-alive), NOT user activity — it must
  // not reset the idle clock, or a polling client would keep the daemon alive
  // forever. Everything else counts as activity.
  if (method !== "ping") lastActivity = Date.now();

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

    case "resync": {
      if (!sock) return { jsonrpc: "2.0", id, result: errResult("Daemon not connected.") };
      log.info("Resync requested via RPC.");
      try {
        await sock.resyncAppState(ALL_WA_PATCH_NAMES, true);
        const groups = await sock.groupFetchAllParticipating();
        let groupCount = 0;
        for (const meta of Object.values(groups || {})) {
          if (meta?.id) { store!.setGroupMeta(meta.id, meta); groupCount++; }
        }
        schedulePersist();
        return { jsonrpc: "2.0", id, result: okResult({
          status: "resynced",
          groups_preloaded: groupCount,
          stats: store!.stats(),
        }) };
      } catch (err) {
        return { jsonrpc: "2.0", id, result: errResult(`Resync failed: ${(err as Error).message}`) };
      }
    }

    case "dispatch": {
      const action = String(params.action || "");
      const args = (params.args as Record<string, unknown>) || {};
      const def = REGISTRY[action];
       if (!def) {
         return rpcError(id, -32601, `Unknown action: ${action}. Run 'whats-proxy do --help' for the catalog.`);
       }
       const validationError = validateRequiredArguments(def, args);
       if (validationError) {
         return { jsonrpc: "2.0", id, result: errResult(validationError) };
       }
      try {
        // Wait for Baileys init (socket bound before createSocket now): the
        // client may dispatch in the tiny window while `sock` is still null.
        for (let i = 0; i < 150 && !sock; i++) {
          await new Promise((r) => setTimeout(r, 200));
        }
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

/**
 * Acquire the exclusive daemon lock (O_CREAT|O_EXCL — kernel-atomic).
 *
 * Exactly one process can create the lock file; every other contender gets
 * EEXIST and loses the race. The winning PID is written before the lock file
 * is closed, so a contender never mistakes the lock-to-socket startup window
 * for a stale owner. Only an absent PID plus an unreachable socket permits
 * stale-lock recovery.
 */
async function acquireLock(lockFile: string, sockFile: string): Promise<boolean> {
  const tryLock = (): boolean => {
    try {
      const fd = openSync(lockFile, "wx");
       writeSync(fd, String(process.pid));
       closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };

  if (tryLock()) return true;

  // Lock exists — an alive owning PID wins even before its socket is bound.
  // This closes the former lock-to-socket TOCTOU window that could let a rival
  // delete a brand-new lock and start a second daemon.
  try {
    const ownerPid = Number(readFileSync(lockFile, "utf-8").trim());
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      process.kill(ownerPid, 0);
      return false;
    }
  } catch {
    // Dead or malformed owner: socket probing below handles stale recovery.
  }

  // No live PID — is a socket owner nevertheless alive?
  const { connect } = await import("node:net");
  const alive = await new Promise<boolean>((resolve) => {
    const probe = connect(sockFile);
    probe.on("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
  });
  if (alive) return false;

  // Stale lock (owner crashed): steal it and retry once.
  try {
    unlinkSync(lockFile);
    return tryLock();
  } catch {
    return false;
  }
}

async function serveSocket(cfg: AppConfig, paths: ReturnType<typeof statePaths>) {
  // Remove stale socket file (left over from a crashed daemon). Single
  // ownership is guaranteed by the exclusive lockfile (startDaemon), so a
  // live socket can never exist here.
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

  // Bind the socket. The exclusive lock guarantees we are the sole owner, so
  // EADDRINUSE here would mean a stale-lock bug — exit rather than serve
  // socket-less (that leaks an orphaned daemon).
  await new Promise<void>((resolve) => {
    server.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      log.warn(`Socket bind failed (${code}); exiting.`);
      process.exit(code === "EADDRINUSE" ? 0 : 1);
    });
    server.listen(paths.sockFile, () => resolve());
  });

  return server;
}

// ── Daemon lifecycle ─────────────────────────────────────────────────────────

export async function startDaemon(accountPhone?: string): Promise<void> {
  config = loadConfig();
  phone = accountPhone || null;
  // Per-account daemon — phone is required for multi-account layout.
  const paths = phone ? (() => {
    const p = accountStatePaths(phone, config);
    mkdirSync(p.dir, { recursive: true });
    mkdirSync(p.auth, { recursive: true });
    mkdirSync(p.autosaveDir, { recursive: true });
    return p;
  })() : ensureDirs(config);
  log = new Logger("info");

  // ── Atomic single-owner lock ─────────────────────────────────────────────
  // O_CREAT|O_EXCL is kernel-atomic: exactly one daemon wins. Unix sockets
  // CANNOT provide this (a second listen() on the same path silently binds an
  // orphaned inode — empirically proven). Losers exit; the winner owns the
  // session. A stale lock (crashed daemon) is detected via the socket probe.
  if (!(await acquireLock(paths.lockFile, paths.sockFile))) {
    log.info("Another daemon holds the lock; exiting.");
    process.exit(0);
  }

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
    log.info("Daemon stopping; persisting store...");
    // Synchronous persist — NOT schedulePersist() which uses setTimeout(500ms)
    // but process.exit(0) runs at 250ms. The old code lost messages on every restart.
    try {
      if (store && config && config.store?.persist !== false) {
        const paths = phone ? accountStatePaths(phone, config) : statePaths(config);
        store.saveSnapshot(paths.storeFile);
      }
    } catch (err) {
      log.warn(`Failed to persist store: ${(err as Error).message}`);
    }
    try {
      if (sock) {
        (sock.ev as unknown as { removeAllListeners: () => void }).removeAllListeners();
        sock.end(undefined);
      }
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 100);
  };
  process.on("exit", clearPid);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  log.info(`whats-proxy daemon ${config.server?.version} starting (pid ${process.pid})`);
  log.info(`State directory: ${paths.dir}`);

  // Store: restore snapshot
  store = new Store({
    ...(config.store || {}),
    onChange: () => schedulePersist(),
  });
  if (config.store?.persist !== false) {
    try {
      const snapshotPaths = phone ? accountStatePaths(phone, config!) : statePaths(config!);
      if (store.loadSnapshot(snapshotPaths.storeFile)) {
        log.info(`Restored store snapshot from ${snapshotPaths.storeFile}`);
      }
    } catch (err) {
      log.warn(`Failed to restore store snapshot: ${(err as Error).message}`);
    }
  }

  // Bind the socket FIRST (we hold the lock): losers probing the socket now
  // see a live owner and exit. The lock window is tiny — from lock to bind is
  // microseconds — so the stale-recovery probe is reliable. `sock` (Baileys)
  // is created afterwards; dispatch guards on `sock` assignment anyway.
  await serveSocket(config, paths);
  log.info(`Unix socket ready: ${paths.sockFile}`);

  // Connect WhatsApp (QR or existing auth). The socket is already up, so a
  // losing daemon's probe sees us as the live owner and exits promptly.
  mkdirSync(paths.auth, { recursive: true });
  await createSocket(paths.auth, config);

  // Idle-exit: if configured (max_idle_minutes > 0) and no RPC arrives for
  // that long, exit cleanly (store persisted, session kept — next `do`
  // auto-spawns). 0 = stay forever (session-holder default).
  const idleMinutes = Number(config.daemon?.max_idle_minutes || 0);
  if (idleMinutes > 0) {
    const checkMs = Math.min(idleMinutes * 60_000, 30_000); // poll ≤30s
    idleTimer = setInterval(() => {
      const idleMs = Date.now() - lastActivity;
      if (idleMs >= idleMinutes * 60_000) {
        log.info(`Idle for ${idleMinutes} min — exiting (max_idle_minutes).`);
        shutdown();
      }
    }, checkMs);
  }

  log.info("Daemon ready. Use 'whats-proxy do <action>' or 'whats-proxy admin service status'.");
}
