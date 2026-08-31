#!/usr/bin/env bun
/**
 * whats-proxy — daemon race stress test.
 *
 * Spawns N daemons SIMULTANEOUSLY against one fresh state dir and asserts
 * exactly ONE survives to own the socket (the atomic socket-probe guard).
 * Regression harness for the TOCTOU leak: run via `make stress`.
 *
 * Usage: bun run scripts/stress.ts [count]   (default 8)
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";

const COUNT = Number(process.argv[2] || 8);
const WORK = mkdtempSync(join(tmpdir(), "whats-proxy-stress-"));
process.env.WHATS_PROXY_STATE_DIR = WORK;
process.env.WHATS_PROXY_CONFIG_DIR = WORK;
const TEST_PHONE = "1234567890";
process.env.WHATS_PROXY_ACCOUNT = TEST_PHONE;

// Seed accounts.json so daemons have a phone.
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, "accounts.json"), JSON.stringify({
  default: TEST_PHONE,
  accounts: { [TEST_PHONE]: { alias: null, created: new Date().toISOString(), last_active: null } },
}, null, 2) + "\n", "utf-8");

const { pingDaemon, rpcCall } = await import("../src/whats_proxy/client.ts");
const { loadConfig, accountStatePaths } = await import("../src/whats_proxy/config.ts");
const paths = accountStatePaths(TEST_PHONE, loadConfig());
const entry = join(import.meta.dir, "../src/whats_proxy/index.ts");

/**
 * Daemons owned by THIS test run: find candidate daemon processes with pgrep,
 * then confirm ownership via each process's own env (WHATS_PROXY_STATE_DIR →
 * WORK, visible through `ps eww <pid>`). Never touches daemons outside the
 * test state dir — a user's real daemon with a live session is never killed
 * by a test.
 */
const ownDaemonPids = (): string[] => {
  let pids: string[] = [];
  try {
    pids = execSync('pgrep -f "index.ts daemon"')
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return []; // no candidates
  }
  return pids.filter((pid) => {
    try {
      return execSync(`ps eww -o args ${pid}`).toString().includes(`WHATS_PROXY_STATE_DIR=${WORK}`);
    } catch {
      return false; // process gone
    }
  });
};

const daemonsAlive = () => ownDaemonPids().length;

// Fire COUNT daemons at the same instant — the race the guard must resolve.
const children = Array.from({ length: COUNT }, () =>
  spawn(process.execPath, [entry, "daemon", "--account", TEST_PHONE], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  }),
);
for (const c of children) c.unref();

await new Promise((r) => setTimeout(r, 4000));

const alive = daemonsAlive();
const ping = await pingDaemon(paths);
console.log(`spawned ${COUNT} daemons simultaneously → alive: ${alive} | ping: ${ping}`);

let failures = 0;
if (alive !== 1) {
  console.log(`  ✗ expected exactly 1 daemon, got ${alive}`);
  failures++;
}
if (!ping) {
  console.log("  ✗ socket not served by the survivor");
  failures++;
}

// Cleanup: stop the survivor, confirm zero orphans.
try {
  await rpcCall(paths.sockFile, "shutdown");
} catch {
  /* already down */
}
await new Promise((r) => setTimeout(r, 800));
const after = daemonsAlive();
if (after !== 0) {
  console.log(`  ✗ ${after} orphan(s) after shutdown`);
  failures++;
}

rmSync(WORK, { recursive: true, force: true });

console.log(failures === 0 ? "✓ STRESS PASSED" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
