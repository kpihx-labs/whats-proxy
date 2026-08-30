# whats-proxy — Agent Context

## Project

Non-MCP CLI proxy for WhatsApp. Full `whats-mcp` catalog (65 actions) as flat JSON-RPC actions over a local background daemon. `../tick_proxy/` is the sole proxy standard; Bun/Baileys preserve only the persistent WhatsApp session and Store. Read `CONTRACT.md` before touching code.

## Key Rules

- **Never delete `~/.config/whats-proxy/state/`** — session credentials live there; losing them forces re-pairing.
- **stdout is pure JSON** — never `console.log` anything that could pollute CLI output (use `logger.ts` → stderr).
- **Single source of truth for version**: `package.json` (read via `src/whats_proxy/version.ts`).
- **Runtime split is intentional**: Bun owns install, typecheck, tests, and packaging; the installed
  CLI uses Node.js because Baileys needs `ws` upgrade events Bun 1.3.11 lacks.
- **All envelope shapes**: `{ meta: { status, comment, edited }, data }` — errors and rejected/timeout HITL exit 1; admin misuse exits 2.
- **Isolated state for tests**: `WHATS_PROXY_STATE_DIR` + `WHATS_PROXY_CONFIG_DIR` point at a temp dir (see `scripts/smoke.ts`).
- **Actions must be registered** in `src/whats_proxy/actions/registry.ts` (duplicate detection on boot; registry test asserts 65 actions; audit test asserts 65 schemas).
- **Safety is declarative**: `actions/policies.ts` is the only source for required approval, preflight locks, and verification. Never call `requestApproval()` inside a domain action or add a CLI bypass.
- **Zod validation**: Every action has a Zod schema in `actions/schemas.ts`. Validation runs at CLI (pre-daemon) and daemon-side (`protectAction`). Required-argument check runs first, then Zod type validation.
- **Baileys quirks**: `sock.end(undefined)`, `ev.removeAllListeners` needs a cast, `lastDisconnect.error` is `Boom | Error | undefined`, `downloadMediaMessage` needs `msg as any`.

## Commands

```bash
make check        # tsc --noEmit + bun test + smoke
make test         # unit tests only
make smoke        # end-to-end (isolated state dir)
make stress       # daemon race stress test (O_EXCL lock arbitration)
make runtime-smoke # verify the installed Node.js execution path
make install      # bun link global
make git-push     # push to github + gitlab (both remotes)
```

Daemon ownership: `O_CREAT|O_EXCL` lockfile (`whats-proxy.lock`) — kernel-atomic,
exactly one winner; socket bound before WhatsApp connect; losers exit. Never
"fix" this with socket probing alone — Unix sockets cannot arbitrate races
(a second listen() on the same path silently binds an orphaned inode).
The winner writes its PID before closing the lock, and contenders honor that
live PID during the tiny lock-to-socket window; only a dead PID plus an
unreachable socket permits stale-lock recovery.
Idle-exit: `daemon.max_idle_minutes` (>0) exits after that long without RPC
activity; `ping` does NOT count as activity (liveness probe, not user input).

## Structure

```
src/whats_proxy/          # all source
├── index.ts cli.ts client.ts daemon.ts store.ts helpers.ts
├── config.ts logger.ts display.ts doc.ts version.ts exceptions.ts types.ts hitl.ts
├── actions/              # 13 category modules + schemas.ts + history.ts + registry.ts + policies.ts
└── admin/                # setup.ts + status.ts + stop.ts
scripts/smoke.ts          # 50-check end-to-end smoke (CLI edge paths, spawn guard, hermetic sweep)
scripts/stress.ts         # daemon race stress test (default 8 spawns, `make stress`)
tests/                    # bun test: helpers, store, display, policies, audit
```

## Porting Status

- 65/65 actions ported from `whats-mcp` (`~/Work/AI/MCPs/whats_mcp/src/tools/*.js`), verified at runtime.
- Standard parity with `../tick_proxy/`: `do`/`admin` namespaces, meta+data envelope, autosave, table/json output, exit codes, structural HITL, and preflighted destructive writes.
