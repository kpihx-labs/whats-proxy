/**
 * whats-proxy — RPC client (WaClient equivalent).
 *
 * Thin JSON-RPC 2.0 client over the daemon's Unix socket. Auto-spawns a
 * detached daemon when none is running (transparent: logged to the state
 * dir, pidfile written, `admin status` reflects it). Every method returns
 * the full Output envelope (`meta` + `data`) — the tick-proxy standard.
 */

import { connect as netConnect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadConfig, statePaths, type AppConfig } from "./config.ts";
import { WhatsProxyError } from "./exceptions.ts";
import type { ConnectionInfo, Output } from "./types.ts";

export interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Execute one JSON-RPC request over the Unix socket and return the response. */
export async function rpcCall(
  sockFile: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<RpcResponse> {
  if (!existsSync(sockFile)) {
    throw new WhatsProxyError(
      `Daemon socket not found at ${sockFile}. Start the daemon or run 'whats-proxy admin status'.`,
      "DAEMON_NOT_RUNNING",
    );
  }
  return new Promise((resolve, reject) => {
    const client: Socket = netConnect(sockFile);
    const timer = setTimeout(() => {
      client.destroy();
      reject(new WhatsProxyError(`RPC call timed out after ${timeoutMs}ms.`, "RPC_TIMEOUT"));
    }, timeoutMs);

    client.on("connect", () => {
      client.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
    });
    client.on("data", (chunk) => {
      clearTimeout(timer);
      client.destroy();
      const text = chunk.toString("utf-8").trim();
      try {
        resolve(JSON.parse(text) as RpcResponse);
      } catch {
        reject(new WhatsProxyError(`Invalid RPC response: ${text}`, "RPC_BAD_RESPONSE"));
      }
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      reject(new WhatsProxyError(`RPC connection error: ${err.message}`, "RPC_CONNECT_ERROR"));
    });
  });
}

/** Parse an RPC response into the Output envelope (or throw on error). */
export function unwrap(resp: RpcResponse): Output {
  if (resp.error) {
    throw new WhatsProxyError(resp.error.message, "RPC_ERROR");
  }
  return resp.result as Output;
}

// ── Daemon spawn / lifecycle ─────────────────────────────────────────────────

function daemonCommand(): { executable: string; args: string[] } {
  const sourceDir = dirname(new URL(import.meta.url).pathname);
  const projectRoot = resolve(sourceDir, "../..");
  return {
    executable: process.execPath,
    args: [join(projectRoot, "bin", "whats-proxy.mjs"), "daemon"],
  };
}

/**
 * Spawn a detached daemon process and wait until it answers ping
 * (up to `waitMs`, default 30s). Returns once the daemon is reachable.
 */
export async function spawnDaemon(cfg: AppConfig, waitMs = 30_000): Promise<void> {
  const paths = statePaths(cfg);
  mkdirSync(paths.dir, { recursive: true });

   // Detached: keeps running after the CLI exits; diagnostics remain on stderr.
   const command = daemonCommand();
   const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    cwd: process.cwd(),
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + waitMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await pingDaemon(paths)) return;
    if (Date.now() > deadline) {
      throw new WhatsProxyError(
         `Daemon did not become ready within ${waitMs / 1000}s. Run 'whats-proxy admin status' and inspect stderr diagnostics.`,
        "DAEMON_START_TIMEOUT",
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Ping the daemon socket (1.5s timeout). True when it answers. */
export async function pingDaemon(paths: ReturnType<typeof statePaths>): Promise<boolean> {
  if (!existsSync(paths.sockFile)) return false;
  try {
    const resp = await rpcCall(paths.sockFile, "ping", {}, 1500);
    return !!resp.result && (resp.result as { pong?: boolean }).pong === true;
  } catch {
    return false;
  }
}

/** Ensure the daemon is reachable; spawn it if needed. */
export async function ensureDaemon(cfg: AppConfig): Promise<void> {
  const paths = statePaths(cfg);
  if (await pingDaemon(paths)) return;
  await spawnDaemon(cfg);
}

// ── WaClient ─────────────────────────────────────────────────────────────────

/**
 * RPC client for `whats-proxy do`. Auto-spawns the daemon on first use.
 * The 65 actions map 1:1 to RPC `dispatch` calls (no per-method wrappers —
 * the daemon owns the Baileys socket and Store, so the client stays thin).
 */
export class WaClient {
  private cfg: AppConfig;
  private paths: ReturnType<typeof statePaths>;
  private autoSpawn: boolean;

  constructor(cfg?: AppConfig, autoSpawn = true) {
    this.cfg = cfg || loadConfig();
    this.paths = statePaths(this.cfg);
    this.autoSpawn = autoSpawn;
  }

  /** Execute one action against the daemon. Returns the Output envelope. */
  async do(action: string, args: Record<string, unknown> = {}): Promise<Output> {
    if (this.autoSpawn) await ensureDaemon(this.cfg);
    const resp = await rpcCall(this.paths.sockFile, "dispatch", { action, args });
    return unwrap(resp);
  }

  /**
   * Call the raw daemon JSON-RPC transport for internal lifecycle operations.
   *
   * This is intentionally a programmatic escape hatch, not a public `do`
   * action: public WhatsApp operations must remain registry-routed so required
   * argument validation, policies, HITL, preflight, and verification cannot be
   * bypassed.
   *
   * Args:
   *   method: Internal daemon method such as `ping`, `connection-info`, or
   *     `shutdown`; never use it to bypass a registered WhatsApp action.
   *   params: JSON-RPC parameters accepted by that internal method.
   *
   * Returns:
   *   Raw JSON-RPC response object from the Unix-socket daemon.
   *
   * Examples:
   *   await new WaClient().raw("ping")
   *   // => { jsonrpc: "2.0", id: 1, result: { pong: true } }
   *   await new WaClient().raw("connection-info")
   *   // => { jsonrpc: "2.0", id: 1, result: { state: "open", ... } }
   *   await new WaClient().raw("shutdown")
   *   // => { jsonrpc: "2.0", id: 1, result: { meta: { status: "ok", ... }, data: { stopped: true, ... } } }
   */
  async raw(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.autoSpawn) await ensureDaemon(this.cfg);
    const resp = await rpcCall(this.paths.sockFile, method, params);
    return resp;
  }

  /** Connection info from the daemon (never spawns). */
  async connectionInfo(): Promise<ConnectionInfo> {
    if (!existsSync(this.paths.sockFile)) {
      return { state: "disconnected", user: null, store_stats: null, reconnect_attempts: 0 };
    }
    try {
      const resp = await rpcCall(this.paths.sockFile, "connection-info", {}, 3000);
      return (resp.result as ConnectionInfo) || { state: "disconnected", user: null, store_stats: null, reconnect_attempts: 0 };
    } catch {
      return { state: "disconnected", user: null, store_stats: null, reconnect_attempts: 0 };
    }
  }

  /** True when the daemon answers ping right now. */
  async isRunning(): Promise<boolean> {
    return pingDaemon(this.paths);
  }

  /** Ask the daemon to shut down gracefully (store snapshot persisted). */
  async shutdown(): Promise<Output> {
    const resp = await rpcCall(this.paths.sockFile, "shutdown", {}, 3000);
    return unwrap(resp);
  }

  /** Connection info getter used by action contexts (admin status). */
  get sockFile(): string {
    return this.paths.sockFile;
  }
}

export default WaClient;
