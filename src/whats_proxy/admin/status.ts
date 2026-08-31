/**
 * whats-proxy — admin status.
 *
 * Independent probe of daemon + WhatsApp auth + connection state.
 * Always works, even when the daemon is down. ALWAYS JSON.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, statePaths } from "../config.ts";
import { okResult } from "../helpers.ts";
import WaClient from "../client.ts";
import type { Output } from "../types.ts";

/**
 * Inspect pairing artifacts, daemon reachability, and live connection state without starting it.
 *
 * Args:
 *   None.
 *
 * Returns:
 *   A JSON envelope containing daemon, auth, connection, state-directory, and version facts.
 *
 * Examples:
 *   await adminStatus()
 *   // => { meta: { status: "ok", ... }, data: { daemon: { running: false, ... }, auth: { present: false, ... }, ... } }
 *   await adminStatus()
 *   // => { meta: { status: "ok", ... }, data: { daemon: { running: true, pid: 1234, ... }, ... } }
 *   await adminStatus()
 *   // => { meta: { status: "ok", ... }, data: { auth: { present: true, auth_directory: "..." }, ... } }
 */
export async function adminStatus(): Promise<Output> {
  const cfg = loadConfig();
  const paths = statePaths(cfg);
  const client = new WaClient(undefined, cfg, false); // never spawn for status

  // Auth presence: Baileys creds exist in state/
  const credsFile = join(paths.auth, "creds.json");
  const authPresent = existsSync(credsFile);

  // PID check
  let pid: number | null = null;
  let running = false;
  try {
    if (existsSync(paths.pidFile)) {
      pid = parseInt(readFileSync(paths.pidFile, "utf-8").trim(), 10);
      try {
        process.kill(pid, 0);
        running = true;
      } catch {
        running = false;
      }
    }
  } catch {
    pid = null;
  }

  // Live connection info (if daemon answers; never spawns)
  const connection = await client.connectionInfo();
  const daemonReachable = connection.state !== "disconnected" || (await client.isRunning());

  return okResult({
    daemon: {
      running: daemonReachable,
      pid,
      socket: paths.sockFile,
    },
    auth: {
      present: authPresent,
      auth_directory: paths.auth,
      hint: authPresent
        ? undefined
        : "Run 'whats-proxy admin setup' to pair this device.",
    },
    connection,
    state_directory: paths.dir,
    version: cfg.server?.version,
  });
}
