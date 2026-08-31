/**
 * whats-proxy — admin service stop.
 *
 * `whats-proxy admin service stop <phone>` — stop and disable
 * whats-proxy@<phone>.service via systemctl --user.
 *
 * Stops the service first, then disables it to prevent auto-start on login.
 */

import { execSync } from "node:child_process";
import { okResult, errResult } from "../../helpers.ts";
import type { Output } from "../../types.ts";

interface ServiceStopOptions {
  phone: string;
}

/**
 * Stop and disable the systemd user service for a WhatsApp account.
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
 *   // => { meta: { status: "ok", ... }, data: { status: "stopped", phone: "33612345678", service: "whats-proxy@33612345678.service" } }
 */
export async function serviceStop(opts: ServiceStopOptions): Promise<Output> {
  const { phone } = opts;
  const service = `whats-proxy@${phone}.service`;

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

    return okResult({
      status: "stopped",
      phone,
      service,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr || "";
    return errResult(`Failed to stop ${service}: ${stderr.trim() || (err as Error).message}`, {
      phone,
      service,
    });
  }
}
