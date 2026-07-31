# whats-proxy — Architecture Contract

> **Status:** 🟡 DESIGN — Complete refonte of `whats-mcp` (MCP server) into a non-MCP CLI proxy, mirroring `tg-proxy` exactly in structure and interface.

---

## Mission

Refonte totale du MCP `whats-mcp` (`~/Work/AI/MCPs/whats_mcp`) suivant exactement le modèle non-MCP de `tg-proxy` (`~/KpihX-Labs/tg_proxy`):

- **CLI JSON-RPC 2.0** — `whats-proxy do <action> [payload|file] [--output-file/-o] [--format/-f json|table] [--help/-h]`
- **Namespaces `do` + `admin`** — `whats-proxy admin setup|status` (admin = toujours JSON, pas de `--format`)
- **Sortie `meta` + `data`** — every response has the envelope
- **Implémentation en Bun** (contrairement à tg-proxy qui est Python/uv/typer)
- **Écosystème préservé** — the 65 whats-mcp tools are preserved as flat `do` actions; `k-whatsapp` skill keeps working (CLI instead of MCP transport)

---

## Mantras

- **0 Hardcoding · 100% Flexibility:** No hardcoded paths, no hardcoded phone numbers, no per-env config.
- **0 Magic · 100% Transparency:** Every API call is explicit; state directory and config are visible and documented.
- **0 Trust · 100% Control:** The session/auth artifacts live in the user's state directory; the daemon is user-controlled.

---

## Design — Single Binary, Namespaced CLI (mirrors tg-proxy v2)

```
whats-proxy
   │
   ├── admin <action>                      # ALWAYS JSON — Baileys session lifecycle
   │   ├── setup                           # First-time auth: QR or pairing code (interactive)
   │   └── status                          # Connection status, account info, store stats
   │
   └── do <action> [payload|file] [--output-file/-o] [--format/-f] [--help/-h]
                                            # RPC — flat actions, JSON payload (inline or file)
```

### `whats-proxy admin` — Admin (ALWAYS JSON to stdout — hardcoded, no --format)

| Command | Role | Output | Interactive | Backend |
|---------|------|--------|:-----------:|---------|
| `whats-proxy admin setup` | First-time auth — QR in terminal OR pairing code via `--phone` | JSON (final) | ✅ | Baileys |
| `whats-proxy admin status` | Connection + account + store summary | JSON | ❌ | Baileys (fresh probe) |

### `whats-proxy do` — RPC Actions (JSON default, table via `--format/-f`)

**Meta options (ONLY for `do`, every `--` has its `-`):**
- `--output-file <path>` / `-o <path>` — redirect output (path required)
- `--format json|table` / `-f json|table` — display format (default: json)
- `--help` / `-h` — show help with full docstring + schema
- Payload (positional): inline JSON `'{"key":"val"}'` or file path `./payload.json`

**Output format — EVERY response has a `meta` section:**

```json
{
  "meta": {
    "status": "ok" | "error",
    "comment": "",
    "edited": false
  },
  "data": { ... }
}
```

**Pre-check (ALL `do` commands):** the daemon must be reachable. `whats-proxy do` auto-starts a detached daemon if none is running (transparent: logged, pidfile written, `admin status` reflects it). If auth is missing, the daemon refuses and `do` reports the error with a hint to run `admin setup`.

---

## Why a daemon? (WhatsApp ≠ Telegram)

`tg-proxy` is one-shot: every `do` opens a fresh Telethon session, queries, closes. Telegram has full server-side history, so one-shot reads are complete.

**WhatsApp (Baileys) is different:**
- The connection is a persistent WebSocket; the local **Store** is populated incrementally by live events (`chats.upsert`, `messages.upsert`, history sync).
- There is **no server-side history dump**: reads like `get_messages`/`whatsup`/`daily_digest`/`search_messages` only work against the accumulated local store.
- Reconnecting a fresh session per command would lose the store → reads would return empty. Not acceptable.

