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

  try {
    execSync(`systemctl --user restart ${service}`, {
      encoding: "utf-8",
      timeout: 15_000,
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
