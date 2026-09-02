# whats-proxy

Non-MCP CLI proxy for WhatsApp — the full `whats-mcp` tool catalog plus an unrestricted raw Baileys escape hatch (68 actions) exposed as a flat JSON-RPC CLI with a local background daemon. Its sole proxy-standard reference is the sibling [`tick_proxy`](../tick_proxy/); Bun + Baileys are retained only for WhatsApp's persistent local Store.

Built with **Bun** + **Baileys** (`@whiskeysockets/baileys`): `meta`+`data` envelope, `do`/`admin` namespaces, `--format json|table`, `--output-file`, autosave, declarative mandatory HITL, destructive preflight identity locks, and local read-back proofs. Bun owns package/test operations; the installed TypeScript CLI is launched through Node.js + bundled `tsx` because Baileys needs Node-compatible WebSocket upgrade events.

## Why

`whats-mcp` is an MCP server — useful inside MCP hosts, useless in a shell. `whats-proxy` turns the same catalog into a **solo CLI**:

```bash
whats-proxy do send-text '{"jid":"33612345678@s.whatsapp.net","text":"Hello from the shell"}'
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
whats-proxy admin auth login          # QR code pairing
whats-proxy admin auth login --code   # phone-pairing mode (enter code on phone)
whats-proxy admin auth login --start-service  # pair + start daemon immediately
whats-proxy admin daemon status       # check daemon + auth state
whats-proxy admin daemon stop         # stop the daemon (persists store, keeps session)
```

The daemon auto-spawns on first `do` command. Session credentials live in `~/.local/share/whats-proxy/<phone>/state/` — **never delete this folder** or you must re-pair. A spawn guard prevents daemon races: if another daemon already serves the socket, a newcomer exits quietly instead of hijacking the session.

For a full validation pass on a real account: `bun run scripts/live.ts --to <phone> [--code]` — pairs (QR or code), sends a test message, stops the daemon. (Excluded from `make check`; it needs a physical phone.)

## Usage

```
whats-proxy do <action> [payload|file] [-a phone] [-o file] [-f json|table] [-h]
whats-proxy admin auth login [--code] [--phone N] [--start-service]
whats-proxy admin auth status|logout|use
whats-proxy admin daemon status|stop|restart|logs|refresh
whats-proxy --version
```

