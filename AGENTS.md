# whats-proxy — Agent Context

## Project

Non-MCP CLI proxy for WhatsApp. Full `whats-mcp` catalog (65 actions) as flat JSON-RPC actions over a local background daemon. Bun implementation mirroring `tg-proxy` (structure + interface). Design reference: `CONTRACT.md`.

## Key Rules

- **Never delete `~/.config/whats-proxy/state/`** — session credentials live there; losing them forces re-pairing.
- **stdout is pure JSON** — never `console.log` anything that could pollute CLI output (use `logger.ts` → stderr).
- **Single source of truth for version**: `package.json` (read via `src/whats_proxy/version.ts`).
- **All envelope shapes**: `{ meta: { status, comment, edited }, data }` — errors exit 1, admin misuse exits 2.
- **Isolated state for tests**: `WHATS_PROXY_STATE_DIR` + `WHATS_PROXY_CONFIG_DIR` point at a temp dir (see `scripts/smoke.ts`).
- **Actions must be registered** in `src/whats_proxy/actions/registry.ts` (duplicate detection on boot; registry test asserts 65 actions).
- **Baileys quirks**: `sock.end(undefined)`, `ev.removeAllListeners` needs a cast, `lastDisconnect.error` is `Boom | Error | undefined`, `downloadMediaMessage` needs `msg as any`.

## Commands

```bash
make check        # tsc --noEmit + bun test + smoke
make test         # unit tests only
make smoke        # end-to-end (isolated state dir)
make install      # bun link global
make git-push     # push to github + gitlab (both remotes)
```

## Structure

```
src/whats_proxy/          # all source
├── index.ts cli.ts client.ts daemon.ts store.ts helpers.ts
├── config.ts logger.ts display.ts doc.ts version.ts exceptions.ts types.ts
├── actions/              # 13 category modules + history.ts + registry.ts
└── admin/                # setup.ts + status.ts + stop.ts
scripts/smoke.ts          # 30-check end-to-end smoke
tests/                    # bun test: helpers, store, display
```

## Porting Status

- 65/65 actions ported from `whats-mcp` (`~/Work/AI/MCPs/whats_mcp/src/tools/*.js`), verified at runtime.
- Interface parity with `tg-proxy` (`~/KpihX-Labs/tg_proxy`): `do`/`admin` namespaces, meta+data envelope, autosave, table/json output, exit codes.