**Solution (transparent, documented, no magic):** `whats-proxy` runs a **background daemon** that owns the Baileys socket + Store. The `do` CLI is a thin **JSON-RPC 2.0 client** over a local Unix socket:

```
┌──────────────┐   JSON-RPC 2.0 (Unix socket)   ┌──────────────────────────┐
│  whats-proxy │ ──────────────────────────────▶ │  whats-proxy daemon      │
│  do <action> │                                 │  ├── Baileys socket       │
│  (client)    │ ◀────────────────────────────── │  ├── Store (analytics…)   │
└──────────────┘         response                │  └── action dispatcher    │
                                                └──────────────────────────┘
```

- `whats-proxy do` — if the daemon socket is alive → send JSON-RPC request → print `meta`+`data` → exit.
- `whats-proxy do` — if no daemon → **spawn a detached daemon** (`admin serve` in background), wait for readiness, then send the request.
- `whats-proxy admin status` — independent probe (short-lived socket OR daemon state) — always works, even when the daemon is down.
- Daemon lifecycle is fully transparent: pidfile + log in the state dir; `admin status` shows daemon state.

---

## Actions — FLAT, ONE level after `do` (65 actions — full whats-mcp catalog)

### Messaging (14)

| Action | Tool (whats-mcp) | Notes |
|--------|------------------|-------|
| `send-text` | `send_text` | jid + text + quoted_id + mentions |
| `send-image` | `send_image` | source: URL/base64/path + caption |
| `send-video` | `send_video` | + gif_playback, ptv |
| `send-audio` | `send_audio` | + ptt (voice note) |
| `send-document` | `send_document` | + filename, mimetype |
| `send-sticker` | `send_sticker` | WebP |
| `send-location` | `send_location` | lat/long + name/address |
| `send-contact` | `send_contact` | vCards array |
| `send-reaction` | `send_reaction` | emoji or empty to remove |
| `send-poll` | `send_poll` | question + options |
| `edit-message` | `edit_message` | jid + message_id + new_text |
| `delete-message` | `delete_message` | jid + message_id (+ from_me/participant) |
| `forward-message` | `forward_message` | to_jid + message_id |
| `batch-send-text` | `batch_send_text` | jids[] + text + delay_ms |

### Chats (5)

| Action | Tool | Notes |
|--------|------|-------|
| `chat-list` | `list_chats` | limit/offset/filter (all/groups/contacts/unread) |
| `chat-read` | `get_messages` | limit/before_id/fetch_history/since/until/types — pagination |
| `chat-manage` | `manage_chat` | archive/pin/mute/mark_read/delete/clear… |
| `chat-star` | `star_message` | star/unstar |
| `chat-disappearing` | `set_disappearing` | 0/86400/604800/7776000 |

### Contacts (6)

| Action | Tool | Notes |
|--------|------|-------|
| `contact-check` | `check_phone_number` | phones[] → on WhatsApp? |
| `contact-info` | `get_contact_info` | name/about/picture |
| `contact-picture` | `get_profile_picture` | jid or 'me' + type |
| `contact-block` | `manage_block` | block/unblock/list |
| `contact-business` | `get_business_profile` | business profile |
| `contact-list` | `list_contacts` | limit/offset/name/tag filters |

### Groups (10)

| Action | Tool | Notes |
|--------|------|-------|
| `group-create` | `create_group` | subject + participants[] |
| `group-info` | `get_group_info` | full metadata + history |
| `group-list` | `list_groups` | limit |
| `group-subject` | `update_group_subject` | rename |
| `group-description` | `update_group_description` | update/clear |
| `group-participants` | `manage_group_participants` | add/remove/promote/demote |
| `group-leave` | `leave_group` | leave |
| `group-invite` | `manage_group_invite` | get/revoke/join |
| `group-settings` | `update_group_settings` | announce/locked/ephemeral/… |
| `group-picture` | `set_group_picture` | source |

### Channels (5)

| Action | Tool | Notes |
|--------|------|-------|
| `channel-create` | `create_channel` | name + desc/picture |
| `channel-info` | `get_channel_info` | jid or invite link |
| `channel-manage` | `manage_channel` | follow/unfollow/mute/unmute |
| `channel-update` | `update_channel` | name/desc/picture/remove |
| `channel-delete` | `delete_channel` | irreversible |

