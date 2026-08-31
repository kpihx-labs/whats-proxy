/**
 * whats-proxy — admin doctor.
 *
 * `whats-proxy admin doctor` — health-check + fix permissions and directories.
 *
 * Checks the split storage layout:
 *   - ~/.config/whats-proxy/          (config, 0o700)
 *   - ~/.config/whats-proxy/accounts.json  (accounts registry, 0o600)
 *   - ~/.local/share/whats-proxy/     (heavy data, 0o700)
 *   - Per-account dirs and auth files
 *   - Service file
 *
 * Creates missing directories/files with correct permissions.
 * Warns on missing auth creds (actionable: "run admin auth login").
 */

import { mkdirSync, existsSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { configDir, shareDir, readAccounts } from "../config.ts";
import { okResult } from "../helpers.ts";
import type { Output } from "../types.ts";

interface CheckResult {
  path: string;
  status: "ok" | "created" | "warn" | "error";
  mode?: string;
  detail?: string;
}

/** Format an octal permission mode to a 4-digit string like "0700". */
function formatMode(mode: number): string {
  return "0" + (mode & 0o777).toString(8);
}

/**
 * Ensure a directory exists with the correct mode.
 *
 * Creates it (recursively) + chmods if missing or wrong permissions.
 * Returns the check result for the report.
 */
function ensureDir(expectedMode: number, label: string, ...segments: string[]): CheckResult {
  const path = join(...segments);
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { recursive: true, mode: expectedMode });
      return { path: label, status: "created", mode: formatMode(expectedMode) };
    } catch (err) {
      return { path: label, status: "error", detail: (err as Error).message };
    }
  }

  // Directory exists — verify permissions
  try {
    const stat = statSync(path);
    const actual = formatMode(stat.mode);
    if (actual !== formatMode(expectedMode)) {
      try {
        chmodSync(path, expectedMode);
        return { path: label, status: "created", mode: formatMode(expectedMode), detail: `fixed permissions ${actual} → ${formatMode(expectedMode)}` };
      } catch {
        return { path: label, status: "warn", mode: actual, detail: `wrong permissions (${actual}, should be ${formatMode(expectedMode)})` };
      }
    }
  } catch {
    // non-fatal
  }

  return { path: label, status: "ok", mode: formatMode(expectedMode) };
}

/**
 * Health-check the whats-proxy installation: verify directories, permissions,
 * accounts, auth credentials, and service file. Auto-fixes missing dirs.
 *
 * Returns:
 *   A JSON envelope with the full health report.
 *
 * Examples:
 *   await adminDoctor()
 *   // => { meta: { status: "ok", ... }, data: { checks: [...], fixed: 2, warnings: [...], service: {...} } }
 */
export async function adminDoctor(): Promise<Output> {
  const checks: CheckResult[] = [];
  const warnings: string[] = [];
  let fixed = 0;

  // 1. Config directory: ~/.config/whats-proxy/ (0o700)
  const cfgCheck = ensureDir(0o700, "~/.config/whats-proxy", configDir());
  checks.push(cfgCheck);
  if (cfgCheck.status === "created") fixed++;

  // 2. Accounts file: ~/.config/whats-proxy/accounts.json (0o600)
  const accountsPath = join(configDir(), "accounts.json");
  if (!existsSync(accountsPath)) {
    try {
      writeFileSync(accountsPath, JSON.stringify({ default: null, accounts: {} }, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
      checks.push({ path: "~/.config/whats-proxy/accounts.json", status: "created", mode: "0600" });
      fixed++;
    } catch (err) {
      checks.push({ path: "~/.config/whats-proxy/accounts.json", status: "error", detail: (err as Error).message });
    }
  } else {
    try {
      const stat = statSync(accountsPath);
      const actual = formatMode(stat.mode);
      if (actual !== "0600") {
        try {
          chmodSync(accountsPath, 0o600);
          checks.push({ path: "~/.config/whats-proxy/accounts.json", status: "created", mode: "0600", detail: `fixed permissions ${actual} → 0600` });
          fixed++;
        } catch {
          checks.push({ path: "~/.config/whats-proxy/accounts.json", status: "warn", mode: actual, detail: `wrong permissions (${actual}, should be 0600)` });
        }
      } else {
        checks.push({ path: "~/.config/whats-proxy/accounts.json", status: "ok", mode: "0600" });
      }
    } catch {
      checks.push({ path: "~/.config/whats-proxy/accounts.json", status: "ok", mode: "0600" });
    }
  }

  // 3. Share directory: ~/.local/share/whats-proxy/ (0o700)
  const shareCheck = ensureDir(0o700, "~/.local/share/whats-proxy", shareDir());
  checks.push(shareCheck);
  if (shareCheck.status === "created") fixed++;

  // 4. Per-account checks
  const accounts = readAccounts();
  for (const phone of Object.keys(accounts.accounts)) {
    const phoneDir = join(shareDir(), phone);

    // 4a. <phone>/ directory (0o700)
    const phoneCheck = ensureDir(0o700, `~/.local/share/whats-proxy/${phone}`, phoneDir);
    checks.push(phoneCheck);
    if (phoneCheck.status === "created") fixed++;

    // 4b. <phone>/state/ directory (0o700)
    const stateCheck = ensureDir(0o700, `~/.local/share/whats-proxy/${phone}/state`, phoneDir, "state");
    checks.push(stateCheck);
    if (stateCheck.status === "created") fixed++;

    // 4c. <phone>/state/creds.json (warn if missing)
    const credsPath = join(phoneDir, "state", "creds.json");
    if (!existsSync(credsPath)) {
      warnings.push(`Auth creds.json missing for ${phone} — run: whats-proxy admin auth login`);
      checks.push({ path: `~/.local/share/whats-proxy/${phone}/state/creds.json`, status: "warn" });
    } else {
      checks.push({ path: `~/.local/share/whats-proxy/${phone}/state/creds.json`, status: "ok" });
    }

    // 4d. <phone>/store.db (warn if missing — will be created on first dispatch)
    const storePath = join(phoneDir, "store.db");
    if (!existsSync(storePath)) {
      checks.push({ path: `~/.local/share/whats-proxy/${phone}/store.db`, status: "warn", detail: "will be created on first dispatch" });
    } else {
      checks.push({ path: `~/.local/share/whats-proxy/${phone}/store.db`, status: "ok" });
    }
  }

  // 5. Service file
  const { homedir } = await import("node:os");
  const serviceTarget = join(homedir(), ".config", "systemd", "user", "whats-proxy@.service");
  const serviceInstalled = existsSync(serviceTarget);
  if (!serviceInstalled) {
    warnings.push("Service file not installed. Run: whats-proxy admin setup");
  }

  return okResult({
    checks,
    fixed,
    warnings,
    service: {
      installed: serviceInstalled,
      path: "~/.config/systemd/user/whats-proxy@.service",
    },
  });
}
