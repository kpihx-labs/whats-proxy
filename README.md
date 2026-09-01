# whats-proxy

Non-MCP CLI proxy for WhatsApp — the full `whats-mcp` tool catalog (67 actions) exposed as a flat JSON-RPC CLI with a local background daemon. Its sole proxy-standard reference is the sibling [`tick_proxy`](../tick_proxy/); Bun + Baileys are retained only for WhatsApp's persistent local Store.

Built with **Bun** + **Baileys** (`@whiskeysockets/baileys`): `meta`+`data` envelope, `do`/`admin` namespaces, `--format json|table`, `--output-file`, autosave, declarative mandatory HITL, destructive preflight identity locks, and local read-back proofs. Bun owns package/test operations; the installed TypeScript CLI is launched through Node.js + bundled `tsx` because Baileys needs Node-compatible WebSocket upgrade events.

## Why

`whats-mcp` is an MCP server — useful inside MCP hosts, useless in a shell. `whats-proxy` turns the same catalog into a **solo CLI**:

```bash
whats-proxy do send-text '{"to": "33612345678", "text": "Hello from the shell"}'
whats-proxy do chat-list
whats-proxy do whatsup '{}' -a 33605957785
```

No MCP runtime required. One binary, one daemon, full catalog.

## Install

```bash
make install
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

For a full validation pass on a real account: `bun run scripts/live.ts --to <phone> [--code]` — pairs (QR or code), sends a test message, stops the daemon. (Excluded from `make check`; it needs a physical phone.)

## Usage

```
whats-proxy do <action> [payload|file] [-o file] [-f json|table] [-h]
whats-proxy admin setup [--code] [--phone N]
whats-proxy admin status
whats-proxy admin stop
whats-proxy --version
```

- **`do`** — dispatch an action. `payload` is a JSON string or a path to a JSON file. Non-object payloads are wrapped as `{ "value": ... }`.
- **`do <action> -h -f json`** — machine-readable per-action help (schema from the registry meta), for scripting/autocomplete.
- **`admin`** — daemon/auth management. Always JSON output; refuses `-f`/`-o` (exit 2).
- **`admin stop`** — cleanly stops the daemon: store snapshot persisted, session credentials kept (`state/auth/` untouched). Next `do` auto-spawns it again.
- Every response is an envelope: `{ "meta": { "status": "ok"|"error", "comment": "", "edited": false }, "data": {...} }`.
- Errors exit `1` with the envelope on stderr. Autosave writes each call to `/tmp/whats-proxy-autosave/`.
- **Idle exit** — set `WHATS_PROXY_MAX_IDLE_MINUTES` in `$HOME/.config/whats-proxy/.env` to make the daemon exit after that long without RPC activity (`ping` does NOT count — it's a liveness probe, not user activity). `0` (default) = stay forever (session-holder).
- **Mandatory review** — consequential `do` actions open a local editable review page and fail closed after 600 seconds. Destructive actions preflight local targets and lock their identifiers; no bypass exists.

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

- **State**: `$HOME/.config/whats-proxy/` — `.env`, `state/` (Baileys credentials), `store.db` (SQLite), `whats-proxy.{pid,lock,sock}`. Diagnostics are stderr-only; there is no log file.
- **Daemon**: owns the Baileys session, SQLite store auto-persists (WAL mode), restores on startup, reconnects with exponential backoff (1.5x, capped 30 s).
- **Dispatch**: action handlers receive `{ args, store, config, sock, registry }` and return the full envelope.
- **Isolation for tests**: `WHATS_PROXY_STATE_DIR` / `WHATS_PROXY_CONFIG_DIR` point the whole stack at a temp dir.

## Actions (69)

| Category | Actions |
|---|---|
| messaging (13) | send-text, send-media, send-document, send-image, send-video, send-audio, send-sticker, send-buttons, send-location, send-contact, send-link-preview, send-reaction, forward-message |
| chats (5) | chat-list, chat-history, chat-info, mark-read, archive-chat |
| contacts (6) | contact-list, contact-info, contact-by-phone, block-list, block-contact, unblock-contact |
| groups (10) | group-list, group-info, group-create, group-add-participants, group-remove-participants, group-promote, group-demote, group-update, group-leave, group-invite-code |
| labels (3) | label-list, label-create, label-associate |
| profile (4) | profile-info, profile-update, profile-picture, profile-link-preview |
| overview (2) | whatsup, find-messages |
| tags (1) | contact-tag-list |
| utils (4) | connection-status, presence, read-messages, media-download |
| communities (13) | community-list, community-info, community-groups, community-pending, community-create ⚠️, community-leave ⚠️, community-subject, community-description, community-participants, community-link ⚠️, community-unlink, community-invite, community-join ⚠️ |

Run `whats-proxy do --help` for the live catalog; `whats-proxy do <action> -h` for per-action help. Every one of the 67 `do` pages renders at least three concrete executable forms from its action-owned payload: inline JSON, a payload file, and captured JSON output. Actions with required fields, local HITL, destructive preflight, or zero-argument table display show their additional branch explicitly. `WaClient.raw()` remains an internal lifecycle API rather than a public `do` escape hatch, so it cannot bypass validation or safety policies.

The complex families also own distinct semantic scenarios: direct/group/reply text; local/remote/reply
media; broadcast recipient mixes and delays; group participant roles and invite lifecycle. `make check`
validates the universal three-example contract and these distinct
complex branches entirely offline. Pairing and a real WhatsApp account are intentionally excluded.

## Development

```bash
bun install
make check       # tsc --noEmit + bun test + smoke (isolated state)
make test        # unit tests only
make smoke       # end-to-end: spawn daemon, RPC, CLI catalog
make stress      # race test: N simultaneous daemon spawns → exactly 1 survives
```

Like `tick-proxy`, this project deliberately ships no separately maintained shell-completion layer.
The registry-derived `whats-proxy do --help` and per-action `--help` remain the single discovery surface.

Layout:

```
src/whats_proxy/
├── index.ts        # entry: exitCode = await main(argv)
├── cli.ts          # arg parsing, do/admin dispatch, autosave
├── client.ts       # RPC client: rpcCall, pingDaemon, ensureDaemon (auto-spawn)
├── daemon.ts       # Baileys session + Unix-socket JSON-RPC server
├── store.ts        # in-memory WhatsApp store (chats/contacts/messages/…)
├── helpers.ts      # formatting, JID utils, ok/err envelope builders
├── config.ts       # documented defaults + one .env override surface (WHATS_PROXY_*)
├── logger.ts       # pino to stderr + log file (stdout stays pure JSON)
├── display.ts      # print_json / print_table / output_result
├── doc.ts          # compact help, per-action help
├── version.ts      # reads version from package.json (single source)
├── exceptions.ts   # WhatsProxyError hierarchy
├── types.ts        # ActionDef, ActionContext, Output envelope
├── hitl.ts         # local editable review page; port 0, 600-second fail-closed timeout
├── actions/        # 14 category modules + registry.ts + policies.ts (67 actions)
└── admin/          # setup (QR/pairing code) + status (independent probe)
```

## Contract

[`CONTRACT.md`](CONTRACT.md) is the authoritative implementation contract — safety, envelope, daemon lifecycle, configuration, and catalog surface.

## License

MIT
