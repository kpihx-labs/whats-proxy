#!/usr/bin/env bun
/**
 * whats-proxy — smoke test.
 *
 * Real end-to-end verification without touching a live WhatsApp account:
 *   1. `do --help` catalog (66 actions)
 *   2. per-action help
 *   3. daemon spawn + ping
 *   4. RPC dispatch against a stub store (chat-list, connection-status, guide)
 *   5. admin status
 *   6. error paths (unknown action, invalid payload)
 *
 * Uses an isolated state dir under /tmp so it never touches the real config.
 */

import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORK = mkdtempSync(join(tmpdir(), "whats-proxy-smoke-"));
process.env.WHATS_PROXY_STATE_DIR = WORK;
process.env.WHATS_PROXY_CONFIG_DIR = WORK;
process.env.WHATS_PROXY_NO_BROWSER = "1"; // suppress xdg-open during tests
const TEST_PHONE = "1234567890";
process.env.WHATS_PROXY_ACCOUNT = TEST_PHONE;

// Seed accounts.json so CLI resolution and daemons have a phone.
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, "accounts.json"), JSON.stringify({
  default: TEST_PHONE,
  accounts: { [TEST_PHONE]: { alias: null, created: new Date().toISOString(), last_active: null } },
}, null, 2) + "\n", "utf-8");

