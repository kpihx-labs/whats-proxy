/**
 * whats-proxy — admin setup (Baileys pairing).
 *
 * `whats-proxy admin setup` — interactive QR pairing.
 * `whats-proxy admin setup --code --phone N` — pairing code (HITL: the code
 * is entered on the phone under Linked Devices → Link with Phone Number).
 *
 * Runs a short-lived login socket (does NOT touch the daemon), saves auth
 * to the state directory, and returns the Output envelope (admin = JSON).
 */

import {
  default as makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { loadConfig, statePaths, ensureDirs } from "../config.ts";
import { logger } from "../logger.ts";
import { okResult, errResult } from "../helpers.ts";
import type { Output } from "../types.ts";

interface SetupOptions {
  code?: boolean;
  phone?: string;
}

/** Normalize a phone number: strip everything but digits (whats-mcp behavior). */
function normalizePhone(raw: string | undefined): string {
  return String(raw || "").replace(/\D/g, "");
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

export async function adminSetup(opts: SetupOptions): Promise<Output> {
  const cfg = loadConfig();
  const paths = ensureDirs(cfg);

  // If auth already exists, warn but re-pairing is still allowed (overwrites).
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

  try {
    const silent = pino({ level: "silent" });
    const { version } = await fetchLatestBaileysVersion();
    logger.info(`Using WA Web version: ${version.join(".")}`);
    mkdirSync(paths.auth, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(paths.auth);
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
    sock.ev.on("creds.update", saveCreds);

    let codeRequested = false;
    let pairingCode: string | null = null;

    return await new Promise<Output>((resolve) => {
      const timeout = setTimeout(() => {
        sock.end(undefined);
        resolve(errResult("Setup timed out after 3 minutes. Run again for a fresh QR/code."));
      }, 180_000);

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
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
              resolve(errResult(`Failed to get pairing code: ${(err as Error).message}`));
              return;
            }
          } else if (!opts.code) {
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
          // Give creds a moment to flush to disk, then wrap up.
          setTimeout(() => {
            sock.end(undefined);
            resolve(
              okResult({
                status: "paired",
                phone: opts.code ? phone : undefined,
                pairing_code: pairingCode,
                user: user
                  ? { id: user.id, name: user.name || user.verifiedName, phone: user.id?.split(":")[0] }
                  : null,
                auth_directory: paths.auth,
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
            resolve(errResult("Pairing failed or session rejected (401)."));
          } else if (statusCode === DisconnectReason.connectionReplaced) {
            clearTimeout(timeout);
            sock.end(undefined);
            resolve(errResult("Connection replaced by another session (440)."));
          }
          // Other transient closes: keep waiting (reconnect handled by Baileys).
        }
      });
    });
  } catch (err) {
    return errResult(`Setup failed: ${(err as Error).message}`);
  }
}
