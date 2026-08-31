#!/usr/bin/env bun
/**
 * whats-proxy — LIVE validation script (requires a real WhatsApp account).
 *
 * Pairs the device (QR or pairing code) then sends a test message. Excluded
 * from `make check` — the sandbox cannot reach WhatsApp servers, and pairing
 * needs a physical phone. Run it on the real machine when ready:
 *
 *   bun run scripts/live.ts --to 33612345678 --text "hello from whats-proxy"
 *   bun run scripts/live.ts --code --to 33612345678   (phone-pairing mode)
 *
 * Exit codes: 0 = paired + sent, 1 = any failure (envelope on stdout).
 */

import { authLogin } from "../src/whats_proxy/admin/auth/login.ts";
import { serviceStatus } from "../src/whats_proxy/admin/service/status.ts";
import { serviceStop } from "../src/whats_proxy/admin/service/stop.ts";
import WaClient from "../src/whats_proxy/client.ts";
import type { Output } from "../src/whats_proxy/types.ts";

const argv = process.argv.slice(2);
const to = argv[argv.indexOf("--to") + 1];
const text = argv[argv.indexOf("--text") + 1] || "hello from whats-proxy";
const code = argv.includes("--code");

function fail(msg: string, detail?: unknown): never {
  const out: Output = { meta: { status: "error", comment: msg, edited: false }, data: { error: msg, detail } };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(1);
}

if (!to) fail("Missing --to <phone> (e.g. 33612345678).");
if (!/^\d{8,15}$/.test(to.replace(/[^\d]/g, ""))) fail(`Invalid phone: ${to}`);

// 1. Pair (QR by default, or pairing code with --code).
console.log(`[live] pairing${code ? " (code mode)" : " (QR mode)"}...`);
const setup = await authLogin({ code, phone: code ? to : undefined });
if (setup.meta.status !== "ok") fail("Pairing failed", setup.data);

// 2. Send a test message via the daemon (auto-spawns).
console.log("[live] sending test message...");
const client = new WaClient(to);
const sent = await client.do("send-text", { to, text });
if (sent.meta.status !== "ok") fail("send-text failed", sent.data);
process.stdout.write(JSON.stringify(sent, null, 2) + "\n");

// 3. Report final state, stop the daemon cleanly (session kept).
const status = await serviceStatus({ phone: to });
const stop = await serviceStop({ phone: to });
process.stdout.write(JSON.stringify({ pairing: setup.data, send: sent.data, final: status.data, stop: stop.data }, null, 2) + "\n");
console.log("[live] OK — paired, sent, daemon stopped (session credentials kept).");
process.exit(0);
