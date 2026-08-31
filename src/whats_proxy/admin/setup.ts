/**
 * whats-proxy — admin setup.
 *
 * `whats-proxy admin setup` — install the systemd user service and
 * create the config and share directories with correct permissions.
 *
 * 1. Creates ~/.config/whats-proxy/ with mode 0o700
 * 2. Creates ~/.local/share/whats-proxy/ with mode 0o700
 * 3. Symlinks services/whats-proxy@.service → ~/.config/systemd/user/
 * 4. Runs systemctl --user daemon-reload
 * 5. Shows next-step instructions
 */

import { mkdirSync, chmodSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

import { configDir, shareDir } from "../config.ts";
import { okResult, errResult } from "../helpers.ts";
import type { Output } from "../types.ts";

/** Resolve the repo root (where systemd/ lives). */
function repoRoot(): string {
  // The binary runs from bun install; systemd/ is relative to the package root.
  // Walk up from this file's location: src/whats_proxy/admin/setup.ts → package root.
  const here = new URL(".", import.meta.url).pathname;
  // Go up 4 levels: admin/ → whats_proxy/ → src/ → repo root
  return join(here, "..", "..", "..", "..");
}

/**
 * Install the systemd user service and create the config directory.
 *
 * Creates the config directory with restrictive permissions (0o700),
 * symlinks the service file into ~/.config/systemd/user/, and reloads
 * the systemd user daemon.
 *
 * Returns:
 *   A JSON envelope with the installation status and paths.
 *
 * Examples:
 *   await adminSetup()
 *   // => { meta: { status: "ok", ... }, data: { status: "installed", service_path: "...", config_path: "...", permissions: { config: "0700" } } }
 */
export async function adminSetup(): Promise<Output> {
  const configPath = configDir();
  const sharePath = shareDir();
  const systemdUserDir = join(homedir(), ".config", "systemd", "user");
  const serviceSource = join(repoRoot(), "services", "whats-proxy@.service");
  const serviceTarget = join(systemdUserDir, "whats-proxy@.service");

  const warnings: string[] = [];

  // 1. Create config directory with 0o700
  try {
    mkdirSync(configPath, { recursive: true, mode: 0o700 });
    chmodSync(configPath, 0o700);
  } catch (err) {
    return errResult(`Failed to create config directory: ${(err as Error).message}`, {
      config_path: configPath,
    });
  }

  // 2. Create share directory with 0o700
  try {
    mkdirSync(sharePath, { recursive: true, mode: 0o700 });
    chmodSync(sharePath, 0o700);
  } catch (err) {
    return errResult(`Failed to create share directory: ${(err as Error).message}`, {
      share_path: sharePath,
    });
  }

  // 3. Create systemd user directory and symlink service file
  try {
    mkdirSync(systemdUserDir, { recursive: true });

    if (!existsSync(serviceSource)) {
      return errResult(`Service source not found: ${serviceSource}`, {
        hint: "Ensure whats-proxy is installed from the repo, not just 'bun link'.",
      });
    }

    // Remove existing symlink/file if present
    if (existsSync(serviceTarget)) {
      unlinkSync(serviceTarget);
    }

    symlinkSync(serviceSource, serviceTarget);
  } catch (err) {
    return errResult(`Failed to install service file: ${(err as Error).message}`, {
      service_source: serviceSource,
      service_target: serviceTarget,
    });
  }

  // 4. Reload systemd daemon
  try {
    execSync("systemctl --user daemon-reload", {
      encoding: "utf-8",
      timeout: 10_000,
    });
  } catch (err) {
    warnings.push(`daemon-reload failed: ${(err as Error).message}`);
  }

  return okResult({
    status: "installed",
    service_path: serviceTarget,
    linked_from: serviceSource,
    config_path: configPath,
    share_path: sharePath,
    permissions: { config: "0700", share: "0700" },
    next_steps: [
      "Pair a WhatsApp account: whats-proxy admin auth login",
      "Start the service: whats-proxy admin service start <phone>",
      "Check status: whats-proxy admin status",
    ],
    warnings,
  });
}
