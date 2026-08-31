/**
 * whats-proxy — admin daemon refresh (multi-account).
 *
 * `whats-proxy admin daemon refresh` — call resync RPC on ALL daemons.
 * `whats-proxy admin daemon refresh <phone>` — call resync on a specific daemon.
 *
 * Triggers `sock.resyncAppState(ALL_WA_PATCH_NAMES, true)` + group preload
 * on the target daemon(s). Useful after schema changes or state corruption.
 */

import {
  loadConfig,
  accountStatePaths,
  readAccounts,
  canonicalPhone,
} from "../../config.ts";
import { okResult, errResult } from "../../helpers.ts";
import { rpcCall, pingDaemon } from "../../client.ts";
import type { Output } from "../../types.ts";

interface DaemonRefreshOptions {
  phone?: string;
}

async function refreshDaemon(
  phone: string,
  cfg: ReturnType<typeof loadConfig>,
): Promise<Record<string, unknown>> {
  const paths = accountStatePaths(phone, cfg);

  if (!await pingDaemon(paths)) {
    return { phone, refreshed: false, reason: "daemon not running" };
  }

  try {
    const resp = await rpcCall(paths.sockFile, "resync", {}, 30_000);
    if (resp.error) {
      return { phone, refreshed: false, error: resp.error.message };
    }
    return { phone, refreshed: true, ...(resp.result as object) };
  } catch (err) {
    return { phone, refreshed: false, error: (err as Error).message };
  }
}

/**
 * Trigger an app-state resync on the daemon for one or all accounts.
 *
 * The daemon calls `sock.resyncAppState(ALL_WA_PATCH_NAMES, true)` and
 * preloads groups after the resync completes.
 *
 * Args:
 *   opts: DaemonRefreshOptions — `{ phone?: string }`.
 *     - `phone`: refresh the daemon for this specific account.
 *     - if omitted, refresh ALL running daemons.
 *
 * Returns:
 *   A JSON envelope reporting which daemons were refreshed.
 *
 * Examples:
 *   await daemonRefresh({ phone: "33612345678" })
 *   // => { meta: { status: "ok", ... }, data: { phone: "33612345678", refreshed: true } }
 *   await daemonRefresh({})
 *   // => { meta: { status: "ok", ... }, data: { results: [...], total: 2, refreshed_count: 1 } }
 */
export async function daemonRefresh(opts: DaemonRefreshOptions): Promise<Output> {
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
    const result = await refreshDaemon(phone, cfg);
    return okResult(result);
  }

  // All accounts
  if (allPhones.length === 0) {
    return okResult({ results: [], total: 0, refreshed_count: 0 });
  }

  const results = await Promise.all(
    allPhones.map((phone) => refreshDaemon(phone, cfg)),
  );

  return okResult({
    results,
    total: results.length,
    refreshed_count: results.filter((r) => r.refreshed).length,
  });
}