const { main } = await import("../src/whats_proxy/cli.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. Catalog help ──────────────────────────────────────────────────────────
console.log("\n[1] catalog help");
{
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
  const code = await main(["do", "--help"]);
  process.stdout.write = orig;
  const text = out.join("");
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  check("exit 0", code === 0);
  check("mentions send-text", stripped.includes("send-text"));
  check("mentions find-messages", stripped.includes("find-messages"));
  check("mentions daily-digest", stripped.includes("daily-digest"));
  // Count action names: lines starting with a lowercase letter, containing
  // only lowercase + hyphens (no spaces, no ANSI). After ANSI strip, these
  // are action names like "analytics-chat-insights" or "send-text".
  const actionCount = (stripped.match(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/gm) || []).length;
  check(`catalog lists ~65 actions (found ${actionCount})`, actionCount >= 60, `count=${actionCount}`);
}

// ── 2. Per-action help ───────────────────────────────────────────────────────
console.log("\n[2] per-action help");
{
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
  const code = await main(["do", "send-text", "--help"]);
  process.stdout.write = orig;
  const text = out.join("");
  check("exit 0", code === 0);
  check("has Parameters section", text.includes("Parameters:"));
  check("has jid arg", text.includes("jid"));
  check("has usage line", text.includes("whats-proxy do send-text"));
}

// ── 3. Unknown action → error envelope + exit 1 ─────────────────────────────
console.log("\n[3] unknown action");
{
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
  const code = await main(["do", "does-not-exist", "{}"]);
  process.stdout.write = orig;
  const text = out.join("");
  check("exit 1", code === 1);
  check("error envelope", text.includes('"status": "error"'));
  check("hint present", text.includes("catalog"));
}

// ── 4. Invalid payload ───────────────────────────────────────────────────────
console.log("\n[4] invalid payload");
{
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
  const code = await main(["do", "chat-list", "not-json-{!!"]);
  process.stdout.write = orig;
  const text = out.join("");
  check("exit 1", code === 1);
  check("error envelope", text.includes('"status": "error"'));
}

// ── 5. Daemon spawn + RPC round-trip (auto-spawn path) ──────────────────────
// Required arguments are rejected before a daemon is spawned.
console.log("\n[5] required payload validation");
{
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
  const code = await main(["do", "send-text", "{}"]);
  process.stdout.write = orig;
  check("missing required arguments exit 1", code === 1);
  check("missing required arguments identify fields", out.join("").includes("jid, text"));
}

// ── 6. Daemon spawn + RPC round-trip (auto-spawn path) ──────────────────────
console.log("\n[6] daemon spawn + dispatch");
{
  const { spawnDaemon, pingDaemon, rpcCall, ensureDaemon } = await import("../src/whats_proxy/client.ts");
  const { loadConfig, accountStatePaths } = await import("../src/whats_proxy/config.ts");
  const cfg = loadConfig();
  const paths = accountStatePaths(TEST_PHONE, cfg);

  await spawnDaemon(cfg, TEST_PHONE, 30_000);
  check("daemon answers ping", await pingDaemon(paths));

  // connection-info
  const info = await rpcCall(paths.sockFile, "connection-info");
  check(
    "connection-info ok",
    !info.error && (info.result as { state: string }).state === "connecting" ||
      (info.result as { state: string }).state === "disconnected",
    JSON.stringify(info.result),
  );

  // dispatch a store-only action (chat-list works without auth — store is empty)
  const resp = await rpcCall(paths.sockFile, "dispatch", { action: "chat-list", args: {} });
  check("chat-list dispatched", !resp.error, resp.error?.message);
  const result = resp.result as { meta: { status: string }; data: unknown };
  check("chat-list ok envelope", result?.meta?.status === "ok");
  check("chat-list data", Array.isArray((result?.data as { chats?: unknown })?.chats));

  // unknown action through RPC
  const bad = await rpcCall(paths.sockFile, "dispatch", { action: "nope", args: {} });
  check("unknown action → RPC error", !!bad.error, JSON.stringify(bad.error));

  // shutdown
  const shut = await rpcCall(paths.sockFile, "shutdown");
  check("shutdown ok", !shut.error);
  await new Promise((r) => setTimeout(r, 600));
  check("daemon stopped", !(await pingDaemon(paths)));
}

// ── 7. admin status (daemon down) ────────────────────────────────────────────
console.log("\n[7] admin status");
{
  const { daemonStatus } = await import("../src/whats_proxy/admin/daemon/status.ts");
  const result = await daemonStatus({});
  check("status ok envelope", result.meta.status === "ok");
  const data = result.data as { accounts: Array<{ daemon: { running: boolean }; auth: { present: boolean } }>; total: number };
  check("total >= 1", data.total >= 1);
  const acct = data.accounts?.[0];
  if (acct) {
    check("daemon.running false", acct.daemon.running === false);
    check("auth.present false", acct.auth.present === false);
  }
}

// ── 8. guide + connection-status (store-only, daemon up) ────────────────────
console.log("\n[8] store-only actions via CLI (daemon auto-spawn)");
{
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
  const code = await main(["do", "guide"]);
  process.stdout.write = orig;
  const text = out.join("");
  check("guide exit 0", code === 0);
  check("guide lists 66 tools", text.includes("66"), text.match(/"total_tools": (\d+)/)?.[1]);
  check("guide has categories", text.includes("categories"));

  // Stop the auto-spawned daemon through `admin daemon stop`
  const out2: string[] = [];
  const orig2 = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out2.push(String(s)); return true; }) as never;
  const stopCode = await main(["admin", "daemon", "stop"]);
  process.stdout.write = orig2;
  const stopText = out2.join("");
  check("admin daemon stop exit 0", stopCode === 0);
  check("admin daemon stop ok envelope", stopText.includes('"status": "ok"'));
  check("admin daemon stop stopped true", stopText.includes('"stopped": true'));
  await new Promise((r) => setTimeout(r, 600));
  const { loadConfig, accountStatePaths } = await import("../src/whats_proxy/config.ts");
  const paths = accountStatePaths(TEST_PHONE, loadConfig());
  check("daemon stopped after stop", !(await (await import("../src/whats_proxy/client.ts")).pingDaemon(paths)));
}

