# whats-proxy — Architecture Contract

> **Status:** 🟢 **IMPLEMENTED — 65 actions.** This document is the authoritative architecture
> contract for `whats-proxy`, the non-MCP WhatsApp CLI built on the ADN of `tick-proxy`
> (`$HOME/KpihX-Labs/tick_proxy/`) with Baileys as the WhatsApp engine.

---

## Mission

Complete rewrite of the MCP `whats-mcp` (`$HOME/Work/AI/MCPs/whats_mcp`) into a non-MCP CLI proxy that
follows **exactly** the `tick-proxy` model (`$HOME/KpihX-Labs/tick_proxy/`), adapted for WhatsApp's
unique requirement: a **persistent daemon** owning a Baileys socket and local Store.

- **Single binary, two namespaces** — `whats-proxy do <action>` (RPC) + `whats-proxy admin <action>` (always JSON)
- **Flat kebab-case actions** — ONE level after `do`, pure JSON-RPC, payload inline or file
- **`meta` + `data` envelope** — every response, always
- **Docstring-driven `--help`** — the docstring IS the documentation (single source of truth)
- **HITL web UI** — destructive and send-touching operations require human approval
- **Autosave** — every `do` execution snapshots to `/tmp/whats-proxy-autosave/`
- **TypeScript + Zod + Bun toolchain + Node.js runtime** — Bun owns install/test/build, Node.js runs Baileys
- **Daemon** — Baileys requires persistent socket + Store; `O_CREAT|O_EXCL` lockfile for single-owner arbitration
- **NO Docker** — explicitly excluded (same as `tick-proxy`)

**Location:** `$HOME/KpihX-Labs/whats_proxy/` — sibling of `tick_proxy/`.

---

## Mantras

- **0 Hardcoding · 100% Flexibility** — no hardcoded URLs, no hardcoded phone numbers; every
  configurable value lives as a documented default in `config.ts`, overridable via env.
- **0 Magic · 100% Transparency** — every Baileys call is explicit; the daemon is visible via
  `admin status`; HITL review payloads are full JSON; no hidden retry loops or silent drops.
- **0 Trust · 100% Control** — session state protected (never deleted by CLI); HITL mandatory on
  all sends; destructive actions preflight then pass through HITL with identity fields locked.
- **Stateful persistence** — daemon owns the session lifecycle; the Store is the local source of
  truth for WhatsApp history; auth is session files, not env secrets.

---

## Design — Single Binary, Namespaced CLI

```
whats-proxy
   │
   ├── admin <action>                       # ALWAYS JSON — auth + daemon lifecycle
   │   ├── setup                            # QR or code pairing → Baileys session
   │   ├── status                           # daemon state, socket, session age, Store stats
   │   └── stop                             # graceful shutdown, persist Store, keep auth
   │
   └── do <action> [payload|file] [--output-file/-o] [--format/-f] [--help/-h]
                                            # RPC — 65 flat actions, JSON payload (inline or file)
```

### `whats-proxy admin` — Admin (ALWAYS JSON to stdout — hardcoded, no `--format`)

| Command | Role | Output | HITL | Backend |
|---------|------|--------|:----:|---------|
| `whats-proxy admin setup` | First-time / re-pair: QR code or phone-number pairing code. Auto-starts daemon if not running. On 515 restartRequired: reconnect with fresh creds. | JSON (final) | ✅ (QR scan or code entry on phone) | Baileys pairing |
| `whats-proxy admin status` | Daemon state: running/stopped, PID, socket path, session age, Store message count, idle timeout remaining, Baileys connection state | JSON | ❌ | daemon probe |
| `whats-proxy admin stop` | Graceful shutdown: flush Store to disk, close Baileys socket, remove lockfile. Auth (`state/`) preserved. | JSON | ❌ | daemon signal |

**`admin setup` is the sole pairing entry point.** Unlike `tick-proxy`'s credential form,
WhatsApp pairing is inherently interactive (QR scan or code entry on the phone). The command:

1. Starts the daemon if not already running.
2. Requests a QR code or pairing code from Baileys.
3. Displays the QR in terminal (via `qrcode-terminal`) or prints the pairing code.
4. User scans QR or enters code on their WhatsApp phone.
5. WhatsApp sends 515 (`restartRequired`) — the socket dies.
6. **Critical:** `admin setup` reconnects with fresh creds via the reusable `connect()` function
   (see **Pairing lifecycle** below). One-shot Baileys means the original socket is dead; a new
   `connect()` call is mandatory.
7. On success → `pair-success` event → `open` event → daemon is ready.
8. Exit 0 with session info (masked JID, device info, Store path).

**Admin never accepts `--format` or `--output-file`** — passing either exits **2** with an error envelope.

### `do` — RPC Actions (JSON default, table via `--format/-f`)

