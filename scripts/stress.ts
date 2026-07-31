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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";

const COUNT = Number(process.argv[2] || 8);
const WORK = mkdtempSync(join(tmpdir(), "whats-proxy-stress-"));
process.env.WHATS_PROXY_STATE_DIR = WORK;
process.env.WHATS_PROXY_CONFIG_DIR = WORK;

const { pingDaemon, rpcCall } = await import("../src/whats_proxy/client.ts");
const { loadConfig, statePaths } = await import("../src/whats_proxy/config.ts");
const paths = statePaths(loadConfig());
const entry = join(import.meta.dir, "../src/whats_proxy/index.ts");

const daemonsAlive = () =>
  Number(
    execSync('ps aux | grep "bun.*whats_proxy.*daemon" | grep -v grep | wc -l')
      .toString()
      .trim(),
  );

// Hermetic baseline: any daemon left over from a previous run would poison the
// "exactly 1 survivor" assertion (system-wide ps count). Clear them first.
for (const pid of execSync('ps aux | grep "bun.*whats_proxy.*daemon" | grep -v grep | awk \'{print $2}\'')
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean)) {
  try {
    process.kill(Number(pid), "SIGKILL");
  } catch {
    /* already gone */
  }
}
await new Promise((r) => setTimeout(r, 300));
const baseline = daemonsAlive();
if (baseline !== 0) {
  console.log(`✗ baseline not clean (${baseline} daemons still alive); aborting.`);
  process.exit(1);
}

// Fire COUNT daemons at the same instant — the race the guard must resolve.
const children = Array.from({ length: COUNT }, () =>
  spawn(process.execPath, [entry, "daemon"], { detached: true, stdio: "ignore", env: process.env }),
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
