/**
 * whats-proxy — admin daemon status (multi-account).
 *
 * `whats-proxy admin daemon status` — show daemon status for ALL accounts.
 * `whats-proxy admin daemon status <phone>` — show daemon status for a specific account.
 *
 * Independent probe of daemon + WhatsApp auth + connection state per account.
 * Always works, even when the daemon is down. ALWAYS JSON.
 */

import { existsSync, readFileSync } from "node:fs";

import {
  loadConfig,
  accountStatePaths,
  readAccounts,
  getDefaultAccount,
} from "../../config.ts";
import { okResult, errResult } from "../../helpers.ts";
import { pingDaemon, rpcCall } from "../../client.ts";
import type { ConnectionInfo, Output } from "../../types.ts";

interface DaemonStatusOptions {
  phone?: string;
}

async function probeDaemon(
  phone: string,
  cfg: ReturnType<typeof loadConfig>,
  isDefault: boolean,
): Promise<Record<string, unknown>> {
  const paths = accountStatePaths(phone, cfg);

  // PID check
  let pid: number | null = null;
  let running = false;
  try {
    if (existsSync(paths.pidFile)) {
      pid = parseInt(readFileSync(paths.pidFile, "utf-8").trim(), 10);
      try {
        process.kill(pid, 0);
        running = true;
      } catch {
        running = false;
      }
    }
  } catch {
    pid = null;
  }

  // Socket presence
  const sockExists = existsSync(paths.sockFile);

  // Live connection info (if daemon answers; never spawns)
  let connection: ConnectionInfo = { state: "disconnected", user: null, store_stats: null, reconnect_attempts: 0 };
  if (running || sockExists) {
    try {
      const resp = await rpcCall(paths.sockFile, "connection-info", {}, 3000);
      connection = (resp.result as ConnectionInfo) || connection;
    } catch {
      // daemon unreachable
    }
  }

  // Auth presence
  const { existsSync: ex } = await import("node:fs");
  const { join } = await import("node:path");
  const authPresent = ex(join(paths.auth, "creds.json"));

  return {
    phone,
    default: isDefault,
    daemon: {
      running,
      pid,
      socket: paths.sockFile,
      lock: paths.lockFile,
    },
    auth: {
      present: authPresent,
    },
    connection,
  };
}

/**
 * Show daemon and connection state for one or all accounts.
 *
 * Args:
 *   opts: DaemonStatusOptions — `{ phone?: string }`.
 *     - `phone`: if provided, show status for that account only.
 *     - if omitted, show status for ALL registered accounts.
 *
 * Returns:
 *   A JSON envelope containing per-account daemon, auth, and connection state.
 *
 * Examples:
 *   await daemonStatus({})
 *   // => { meta: { status: "ok", ... }, data: { accounts: [...], default: "33612345678", total: 2 } }
 *   await daemonStatus({ phone: "33612345678" })
 *   // => { meta: { status: "ok", ... }, data: { phone: "33612345678", daemon: { running: true, pid: 1234, ... }, ... } }
 */
/** Backward-compatible alias for CLI re-export. */
export { daemonStatus as adminDaemonStatus };

export async function daemonStatus(opts: DaemonStatusOptions): Promise<Output> {
  const cfg = loadConfig();
  const accounts = readAccounts(cfg);
  const defaultPhone = getDefaultAccount(cfg);
  const allPhones = Object.keys(accounts.accounts);

  // Specific account requested
  if (opts.phone) {
    const { canonicalPhone } = await import("../../config.ts");
    const phone = canonicalPhone(opts.phone);
    if (!accounts.accounts[phone]) {
      return errResult(
        `Account ${phone} is not registered.`,
        { hint: "Run 'whats-proxy admin auth status' to list registered accounts." },
      );
    }
    const info = await probeDaemon(phone, cfg, defaultPhone === phone);
    return okResult(info);
  }

  // All accounts
  if (allPhones.length === 0) {
    return okResult({
      accounts: [],
      default: null,
      total: 0,
      hint: "No accounts registered. Run 'whats-proxy admin auth login' to pair.",
    });
  }

  const probes = await Promise.all(
    allPhones.map((phone) => probeDaemon(phone, cfg, defaultPhone === phone)),
  );

  return okResult({
    accounts: probes,
    default: defaultPhone,
    total: probes.length,
  });
}
