/**
 * whats-proxy — admin auth logout (multi-account).
 *
 * `whats-proxy admin auth logout <phone>` — wipe account auth + all files,
 * unregister the account, and update the default if needed.
 *
 * Deletes the entire `<phone>/` directory (state, store, daemon artifacts).
 * Non-destructive to other accounts.
 */

import {
  loadConfig,
  canonicalPhone,
  readAccounts,
  unregisterAccount,
  deleteAccountFiles,
  setDefaultAccount,
  getDefaultAccount,
} from "../../config.ts";
import { okResult, errResult } from "../../helpers.ts";
import type { Output } from "../../types.ts";

interface LogoutOptions {
  phone: string;
}

/**
 * Wipe an account's auth, store, and daemon files, then unregister it.
 *
 * If the deleted account was the default, a new default is chosen
 * from the remaining accounts (or set to null if none remain).
 *
 * Args:
 *   opts: LogoutOptions — `{ phone: string }`.
 *     The phone number of the account to remove (digits with country code).
 *
 * Returns:
 *   A JSON envelope confirming deletion and showing the new default.
 *
 * Examples:
 *   await authLogout({ phone: "33612345678" })
 *   // => { meta: { status: "ok", ... }, data: { deleted: "33612345678", new_default: "4917612345678", files_deleted: true } }
 *   await authLogout({ phone: "00000000000" })
 *   // => { meta: { status: "error", ... }, data: { error: "Account 00000000000 is not registered." } }
 */
export async function authLogout(opts: LogoutOptions): Promise<Output> {
  const cfg = loadConfig();
  const phone = canonicalPhone(opts.phone);

  const accounts = readAccounts(cfg);
  if (!accounts.accounts[phone]) {
    return errResult(
      `Account ${phone} is not registered.`,
      { hint: "Run 'whats-proxy admin auth status' to list registered accounts." },
    );
  }

  const wasDefault = getDefaultAccount(cfg) === phone;

  // Delete all files for this account
  deleteAccountFiles(phone, cfg);

  // Unregister (also updates default if this was the default)
  unregisterAccount(phone, cfg);

  // Determine new default
  const newDefault = getDefaultAccount(cfg);

  return okResult({
    deleted: phone,
    files_deleted: true,
    was_default: wasDefault,
    new_default: newDefault,
  });
}
