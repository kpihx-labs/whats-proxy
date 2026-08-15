# whats-proxy — Architecture Contract

> **Status:** 🟢 **IMPLEMENTED — 65 actions.** `../tick_proxy/` is the sole standard reference for
> proxy behavior. This contract defines its faithful Bun/Baileys adaptation where WhatsApp requires
> a persistent local daemon and Store.

## Mission

`whats-proxy` turns the complete `whats-mcp` catalogue into one local, non-MCP CLI:

```text
whats-proxy admin setup|status|stop       # always JSON
whats-proxy do <action> [payload|file]    # 65 flat kebab-case RPC actions
```

It preserves `tick-proxy` invariants: registry-only actions, pure JSON stdout, `meta` + `data`,
dynamic action help, autosave, no Docker, stderr diagnostics, structural HITL policy, preflighted
destructive writes, and explicit verification proofs. Bun owns package installation and testing;
Node.js runs the production CLI and Baileys daemon because Bun 1.3.11 lacks the `ws` upgrade events
required for a reliable WhatsApp handshake. A daemon remains necessary because WhatsApp history
lives in a continuously synchronized local Store.

## Non-negotiable invariants

1. **Registry only:** every action is one `ActionDef` in a category module and is aggregated once by
   `actions/registry.ts`. Duplicate names crash at import.
2. **Envelope always:** every response is
   `{"meta":{"status","comment","edited"},"data":…}`. Failures exit 1; CLI misuse exits 2.
3. **Stdout is machine-safe:** diagnostics, daemon notices, and HITL URLs use stderr. JSON is safe to
   pipe; table format is an explicit `do -f table` presentation option.
4. **One config surface:** optional environment overrides are in
   `$HOME/.config/whats-proxy/.env`. `config.ts` owns documented defaults; no `config.json` exists.
5. **No file logging:** diagnostics are stderr-only. There is no proxy log file or log-level setting.
6. **Daemon ownership:** `O_CREAT|O_EXCL` lockfile decides the single owner, which binds the Unix
   socket before connecting Baileys. Socket probing alone is never ownership arbitration.
7. **No credential deletion:** `state/` contains Baileys authentication and is never removed by the
   CLI. `admin stop` persists the Store but keeps authentication intact.

## Safety model

`src/whats_proxy/actions/policies.ts` is the single, executable safety contract. The registry applies
each policy before exposing its handler; callers cannot bypass it with a CLI flag.

| Protection | Mechanism | Applies to |
|---|---|---|
| **Approval** | Local editable browser review, port `0`, 600-second fail-closed timeout | every send/edit, profile/group/channel mutation, contact blocking, business label mutation, media cleanup, and other consequential action |
| **Preflight** | Read the local Store or WhatsApp resource before review, then lock declared identity fields | message deletion, destructive chat management, watchlist deletion, group leave/invite revocation, channel deletion, label deletion |
| **Verification** | Post-write local Store read-back at `data.verification` | contact-tag and watchlist policy writes |

For example, `delete-message` refuses to open HITL unless its `message_id` is in the local Store;
`group-leave`, `channel-delete`, and Business-label deletion first read their remote target. A reviewer
cannot change a preflighted identity such as `jid`, `message_id`, or `label_id`. A rejected or timed-out review returns
`meta.status:"rejected"`, `data:null`, and exit 1. An approved write that fails remains
`meta.status:"error"`; approval never masks a Baileys error.

## HITL lifecycle

1. Daemon validates and preflights the proposed payload.
2. A local HTTP server binds directly to `127.0.0.1:0`; the actual OS port is printed to stderr and
   opened with `xdg-open` when available.
3. The reviewer may edit the complete JSON, approve, or reject with a comment.
4. Locked preflight identities are compared after review, then the action executes once.
5. Approved outputs carry `meta.status:"approved"`, comment, and edit state. No `meta.review` wrapper
   exists. Required verification appears only under `data.verification`.

## Daemon adaptation

Unlike stateless TickTick REST calls, Baileys needs a durable socket and local Store:

```text
CLI do/admin ── JSON-RPC over Unix socket ── daemon
                                             ├── Baileys session
                                             ├── persistent Store snapshot
                                             ├── 65-action registry + safety policies
                                             └── O_EXCL lock + socket-first ownership
```

`bin/whats-proxy.mjs` is the production Node.js + `tsx` launcher. This keeps the source TypeScript
while avoiding Bun's incomplete `ws` upgrade-event shim in the Baileys connection path; Bun remains
the dependency, typecheck, test, smoke, stress, and packaging toolchain.

The daemon autostarts for `do`; `admin status` never starts it. Test isolation uses
`WHATS_PROXY_STATE_DIR` and `WHATS_PROXY_CONFIG_DIR`; `make smoke` therefore never uses a real
WhatsApp session.

## Configuration

The only optional override file is `$HOME/.config/whats-proxy/.env`. See `.env.example`: every line
documents a valid value. It controls state placement, reconnect behavior, Store limits, QR rendering,
and optional idle exit. Baileys credentials are session artifacts in `state/`, not environment secrets.

## Commands and quality gates

```bash
make help       # discover canonical targets
make check      # typecheck + tests + isolated daemon smoke
make stress     # concurrent daemon ownership proof
make install    # Bun development link
make git-push   # both github and gitlab remotes
```

`scripts/live.ts` is deliberately outside `make check`: it requires an operator to pair a physical
WhatsApp device. Authentication failures are fail-closed; never invent a browser workaround.

## Action catalogue

The 65 action names remain registry-derived and are discoverable from the executable source:

```bash
whats-proxy do --help
whats-proxy do send-text --help
whats-proxy do send-text '{"jid":"33600000000","text":"Hello"}'
```

Every per-action `--help` page contains at least three executable examples generated from that
action's central `meta.example`: inline JSON, a payload-file invocation, and result capture with
`-o`. Required-argument actions additionally show fail-fast validation; HITL actions show the
review path; destructive actions show their preflight condition; zero-argument reads show table
rendering. `WaClient.raw()` is internal-only and explicitly documented with three lifecycle
examples; it cannot bypass a registered `do` action's safety policy.

Categories: messaging (14), chats (5), contacts (6), groups (10), channels (5), labels (3), profile
(4), analytics (5), overview (2), digest (2), tags (1), watchlists (1), utilities (7).

## Project shape

```text
src/whats_proxy/
├── cli.ts                 # one binary: do/admin/hidden daemon
├── config.ts              # defaults + one .env override surface
├── client.ts daemon.ts    # JSON-RPC lifecycle + Baileys owner
├── hitl.ts                # local editable approval server
├── actions/
│   ├── registry.ts        # one registry map, duplicate detection
│   ├── policies.ts        # approval/preflight/verification source of truth
│   └── <domain>.ts        # ActionDefs and domain handlers
├── admin/                 # setup, status, stop
└── store.ts               # synchronized local WhatsApp state
tests/                     # unit, policy, and local HTTP HITL coverage
scripts/                   # isolated smoke, race stress, explicit live pairing
```
