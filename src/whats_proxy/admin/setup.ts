/**
 * whats-proxy — admin setup.
 *
 * `whats-proxy admin setup` — install the systemd user service and
 * create the config and share directories with correct permissions.
 *
 * 1. Creates ~/.config/whats-proxy/ with mode 0o700
 * 2. Creates ~/.local/share/whats-proxy/ with mode 0o700
 * 3. Writes src/services/whats-proxy@.service → ~/.config/systemd/user/
 * 4. Runs systemctl --user daemon-reload
 * 5. Shows next-step instructions
 */

import { mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { configDir, shareDir } from "../config.ts";
import { okResult, errResult } from "../helpers.ts";
import type { Output } from "../types.ts";

/**
 * Resolve the service file path from the package's own source tree.
 *
 * Layout: src/services/whats-proxy@.service (relative to this file via ../services/)
 * Works both for `bun link` (resolves to repo source) and `bun install`
 * (resolves to package copy in node_modules).
 */
function serviceSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // admin/ → src/ → services/
  return join(here, "..", "services", "whats-proxy@.service");
}

/**
 * Install the systemd user service and create the config/share directories.
 *
 * Reads the service file from src/services/whats-proxy@.service (inside the
 * package), writes it to ~/.config/systemd/user/, and reloads systemd.
 *
 * Works whether installed via `bun link` or `bun install` — the service
 * file is always part of the package (included via "src" in files[]).
 *
 * Returns:
 *   A JSON envelope with the installation status and paths.
 */
export async function adminSetup(): Promise<Output> {
  const configPath = configDir();
  const sharePath = shareDir();
  const systemdUserDir = join(homedir(), ".config", "systemd", "user");
  const serviceTarget = join(systemdUserDir, "whats-proxy@.service");
  const serviceSource = serviceSourcePath();

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

  // 3. Read service file from package and write to systemd user dir
  if (!existsSync(serviceSource)) {
    return errResult(`Service file not found: ${serviceSource}`, {
      hint: "Ensure whats-proxy is properly installed (bun link or bun install).",
    });
  }

  try {
    mkdirSync(systemdUserDir, { recursive: true });
    const content = readFileSync(serviceSource, "utf-8");
    writeFileSync(serviceTarget, content, { mode: 0o644 });
  } catch (err) {
    return errResult(`Failed to install service file: ${(err as Error).message}`, {
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
    service_source: serviceSource,
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
