# whats-proxy

Non-MCP CLI proxy for WhatsApp — the full `whats-mcp` tool catalog (65 actions) exposed as a flat JSON-RPC CLI with a local background daemon, in the exact spirit and structure of [`tg-proxy`](https://github.com/KpihX/tg-proxy).

Built with **Bun** + **Baileys** (`@whiskeysockets/baileys`), mirroring `tg-proxy`'s interface contract: `meta`+`data` envelope, `do`/`admin` namespaces, `--format json|table`, `--output-file`, and autosave.

## Why

`whats-mcp` is an MCP server — useful inside MCP hosts, useless in a shell. `whats-proxy` turns the same catalog into a **solo CLI**:

```bash
whats-proxy do send-text '{"to": "33612345678", "text": "Hello from the shell"}'
whats-proxy do chat-list
whats-proxy do guide | jq .data.categories
```

No MCP runtime required. One binary, one daemon, full catalog.

## Install

```bash
make install          # or: ./scripts/install.sh
```

Requires [Bun](https://bun.sh) >= 1.1.

## First run — pairing

```bash
whats-proxy admin setup            # shows QR code in terminal
whats-proxy admin setup --code     # phone-pairing mode (enter code on phone)
whats-proxy admin status           # check daemon + auth state
whats-proxy admin stop             # stop the daemon (persists store, keeps session)
```

The daemon auto-spawns on first `do` command. Session credentials live in `~/.config/whats-proxy/state/` — **never delete this folder** or you must re-pair. A spawn guard prevents daemon races: if another daemon already serves the socket, a newcomer exits quietly instead of hijacking the session.

## Usage

```
whats-proxy do <action> [payload|file] [-o file] [-f json|table] [-h]
whats-proxy admin setup [--code] [--phone N]
whats-proxy admin status
whats-proxy admin stop
whats-proxy --version
```

- **`do`** — dispatch an action. `payload` is a JSON string or a path to a JSON file. Non-object payloads are wrapped as `{ "value": ... }`.
- **`admin`** — daemon/auth management. Always JSON output; refuses `-f`/`-o` (exit 2).
- **`admin stop`** — cleanly stops the daemon: store snapshot persisted, session credentials kept (`state/auth/` untouched). Next `do` auto-spawns it again.
- Every response is an envelope: `{ "meta": { "status": "ok"|"error", "comment": "", "edited": false }, "data": {...} }`.
- Errors exit `1` with the envelope on stderr. Autosave writes each call to `/tmp/whats-proxy-autosave/`.

### Table format

```bash
whats-proxy do chat-list -f table
+--------------------+---------+
| jid                | name    |
+--------------------+---------+
| 33612345678@s.whatsapp.net | Alice |
+--------------------+---------+
```

## Architecture

```
whats-proxy (CLI, Bun)                daemon (detached background process)
┌──────────────────────┐    spawn     ┌───────────────────────────────────┐
│ do <action>          │ ───────────► │ Baileys socket (WhatsApp session)  │
│   payload/file       │              │ + in-memory Store                 │
│ admin setup/status/stop │         │ JSON-RPC 2.0 over Unix socket      │
│ --version            │ ◄─────────── │   ping | connection-info |         │
└──────────────────────┘  newline     │   dispatch | shutdown              │
                          JSON-RPC    └───────────────────────────────────┘
```

- **State**: `~/.config/whats-proxy/` — `config.json`, `.env`, `state/auth/` (Baileys creds), `store.json`, `whats-proxy.{pid,log,sock}`.
- **Daemon**: owns the Baileys session, snapshots the store to `store.json` (500 ms debounce), restores it on startup, reconnects with exponential backoff (1.5x, capped 30 s).
- **Dispatch**: action handlers receive `{ args, store, config, sock, registry }` and return the full envelope.
- **Isolation for tests**: `WHATS_PROXY_STATE_DIR` / `WHATS_PROXY_CONFIG_DIR` point the whole stack at a temp dir.

## Actions (65)

| Category | Actions |
|---|---|
| messaging (14) | send-text, send-media, send-document, send-image, send-video, send-audio, send-sticker, send-buttons, send-location, send-contact, send-link-preview, send-reaction, batch-send-text, forward-message |
| chats (5) | chat-list, chat-history, chat-info, mark-read, archive-chat |
| contacts (6) | contact-list, contact-info, contact-by-phone, block-list, block-contact, unblock-contact |
| groups (10) | group-list, group-info, group-create, group-add-participants, group-remove-participants, group-promote, group-demote, group-update, group-leave, group-invite-code |
| channels (5) | channel-list, channel-info, channel-follow, channel-unfollow, channel-update |
| labels (3) | label-list, label-create, label-associate |
| profile (4) | profile-info, profile-update, profile-picture, profile-link-preview |
| analytics (5) | analytics-overview, analytics-chat, analytics-top-chats, analytics-search, analytics-trends |
| overview (2) | overview-dashboard, overview-quick-stats |
| digest (2) | digest-daily, digest-weekly |
| tags (1) | contact-tag-list |
| watchlists (1) | watchlist-list |
| utils (7) | connection-status, guide, presence, read-messages, search-messages, media-download, media-cleanup |

Run `whats-proxy do --help` or `whats-proxy do guide` for the live catalog; `whats-proxy do <action> -h` for per-action help.

## Development

```bash
bun install
make check       # tsc --noEmit + bun test + smoke (isolated state)
make test        # unit tests only
make smoke       # end-to-end: spawn daemon, RPC, CLI catalog
```

Layout:

```
src/whats_proxy/
├── index.ts        # entry: exitCode = await main(argv)
├── cli.ts          # arg parsing, do/admin dispatch, autosave
├── client.ts       # RPC client: rpcCall, pingDaemon, ensureDaemon (auto-spawn)
├── daemon.ts       # Baileys session + Unix-socket JSON-RPC server
├── store.ts        # in-memory WhatsApp store (chats/contacts/messages/…)
├── helpers.ts      # formatting, JID utils, ok/err envelope builders
├── config.ts       # config.json/.env/env loading (WHATS_PROXY_*)
├── logger.ts       # pino to stderr + log file (stdout stays pure JSON)
├── display.ts      # print_json / print_table / output_result
├── doc.ts          # compact help, per-action help
├── version.ts      # reads version from package.json (single source)
├── exceptions.ts   # WhatsProxyError hierarchy
├── types.ts        # ActionDef, ActionContext, Output envelope
├── actions/        # 13 category modules + history.ts + registry.ts (65 actions)
└── admin/          # setup (QR/pairing code) + status (independent probe)
```

## Contract

[`CONTRACT.md`](CONTRACT.md) is the design reference — envelope, RPC protocol, daemon lifecycle, catalog mapping to `whats-mcp`, and every porting decision.

## License

MIT