**Meta options (ONLY for `do`, every `--` has its `-`):**

| Option | Role |
|--------|------|
| `--output-file <path>` / `-o <path>` | Write the full envelope to a file (path required) |
| `--format json\|table` / `-f json\|table` | Display format (default: `json`) |
| `--help` / `-h` | Full docstring + Zod payload schema for that action |
| *(positional)* `payload` | Inline JSON `'{"k":"v"}'` **or** a file path `./payload.json` |

**Output envelope — EVERY response:**

```json
{
  "meta": {
    "status": "ok",
    "comment": "",
    "edited": false
  },
  "data": { }
}
```

| `meta` field | Values | Meaning |
|--------------|--------|---------|
| `status` | `ok` · `approved` · `rejected` · `error` | `approved`/`rejected` only when HITL was involved |
| `comment` | free text | the HITL reviewer's comment (empty if none) |
| `edited` | `true` · `false` | the HITL reviewer modified the payload before approving |
| `verification` | — | never present in `meta` |

**Pre-check (ALL `do` commands):** daemon must be running (socket reachable). If not, `do`
auto-starts the daemon. If no session exists (`state/creds.json` missing), returns an error
envelope with hint `whats-proxy admin setup`.

**Autosave:** every `do` execution writes `/tmp/whats-proxy-autosave/{action}_{YYYYmmdd_HHMMSS}.json`.
When `-o` is given, the file path is printed instead of the autosave path (both are always written).

---

## Actions — FLAT, ONE level after `do` (65 actions)

Naming convention (inherited from `tick-proxy` / `tg-proxy`): **`<domain>-<verb>`, kebab-case,
domain FIRST.** All `whats-mcp` `verb_noun` names are flipped.

### Messaging — write (14)

| Action | Source tool (`whats-mcp`) | Auth | HITL | Notes |
|--------|---------------------------|:----:|:----:|-------|
| `send-text` | `send_message` | WS | ✅ | mandatory approval; text only, no media |
| `send-image` | `send_image` | WS | ✅ | mandatory approval; base64 or file path in payload |
| `send-video` | `send_video` | WS | ✅ | mandatory approval; base64 or file path |
| `send-audio` | `send_audio` | WS | ✅ | mandatory approval; PTT (push-to-talk) optional |
| `send-document` | `send_document` | WS | ✅ | mandatory approval; filename required |
| `send-sticker` | `send_sticker` | WS | ✅ | mandatory approval; WebP input |
| `send-location` | `send_location` | WS | ✅ | mandatory approval; lat + lng required |
| `send-contact` | `send_contact` | WS | ✅ | mandatory approval; vCard string |
| `send-reaction` | `send_reaction` | WS | ✅ | mandatory approval; message_id required |
| `send-poll` | `send_poll` | WS | ✅ | mandatory approval; name + options[] required |
| `edit-message` | `edit_message` | WS | ✅ | mandatory approval; message_id + new text |
| `delete-message` | `delete_message` | WS | ✅ | **preflight + lockIdentity** (jid, message_id); irreversible |
| `forward-message` | `forward_message` | WS | ✅ | mandatory approval; source + targetjid |
| `batch-send-text` | `batch_send_message` | WS | ✅ | mandatory approval; jid[] + text; one HITL review for the batch |

### Chats (5)

| Action | Source tool | Auth | HITL | Notes |
|--------|-------------|:----:|:----:|-------|
| `chat-list` | `list_chats` | Store | ❌ | read-only; paginated |
| `chat-read` | `read_chat` | WS | ❌ | marks chat as read |
| `chat-manage` | `manage_chat` | WS | ✅ | **preflight** on dangerous ops (archive, pin, mute, delete); approval only on dangerous |
| `chat-star` | `star_chat` | WS | ✅ | mandatory approval; star/unstar toggle |
| `chat-disappearing` | `set_disappearing` | WS | ✅ | mandatory approval; timer setting (24h/7d/90d/off) |

### Contacts (7)

| Action | Source tool | Auth | HITL | Notes |
|--------|-------------|:----:|:----:|-------|
| `contact-list` | `list_contacts` | Store | ❌ | read-only |
| `contact-info` | `get_contact` | Store | ❌ | read-only; JID required |
| `contact-check` | `check_exists` | WS | ❌ | on-demand existence check via Baileys |
| `contact-block` | `block_contact` | WS | ⚠️ | **conditional** approval; dangerous side-effect |
| `contact-business` | `get_business` | Store | ❌ | read-only; BIZ profile from Store |
| `contact-picture` | `get_picture` | WS | ❌ | fetches profile picture URL |
| `contact-tags` | `manage_tags` | Local | ⚠️ | **verification**; local Store write — mutates collection |

### Groups (10)

