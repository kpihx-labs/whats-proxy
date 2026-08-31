/**
 * whats-proxy — admin auth status (multi-account).
 *
 * `whats-proxy admin auth status` — show auth state for ALL registered accounts.
 * `whats-proxy admin auth status <phone>` — show auth state for a specific account.
 *
 * Checks per-account auth artifacts (creds.json) and daemon reachability.
 * Always works, even when the daemon is down. ALWAYS JSON.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadConfig,
  accountStatePaths,
  readAccounts,
  getDefaultAccount,
} from "../../config.ts";
import { okResult, errResult } from "../../helpers.ts";
import { pingDaemon } from "../../client.ts";
import type { ConnectionInfo, Output } from "../../types.ts";

interface AuthStatusOptions {
  phone?: string;
}

async function probeAccount(
  phone: string,
  cfg: ReturnType<typeof loadConfig>,
  isDefault: boolean,
): Promise<Record<string, unknown>> {
  const paths = accountStatePaths(phone, cfg);

  // Auth presence: Baileys creds exist in <phone>/state/
  const credsFile = join(paths.auth, "creds.json");
  const authPresent = existsSync(credsFile);

  // PID check
  let pid: number | null = null;
  let daemonRunning = false;
  try {
    if (existsSync(paths.pidFile)) {
      pid = parseInt(readFileSync(paths.pidFile, "utf-8").trim(), 10);
      try {
        process.kill(pid, 0);
        daemonRunning = true;
      } catch {
        daemonRunning = false;
      }
    }
  } catch {
    pid = null;
  }

  // Live connection info (if daemon answers; never spawns)
  let connection: ConnectionInfo = { state: "disconnected", user: null, store_stats: null, reconnect_attempts: 0 };
  if (daemonRunning || existsSync(paths.sockFile)) {
    try {
      const { rpcCall } = await import("../../client.ts");
      const resp = await rpcCall(paths.sockFile, "connection-info", {}, 3000);
      connection = (resp.result as ConnectionInfo) || connection;
    } catch {
      // daemon unreachable
    }
  }

  return {
    phone,
    default: isDefault,
    auth: {
      present: authPresent,
      auth_directory: paths.auth,
      hint: authPresent
        ? undefined
        : `Run 'whats-proxy admin auth login --code --phone ${phone}' to pair.`,
    },
    daemon: {
      running: daemonRunning,
      pid,
      socket: paths.sockFile,
    },
    connection,
  };
}

/**
 * Show authentication and connection state for one or all accounts.
 *
 * Args:
 *   opts: AuthStatusOptions — `{ phone?: string }`.
 *     - `phone`: if provided, show status for that account only.
 *     - if omitted, show status for ALL registered accounts.
 *
 * Returns:
 *   A JSON envelope containing per-account auth, daemon, and connection state.
 *
 * Examples:
 *   await authStatus({})
 *   // => { meta: { status: "ok", ... }, data: { accounts: [...], default: "33612345678", total: 2 } }
 *   await authStatus({ phone: "33612345678" })
 *   // => { meta: { status: "ok", ... }, data: { phone: "33612345678", auth: { present: true, ... }, ... } }
 */
export async function authStatus(opts: AuthStatusOptions): Promise<Output> {
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
        { hint: "Run 'whats-proxy admin auth login --code --phone <phone>' to register." },
      );
    }
    const info = await probeAccount(phone, cfg, defaultPhone === phone);
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
    allPhones.map((phone) => probeAccount(phone, cfg, defaultPhone === phone)),
  );

  return okResult({
    accounts: probes,
    default: defaultPhone,
    total: probes.length,
  });
}
