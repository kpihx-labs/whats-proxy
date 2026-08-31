/**
 * whats-proxy — admin service status.
 *
 * `whats-proxy admin service status [phone]` — show systemd service
 * status for one or all WhatsApp accounts.
 *
 * Probes `systemctl --user is-active`, PID, memory, uptime, and recent
 * journal entries per account.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadConfig,
  readAccounts,
  getDefaultAccount,
  accountStatePaths,
} from "../../config.ts";
import { okResult, errResult } from "../../helpers.ts";
import type { Output } from "../../types.ts";

interface ServiceStatusOptions {
  phone?: string;
}

/** Probe systemd service state for one account. */
async function probeService(
  phone: string,
  cfg: ReturnType<typeof loadConfig>,
  isDefault: boolean,
): Promise<Record<string, unknown>> {
  const service = `whats-proxy@${phone}.service`;
  const paths = accountStatePaths(phone, cfg);

  let active = false;
  let statusText = "inactive";
  let pid: number | null = null;
  let memory: string | null = null;
  let uptime: string | null = null;

  try {
    const result = execSync(`systemctl --user is-active ${service}`, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    active = result === "active";
    statusText = result;
  } catch {
    active = false;
    statusText = "inactive";
  }

  // Get detailed status if active
  if (active) {
    try {
      const show = execSync(
        `systemctl --user show ${service} --property=MainPID,MemoryCurrent,ActiveEnterTimestamp`,
        { encoding: "utf-8", timeout: 5_000 },
      );
      for (const line of show.split("\n")) {
        if (line.startsWith("MainPID=")) {
          const p = parseInt(line.split("=")[1] || "0", 10);
          if (p > 0) pid = p;
        } else if (line.startsWith("MemoryCurrent=")) {
          const bytes = line.split("=")[1];
          if (bytes && bytes !== "[not set]") {
            const mb = Math.round(Number(bytes) / 1024 / 1024);
            memory = `${mb}MB`;
          }
        } else if (line.startsWith("ActiveEnterTimestamp=")) {
          uptime = line.split("=").slice(1).join("=").trim() || null;
        }
      }
    } catch {
      // non-fatal
    }
  }

  // Recent journal entries
  let recentLogs = "";
  try {
    recentLogs = execSync(
      `journalctl --user -u ${service} -n 5 --no-pager`,
      { encoding: "utf-8", timeout: 5_000 },
    ).trim();
  } catch {
    recentLogs = "(no journal entries)";
  }

  // Auth presence
  const authPresent = existsSync(join(paths.auth, "creds.json"));

  return {
    phone,
    default: isDefault,
    service,
    active,
    status: statusText,
    pid,
    memory,
    uptime,
    auth: { present: authPresent },
    recent_logs: recentLogs,
  };
}

/**
 * Show systemd service status for one or all WhatsApp accounts.
 *
 * Args:
 *   opts: ServiceStatusOptions — `{ phone?: string }`.
 *     - `phone`: if provided, show status for that account only.
 *     - if omitted, show status for ALL registered accounts.
 *
 * Returns:
 *   A JSON envelope containing per-account service state.
 *
 * Examples:
 *   await serviceStatus({})
 *   // => { meta: { status: "ok", ... }, data: { accounts: [...], default: "336...", total: 2 } }
 *   await serviceStatus({ phone: "33612345678" })
 *   // => { meta: { status: "ok", ... }, data: { phone: "33612345678", service: "whats-proxy@336...service", active: true, ... } }
 */
export async function serviceStatus(opts: ServiceStatusOptions): Promise<Output> {
  const cfg = loadConfig();
  const accounts = readAccounts(cfg);
  const defaultPhone = getDefaultAccount(cfg);
  const allPhones = Object.keys(accounts.accounts);

  if (opts.phone) {
    const phone = opts.phone;
    if (!accounts.accounts[phone]) {
      return errResult(
        `Account ${phone} is not registered.`,
        { hint: "Run 'whats-proxy admin auth status' to list registered accounts." },
      );
    }
    const info = await probeService(phone, cfg, defaultPhone === phone);
    return okResult(info);
  }

  if (allPhones.length === 0) {
    return okResult({
      accounts: [],
      default: null,
      total: 0,
      hint: "No accounts registered. Run 'whats-proxy admin auth login' to pair.",
    });
  }

  const probes = await Promise.all(
    allPhones.map((phone) => probeService(phone, cfg, defaultPhone === phone)),
  );

  return okResult({
    accounts: probes,
    default: defaultPhone,
    total: probes.length,
  });
}