| Action | Source tool | Auth | HITL | Notes |
|--------|-------------|:----:|:----:|-------|
| `group-list` | `list_groups` | Store | ❌ | read-only |
| `group-info` | `get_group` | Store | ❌ | read-only; JID required |
| `group-create` | `create_group` | WS | ✅ | mandatory approval; name + participants[] |
| `group-subject` | `set_subject` | WS | ✅ | mandatory approval; new subject text |
| `group-description` | `set_description` | WS | ✅ | mandatory approval; new description |
| `group-participants` | `manage_participants` | WS | ✅ | mandatory approval; add/remove/promote/demote |
| `group-invite` | `get_invite` | WS | ✅ | **preflight** on revoke (jid); approval always |
| `group-leave` | `leave_group` | WS | ✅ | **preflight + lockIdentity** (jid); irreversible |
| `group-settings` | `set_settings` | WS | ✅ | mandatory approval; admin-only, ephemeral, etc. |
| `group-picture` | `set_picture` | WS | ✅ | mandatory approval; image upload |

### Channels (6)

| Action | Source tool | Auth | HITL | Notes |
|--------|-------------|:----:|:----:|-------|
| `channel-list` | `list_channels` | Store | ❌ | read-only |
| `channel-info` | `get_channel` | Store | ❌ | read-only |
| `channel-create` | `create_channel` | WS | ✅ | mandatory approval; name + description |
| `channel-update` | `update_channel` | WS | ✅ | mandatory approval; name/description update |
| `channel-manage` | `manage_channel` | WS | ✅ | **preflight** on destructive ops |
| `channel-delete` | `delete_channel` | WS | ✅ | **preflight + lockIdentity** (jid); irreversible |

### Labels (3)

| Action | Source tool | Auth | HITL | Notes |
|--------|-------------|:----:|:----:|-------|
| `label-chat` | `label_chat` | WS | ❌ | attach/detach label to chat |
| `label-manage` | `manage_label` | WS | ⚠️ | **conditional** approval; delete requires preflight |
| `label-message` | `label_message` | WS | ❌ | attach/detach label to message |

### Profile (4)

| Action | Source tool | Auth | HITL | Notes |
|--------|-------------|:----:|:----:|-------|
| `profile-about` | `get_about` | Store | ❌ | read-only |
| `profile-name` | `set_name` | WS | ❌ | display name change |
| `profile-picture` | `set_picture` | WS | ❌ | profile picture upload |
| `profile-privacy` | `set_privacy` | WS | ⚠️ | **conditional** approval; who sees last seen/about/photo |

### Overview (5)

| Action | Source tool | Auth | HITL | Notes |
|--------|-------------|:----:|:----:|-------|
| `whatsup` | `get_whatsup` | Store | ❌ | quick status summary |
| `find-messages` | `find_messages` | Store | ❌ | search messages by text/jid/date |
| `messages-multi` | `get_messages_multi` | Store | ❌ | fetch messages from multiple chats |
| `daily-digest` | `daily_digest` | Store | ❌ | aggregated daily summary |
| `watchlist` | `manage_watchlist` | Local | ⚠️ | **verification** + **preflight** on delete; local collection |

### Analytics (5)

| Action | Source tool | Auth | HITL | Notes |
|--------|-------------|:----:|:----:|-------|
| `analytics-overview` | `analytics_overview` | Store | ❌ | message/volume stats |
| `analytics-top-chats` | `analytics_top_chats` | Store | ❌ | most active chats |
| `analytics-chat-insights` | `analytics_chat_insights` | Store | ❌ | per-chat detail |
| `analytics-timeline` | `analytics_timeline` | Store | ❌ | activity over time |
| `analytics-search` | `analytics_search` | Store | ❌ | search across analytics |

### Utilities (7)

| Action | Source tool | Auth | HITL | Notes |
|--------|-------------|:----:|:----:|-------|
| `connection-status` | `connection_status` | Daemon | ❌ | Baileys connection state + latency |
| `guide` | `whatsapp_guide` | — | ❌ | folded into `do --help` (docstrings = guide) |
| `read-messages` | `read_messages` | WS | ⚠️ | **conditional** approval; bulk read |
| `search-messages` | `search_messages` | Store | ❌ | text search across Store |
| `media-download` | `download_media` | WS | ⚠️ | **conditional** approval; file write to disk |
| `media-cleanup` | `cleanup_media` | Local | ⚠️ | **conditional** approval; deletes local media cache |
| `presence` | `set_presence` | WS | ⚠️ | **conditional** approval; typing/recording/broadcast |

### Action count

| Group | Count |
|-------|------:|
| Messaging — write | 14 |
| Chats | 5 |
| Contacts | 7 |
| Groups | 10 |
| Channels | 6 |
| Labels | 3 |
| Profile | 4 |
| Overview | 5 |
| Analytics | 5 |
| Utilities | 7 |
| **TOTAL `do` actions** | **65** |

