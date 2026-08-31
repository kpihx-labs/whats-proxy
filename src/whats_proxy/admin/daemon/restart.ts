/**
 * whats-proxy — admin daemon restart (multi-account).
 *
 * `whats-proxy admin daemon restart` — stop + re-spawn ALL daemons.
 * `whats-proxy admin daemon restart <phone>` — stop + re-spawn a specific daemon.
 *
 * Sends `shutdown` to the existing socket, waits for exit, then spawns
 * a fresh daemon via the auto-spawn mechanism.
 */

import {
  loadConfig,
  canonicalPhone,
  readAccounts,
  accountStatePaths,
} from "../../config.ts";
import { okResult, errResult } from "../../helpers.ts";
import { spawnDaemon, pingDaemon } from "../../client.ts";
import type { Output } from "../../types.ts";

interface DaemonRestartOptions {
  phone?: string;
}

async function restartDaemon(
  phone: string,
  cfg: ReturnType<typeof loadConfig>,
): Promise<Record<string, unknown>> {
  const paths = accountStatePaths(phone, cfg);

  // Stop existing daemon
  let wasRunning = false;
  try {
    const { rpcCall } = await import("../../client.ts");
    if (await pingDaemon(paths)) {
      wasRunning = true;
      await rpcCall(paths.sockFile, "shutdown", {}, 5000);
      // Wait for socket to disappear (max 5s)
      const deadline = Date.now() + 5000;
      while (await pingDaemon(paths)) {
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  } catch {
    // Best-effort stop
  }

  // Spawn fresh daemon
  // NOTE: spawnDaemon uses global statePaths (no per-account override).
  // For multi-account, we rely on the daemon's own account discovery.
  // If the daemon is account-aware, it will pick up the correct account
  // from accounts.json. If not, this restart is a best-effort signal.
  try {
    await spawnDaemon(cfg, phone, 30_000);
    return { phone, restarted: true, was_running: wasRunning };
  } catch (err) {
    return { phone, restarted: false, error: (err as Error).message, was_running: wasRunning };
  }
}

/**
 * Stop and re-spawn the daemon for one or all accounts.
 *
 * Args:
 *   opts: DaemonRestartOptions — `{ phone?: string }`.
 *     - `phone`: restart the daemon for this specific account.
 *     - if omitted, restart ALL daemons.
 *
 * Returns:
 *   A JSON envelope reporting which daemons were restarted.
 *
 * Examples:
 *   await daemonRestart({ phone: "33612345678" })
 *   // => { meta: { status: "ok", ... }, data: { phone: "33612345678", restarted: true, was_running: true } }
 *   await daemonRestart({})
 *   // => { meta: { status: "ok", ... }, data: { results: [...], total: 2, restarted_count: 1 } }
 */
export async function daemonRestart(opts: DaemonRestartOptions): Promise<Output> {
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
    const result = await restartDaemon(phone, cfg);
    return okResult(result);
  }

  // All accounts
  if (allPhones.length === 0) {
    return okResult({ results: [], total: 0, restarted_count: 0 });
  }

  const results = await Promise.all(
    allPhones.map((phone) => restartDaemon(phone, cfg)),
  );

  return okResult({
    results,
    total: results.length,
    restarted_count: results.filter((r) => r.restarted).length,
  });
}