### Labels (3)

| Action | Tool | Notes |
|--------|------|-------|
| `label-manage` | `manage_label` | create/edit/delete/list (Business only) |
| `label-chat` | `manage_chat_label` | add/remove chat label |
| `label-message` | `manage_message_label` | add/remove message label |

### Profile (4)

| Action | Tool | Notes |
|--------|------|-------|
| `profile-name` | `update_display_name` | max 25 chars |
| `profile-about` | `update_about` | max 139 chars |
| `profile-picture` | `update_profile_picture` | source or 'remove' |
| `profile-privacy` | `manage_privacy` | get/set settings |

### Analytics (5)

| Action | Tool | Notes |
|--------|------|-------|
| `analytics-overview` | `analytics_overview` | totals, top chats/tokens/senders, trends |
| `analytics-top-chats` | `analytics_top_chats` | sortable ranking |
| `analytics-chat-insights` | `analytics_chat_insights` | per-chat detail |
| `analytics-timeline` | `analytics_timeline` | daily activity |
| `analytics-search` | `analytics_search` | ranked search w/ time range |

### Digest / Overview (4)

| Action | Tool | Notes |
|--------|------|-------|
| `whatsup` | `whatsup` | daily overview, watchlist-first, needs-reply |
| `find-messages` | `find_messages` | smart semantic search w/ topic expansion |
| `messages-multi` | `get_messages_multi` | multi-chat read (jids[] or watchlist) |
| `daily-digest` | `daily_digest` | structured daily digest |

### Tags / Watchlists (2)

| Action | Tool | Notes |
|--------|------|-------|
| `contact-tags` | `manage_contact_tags` | set/add/remove/get/list/list_by_tag |
| `watchlist` | `manage_watchlist` | set/add/remove/get/list/delete |

### Utilities (7)

| Action | Tool | Notes |
|--------|------|-------|
| `connection-status` | `connection_status` | works even disconnected |
| `guide` | `whatsapp_guide` | category help |
| `presence` | `send_presence` | available/unavailable/composing/recording/paused |
| `read-messages` | `read_messages` | mark read (receipts) |
| `search-messages` | `search_messages` | local store search |
| `media-download` | `download_media` | save media to `$HOME/.cache/whats_media/` |
| `media-cleanup` | `cleanup_media` | clear media cache |

---

## Config — `~/.config/whats-proxy/`

```
~/.config/whats-proxy/
├── config.json     # non-sensitive settings (see below)
├── .env            # optional env overrides (WHATS_PROXY_STATE_DIR, WHATS_PROXY_LOG_LEVEL)
├── state/          # Baileys auth artifacts (creds.json, session files) — NEVER committed
├── store.json      # persistent Store snapshot (chats/contacts/messages/analytics)
├── whats-proxy.pid # daemon pidfile
├── whats-proxy.log # daemon + CLI log (rotating)
└── whats-proxy.sock # daemon Unix socket (JSON-RPC 2.0)
```

**config.json (defaults):**
```json
{
  "state_directory": "~/.config/whats-proxy",
  "connection": {
    "reconnect_interval_ms": 3000,
    "max_reconnect_attempts": 10,
    "mark_online_on_connect": false,
    "sync_full_history": true,
    "refresh_app_state": true
  },
  "store": {
    "max_messages_per_chat": 5000,
    "max_chats": 1000,
    "persist": true
  },
  "logging": {
    "level": "info"
  },
  "watchlists": {}
}
```

**No secrets in config.json.** WhatsApp auth is a session artifact (creds.json) inside `state/`, created by `admin setup`. The only "secret" is the state directory itself.

---

## Architecture