- **`do`** — dispatch an action. `payload` is a JSON string or a path to a JSON file. Non-object payloads are wrapped as `{ "value": ... }`. Use `-a <phone>` to target a specific account.
- **`do <action> -h -f json`** — machine-readable per-action help (schema from the registry meta), for scripting/autocomplete.
- **`admin`** — auth lifecycle and daemon management. Always JSON output; refuses `-f`/`-o` (exit 2).
- **`admin daemon stop`** — cleanly stops the daemon: store snapshot persisted, session credentials kept. Next `do` auto-spawns it again.
- Every response is an envelope: `{ "meta": { "status": "ok"|"error", "comment": "", "edited": false }, "data": {...} }`.
- Errors exit `1` with the envelope on stderr. Autosave writes each call to `/tmp/whats-proxy-autosave/`.
- **Idle exit** — configurable via `WHATS_PROXY_MAX_IDLE_MINUTES` (default 30). `ping` does NOT count as activity.
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
│   payload/file       │              │ + in-memory Store + SQLite         │
│   -a <phone>         │              │ JSON-RPC 2.0 over Unix socket      │
│ admin auth/daemon    │ ◄─────────── │   ping | connection-info |         │
│ --version            │  newline     │   dispatch | shutdown              │
└──────────────────────┘  JSON-RPC    └───────────────────────────────────┘
```

- **State**: `~/.local/share/whats-proxy/<phone>/` — `state/` (Baileys credentials), `store.db` (SQLite WAL), `daemon.{sock,lock,pid}`. Config: `~/.config/whats-proxy/accounts.json`. Diagnostics are stderr-only; there is no log file.
- **Daemon**: owns the Baileys session, SQLite store auto-persists (WAL mode), restores on startup, reconnects with exponential backoff (1.5x, capped 30 s).
- **Dispatch**: action handlers receive `{ args, store, config, sock, registry }` and return the full envelope.
- **Multi-account**: `-a <phone>` routes to the correct daemon. Default from `accounts.json`. Each account has its own daemon, store, and socket.
- **Isolation for tests**: `WHATS_PROXY_STATE_DIR` / `WHATS_PROXY_CONFIG_DIR` point the whole stack at a temp dir.

## Actions (68)

| Category | Count | Actions |
|---|---:|---|
| Messaging | 15 | send-text, send-image, send-video, send-audio, send-document, send-sticker, send-location, send-contact, send-reaction, send-poll, edit-message, delete-message, forward-message, send-batch, media-upload |
| Chats | 6 | chat-list, chat-read, chat-manage, chat-star, chat-disappearing, message-status |
| Contacts | 8 | contact-list, contact-info, contact-check, contact-block, contact-business, contact-picture, contact-presence-check, contact-tags |
| Groups | 11 | group-list, group-info, group-create, group-subject, group-description, group-participants, group-invite, group-leave, group-settings, group-picture, group-disband |
| Communities | 13 | community-list, community-info, community-groups, community-pending, community-create, community-leave, community-subject, community-description, community-participants, community-link, community-unlink, community-invite, community-join |
| Stories | 3 | story-list, story-download, story-view |
| Profile | 4 | profile-about, profile-name, profile-picture, profile-privacy |
| Overview | 3 | whatsup, find-messages, chat-read-batch |
| Utilities | 4 | connection-status, read-messages, media-download, presence |
| Raw API | 1 | raw |
| **TOTAL** | **68** | |

Run `whats-proxy do --help` for the live catalog; `whats-proxy do <action> -h` for per-action help. Every one of the 68 `do` pages renders at least three concrete executable forms from its action-owned payload: inline JSON, a payload file, and captured JSON output. Actions with required fields, local HITL, destructive preflight, or zero-argument table display show their additional branch explicitly. `do raw` provides unrestricted access to the Baileys socket API and the local SQLite store.

The complex families also own distinct semantic scenarios: direct/group/reply text; local/remote/reply
media; broadcast recipient mixes and delays; group participant roles and invite lifecycle. `make check`
validates the universal three-example contract and these distinct
complex branches entirely offline. Pairing and a real WhatsApp account are intentionally excluded.

## Receipt visibility

`chat-read` exposes `delivered_to` and `read_by` for outgoing messages, while `message-status`
exposes persisted delivery/read receipts and `read_count`. In one-to-one chats, a read state is
available only when the recipient has WhatsApp **Read receipts** enabled (`profile-privacy`:
`read_receipts=all`). With `read_receipts=none`, WhatsApp does not send or reveal one-to-one read
receipts. Group read receipts are not controlled by this setting. `read-messages` explicitly marks
selected messages read; it does not enable receipt observation for another account.

## Media download destination

`media-download` saves files by default under `$HOME/Downloads/Whats-Proxy/<active-account-phone>/`, keeping
each account's received media separate. Pass `output_dir` to use another directory; absolute paths
and `~/` paths are supported.

## Pairing lifecycle

`admin auth login` stores credentials in a private per-account state directory (`0700`) and exits
after pairing. Add `--start-service` to immediately enable and start that account's persistent
daemon; without it, the first `do` command can still auto-spawn a daemon on demand.

## Raw Baileys + Store API

`do raw` is an always-HITL atomic gateway with exactly two protocols: `baileys` and `store`.
`baileys/socket` invokes any callable live `WASocket` method, including `query`; `baileys/module`
invokes any callable Baileys export. `store/method` invokes any Store method; `store/sql` executes
one arbitrary SQLite statement. There is no `do`, filesystem, runtime, or flow protocol: agents
compose unlimited successive raw calls and use their normal shell for files and result transformation.
Use `{"$base64":"..."}` for binary inputs; binary or stream results are returned as base64.

```bash
whats-proxy do raw '{"protocol":"baileys","target":"socket","method":"sendMessage","args":["33612345678@s.whatsapp.net",{"text":"Raw API call"}]}'
whats-proxy do raw '{"protocol":"store","target":"sql","sql":"SELECT id, timestamp FROM messages LIMIT ?","params":[20]}'
```

## Development

```bash
bun install
make check       # tsc --noEmit + bun test + smoke (isolated state)
make test        # unit tests only
make smoke       # end-to-end: spawn daemon, RPC, CLI catalog
make stress      # race test: N simultaneous daemon spawns → exactly 1 survives
```

### Publish (requires with-env)

```bash
with-env make publish   # sources NPM_TOKEN from .agents/.env, configures npm auth, publishes
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
├── logger.ts       # stderr-only logger (stdout stays pure JSON)
├── display.ts      # print_json / print_table / output_result
├── doc.ts          # compact help, per-action help
├── version.ts      # reads version from package.json (single source)
├── exceptions.ts   # WhatsProxyError hierarchy
├── types.ts        # ActionDef, ActionContext, Output envelope
├── hitl.ts         # local editable review page; port 0, 600-second fail-closed timeout
├── actions/        # 15 category modules + registry.ts + policies.ts (68 actions)
└── admin/          # auth/ (login, status, logout, use) + daemon/ (status, stop, restart, logs, refresh)
```

## Contract

[`CONTRACT.md`](CONTRACT.md) is the authoritative implementation contract — safety, envelope, daemon lifecycle, configuration, and catalog surface.

## License

MIT
