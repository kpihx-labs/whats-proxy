/**
 * whats-proxy — admin auth use (multi-account).
 *
 * `whats-proxy admin auth use <phone>` — set the default account.
 *
 * Verifies the account is registered before switching.
 */

import {
  loadConfig,
  canonicalPhone,
  readAccounts,
  setDefaultAccount,
} from "../../config.ts";
import { okResult, errResult } from "../../helpers.ts";
import type { Output } from "../../types.ts";

interface UseOptions {
  phone: string;
}

/**
 * Set the default WhatsApp account.
 *
 * The default account is used when no `--phone` flag is given to
 * `do` commands, daemon operations, or status checks.
 *
 * Args:
 *   opts: UseOptions — `{ phone: string }`.
 *     The phone number to set as default (must be registered).
 *
 * Returns:
 *   A JSON envelope confirming the new default.
 *
 * Examples:
 *   await authUse({ phone: "33612345678" })
 *   // => { meta: { status: "ok", ... }, data: { previous_default: "4917612345678", new_default: "33612345678" } }
 *   await authUse({ phone: "00000000000" })
 *   // => { meta: { status: "error", ... }, data: { error: "Account 00000000000 is not registered." } }
 */
export async function authUse(opts: UseOptions): Promise<Output> {
  const cfg = loadConfig();
  const phone = canonicalPhone(opts.phone);

  const accounts = readAccounts(cfg);
  if (!accounts.accounts[phone]) {
    return errResult(
      `Account ${phone} is not registered.`,
      { hint: "Run 'whats-proxy admin auth status' to list registered accounts." },
    );
  }

  const previousDefault = accounts.default;
  setDefaultAccount(phone, cfg);

  return okResult({
    previous_default: previousDefault,
    new_default: phone,
  });
}
