/**
 * whats-proxy — admin daemon stop (multi-account).
 *
 * `whats-proxy admin daemon stop` — stop ALL running daemons.
 * `whats-proxy admin daemon stop <phone>` — stop a specific daemon.
 *
 * Sends the `shutdown` RPC to the target socket. Clean exit: the daemon
 * persists the store snapshot before exiting (see daemon.ts shutdown path).
 * Non-destructive: does NOT touch session credentials in `<phone>/state/`.
 */

import { existsSync, readFileSync } from "node:fs";

import {
  loadConfig,
  accountStatePaths,
  readAccounts,
  getDefaultAccount,
  canonicalPhone,
} from "../../config.ts";
import { okResult, errResult } from "../../helpers.ts";
import { rpcCall } from "../../client.ts";
import type { Output } from "../../types.ts";

interface DaemonStopOptions {
  phone?: string;
}

async function stopDaemon(
  phone: string,
  cfg: ReturnType<typeof loadConfig>,
): Promise<Record<string, unknown>> {
  const paths = accountStatePaths(phone, cfg);

  if (!existsSync(paths.sockFile)) {
    return { phone, stopped: false, reason: "no socket" };
  }

  const pid = (() => {
    try {
      return Number(readFileSync(paths.pidFile, "utf-8").trim()) || null;
    } catch {
      return null;
    }
  })();

  try {
    const resp = await rpcCall(paths.sockFile, "shutdown", {}, 5000);
    if (resp.error) {
      return { phone, stopped: false, pid, error: resp.error.message };
    }
    return { phone, stopped: true, pid, ...(resp.result as object) };
  } catch (err) {
    return { phone, stopped: false, pid, error: (err as Error).message };
  }
}

/**
 * Stop the running daemon(s) via their Unix socket(s).
 *
 * Args:
 *   opts: DaemonStopOptions — `{ phone?: string }`.
 *     - `phone`: stop the daemon for this specific account.
 *     - if omitted, stop ALL running daemons.
 *
 * Returns:
 *   A JSON envelope reporting which daemons were stopped.
 *
 * Examples:
 *   await daemonStop({})
 *   // => { meta: { status: "ok", ... }, data: { results: [{ phone: "336...", stopped: true, ... }], total: 2, stopped_count: 1 } }
 *   await daemonStop({ phone: "33612345678" })
 *   // => { meta: { status: "ok", ... }, data: { phone: "33612345678", stopped: true, pid: 1234 } }
 */
/** Backward-compatible alias for CLI re-export. */
export { daemonStop as adminDaemonStop };

export async function daemonStop(opts: DaemonStopOptions): Promise<Output> {
  const cfg = loadConfig();
  const accounts = readAccounts(cfg);
  const allPhones = Object.keys(accounts.accounts);

  // Specific account
  if (opts.phone) {
    const phone = canonicalPhone(opts.phone);
    if (!accounts.accounts[phone]) {
      return errResult(
        `Account ${phone} is not registered.`,
        { hint: "Run 'whats-proxy admin auth status' to list registered accounts." },
      );
    }
    const result = await stopDaemon(phone, cfg);
    return okResult(result);
  }

  // All accounts
  if (allPhones.length === 0) {
    return okResult({ results: [], total: 0, stopped_count: 0 });
  }

  const results = await Promise.all(
    allPhones.map((phone) => stopDaemon(phone, cfg)),
  );

  return okResult({
    results,
    total: results.length,
    stopped_count: results.filter((r) => r.stopped).length,
  });
}
