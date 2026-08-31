/**
 * whats-proxy — admin service logs.
 *
 * `whats-proxy admin service logs [phone] [--lines N]` — show journal
 * logs for one or all whats-proxy systemd services.
 *
 * If a phone is provided, shows `journalctl --user -u whats-proxy@<phone>.service`.
 * If no phone, shows all whats-proxy services via wildcard.
 */

import { execSync } from "node:child_process";
import { okResult, errResult } from "../../helpers.ts";
import type { Output } from "../../types.ts";

interface ServiceLogsOptions {
  phone?: string;
  lines?: number;
}

const DEFAULT_LINES = 50;

/**
 * Show journal logs for one or all whats-proxy systemd services.
 *
 * Args:
 *   opts: ServiceLogsOptions — `{ phone?: string; lines?: number }`.
 *     - `phone`: filter logs for this specific account.
 *     - `lines`: maximum number of journal lines (default: 50).
 *
 * Returns:
 *   A JSON envelope containing the log output.
 *
 * Examples:
 *   await serviceLogs({ phone: "33612345678", lines: 100 })
 *   // => { meta: { status: "ok", ... }, data: { phone: "33612345678", lines: 85, output: "..." } }
 *   await serviceLogs({})
 *   // => { meta: { status: "ok", ... }, data: { phone: null, lines: 50, output: "..." } }
 */
export async function serviceLogs(opts: ServiceLogsOptions): Promise<Output> {
  const maxLines = opts.lines || DEFAULT_LINES;

  if (opts.phone) {
    const service = `whats-proxy@${opts.phone}.service`;
    try {
      const output = execSync(
        `journalctl --user -u ${service} -n ${maxLines} --no-pager`,
        { encoding: "utf-8", timeout: 10_000 },
      );
      return okResult({
        phone: opts.phone,
        lines: output.split("\n").length,
        output,
      });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr || "";
      return errResult(`Failed to read logs for ${service}: ${stderr.trim() || (err as Error).message}`, {
        phone: opts.phone,
      });
    }
  }

  // No phone — show all whats-proxy services
  try {
    const output = execSync(
      `journalctl --user -u "whats-proxy*" -n ${maxLines} --no-pager`,
      { encoding: "utf-8", timeout: 10_000 },
    );
    return okResult({
      phone: null,
      lines: output.split("\n").length,
      output,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr || "";
    return errResult(`Failed to read logs: ${stderr.trim() || (err as Error).message}`, {});
  }
}
