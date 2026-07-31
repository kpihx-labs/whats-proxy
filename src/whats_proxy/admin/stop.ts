/**
 * whats-proxy — `admin stop` implementation.
 *
 * Sends the `shutdown` RPC to the running daemon. Clean exit: the daemon
 * persists the store snapshot before exiting (see daemon.ts shutdown path).
 * Non-destructive: does NOT touch session credentials in state/auth/.
 */

import { existsSync, readFileSync } from "node:fs";
import { rpcCall } from "../client.ts";
import { loadConfig, statePaths } from "../config.ts";
import type { Output } from "../types.ts";

/**
 * Stop the running daemon via its Unix socket.
 * Always returns the standard envelope (admin = JSON only).
 */
export async function adminStop(): Promise<Output> {
  const paths = statePaths(loadConfig());

  if (!existsSync(paths.sockFile)) {
    return {
      meta: { status: "ok", comment: "daemon is not running.", edited: false },
      data: { stopped: false, reason: "no socket" },
    };
  }

  const pid = (() => {
    try {
      return Number(readFileSync(paths.pidFile, "utf-8").trim()) || null;
    } catch {
      return null;
    }
  })();

  try {
    const resp = await rpcCall(paths.sockFile, "shutdown", {}, 5000);
    if (resp.error) {
      return {
        meta: { status: "error", comment: resp.error.message, edited: false },
        data: { stopped: false, pid, error: resp.error.code },
      };
    }
    return {
      meta: { status: "ok", comment: "shutdown requested.", edited: false },
      data: { stopped: true, pid, ...(resp.result as object) },
    };
  } catch (err) {
    return {
      meta: { status: "error", comment: (err as Error).message, edited: false },
      data: { stopped: false, pid },
    };
  }
}
