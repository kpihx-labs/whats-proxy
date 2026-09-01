# whats-proxy — Agent Context

## Project

Non-MCP CLI proxy for WhatsApp. Full `whats-mcp` catalog (69 actions) as flat JSON-RPC actions
over per-account background daemons. `../tick_proxy/` is the sole proxy standard; Bun/Baileys
preserve only the persistent WhatsApp session and Store. **Read `CONTRACT.md` before touching code.**

> **Status:** 🟢 **IMPLEMENTED — 69 actions, multi-account, pairing working live.** `CONTRACT.md`
> is the architecture contract. Version 0.6.0.

## Overview

```bash
whats-proxy do <action> [payload|file] [-a phone] [-o path] [-f json|table]   # 69 actions
whats-proxy admin auth login|status|logout|use                                # auth lifecycle
whats-proxy admin daemon status|stop|restart|logs|refresh                     # daemon lifecycle
```

## Key Rules

- **Never delete `~/.local/share/whats-proxy/<phone>/state/`** — session credentials live there;
  losing them forces re-pairing via `admin auth login`.
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
   test asserts 69; audit test asserts 69 schemas).
- **Safety is declarative:** `actions/policies.ts` is the only source for approval, preflight
  locks, and verification. Never call `requestApproval()` inside a domain action.
- **Zod validation:** Every action has a Zod schema in `actions/schemas.ts`. Validation runs
  at CLI (pre-daemon) and daemon-side (`protectAction`). Required-argument check first, then Zod.
- **Baileys is one-shot:** `makeWASocket()` dies after `close`. On `515 restartRequired`,
  create a NEW socket (the `connect()` reconnection pattern in `admin/auth/login.ts`).
- **Baileys fork:** `ayusc/Baileys` — merges upstream PRs #2608, #2749, #2765. Remove when
  upstream merges these.
- **Multi-account:** Each account = `<phone>/` under the base config dir. `-a`/`--account`
  on `do` routes to the correct daemon. Default from `accounts.json`.

## Commands

```bash
make check        # tsc --noEmit + bun test + smoke (50 checks)
make test         # unit tests only (51 tests, 1554 expects)
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
├── actions/   # 12 category modules + schemas.ts + registry.ts + policies.ts
└── admin/
    ├── auth/      # login.ts + status.ts + logout.ts + use.ts
    └── daemon/    # status.ts + stop.ts + restart.ts + logs.ts + refresh.ts
scripts/smoke.ts    # 50-check end-to-end smoke (CLI edge paths, spawn guard, hermetic sweep)
scripts/stress.ts   # daemon race stress test (default 8 spawns, `make stress`)
tests/              # bun test: helpers, store, display, policies, audit
```

## Multi-account layout

```
~/.config/whats-proxy/           # CONFIG ONLY (light)
├── accounts.json                # registry: default + per-account metadata

~/.local/share/whats-proxy/      # HEAVY DATA (per-account)
└── <phone>/
    ├── state/                   # Baileys auth
    ├── store.db                 # SQLite database (messages, contacts, chats)
    ├── daemon.sock              # daemon socket
    ├── daemon.lock              # O_EXCL lock
    └── daemon.pid               # daemon PID
```

## Account resolution

`-a <phone>` → `WHATS_PROXY_ACCOUNT` env → default from `accounts.json` → legacy flat path.

## Daemon ownership

`O_CREAT|O_EXCL` lockfile per account — kernel-atomic, exactly one winner per `<phone>/daemon.lock`.
Idle-exit: 30 min default.

## Store sync

The in-memory store captures messages via Baileys events. Sync behavior:

| Mechanism | When | What |
|-----------|------|------|
| `messaging-history.set` | Initial connect + resync | Batch of recent messages per chat (~100/chat) |
| `messages.upsert` | Real-time (daemon running) | Every new message as it arrives |
| `admin service refresh` | On demand (CLI) | Force resync: chats, contacts, groups + messages |

The store does NOT hold full WhatsApp history — WhatsApp limits initial sync to ~100 messages per chat.
To accumulate more: keep the daemon running (real-time `messages.upsert`) and periodically `admin service refresh`.

## Pairing lifecycle

```
admin auth login [--code] [--phone N] → wipe stale auth → QR/code displayed
→ user scans/enters → WhatsApp sends 515 → sock.end() → connect() again
→ pair-success → connection=open → register account → set default ✅
```

## Porting status

62/65 `whats-mcp` tools ported (3 dead labels removed) + 1 `send-batch` + 3 story actions + 13 community actions - 4 analytics actions = **69 actions** total.

## Backward compatibility

- `admin setup` → `admin auth login` (deprecated alias, warning)
- `admin status` → `admin daemon status` (deprecated alias, warning)
- `admin stop` → `admin daemon stop` (deprecated alias, warning)
- `do` without `--account` → uses default account or legacy flat path
