/**
 * whats-proxy — admin service start.
 *
 * `whats-proxy admin service start <phone>` — enable and start
 * whats-proxy@<phone>.service via systemctl --user.
 *
 * Uses `systemctl --user enable --now` to atomically enable + start.
 * The service must have been installed via `whats-proxy admin setup` first.
 */

import { execSync } from "node:child_process";
import { okResult, errResult } from "../../helpers.ts";
import type { Output } from "../../types.ts";

interface ServiceStartOptions {
  phone: string;
}

/**
 * Enable and start the systemd user service for a WhatsApp account.
 *
 * Args:
 *   opts: ServiceStartOptions — `{ phone: string }`.
 *     - `phone`: the account phone number (digits only, with country code).
 *
 * Returns:
 *   A JSON envelope with the service start status.
 *
 * Examples:
 *   await serviceStart({ phone: "33612345678" })
 *   // => { meta: { status: "ok", ... }, data: { status: "started", phone: "33612345678", service: "whats-proxy@33612345678.service" } }
 */
export async function serviceStart(opts: ServiceStartOptions): Promise<Output> {
  const { phone } = opts;
  const service = `whats-proxy@${phone}.service`;

  try {
    execSync(`systemctl --user enable --now ${service}`, {
      encoding: "utf-8",
      timeout: 15_000,
    });

    return okResult({
      status: "started",
      phone,
      service,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr || "";
    return errResult(`Failed to start ${service}: ${stderr.trim() || (err as Error).message}`, {
      phone,
      service,
      hint: "Ensure 'whats-proxy admin setup' has been run and the service file is installed.",
    });
  }
}
