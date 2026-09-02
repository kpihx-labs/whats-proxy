/**
 * whats-proxy — admin service stop.
 *
 * `whats-proxy admin service stop <phone>` — stop and disable
 * whats-proxy@<phone>.service via systemctl --user, or fall back
 * to an RPC shutdown call if systemd doesn't manage the process
 * (e.g. daemon was auto-spawned by a `do` command).
 *
 * Tries systemctl first → falls back to RPC socket shutdown.
 */

import { execSync } from "node:child_process";
import { loadConfig, accountStatePaths } from "../../config.ts";
import { rpcCall, pingDaemon } from "../../client.ts";
import { okResult, errResult } from "../../helpers.ts";
import type { Output } from "../../types.ts";

interface ServiceStopOptions {
  phone: string;
}

/**
 * Stop the daemon for a WhatsApp account.
 *
 * First tries `systemctl --user stop whats-proxy@<phone>.service`.
 * If systemd doesn't manage the process (auto-spawned daemon), falls
 * back to an RPC `shutdown` call over the Unix socket.
 *
 * Args:
 *   opts: ServiceStopOptions — `{ phone: string }`.
 *     - `phone`: the account phone number (digits only, with country code).
 *
 * Returns:
 *   A JSON envelope with the service stop status.
 *
 * Examples:
 *   await serviceStop({ phone: "33612345678" })
 *   // => { meta: { status: "ok", ... }, data: { status: "stopped", phone: "33612345678" } }
 */
export async function serviceStop(opts: ServiceStopOptions): Promise<Output> {
  const { phone } = opts;
  const service = `whats-proxy@${phone}.service`;
  const cfg = loadConfig();
  const paths = accountStatePaths(phone, cfg);

  // Attempt 1: systemctl
  let stoppedVia = "systemctl";
  try {
    execSync(`systemctl --user stop ${service}`, {
      encoding: "utf-8",
      timeout: 15_000,
    });
    try {
      execSync(`systemctl --user disable ${service}`, {
        encoding: "utf-8",
        timeout: 10_000,
      });
    } catch {
      // Disable may fail if not enabled — non-fatal
    }
  } catch {
    // systemd doesn't manage this process — try RPC fallback
    stoppedVia = "rpc";

    if (!await pingDaemon(paths)) {
      return okResult({
        status: "already_stopped",
        phone,
        message: "Daemon was not running (no systemd service, no active socket).",
      });
    }

    try {
      await rpcCall(paths.sockFile, "shutdown", {}, 5_000);
    } catch {
      return errResult(`Failed to stop daemon for ${phone}: neither systemctl nor RPC shutdown succeeded.`, {
        phone,
        service,
      });
    }
  }

  // systemd may be inactive while an auto-spawned daemon still owns the
  // account socket. Always request that socket owner to stop as well.
  await new Promise((r) => setTimeout(r, 300));
  if (await pingDaemon(paths)) {
    try {
      await rpcCall(paths.sockFile, "shutdown", {}, 5_000);
      stoppedVia = stoppedVia === "systemctl" ? "systemctl+rpc" : "rpc";
      await new Promise((r) => setTimeout(r, 300));
    } catch {
      return errResult(`Failed to stop active daemon for ${phone} through its RPC socket.`, {
        phone,
        service,
      });
    }
  }
  const stillRunning = await pingDaemon(paths);

  return okResult({
    status: stillRunning ? "stop_requested" : "stopped",
    phone,
    stopped_via: stoppedVia,
  });
}