**Coverage proof — all 65 `whats-mcp` tools accounted for:**

| Fate | Count | Detail |
|------|------:|--------|
| Renamed 1:1 → `do` action | 65 | domain-first kebab rename |
| Folded into `do --help` | 1 | `whatsapp_guide` — docstrings are the single source of truth |
| Folded into `admin status` | 1 | connection status (daemon probe) |
| **Merged into an existing action** | 0 | — |
| **Dropped** | 0 | — |
| **Total consumed** | **65** | ✅ zero gaps |
| **New** | +0 | — |
| **Result** | **65** | `65 + 0` |

---

## Safety Model

`src/whats_proxy/actions/policies.ts` is the **single, executable safety contract**. The registry
applies each policy before exposing its handler; callers cannot bypass it with a CLI flag.

| Protection | Mechanism | Applies to |
|---|---|---|
| **Approval** | Local editable browser review, port `0`, 600-second fail-closed timeout | every send/edit, profile/group/channel mutation, contact blocking, business label mutation, media cleanup, and other consequential action |
| **Preflight** | Read the local Store or WhatsApp resource before review, then lock declared identity fields | message deletion, destructive chat management, watchlist deletion, group leave/invite revocation, channel deletion, label deletion |
| **Verification** | Post-write local Store read-back at `data.verification` | contact-tag and watchlist policy writes |

**No verification decorator (unlike tick-proxy):** WhatsApp writes always succeed or fail with an
error from Baileys — there is no silent-drop like TickTick's "200 OK but not saved". The
`@require_verification` pattern is therefore unnecessary; verification is limited to local Store
writes (`contact-tags`, `watchlist`) where a read-back confirms the local state mutation landed.

### HITL classification

| HITL Level | Count | Actions |
|------------|------:|---------|
| **approval: always** | 28 | send-text, send-image, send-video, send-audio, send-document, send-sticker, send-location, send-contact, send-reaction, send-poll, edit-message, delete-message, forward-message, batch-send-text, chat-manage (dangerous), chat-star, chat-disappearing, group-create, group-subject, group-description, group-participants, group-leave, group-settings, group-picture, channel-create, channel-manage, channel-update, channel-delete |
| **approval: conditional** | 10 | contact-block (dangerous), group-invite (revoke), label-manage (delete), profile-privacy (set), contact-tags (mutates collection), watchlist (mutates collection), presence, read-messages, media-download, media-cleanup |
| **approval: never** | 27 | chat-list, chat-read, contact-list, contact-info, contact-check, contact-business, group-list, group-info, channel-info, daily-digest, whatsup, find-messages, messages-multi, analytics-overview, analytics-top-chats, analytics-chat-insights, analytics-timeline, analytics-search, profile-about, profile-name, connection-status, guide, search-messages, label-chat, label-message, contact-picture, store-stats |

### Preflight + lockIdentity targets

| Action | Preflight reads | Identity fields locked |
|--------|----------------|----------------------|
| `delete-message` | Store (message exists?) | `jid`, `message_id` |
| `chat-manage` | Store (chat exists?) | `jid` (dangerous ops only) |
| `group-leave` | WhatsApp (group exists?) | `jid` |
| `group-invite` (revoke) | WhatsApp (invite exists?) | `jid` |
| `channel-delete` | WhatsApp (channel exists?) | `jid` |
| `label-manage` (delete) | Store (label exists?) | `label_id` |
| `watchlist` (delete) | Local Store (entry exists?) | `name` |

### HITL lifecycle

1. Daemon validates and preflights the proposed payload.
2. A local HTTP server binds directly to `127.0.0.1:0`; the actual OS port is printed to stderr and
   opened with `xdg-open` when available.
3. The reviewer may edit the complete JSON, approve, or reject with a comment.
4. Locked preflight identities are compared after review, then the action executes once.
5. Approved outputs carry `meta.status:"approved"`, comment, and edit state. No `meta.review` wrapper
   exists. Required verification appears only under `data.verification`.

**If no browser is available:** the URL is printed with an `ssh -L` hint. Timeout 600 s → automatic
`rejected`. HITL-required actions: 28 always-approval + 10 conditional = 38 total (of 65).

---

## Daemon Architecture

Unlike stateless TickTick REST calls, Baileys needs a durable socket and local Store:

```text
CLI do/admin ── JSON-RPC over Unix socket ── daemon
                                             ├── Baileys session (persistent socket)
                                             ├── Store (WhatsApp history snapshot)
                                             ├── 65-action registry + safety policies
                                             ├── Zod validation (CLI pre-daemon + daemon-side)
                                             └── O_EXCL lock + socket-first ownership
```

### Daemon lifecycle