// ── 9. CLI edge paths: no-payload, file-payload, -o output-file, direct daemon ──
console.log("\n[9] CLI edge paths");
{
  const { writeFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { loadConfig, accountStatePaths } = await import("../src/whats_proxy/config.ts");
  const paths = accountStatePaths(TEST_PHONE, loadConfig());

  // 9a. `do <action>` with NO payload (defaults apply)
  {
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
    const code = await main(["do", "chat-list"]);
    process.stdout.write = orig;
    const text = out.join("");
    check("no-payload exit 0", code === 0);
    check("no-payload ok envelope", text.includes('"status": "ok"'));
  }

  // 9b. payload from a JSON FILE
  {
    const payloadFile = join(WORK, "payload.json");
    writeFileSync(payloadFile, JSON.stringify({ value: 1 }));
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
    const code = await main(["do", "connection-status", payloadFile]);
    process.stdout.write = orig;
    const text = out.join("");
    check("file-payload exit 0", code === 0);
    check("file-payload ok envelope", text.includes('"status": "ok"'));
  }

  // 9c. -o output-file: file written, result still printed, stdout pure JSON
  {
    const outFile = join(WORK, "out.json");
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
    const code = await main(["do", "chat-list", "-o", outFile]);
    process.stdout.write = orig;
    const text = out.join("");
    check("-o exit 0", code === 0);
    check("-o file written", existsSync(outFile));
    const fileResult = JSON.parse((await import("node:fs")).readFileSync(outFile, "utf-8"));
    check("-o file has envelope", fileResult?.meta?.status === "ok");
    check("-o stdout still JSON", (() => { try { JSON.parse(text); return true; } catch { return false; } })());
  }

  // 9e. argument parsing errors: -o and -f without a value → exit 2, clear stderr
  {
    for (const args of [["do", "chat-list", "-o"], ["do", "chat-list", "-f"]]) {
      const out: string[] = [];
      const err: string[] = [];
      const origOut = process.stdout.write.bind(process.stdout);
      const origErr = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
      process.stderr.write = ((s: string) => { err.push(String(s)); return true; }) as never;
      const code = await main(args);
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      check(`missing value exit 2 (${args[2]})`, code === 2);
      check(`missing value error msg (${args[2]})`, err.join("").includes("requires"));
    }
    // Unknown option → exit 2
    const code = await main(["do", "chat-list", "--bogus"]);
    check("unknown option exit 2", code === 2);
  }

  // 9d. direct `daemon` command (hidden) serves RPC, then shuts down cleanly.
  // Runs on a fresh socket: stop any daemon first so the direct spawn is the
  // sole owner (also exercises the guard: a second spawn must exit quietly).
  {
    const { spawn } = await import("node:child_process");
    const { pingDaemon, rpcCall } = await import("../src/whats_proxy/client.ts");
    try { await rpcCall(paths.sockFile, "shutdown"); } catch { /* already down */ }
    await new Promise((r) => setTimeout(r, 600));

    const entry = join(import.meta.dir, "../src/whats_proxy/index.ts");
    const child = spawn(process.execPath, [entry, "daemon", "--account", TEST_PHONE], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    let up = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await pingDaemon(paths)) { up = true; break; }
    }
    check("direct daemon serves ping", up);

    // Second spawn must NOT hijack: the guard makes it exit(0) immediately.
    const rival = spawn(process.execPath, [entry, "daemon", "--account", TEST_PHONE], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    rival.unref();
    await new Promise((r) => setTimeout(r, 1200));
    check("rival daemon exits (guard)", rival.exitCode !== null, `exitCode=${rival.exitCode}`);

    try { await rpcCall(paths.sockFile, "shutdown"); } catch { /* already down */ }
    await new Promise((r) => setTimeout(r, 600));
    check("direct daemon stopped", !(await pingDaemon(paths)));
  }

  // 9f. hermetic sweep: no daemon may survive section 9 (kill-if-needed).
  {
    const { pingDaemon, rpcCall } = await import("../src/whats_proxy/client.ts");
    try { await rpcCall(paths.sockFile, "shutdown"); } catch { /* already down */ }
    await new Promise((r) => setTimeout(r, 600));
    const stillUp = await pingDaemon(paths);
    if (stillUp) {
      // The daemon ignored shutdown (rare race) — force it via the pid file.
      const { readFileSync } = await import("node:fs");
      try {
        const pid = Number(readFileSync(paths.pidFile, "utf-8").trim());
        process.kill(pid, "SIGTERM");
      } catch { /* no pid file */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    check("no daemon survives section 9", !(await pingDaemon(paths)));
  }

  // 9g. idle-exit: daemon with max_idle_minutes exits itself after inactivity
  {
    const { spawn } = await import("node:child_process");
    const { pingDaemon, rpcCall } = await import("../src/whats_proxy/client.ts");
    try { await rpcCall(paths.sockFile, "shutdown"); } catch { /* already down */ }
    await new Promise((r) => setTimeout(r, 600));

    const entry = join(import.meta.dir, "../src/whats_proxy/index.ts");
    const idleChild = spawn(process.execPath, [entry, "daemon", "--account", TEST_PHONE], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, WHATS_PROXY_MAX_IDLE_MINUTES: "0.05" }, // 3s idle
    });
    idleChild.unref();
    let up = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await pingDaemon(paths)) { up = true; break; }
    }
    check("idle daemon serves ping", up);
    await new Promise((r) => setTimeout(r, 5000)); // wait past the 3s idle window
    check("idle daemon exits itself", !(await pingDaemon(paths)));
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
rmSync(WORK, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
