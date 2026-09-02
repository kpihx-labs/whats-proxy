/**
 * whats-proxy — admin service restart.
 *
 * `whats-proxy admin service restart <phone>` — restart
 * whats-proxy@<phone>.service via systemctl --user.
 *
 * Sends SIGTERM to the current process and waits for systemd to
 * respawn it with the configured restart delay.
 */

import { execSync } from "node:child_process";
import { loadConfig, accountStatePaths } from "../../config.ts";
import { pingDaemon, rpcCall } from "../../client.ts";
import { okResult, errResult } from "../../helpers.ts";
import type { Output } from "../../types.ts";

interface ServiceRestartOptions {
  phone: string;
}

/**
 * Restart the systemd user service for a WhatsApp account.
 *
 * Args:
 *   opts: ServiceRestartOptions — `{ phone: string }`.
 *     - `phone`: the account phone number (digits only, with country code).
 *
 * Returns:
 *   A JSON envelope with the service restart status.
 *
 * Examples:
 *   await serviceRestart({ phone: "33612345678" })
 *   // => { meta: { status: "ok", ... }, data: { status: "restarted", phone: "33612345678", service: "whats-proxy@33612345678.service" } }
 */
export async function serviceRestart(opts: ServiceRestartOptions): Promise<Output> {
  const { phone } = opts;
  const service = `whats-proxy@${phone}.service`;
  const paths = accountStatePaths(phone, loadConfig());

  try {
    // A `do` command can own the account socket outside systemd. Stop that
    // daemon first; otherwise systemd reports a successful restart although
    // its replacement exits immediately because the O_EXCL lock is held.
    if (await pingDaemon(paths)) {
      await rpcCall(paths.sockFile, "shutdown", {}, 5_000);
      await new Promise((r) => setTimeout(r, 300));
      if (await pingDaemon(paths)) {
        return errResult(`Failed to restart ${service}: the existing daemon still owns the account socket.`, {
          phone,
          service,
        });
      }
    }

    execSync(`systemctl --user restart ${service}`, {
      encoding: "utf-8",
      timeout: 15_000,
    });

    await new Promise((r) => setTimeout(r, 500));
    execSync(`systemctl --user is-active --quiet ${service}`, {
      encoding: "utf-8",
      timeout: 5_000,
    });

    return okResult({
      status: "restarted",
      phone,
      service,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr || "";
    return errResult(`Failed to restart ${service}: ${stderr.trim() || (err as Error).message}`, {
      phone,
      service,
      hint: "Ensure the service is installed: 'whats-proxy admin setup'",
    });
  }
}
