/**
 * whats-proxy — admin status (comprehensive).
 *
 * `whats-proxy admin status` — show the FULL installation state.
 *
 * Checks: binary, config dir, accounts file, service file, per-account
 * state dirs, auth presence, service active state, and emits warnings
 * for any permission or configuration issues.
 *
 * Based on tick-proxy's `admin status` output pattern.
 */

import {
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

import {
  loadConfig,
  readAccounts,
  getDefaultAccount,
  configDir,
  shareDir,
} from "../config.ts";
import { okResult } from "../helpers.ts";
import { VERSION } from "../version.ts";
import type { Output } from "../types.ts";

/** Format an octal permission mode to a 4-digit string like "0700". */
function formatMode(mode: number): string {
  return "0" + (mode & 0o777).toString(8);
}

/** Check a directory's mode and return status + warnings. */
function checkDir(
  path: string,
  expectedMode: number,
  label: string,
  warnings: string[],
): { exists: boolean; mode: string | null; status: string } {
  if (!existsSync(path)) {
    return { exists: false, mode: null, status: "missing" };
  }
  const stat = statSync(path);
  const actual = formatMode(stat.mode);
  const expected = formatMode(expectedMode);
  if (actual !== expected) {
    warnings.push(
      `⚠️ ${label} has wrong permissions (${actual}, should be ${expected}). Run: chmod ${expected.slice(1)} ${path}`,
    );
    return { exists: true, mode: actual, status: "wrong_permissions" };
  }
  return { exists: true, mode: actual, status: "ok" };
}

/**
 * Show the comprehensive installation status of whats-proxy.
 *
 * Checks every aspect: binary, config directory, accounts file,
 * service file, per-account state directories, auth presence,
 * and systemd service state. Emits warnings for any issues found.
 *
 * Returns:
 *   A JSON envelope with the full installation state.
 *
 * Examples:
 *   await adminStatus()
 *   // => { meta: { status: "ok", ... }, data: { version: "0.6.0", binary: "...", config_dir: {...}, ... } }
 */
export async function adminStatus(): Promise<Output> {
  const cfg = loadConfig();
  const accounts = readAccounts(cfg);
  const defaultPhone = getDefaultAccount(cfg);
  const configPath = configDir();
  const sharePath = shareDir();
  const warnings: string[] = [];

  // Binary
  let binaryPath = "";
  let binaryExists = false;
  try {
    binaryPath = execSync("which whats-proxy", { encoding: "utf-8", timeout: 5000 }).trim();
    binaryExists = existsSync(binaryPath);
  } catch {
    binaryPath = "(not found)";
    binaryExists = false;
  }

  // Config directory
  const configDirInfo = checkDir(configPath, 0o700, "Config directory", warnings);

  // Share directory
  const shareDirInfo = checkDir(sharePath, 0o700, "Share directory", warnings);

  // Accounts file
  const accountsPath = join(configPath, "accounts.json");
  const accountsFileInfo = checkDir(accountsPath, 0o600, "Accounts file", warnings);
  // Also check if it's a file, not a directory
  if (accountsFileInfo.exists) {
    try {
      const s = statSync(accountsPath);
      if (!s.isFile()) {
        accountsFileInfo.status = "not_a_file";
      }
    } catch {
      // non-fatal
    }
  }

  // Service file installed
  const serviceTarget = join(
    process.env.HOME || "/home/kpihx",
    ".config", "systemd", "user", "whats-proxy@.service",
  );
  const serviceInstalled = existsSync(serviceTarget);
  if (!serviceInstalled) {
    warnings.push("⚠️ Service file not found. Run: whats-proxy admin setup");
  }

  // Per-account probes
  const accountProbes: Record<string, unknown>[] = [];
  const allPhones = Object.keys(accounts.accounts);

  for (const phone of allPhones) {
    const phoneDir = join(sharePath, phone);
    const stateDir = join(phoneDir, "state");

    // State directory permissions
    const stateDirInfo = checkDir(stateDir, 0o700, `Auth directory (${phone})`, warnings);

    // Auth files
    let authFiles: string[] = [];
    let authExists = false;
    if (stateDirInfo.exists) {
      try {
        authFiles = readdirSync(stateDir);
        authExists = authFiles.length > 0;
      } catch {
        // non-fatal
      }
    }

    // Service state
    let serviceActive = false;
    let serviceStatus = "inactive";
    let pid: number | null = null;
    let connection = "disconnected";
    const service = `whats-proxy@${phone}.service`;

    try {
      const result = execSync(`systemctl --user is-active ${service}`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      serviceActive = result === "active";
      serviceStatus = result;

      if (serviceActive) {
        try {
          const show = execSync(
            `systemctl --user show ${service} --property=MainPID`,
            { encoding: "utf-8", timeout: 5000 },
          );
          const p = parseInt(show.split("=")[1]?.trim() || "0", 10);
          if (p > 0) pid = p;
        } catch {
          // non-fatal
        }

        // Check connection state via daemon socket
        try {
          const { rpcCall } = await import("../client.ts");
          const sockPath = join(phoneDir, "daemon.sock");
          if (existsSync(sockPath)) {
            const resp = await rpcCall(sockPath, "connection-info", {}, 3000);
            const info = resp.result as { state?: string } | undefined;
            connection = info?.state || "unknown";
          }
        } catch {
          connection = "unreachable";
        }
      }
    } catch {
      serviceActive = false;
      serviceStatus = "inactive";
    }

    if (!serviceActive) {
      warnings.push(`⚠️ Service not active for ${phone}. Run: whats-proxy admin service start ${phone}`);
    }

    accountProbes.push({
      phone,
      default: phone === defaultPhone,
      state_dir: stateDirInfo,
      auth: { exists: authExists, files: authFiles.length },
      service_active: serviceActive,
      service_status: serviceStatus,
      pid,
      connection,
    });
  }

  return okResult({
    version: VERSION,
    binary: binaryPath,
    binary_exists: binaryExists,
    config_dir: {
      path: configPath,
      ...configDirInfo,
    },
    share_dir: {
      path: sharePath,
      ...shareDirInfo,
    },
    accounts_file: {
      path: accountsPath,
      ...accountsFileInfo,
    },
    service: {
      installed: serviceInstalled,
      path: serviceTarget,
      service: { installed: serviceInstalled, path: serviceTarget },
    },
    accounts: accountProbes,
    default: defaultPhone,
    total: allPhones.length,
    warnings,
  });
}
