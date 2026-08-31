/**
 * whats-proxy — admin daemon logs (multi-account).
 *
 * `whats-proxy admin daemon logs` — read recent daemon stderr logs for ALL accounts.
 * `whats-proxy admin daemon logs <phone>` — read logs for a specific account.
 *
 * Uses `journalctl --user` when available, falls back to reading stderr log files.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  loadConfig,
  accountStatePaths,
  readAccounts,
  canonicalPhone,
} from "../../config.ts";
import { okResult, errResult } from "../../helpers.ts";
import type { Output } from "../../types.ts";

interface DaemonLogsOptions {
  phone?: string;
  lines?: number;
  since?: string;
}

const DEFAULT_LINES = 50;

/**
 * Read recent daemon stderr logs for one or all accounts.
 *
 * Attempts `journalctl --user -u whats-proxy-daemon --since` first.
 * Falls back to reading a `daemon.stderr.log` file in the account dir.
 *
 * Args:
 *   opts: DaemonLogsOptions — `{ phone?: string; lines?: number; since?: string }`.
 *     - `phone`: filter logs for this specific account.
 *     - `lines`: maximum number of lines to return (default: 50).
 *     - `since`: journalctl `--since` value (default: "10 min ago").
 *
 * Returns:
 *   A JSON envelope containing the log output per account.
 *
 * Examples:
 *   await daemonLogs({})
 *   // => { meta: { status: "ok", ... }, data: { logs: [{ phone: "336...", lines: 42, output: "..." }], total: 2 } }
 *   await daemonLogs({ phone: "33612345678", lines: 20 })
 *   // => { meta: { status: "ok", ... }, data: { phone: "33612345678", lines: 15, output: "..." } }
 */
export async function daemonLogs(opts: DaemonLogsOptions): Promise<Output> {
  const cfg = loadConfig();
  const accounts = readAccounts(cfg);
  const allPhones = Object.keys(accounts.accounts);
  const maxLines = opts.lines || DEFAULT_LINES;
  const since = opts.since || "10 min ago";

  // Specific account
  if (opts.phone) {
    const phone = canonicalPhone(opts.phone);
    if (!accounts.accounts[phone]) {
      return errResult(
        `Account ${phone} is not registered.`,
        { hint: "Run 'whats-proxy admin auth status' to list registered accounts." },
      );
    }
    const output = await readLogs(phone, cfg, maxLines, since);
    return okResult({ phone, lines: output.split("\n").length, output });
  }

  // All accounts
  if (allPhones.length === 0) {
    return okResult({ logs: [], total: 0, hint: "No accounts registered." });
  }

  const logs = await Promise.all(
    allPhones.map(async (phone) => {
      const output = await readLogs(phone, cfg, maxLines, since);
      return { phone, lines: output.split("\n").length, output };
    }),
  );

  return okResult({ logs, total: logs.length });
}

async function readLogs(
  phone: string,
  cfg: ReturnType<typeof loadConfig>,
  maxLines: number,
  since: string,
): Promise<string> {
  // Try journalctl first
  try {
    const out = execFileSync("journalctl", [
      "--user",
      "-u", "whats-proxy-daemon",
      "--since", since,
      "--no-pager",
      "-n", String(maxLines * 2), // over-fetch for filtering
    ], { encoding: "utf-8", timeout: 5000 });

    // Filter lines containing the phone number (daemon may log it)
    const lines = out.split("\n").filter((l) =>
      l.includes(phone) || l.includes("whats-proxy") || l.includes("daemon"),
    );
    return lines.slice(-maxLines).join("\n") || "(no matching log lines)";
  } catch {
    // journalctl not available or unit not found — try stderr log file
  }

  // Fallback: read daemon stderr log from account dir
  const paths = accountStatePaths(phone, cfg);
  const stderrLog = join(paths.dir, "daemon.stderr.log");
  if (existsSync(stderrLog)) {
    try {
      const content = readFileSync(stderrLog, "utf-8");
      const lines = content.split("\n");
      return lines.slice(-maxLines).join("\n");
    } catch {
      return "(failed to read log file)";
    }
  }

  return `(no logs available for account ${phone})`;
}
