/**
 * whats-proxy — admin setup (Baileys pairing).
 *
 * `whats-proxy admin setup` — interactive QR pairing.
 * `whats-proxy admin setup --code --phone N` — pairing code (HITL: the code
 * is entered on the phone under Linked Devices → Link with Phone Number).
 *
 * Runs a short-lived login socket (does NOT touch the daemon), saves auth
 * to the state directory, and returns the Output envelope (admin = JSON).
 * It is deliberately executed by Node.js through the package launcher: Baileys
 * depends on `ws` client upgrade events unavailable in Bun 1.3.11.
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
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
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

    // Fresh pairing: wipe stale creds that may conflict with the current
    // Baileys version (rc.9 → rc.14 migration causes 428 if old creds are
    // presented to WhatsApp's server). whats-mcp works because its creds
    // are always empty — we replicate that by starting fresh here.
    const authFiles = readdirSync(paths.auth);
    if (authFiles.length > 0) {
      logger.info(`Wiping ${authFiles.length} stale auth file(s) for fresh pairing.`);
      rmSync(paths.auth, { recursive: true, force: true });
      mkdirSync(paths.auth, { recursive: true });
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

      // Resolve once and mark done so late socket teardown events (the final
      // `close` after we deliberately sock.end()) are silently ignored.
      const finish = (output: Output) => {
        if (resolved) return;
        resolved = true;
        resolve(output);
      };

      const timeout = setTimeout(() => {
        currentSock?.end(undefined);
        finish(errResult("Setup timed out after 3 minutes. Run again for a fresh QR/code."));
      }, 180_000);

      // Create a fresh login socket. Re-usable: on 515 (restartRequired)
      // WhatsApp has ACCEPTED the scan/code and asks us to reconnect with the
      // session credentials it just handed over — the old socket is dead, so
      // we create a new one that authenticates with the saved creds and
      // reaches "open" (pair-success). This is the reconnection that was
      // missing and caused "couldn't link device" on the phone.
      const connect = async (): Promise<void> => {
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
        currentSock = sock;

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
          const { connection, lastDisconnect, qr } = update;
          if (resolved) return; // ignore late teardown events after pairing/error

          if (qr) {
            receivedQr = true;
            transientCloses = 0; // QR received = connection works, reset counter
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
                  "\n⚠️  Scan the QR below. WhatsApp will briefly disconnect to finalize — that's normal.\n\n"
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
            // Give creds a moment to flush to disk, then wrap up.
            setTimeout(() => {
              sock.end(undefined);
              finish(
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
              finish(errResult("Pairing failed or session rejected (401)."));
            } else if (statusCode === DisconnectReason.connectionReplaced) {
              clearTimeout(timeout);
              sock.end(undefined);
              finish(errResult("Connection replaced by another session (440)."));
            } else if (statusCode === DisconnectReason.restartRequired) {
              // 515 — WhatsApp accepted the pairing and now asks us to
              // reconnect with the freshly-saved session creds to finalize.
              // The old socket is dead: create a NEW one (the missing step).
              logger.info("Pairing accepted — reconnecting to finalize session...");
              sock.end(undefined);
              void connect();
            } else {
              // Other transient closes (428, network blip): count toward limit.
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
