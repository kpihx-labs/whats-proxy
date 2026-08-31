# whats-proxy — Agent Context

## Project

Non-MCP CLI proxy for WhatsApp. Full `whats-mcp` catalog (65 actions) as flat JSON-RPC actions
over a local background daemon. `../tick_proxy/` is the sole proxy standard; Bun/Baileys
preserve only the persistent WhatsApp session and Store. **Read `CONTRACT.md` before touching code.**

> **Status:** 🟢 **IMPLEMENTED — 65 actions, pairing working live.** `CONTRACT.md` is the
> architecture contract. Version 0.5.0.

## Overview

```bash
whats-proxy do <action> [payload|file] [-o path] [-f json|table]   # 65 RPC actions
whats-proxy admin setup|status|stop                                 # always JSON
```

## Key Rules

- **Never delete `~/.config/whats-proxy/state/`** — session credentials live there; losing them
  forces re-pairing via `admin setup`.
- **stdout is pure JSON** — never `console.log` anything that could pollute CLI output
  (use `logger.ts` → stderr).
- **Single source of truth for version:** `package.json` (read via `src/whats_proxy/version.ts`).
- **Runtime split is intentional:** Bun owns install, typecheck, tests, and packaging; the installed
  CLI uses Node.js because Baileys needs `ws` upgrade events Bun 1.3.11 lacks.
- **Envelope always:** `{ meta: { status, comment, edited }, data }` — errors exit 1; admin
  misuse exits 2.
- **Isolated state for tests:** `WHATS_PROXY_STATE_DIR` + `WHATS_PROXY_NO_BROWSER` suppress
  real WhatsApp and browser interaction during `make check`.
- **Actions must be registered** in `actions/registry.ts` (duplicate detection on boot; registry
  test asserts 65; audit test asserts 65 schemas).
- **Safety is declarative:** `actions/policies.ts` is the only source for approval, preflight
  locks, and verification. Never call `requestApproval()` inside a domain action.
- **Zod validation:** Every action has a Zod schema in `actions/schemas.ts`. Validation runs
  at CLI (pre-daemon) and daemon-side (`protectAction`). Required-argument check first, then Zod.
- **Baileys is one-shot:** `makeWASocket()` dies after `close`. On `515 restartRequired`,
  create a NEW socket (the `connect()` reconnection pattern in `setup.ts` and `daemon.ts`).
- **Baileys fork:** `ayusc/Baileys` — merges upstream PRs #2608, #2749, #2765. Remove when
  upstream merges these.

## Commands

```bash
make check        # tsc --noEmit + bun test + smoke (50 checks)
make test         # unit tests only (51 tests, 1530 expects)
make smoke        # end-to-end CLI + daemon + dispatch (isolated state)
make stress       # daemon race stress test (O_EXCL lock arbitration, default 8 spawns)
make runtime-smoke # verify the installed Node.js execution path
make install      # bun link global
make git-push     # push to github + gitlab (both remotes)
```

## Structure

```
src/whats_proxy/
├── index.ts cli.ts client.ts daemon.ts store.ts helpers.ts
├── config.ts logger.ts display.ts doc.ts version.ts exceptions.ts types.ts hitl.ts
├── actions/   # 13 category modules + schemas.ts + registry.ts + policies.ts
└── admin/     # setup.ts + status.ts + stop.ts
scripts/smoke.ts    # 50-check end-to-end smoke (CLI edge paths, spawn guard, hermetic sweep)
scripts/stress.ts   # daemon race stress test (default 8 spawns, `make stress`)
tests/              # bun test: helpers, store, display, policies, audit
```

## Daemon ownership

`O_CREAT|O_EXCL` lockfile (`whats-proxy.lock`) — kernel-atomic, exactly one winner; socket bound
before WhatsApp connect; losers exit. Never "fix" this with socket probing alone — Unix sockets
cannot arbitrate races. The winner writes its PID before closing the lock; contenders honor that
live PID during the tiny lock-to-socket window; only a dead PID plus an unreachable socket
permits stale-lock recovery.

**Idle-exit:** `daemon.max_idle_minutes` (>0) exits after that long without RPC activity;
`ping` does NOT count as activity (liveness probe, not user input). Default: 30 minutes.

## Pairing lifecycle

```
admin setup [QR|code] → fetchLatestBaileysVersion → wipe stale auth
  → useMultiFileAuthState → makeWASocket → QR or pairing code displayed
  → user scans/enters → WhatsApp sends 515 (restartRequired)
  → sock.end() → connect() again (re-reads fresh creds from disk)
  → new socket → pair-success → connection=open → paired ✅
```

Key: `makeWASocket` is one-shot. 515 means "reconnect with new creds". The daemon has this
reconnect loop natively; `admin setup` had to learn it (was the root cause of "couldn't link").

## Baileys fork (`ayusc/Baileys`)

| PR | Fix | Why needed |
|----|-----|-----------|
| #2608 | Empty `link_code_companion_reg` ack | Prevents crash on malformed pre-login notification |
| #2749 | Pre-login notification ack | `authState.creds.me` is undefined pre-pairing → crash |
| #2765 | `companion_reg_refresh` handler | Rotates adv secret + re-renders QR mid-flow |

Source: `package.json` → `"@whiskeysockets/baileys": "ayusc/Baileys"`

## Porting status

65/65 actions ported from `whats-mcp` (`~/Work/AI/MCPs/whats_mcp/src/tools/*.js`), verified at
runtime. Standard parity with `../tick_proxy/`: `do`/`admin` namespaces, meta+data envelope,
autosave, table/json output, exit codes, structural HITL, and preflighted destructive writes.