| Aspect | Detail |
|--------|--------|
| **Binary** | `bin/whats-proxy.mjs` — Node.js + `tsx` launcher (Bun lacks `ws` upgrade events) |
| **Socket** | `~/.config/whats-proxy/whats-proxy.sock` — JSON-RPC over Unix domain socket |
| **Lockfile** | `O_CREAT\|O_EXCL` — kernel-atomic, exactly one winner |
| **Ownership** | Lock → bind socket → write PID → release lock. Losers exit. |
| **Idle exit** | Configurable via `WHATS_PROXY_MAX_IDLE_MINUTES` (default 30). `ping` does NOT count as activity. |
| **Store** | Persisted as JSON snapshot; flushed on `admin stop` and periodically |
| **Auto-start** | `do` auto-starts daemon if not running. `admin status` never starts it. |
| **State dir** | `~/.config/whats-proxy/state/` — creds.json + session files. **NEVER deleted by CLI.** |

### Runtime split — Bun vs Node.js

| Layer | Runtime | Why |
|-------|---------|-----|
| Install, typecheck, test, smoke, stress, package | **Bun** | fast toolchain, `bun test`, `bun link` |
| Production CLI + Baileys daemon | **Node.js + tsx** | Baileys requires `ws` upgrade events (Bun 1.3.11 lacks them) |
| `bin/whats-proxy.mjs` | **Node.js** | bridges the gap: `tsx` runs TypeScript under Node.js |

### Daemon autostart flow

```
whats-proxy do send-text ...
  │
  ├── Is daemon running? (socket probe)
  │   ├── YES → send JSON-RPC → receive response
  │   └── NO  → spawn daemon (Node.js + bin/whats-proxy.mjs)
  │             ├── acquire O_EXCL lock (fail → exit 1)
  │             ├── bind Unix socket
  │             ├── start Baileys (if session exists)
  │             ├── send JSON-RPC → receive response
  │             └── idle exit after configured minutes
```

---

## Pairing Lifecycle — QR and Code Flows

WhatsApp pairing is inherently interactive (unlike TickTick credential entry). The critical gotcha:
**Baileys is one-shot** — after QR scan or code entry, WhatsApp sends 515 (`restartRequired`),
killing the socket. A fresh `connect()` call is mandatory.

### QR flow

```
whats-proxy admin setup
  │
  ├── 1. Start daemon (if not running)
  ├── 2. Request QR from Baileys (sock.ev.on('connection.update'))
  ├── 3. Display QR in terminal (qrcode-terminal)
  ├── 4. User scans QR on WhatsApp phone
  ├── 5. WhatsApp sends 515 (restartRequired) → socket dies
  ├── 6. CRITICAL: extract socket creation into reusable connect()
  │      sock.end(undefined) → connect() again → fresh creds
  ├── 7. pair-success event → open event → daemon ready
  └── 8. Exit 0 with session info
```

### Code flow

```
whats-proxy admin setup --code --phone 33600000000
  │
  ├── 1. Start daemon (if not running)
  ├── 2. Request pairing code from Baileys (sock.requestPairingCode)
  ├── 3. Display 8-digit code in terminal
  ├── 4. User enters code on WhatsApp phone (Settings → Linked Devices)
  ├── 5. WhatsApp sends 515 (restartRequired) → socket dies
  ├── 6. CRITICAL: connect() again → fresh creds
  ├── 7. pair-success → open → daemon ready
  └── 8. Exit 0
```

### 515 reconnect fix (critical)

The original `admin setup` was NOT reconnecting on 515 — it received the disconnect, but the
socket was dead and no new `connect()` was called. Fixed by:

1. Extracting socket creation into a **re-usable `connect()` function** (not one-shot).
2. On 515: `sock.end(undefined)` → `connect()` with fresh credentials.
3. The `connect()` function handles auth state, event binding, and Store synchronization.

Without this fix, pairing always fails — the user scans the QR, sees the phone confirm linkage,
but the daemon is dead.

### Baileys fork

`whats-proxy` uses `ayusc/Baileys` (not the npm `@whiskeysockets/baileys`), which merges three
critical upstream PRs:

| PR | Issue | Fix |
|----|-------|-----|
| [#2608](https://github.com/WhiskeySockets/Baileys/pull/2608) | Empty `link_code` ack crashes | Proper handling of empty pairing code acknowledgment |
| [#2749](https://github.com/WhiskeySockets/Baileys/pull/2749) | Pre-login ack crash | Guard against undefined ack in pre-login state |
| [#2765](https://github.com/WhiskeySockets/Baileys/pull/2765) | `companion_reg_refresh` handler missing | Handles device companion registration refresh |

These PRs are required for reliable pairing. Using upstream Baileys without these patches causes
crashes during QR flow, code flow, and session refresh.

---

## Configuration

**No `.env` file by default.** Defaults live in `config.ts`. Two env overrides exist for
operational needs:

| Env Var | Purpose | Default |
|---------|---------|---------|
| `WHATS_PROXY_STATE_DIR` | Override state directory (test isolation) | `~/.config/whats-proxy/state/` |
| `WHATS_PROXY_MAX_IDLE_MINUTES` | Daemon idle exit timeout | `30` |
| `WHATS_PROXY_NO_BROWSER` | Test-only: suppresses `xdg-open` in HITL | `false` |

**Config directory layout:**

```
~/.config/whats-proxy/
├── state/                # Baileys auth — creds.json + session files (NEVER deleted by CLI)
├── whats-proxy.sock      # Unix socket (daemon-owned)
└── whats-proxy.lock      # O_EXCL lockfile (daemon-owned)
```

**No log file** — like `tick-proxy`, logs go to stderr only (systemd/journald captures them).
`logger.ts` is a pure stderr logger, no file, no rotation.

**Env-var prefix:** `WHATS_*`, harmonizing with `tick-proxy`'s `TICK_*` and `tg-proxy`'s `TG_*`.

---

## Zod Validation

Every action has a Zod schema in `actions/schemas.ts` (65 schemas). Validation runs at two points:

| Gate | Location | Purpose |
|------|----------|---------|
| CLI pre-daemon | `cli.ts` | fail-fast before JSON-RPC: required args + type checks |
| Daemon-side | `protectAction` in `policies.ts` | defense-in-depth: same validation on the server side |

**Validation order:** `validateRequiredArguments` first (checks presence of mandatory fields),
then Zod type validation (coercion, enums, refinements).

```typescript
// actions/schemas.ts — one schema per action, colocated with its ActionDef
export const SendTextSchema = z.object({
  jid: z.string().describe('Recipient JID (phone@s.whatsapp.net or group@g.us)'),
  text: z.string().min(1).describe('Message text'),
});
```

**Anti-bypass:** `make smoke` (registry integrity) checks — at startup, via AST — that every
action declaring a schema has a matching entry in `schemas.ts`. A missing schema is a **hard error**.

---

## Architecture Diagram

```
whats-proxy
   │
   ├── admin setup|status|stop               # ALWAYS JSON
   └── do <action> [payload|file] [-o] [-f]  # 65 flat RPC actions
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│  src/whats_proxy/                                               │
│  ├── cli.ts              ONE binary: do/admin/hidden daemon      │
│  │                       (thin — parse, dispatch, envelope, exit)│
│  ├── client.ts           WaClient — JSON-RPC over Unix socket   │
│  ├── daemon.ts           Baileys owner — socket + Store lifecycle│
│  ├── store.ts            Synchronized local WhatsApp state      │
│  ├── config.ts           defaults + one .env override surface   │
│  ├── helpers.ts          shared utilities                        │
│  ├── display.ts          output helpers: print_json / print_table│
│  ├── doc.ts              dynamic --help injection from docstrings│
│  ├── logger.ts           stderr logger — no file                 │
│  ├── version.ts          version from package.json               │
│  ├── exceptions.ts       WhatsProxyError                         │
│  ├── types.ts            shared type definitions                 │
│  ├── hitl.ts             HITL web UI (free port, browser auto)   │
│  │                                                              │
│  ├── actions/            THE 65 ACTIONS                           │
│  │   ├── registry.ts     name → ActionDef map, duplicate = error │
│  │   ├── policies.ts     approval/preflight/verification truth   │
│  │   ├── schemas.ts      65 Zod schemas (one per action)         │
│  │   ├── messaging.ts    send-* · edit-message · delete-message  │
│  │   │                   · forward-message · batch-send-text     │
│  │   ├── chats.ts        chat-*                                   │
│  │   ├── contacts.ts     contact-*                                │
│  │   ├── groups.ts       group-*                                  │
│  │   ├── channels.ts     channel-*                                │
│  │   ├── labels.ts       label-*                                  │
│  │   ├── profile.ts      profile-*                                │
│  │   ├── overview.ts     whatsup · find-messages · messages-multi│
│  │   │                   · daily-digest · watchlist               │
│  │   ├── analytics.ts    analytics-*                              │
│  │   └── utilities.ts    connection-status · guide · read-messages│
│  │                       · search-messages · media-download ·    │
│  │                       media-cleanup · presence                 │
│  │                                                              │
│  └── admin/              setup · status · stop                   │
│                        SINGLE SOURCE OF TRUTH for admin logic    │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│  bin/whats-proxy.mjs         Node.js + tsx launcher              │
│  ~/.config/whats-proxy/      state/ + socket + lockfile           │
│  /tmp/whats-proxy-autosave/  action snapshots                    │
└─────────────────────────────────────────────────────────────────┘
```

### Why a daemon instead of `tick-proxy`'s stateless model

`tick-proxy` is stateless: every `do` call is an independent HTTP request to TickTick's REST API.
`whats-proxy` cannot be stateless because:

1. **Baileys requires a persistent socket** — WhatsApp maintains a long-lived WebSocket connection
   with encryption state. Killing and restarting it for every action is expensive and unreliable.
2. **The Store is local** — WhatsApp message history lives in a Baileys-managed in-memory Store
   that is periodically snapshotted to disk. The Store is the read source for all Store-backed actions.
3. **Auth is session files** — `creds.json` and session files are Baileys' auth state. They must
   persist across daemon restarts but cannot be re-created from a token like TickTick's session cookie.

The daemon owns the full lifecycle: lock → bind socket → start Baileys → serve RPC → flush Store → exit.

### Why `bin/whats-proxy.mjs` instead of a direct `bun` run

Bun 1.3.11 lacks the `ws` upgrade events that Baileys requires for its WebSocket handshake. The
production CLI uses **Node.js + tsx** to run the TypeScript source directly, while Bun remains the
toolchain for install, typecheck, tests, and packaging. `bin/whats-proxy.mjs` is the bridge:
it spawns `tsx` under Node.js with the correct module resolution.

---

## Error Model

| Case | Behavior | Exit |
|------|----------|-----:|
| Success | `{"meta":{"status":"ok",…},"data":…}` | 0 |
| HITL approved | `meta.status = "approved"` | 0 |
| HITL rejected / timeout | `meta.status = "rejected"`, `data = null` | 1 |
| Daemon not running + auto-start fails | error envelope | 1 |
| No session (`state/creds.json` missing) | error envelope + hint `whats-proxy admin setup` | 1 |
| Baileys error (send failed, group not found, etc.) | error envelope with Baileys error message | 1 |
| Invalid JSON / file not found | `WhatsProxyError` envelope | 1 |
| Zod validation error | error envelope listing offending fields | 1 |
| Rate limit / WhatsApp throttle | error envelope, no auto-retry (explicit, no magic) | 1 |
| Lock contention (daemon already running) | error envelope naming the existing PID | 1 |
| `admin` + `--format`/`-o` | misuse error envelope | 2 |

**stdout is pure JSON.** All logs, HITL prompts, daemon notices and progress go to **stderr** — a piped
`whats-proxy do … \| jq` must never break.

---

## What Differs from tick-proxy

| Aspect | tick-proxy | whats-proxy |
|--------|-----------|-------------|
| **Transport** | Stateless REST (V1 + V2 HTTP) | Persistent Baileys WebSocket daemon |
| **Daemon** | None (stateless) | `O_CREAT\|O_EXCL` lock, Unix socket, idle exit |
| **Store** | Server-side (TickTick owns data) | Local Baileys Store (JSON snapshot) |
| **Runtime** | Python (Typer + Pydantic + httpx) | TypeScript (Zod + Bun toolchain + Node.js runtime) |
| **Pairing** | `.env` tokens via HITL form | QR/code + 515 reconnect lifecycle |
| **Config** | `.env` file with secrets | No `.env` (defaults in config.ts; auth = session files) |
| **Secrets** | API token + session token in `.env` | None — auth is `state/` directory |
| **Verification decorator** | `@require_verification` (TickTick silent-drop) | Not needed (WhatsApp fails loud) |
| **Verification scope** | 4 always-on + 2 conditional | 2 actions (`contact-tags`, `watchlist`) |
| **Preflight targets** | V1/V2 reads | Local Store + WhatsApp resource reads |
| **HITL scope** | 13 actions + 2 admin | 28 always + 10 conditional |
| **State directory** | N/A | `~/.config/whats-proxy/state/` (protected) |
| **Error behavior** | Same envelope | Same envelope |

---

## Porting Proof

**65/65 `whats-mcp` tools ported.** Every tool in `$HOME/Work/AI/MCPs/whats_mcp/src/tools/*.js`
is accounted for in the 65-action registry. The porting was verified at runtime — every action
name maps to a working handler backed by a Baileys operation or local Store read.

| Domain | whats-mcp tools | whats-proxy actions | Fate |
|--------|----------------:|-------------------:|------|
| Messaging | 14 | 14 | 1:1 rename |
| Chats | 5 | 5 | 1:1 rename |
| Contacts | 7 | 7 | 1:1 rename |
| Groups | 10 | 10 | 1:1 rename |
| Channels | 6 | 6 | 1:1 rename |
| Labels | 3 | 3 | 1:1 rename |
| Profile | 4 | 4 | 1:1 rename |
| Overview | 5 | 5 | 1:1 rename |
| Analytics | 5 | 5 | 1:1 rename |
| Utilities | 7 | 7 | 1:1 rename + `guide` folded into `do --help` |
| **TOTAL** | **65** | **65** | ✅ zero gaps |

**No tools were dropped, merged, or split.** The 1:1 mapping is possible because `whats-mcp` was
already well-structured (domain-grouped tools with clear inputs/outputs). The porting is a
rename (`send_message` → `send-text`) plus schema migration (JS object → Zod), not a redesign.

---

## Infrastructure

| File | Source | Note |
|------|--------|------|
| `package.json` | new | entry point `bin/whats-proxy.mjs`, dependencies: `@ayusc/baileys`, `zod`, `qrcode-terminal` |
| `Makefile` | `tick-proxy` | **minus** Docker, **plus** `stress` and `runtime-smoke` targets |
| `tsconfig.json` | new | strict TypeScript, ESM modules |
| `.gitignore` | `tick-proxy` | `state/` ignored, `.env` ignored |
| `.env.example` | this document | the three env vars documented above |
| `bin/whats-proxy.mjs` | new | Node.js + tsx launcher (bridges Bun toolchain → Node.js runtime) |
| `tests/` | new | bun test: helpers, store, display, policies, audit |
| `scripts/smoke.ts` | new | 50-check end-to-end smoke (CLI edge paths, spawn guard, hermetic sweep) |
| `scripts/stress.ts` | new | daemon race stress test (default 8 spawns, `make stress`) |
| `AGENTS.md` · `README.md` · `CHANGELOG.md` · `TODO.md` | standard | |

### Makefile targets

| Target | Action |
|--------|--------|
| `check` | `tsc --noEmit` + `bun test` + smoke |
| `test` | unit tests only |
| `smoke` | end-to-end isolated daemon smoke (50 checks) |
| `stress` | concurrent daemon ownership proof (8 spawns) |
| `runtime-smoke` | verify the installed Node.js execution path |
| `install` / `uninstall` | `bun link` global lifecycle |
| `git-push` / `push` | push to `github` **and** `gitlab` |

**Remotes:** `github: git@github.com:KpihX/whats-proxy.git` · `gitlab: git@gitlab.com:kpihx/whats-proxy.git`

---

## Quality Gates

| Gate | What it checks | Where |
|------|----------------|-------|
| `make check` | `tsc --noEmit` + `bun test` + isolated daemon smoke (50 checks) | CI + local |
| `make smoke` | 50 end-to-end checks: CLI edge paths, spawn guard, hermetic sweep, no real WhatsApp | local |
| `make stress` | 8 concurrent daemon spawns → exactly 1 winner (O_EXCL proof) | local |
| `make runtime-smoke` | Verify `bin/whats-proxy.mjs` runs under Node.js (not Bun) | local |
| Registry integrity | 65 actions, zero duplicates, every action has a Zod schema | `bun test` |
| Policy integrity | Every action in `policies.ts` maps to a registered action | `bun test` |
| HITL completeness | Every send/mutation action has HITL policy | `bun test` |

`scripts/live.ts` is deliberately outside `make check`: it requires an operator to pair a physical
WhatsApp device. Authentication failures are fail-closed; never invent a browser workaround.

---

## Decisions requiring KπX validation

| # | Decision | Proposal | Impact if refused |
|---|----------|----------|-------------------|
| **D1** | Runtime split | Bun = toolchain, Node.js = production Baileys (Bun lacks `ws` upgrade) | must use Bun only → Baileys broken |
| **D2** | Daemon model | persistent daemon with O_EXCL lock (Baileys requires long-lived socket) | stateless → session re-pairing every action |
| **D3** | Baileys fork | `ayusc/Baileys` (merges PRs #2608/#2749/#2765) | upstream Baileys crashes during pairing |
| **D4** | No .env file | defaults in `config.ts`, only 2 env overrides | must configure everything via `.env` |
| **D5** | No verification decorator | WhatsApp fails loud (unlike TickTick silent-drop) | add unnecessary verification overhead |
| **D6** | Pairing lifecycle | dedicated section documenting 515 reconnect gotcha | pairing bugs are the #1 support issue |
| **D7** | Env prefix | **`WHATS_*`** (harmonizes with `TICK_*` and `TG_*`) | any other prefix |
| **D8** | HITL scope | 28 always + 10 conditional = 38 of 65 actions | narrower policy would miss send safety |

---

## Status

- See `AGENTS.md` for the agent working context.
- See `TODO.md` for the live task list.
- See `CHANGELOG.md` for version history.
- See `README.md` for user-facing documentation.

*Architecture contract drafted 2026-08-31 — rewrite of `whats-mcp` (65 MCP tools) into
`whats-proxy` (65 RPC actions), modelled on `tick-proxy` v1.1.0 (52 RPC actions).*