```
whats-proxy
   │
   ├── admin setup|status                    # Baileys auth + status (ALWAYS JSON)
   └── do <action> [payload] [-o file] [-f fmt]
       │
       ▼
┌──────────────────────────────────────┐
│  src/whats_proxy/                    │
│  ├── index.ts        # entry point   │
│  ├── cli.ts          # CLI dispatch  │
│  ├── client.ts       # WaClient — Baileys + 65 actions + raw
│  ├── store.ts        # persistent Store (analytics, watchlists)
│  ├── helpers.ts      # JID helpers, media resolution, formatting
│  ├── config.ts       # ~/.config/whats-proxy/config.json + env loader
│  ├── display.ts      # print_json / print_table (meta+data envelope)
│  ├── doc.ts          # dynamic --help injection (tg-proxy doc.py equivalent)
│  ├── exceptions.ts   # WhatsProxyError (ts_proxy style)
│  ├── logger.ts       # rotating file + stderr logger
│  ├── daemon.ts       # background daemon: socket + store + RPC dispatch
│  └── admin/          # setup (QR/pairing) + status
└──────────────────────────────────────┘
```

### Doc system (tg-proxy doc.py equivalent)

Each `WaClient` method has a **structured JSDoc** with mandatory sections:

```
Description of what this method does.
More detail about behavior, edge cases, and limitations.

Parameters:
    - param (type): Description.

Examples:
    - whats-proxy do send-text '{"jid":"33612345678","text":"Hello"}'
    - whats-proxy do send-text ./payload.json
    - whats-proxy do send-text '{"jid":"@g.us","text":"Hi"}' -o result.json -f table
```

`doc.ts` extracts these at import time and injects them into CLI help (tg-proxy `apply_dynamic_docs()` pattern). The JSON schema appears inline in `--help`.

**Result:** `whats-proxy do send-text --help` shows full docstring + exact payload schema — both **human-readable** and **agent-parseable**.

### Store persistence

- The Store mirrors whats-mcp `store.js` (chats, contacts, messages, analytics index, watchlists, contact tags).
- On daemon exit / SIGTERM → snapshot to `store.json`. On daemon start → load snapshot. Sessions survive restarts; `admin setup` re-auths only when creds are missing/expired.
- Analytics are rebuilt incrementally from events (same logic as whats-mcp `store.js`).

---

## Error model

| Case | Behavior |
|------|----------|
| Daemon not running | `do` spawns detached daemon, waits (≤30s), retries request once |
| Auth missing | `do`/`admin status` → `{"meta":{"status":"error"},"data":{"error":"..."}}` + hint `whats-proxy admin setup`, exit 1 |
| Invalid JSON / file not found | `WhatsProxyError` → same error envelope, exit 1 |
| Action validation error | Same error envelope listing missing/unknown fields, exit 1 |
| Action runtime error (Baileys) | Error envelope with Baileys message, exit 1 |
| `admin` commands | Never accept `--format`/`--output-file`; ignore-with-error if passed |

---

## Ecosystem preservation

- `k-whatsapp` skill procedure ("What's up" slice, open threads, group index, JIDs, closure hygiene) is **transport-agnostic** — it works against `whats-proxy do chat-read` etc. exactly as it did against MCP tools. The skill file itself does NOT need changes (it references tool behavior, and the CLI is a drop-in).
- JID conventions preserved: phone → `@s.whatsapp.net`, groups `@g.us`, channels `@newsletter`, `status@broadcast` skipped.
- Topic expansion map (FR/EN) from `overview.js` preserved inside `find-messages`.

---

## Deliverables

- [x] Full whats-mcp catalog extraction (65 tools + schemas)
- [x] CONTRACT.md (this file)
- [ ] `package.json` (bin: `whats-proxy`), `tsconfig.json`
- [ ] `src/whats_proxy/` — cli, client, store, helpers, config, display, doc, exceptions, logger, daemon, admin/
- [ ] `README.md`, `AGENTS.md`, `Makefile` (check/smoke/install/uninstall/git-push/release), `.env.example`, `scripts/install.sh`, `scripts/uninstall.sh`
- [ ] Tests (jest-style → bun:test) + smoke test
- [ ] Final verification: `admin setup` (QR), `admin status`, `do` against live daemon
