/**
 * whats-proxy — admin backup.
 *
 * `whats-proxy admin backup` — atomic backup of all account stores using SQLite VACUUM.
 * `whats-proxy admin backup <phone>` — backup a specific account.
 *
 * VACUUM INTO creates a consistent, crash-safe snapshot of the database.
 * Unlike `cp`, it guarantees the backup is internally consistent even if the
 * daemon is writing simultaneously (WAL mode).
 *
 * Backups are saved to ~/.config/whats-proxy/backup/<phone>-<timestamp>.db
 */

import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { shareDir, readAccounts } from "../config.ts";
import { okResult, errResult } from "../helpers.ts";
import type { Output } from "../types.ts";

interface BackupResult {
  phone: string;
  source: string;
  backup: string;
  size_kb: number;
  integrity: string;
  rows: Record<string, number>;
}

async function createDb(phone: string) {
  const storePath = join(shareDir(), phone, "store.db");
  if (!existsSync(storePath)) return null;
  let SqliteDb: any;
  try { SqliteDb = (await import("better-sqlite3")).default; } catch { SqliteDb = (await import("bun:sqlite")).Database; }
  return new SqliteDb(storePath);
}

/**
 * Backup one account's store.db using VACUUM INTO.
 *
 * VACUUM INTO is an atomic, crash-safe operation that produces a consistent
 * copy of the database — even while the daemon is writing to it (WAL mode).
 *
 * Args:
 *   phone: The account phone number.
 *
 * Returns:
 *   A JSON envelope with the backup details or an error.
 *
 * Examples:
 *   await adminBackup({ phone: "33605957785" })
 *   // => { status: "ok", backup: ".../33605957785-20260831-195000.db", size_kb: 1770, integrity: "ok" }
 */
export async function adminBackup(opts: { phone?: string }): Promise<Output> {
  const accounts = readAccounts();
  const phones = opts.phone
    ? [opts.phone.replace(/\D/g, "")]
    : Object.keys(accounts.accounts);

  if (phones.length === 0) {
    return errResult("No accounts registered. Run: whats-proxy admin auth login");
  }

  const backupDir = join(shareDir(), "backup");
  mkdirSync(backupDir, { recursive: true });

  const results: BackupResult[] = [];
  const errors: string[] = [];

  for (const phone of phones) {
    const storePath = join(shareDir(), phone, "store.db");
    if (!existsSync(storePath)) {
      errors.push(`${phone}: store.db not found — run the daemon first to create it`);
      continue;
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = join(backupDir, `${phone}-${ts}.db`);

    try {
      let SqliteDb: any;
      try { SqliteDb = (await import("better-sqlite3")).default; } catch { SqliteDb = (await import("bun:sqlite")).Database; }

      // VACUUM INTO is atomic and crash-safe — creates a consistent snapshot
      // even while the daemon is writing via WAL.
      const db = new SqliteDb(storePath, { readonly: true });
      db.exec(`VACUUM INTO '${backupPath}'`);

      // Verify the backup
      const backupDb = new SqliteDb(backupPath, { readonly: true });
      const integrity = backupDb.pragma("integrity_check", { simple: true }) as string;
      const pageCount = backupDb.pragma("page_count", { simple: true }) as number;
      const pageSize = backupDb.pragma("page_size", { simple: true }) as number;
      const sizeKB = Math.round((pageCount * pageSize) / 1024);

      const rows: Record<string, number> = {};
      for (const tbl of ["chats", "contacts", "messages", "group_meta", "lid_mappings"]) {
        try {
          if (typeof backupDb.query === "function") {
            rows[tbl] = (backupDb.query(`SELECT COUNT(*) as c FROM ${tbl}`).get() as { c: number }).c;
          } else {
            rows[tbl] = (backupDb.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get() as { c: number }).c;
          }
        } catch { rows[tbl] = 0; }
      }

      backupDb.close();
      db.close();

      results.push({ phone, source: storePath, backup: backupPath, size_kb: sizeKB, integrity, rows });
    } catch (err) {
      errors.push(`${phone}: ${ (err as Error).message}`);
    }
  }

  if (results.length === 0 && errors.length > 0) {
    return errResult(errors.join("; "));
  }

  // Prune old backups — keep only the last 3 per account
  for (const phone of phones) {
    try {
      const files = readdirSync(backupDir)
        .filter((f) => f.startsWith(`${phone}-`) && f.endsWith(".db"))
        .sort()
        .reverse();
      for (const old of files.slice(3)) {
        try { (await import("node:fs")).unlinkSync(join(backupDir, old)); } catch { /* best effort */ }
      }
    } catch { /* non-fatal */ }
  }

  return okResult({
    backup_dir: backupDir,
    results,
    errors,
    count: results.length,
  });
}
