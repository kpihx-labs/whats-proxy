/**
 * whats-proxy — admin auth login (Baileys pairing, multi-account).
 *
 * `whats-proxy admin auth login [--start-service]` — interactive QR pairing.
 * `whats-proxy admin auth login --code --phone N` — pairing code (HITL: the code
 * is entered on the phone under Linked Devices → Link with Phone Number).
 *
 * Runs a short-lived login socket (does NOT touch the daemon), saves auth
 * to the per-account state directory (`<phone>/state/`), registers the
 * account, and sets it as default if it's the first. Returns the Output
 * envelope (admin = JSON). It is deliberately executed by Node.js through
 * the package launcher: Baileys depends on `ws` client upgrade events
 * unavailable in Bun 1.3.11.
 */

import {
  default as makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode";
import { chmodSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";

import {
  loadConfig,
  accountStatePaths,
  registerAccount,
  setDefaultAccount,
  listAccounts,
} from "../../config.ts";
import { logger } from "../../logger.ts";
import { okResult, errResult } from "../../helpers.ts";
import type { Output } from "../../types.ts";
import { serviceStart } from "../service/start.ts";

interface LoginOptions {
  code?: boolean;
  phone?: string;
  startService?: boolean;
}

/** Normalize a phone number: strip everything but digits. */
function normalizePhone(raw: string | undefined): string {
  return String(raw || "").replace(/\D/g, "");
}

/** Create or repair an account auth directory without exposing session material. */
function ensurePrivateAuthDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Prompt the user on the terminal (HITL). */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Pair a WhatsApp account via QR code or numeric pairing code.
 *
 * Auth artifacts are written to `<phone>/state/`. The account is registered
 * in `accounts.json` and set as default if it's the first.
 *
 * Args:
 *   opts: LoginOptions — `{ code?: boolean; phone?: string; startService?: boolean }`.
 *     - `code`: use numeric pairing code instead of QR.
 *     - `phone`: target phone number (digits only, with country code).
 *     - `startService`: start the persistent account daemon after pairing.
 *
 * Returns:
 *   A JSON envelope with pairing status, user info, and auth directory.
 *
 * Examples:
 *   await authLogin({})
 *   // => { meta: { status: "ok", ... }, data: { status: "paired", auth_directory: ".../1234567890/state/" } }
 *   await authLogin({ code: true, phone: "33612345678", startService: true })
 *   // => { meta: { status: "ok", ... }, data: { status: "paired", phone: "33612345678", pairing_code: "12345678" } }
 */
/** Backward-compatible alias for CLI re-export. */
export { authLogin as adminLogin };

export async function authLogin(opts: LoginOptions): Promise<Output> {
  const cfg = loadConfig();

  // Resolve phone number (required for code pairing, auto-detected for QR).
  let phone = normalizePhone(opts.phone);
  if (opts.code && !phone) {
    phone = normalizePhone(
      await prompt("Phone number (with country code, e.g. 33612345678): "),
    );
  }
  if (opts.code && !/^\d{8,15}$/.test(phone)) {
    return errResult(
      "Invalid phone number. Use country code; separators are allowed and will be stripped.",
    );
  }

  // Ensure per-account directories exist.
    const paths = phone ? accountStatePaths(phone, cfg) : null;
    if (paths) {
      ensurePrivateAuthDirectory(paths.auth);
  }

  try {
    const silent = pino({ level: "silent" });
    const { version } = await fetchLatestBaileysVersion();
    logger.info(`Using WA Web version: ${version.join(".")}`);

    // For QR pairing (no phone yet), we need a temporary auth dir.
    // The phone is discovered after successful pairing via creds.json.
    const authDir = paths?.auth || `/tmp/whats-proxy-temp-auth-${Date.now()}`;
    ensurePrivateAuthDirectory(authDir);

    // Fresh pairing: wipe stale creds that may conflict with the current
    // Baileys version (rc.9 → rc.14 migration causes 428 if old creds are
    // presented to WhatsApp's server).
    const authFiles = readdirSync(authDir);
    if (authFiles.length > 0) {
      logger.info(`Wiping ${authFiles.length} stale auth file(s) for fresh pairing.`);
      rmSync(authDir, { recursive: true, force: true });
        ensurePrivateAuthDirectory(authDir);
    }

    let codeRequested = false;
    let receivedQr = false;
    let firstQrShown = false;
    let pairingCode: string | null = null;
    let transientCloses = 0;
    const MAX_TRANSIENT_CLOSES = 3;

    return await new Promise<Output>((resolve) => {
      let currentSock: WASocket | null = null;
      let resolved = false;

      const finish = (output: Output) => {
        if (resolved) return;
        resolved = true;
        resolve(output);
      };

      const timeout = setTimeout(() => {
        currentSock?.end(undefined);
        finish(errResult("Setup timed out after 3 minutes. Run again for a fresh QR/code."));
      }, 180_000);

      const connect = async (): Promise<void> => {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const sock = makeWASocket({
          version,
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, silent),
          },
          browser: Browsers.ubuntu("Chrome"),
          logger: silent,
          markOnlineOnConnect: false,
          generateHighQualityLinkPreview: false,
          syncFullHistory: true,
        });
        currentSock = sock;

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
          const { connection, lastDisconnect, qr } = update;
          if (resolved) return;

          if (qr) {
            receivedQr = true;
            transientCloses = 0;
            if (opts.code && !codeRequested) {
              codeRequested = true;
              try {
                pairingCode = await sock.requestPairingCode(phone);
                logger.info(`Pairing Code: ${pairingCode}`);
                logger.info(
                  "Go to WhatsApp → Linked Devices → Link with Phone Number → enter this code.",
                );
              } catch (err) {
                clearTimeout(timeout);
                sock.end(undefined);
                finish(errResult(`Failed to get pairing code: ${(err as Error).message}`));
                return;
              }
            } else if (!opts.code) {
              if (!firstQrShown) {
                process.stderr.write(
                  "\n⚠️  Scan the QR below. WhatsApp will briefly disconnect to finalize — that's normal.\n\n",
                );
                firstQrShown = true;
              }
              logger.info("Scan this QR code with WhatsApp (Linked Devices):");
              qrcode.toString(qr, { type: "terminal", small: true }, (err, code) => {
                process.stderr.write((err ? err.message : code) + "\n");
              });
            }
          }

          if (connection === "open") {
            clearTimeout(timeout);
            const user = sock.user;
            logger.info(`Connected as ${user?.name || "?"} (${user?.id?.split(":")[0] || "?"})`);

            // Discover phone from creds if not provided via --phone.
            const discoveredPhone = phone || user?.id?.split(":")[0];
            if (!discoveredPhone) {
              sock.end(undefined);
              finish(errResult("Could not determine phone number from pairing result."));
              return;
            }

            // If we used a temp dir (QR without --phone), move files to the
            // proper per-account location.
            const targetPaths = accountStatePaths(discoveredPhone, cfg);
            if (authDir !== targetPaths.auth) {
              ensurePrivateAuthDirectory(targetPaths.auth);
              // Copy auth files to the target dir (move not possible during active socket).
              const { copyFileSync, readdirSync: rd } = await import("node:fs");
              for (const f of rd(authDir)) {
                copyFileSync(`${authDir}/${f}`, `${targetPaths.auth}/${f}`);
              }
            }

            // Register account + set default if first.
            registerAccount(discoveredPhone, user?.name || null, cfg);
            if (listAccounts(cfg).length === 1) {
              setDefaultAccount(discoveredPhone, cfg);
            }

            // Give creds a moment to flush to disk, then wrap up.
            setTimeout(async () => {
              sock.end(undefined);
              const serviceResult = opts.startService
                ? await serviceStart({ phone: discoveredPhone })
                : null;
              finish(
                okResult({
                  status: "paired",
                  phone: discoveredPhone,
                  pairing_code: pairingCode,
                  user: user
                    ? { id: user.id, name: user.name || user.verifiedName, phone: user.id?.split(":")[0] }
                    : null,
                  auth_directory: targetPaths.auth,
                  service_started: serviceResult?.meta.status === "ok",
                  service_start_error: serviceResult?.meta.status === "error" ? serviceResult.meta.comment : null,
                }),
              );
            }, 2000);
          }

          if (connection === "close") {
            const disconnectErr = lastDisconnect?.error;
            const statusCode = (disconnectErr as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
              clearTimeout(timeout);
              sock.end(undefined);
              finish(errResult("Pairing failed or session rejected (401)."));
            } else if (statusCode === DisconnectReason.connectionReplaced) {
              clearTimeout(timeout);
              sock.end(undefined);
              finish(errResult("Connection replaced by another session (440)."));
            } else if (statusCode === DisconnectReason.restartRequired) {
              logger.info("Pairing accepted — reconnecting to finalize session...");
              sock.end(undefined);
              void connect();
            } else {
              transientCloses++;
              logger.info(`Transient close (status ${statusCode ?? "?"}) ${transientCloses}/${MAX_TRANSIENT_CLOSES}`);
              if (transientCloses >= MAX_TRANSIENT_CLOSES) {
                clearTimeout(timeout);
                sock.end(undefined);
                finish(errResult(
                  `Connection failed ${MAX_TRANSIENT_CLOSES} times (last: status ${statusCode ?? "?"}). ` +
                  (receivedQr ? "QR was scanned but pairing was rejected — retry later." : "Check network and retry.")
                ));
              }
            }
          }
        });
      };

      void connect();
    });
  } catch (err) {
    return errResult(`Setup failed: ${(err as Error).message}`);
  }
}
