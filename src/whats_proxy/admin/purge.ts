/**
 * whats-proxy — admin purge.
 *
 * `whats-proxy admin purge` — completely remove whats-proxy from the system.
 *
 * 1. Stops all running services
 * 2. Disables all services
 * 3. Removes the service symlink from ~/.config/systemd/user/
 * 4. Runs systemctl --user daemon-reload
 * 5. Removes ~/.config/whats-proxy/ (accounts.json)
 * 6. Removes ~/.local/share/whats-proxy/ (all heavy data)
 *
 * Does NOT uninstall the binary — that's `uv tool uninstall whats-proxy` or
 * `bun unlink`.
 */

import { existsSync, rmSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

import { configDir, shareDir, readAccounts, loadConfig } from "../config.ts";
import { okResult, errResult } from "../helpers.ts";
import type { Output } from "../types.ts";

/**
 * Completely remove whats-proxy: services, config, and state.
 *
 * Stops all running services, removes the service symlink, reloads
 * systemd, and deletes the config directory. The binary itself is NOT
 * removed (use `bun unlink` or `uv tool uninstall whats-proxy`).
 *
 * Returns:
 *   A JSON envelope with the purge status and removal details.
 *
 * Examples:
 *   await adminPurge()
 *   // => { meta: { status: "ok", ... }, data: { status: "purged", removed: [...], uninstall_command: "uv tool uninstall whats-proxy" } }
 */
export async function adminPurge(): Promise<Output> {
  const cfg = loadConfig();
  const accounts = readAccounts(cfg);
  const configPath = configDir();
  const sharePath = shareDir();
  const systemdUserDir = join(homedir(), ".config", "systemd", "user");
  const serviceTarget = join(systemdUserDir, "whats-proxy@.service");
  const removed: string[] = [];
  const warnings: string[] = [];

  // 1. Stop all running services
  const phones = Object.keys(accounts.accounts);
  for (const phone of phones) {
    const service = `whats-proxy@${phone}.service`;
    try {
      execSync(`systemctl --user stop ${service}`, {
        encoding: "utf-8",
        timeout: 10_000,
      });
      removed.push(`service:${service} (stopped)`);
    } catch {
      // Service may not be running — non-fatal
    }

    try {
      execSync(`systemctl --user disable ${service}`, {
        encoding: "utf-8",
        timeout: 10_000,
      });
      removed.push(`service:${service} (disabled)`);
    } catch {
      // May not be enabled — non-fatal
    }
  }

  // 2. Remove the service symlink
  if (existsSync(serviceTarget)) {
    try {
      unlinkSync(serviceTarget);
      removed.push(`symlink:${serviceTarget}`);
    } catch (err) {
      warnings.push(`Failed to remove service symlink: ${(err as Error).message}`);
    }
  }

  // 3. Reload systemd daemon
  try {
    execSync("systemctl --user daemon-reload", {
      encoding: "utf-8",
      timeout: 10_000,
    });
  } catch (err) {
    warnings.push(`daemon-reload failed: ${(err as Error).message}`);
  }

  // 4. Remove config directory (accounts.json)
  if (existsSync(configPath)) {
    try {
      rmSync(configPath, { recursive: true, force: true });
      removed.push(`config:${configPath}`);
    } catch (err) {
      warnings.push(`Failed to remove config directory: ${(err as Error).message}`);
    }
  }

  // 5. Remove share directory (heavy per-account data)
  if (existsSync(sharePath)) {
    try {
      rmSync(sharePath, { recursive: true, force: true });
      removed.push(`share:${sharePath}`);
    } catch (err) {
      warnings.push(`Failed to remove share directory: ${(err as Error).message}`);
    }
  }

  return okResult({
    status: "purged",
    removed,
    warnings,
    accounts_removed: phones.length,
    uninstall_command: "uv tool uninstall whats-proxy",
    note: "The binary was NOT removed. Run the uninstall command above if desired.",
  });
}
