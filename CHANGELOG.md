# Changelog

## Unreleased

## 0.7.2 — 2026-09-03

- **Media download path relocated:** default save directory changed from
  `$HOME/Downloads/<active-account-phone>/` to `$HOME/Downloads/Whats-Proxy/<active-account-phone>/`
  for better organization under a dedicated app namespace.

## 0.7.0 — 2026-09-02

- **Raw Baileys + Store API:** `do raw` now has exactly two always-HITL atomic protocols:
  unrestricted `baileys` (`socket|module`) and `store` (`method|sql`). Agents compose successive
  calls externally; there is no do, filesystem, runtime, or flow protocol.
- **Secure pairing lifecycle:** Auth-state directories are created/repaired with mode `0700`.
  `admin auth login --start-service` optionally starts the paired account's persistent daemon.
- **Media download destination:** `media-download` accepts optional `output_dir` (absolute or
  `~/` path); its default is now `$HOME/Downloads/<active-account-phone>/`.
- **Direct receipt visibility:** `chat-read` and `message-status` now document that one-to-one
  `read_by` / `read_count` data requires the recipient's WhatsApp `readreceipts=all` privacy
  setting; group receipts remain independent. `read-messages` and `profile-privacy` help now
  distinguish explicit marking from receipt visibility.
- **Direct receipt persistence:** Persist direct Baileys `messages.update` delivery/read/played
  statuses alongside existing group receipt handling.
- **Service ownership:** `admin service stop|restart` now shuts down an auto-spawned socket owner
  before lifecycle control, preventing a false-success systemd restart blocked by the account lock.
- **chat-manage mark_read fix:** Correct Baileys `lastMessages` payload for read receipts.
- **Community create + join live-tested:** `community-create` successfully created KπX-Labs community;
  `community-join` successfully joined both accounts via invite code (2026-09-02).
- **Documentation audit:** Fixed all action counts to 68 across README, CONTRACT, AGENTS; corrected
  HITL classification (38 always + 7 conditional), porting proof, and module descriptions.

## 0.6.0 — 2026-08-31

- **Multi-account support:** whats-proxy now manages multiple WhatsApp accounts simultaneously.
  Each account lives in `~/.config/whats-proxy/<phone>/` with its own Baileys auth, Store, daemon
  socket, and lock. Legacy single-account layouts are auto-migrated on first run.
- **New admin namespace:** Two sub-namespaces replace the old monolithic admin:
  - `admin auth login|status|logout|use` — authentication lifecycle per account
  - `admin daemon status|stop|restart|logs|refresh` — daemon lifecycle per account or all
  Old commands (`admin setup`, `admin status`, `admin stop`) still work with deprecation warnings.
- **`-a`/`--account` flag on `do`:** Every RPC action now accepts `--account <phone>` to target
  a specific daemon. Resolution: flag → `WHATS_PROXY_ACCOUNT` env → default account → legacy.
- **`admin auth login` replaces `admin setup`:** Same QR/code pairing logic, but writes to
  `<phone>/state/`, auto-registers the account, and auto-sets first account as default.
- **`admin daemon refresh [phone]`:** Force-resync WhatsApp state (messages, contacts, groups)
  for one or all accounts via the daemon's `resyncAppState` RPC.
- **`accounts.json` registry:** Central registry tracking all linked accounts, default, aliases,
  and creation timestamps at `~/.config/whats-proxy/accounts.json`.
- **`admin auth use <phone>`:** Switch the default account without `--account` on every call.
- **Auto-migration:** On first launch, detects legacy flat layout (`state/creds.json` at root),
  reads phone from creds, moves to `<phone>/state/`, and registers in `accounts.json`.

## 0.5.0 — 2026-08-31

- **Baileys fork switch:** Replaced npm `@whiskeysockets/baileys@^7.0.0-rc14` with
  `ayusc/Baileys` fork that merges upstream PRs #2608 (empty link_code_companion_reg ack),
  #2749 (pre-login ack crash), #2765 (companion_reg_refresh handler). Fork is tested and
  confirmed by author on local + cloud (Koyeb). Remove when upstream merges these PRs.
- **Fix pairing — reconnect on 515 restartRequired:** The decisive fix. After WhatsApp accepts
  a QR scan or pairing code, it sends 515 (restartRequired) to ask the client to reconnect
  with freshly-issued session credentials. The old socket is dead; `makeWASocket` is one-shot.
  `admin setup` previously did `return;` assuming Baileys auto-reconnects (it does not). Fixed
  by extracting socket creation into a re-usable `connect()` function that re-reads auth from
  disk and creates a NEW socket on 515 — mirroring the daemon's own reconnect loop. Without
  this, `pair-success` never arrives and the phone shows "couldn't link device".
- **Admin --help:** `whats-proxy admin --help` and `whats-proxy admin setup --help` now show
  proper usage (was "Unknown admin subcommand: --help").
- **admin status:** Removed stale `config_file`/`.env` field — whats-proxy has no `.env`.
- **No .env file:** Removed `.env.example` entirely. Defaults live in `config.ts`. Only 2 env
  overrides remain (both for operational/test needs): `WHATS_PROXY_STATE_DIR`,
  `WHATS_PROXY_MAX_IDLE_MINUTES`. Default `max_idle_minutes` changed from 0 to 30 (safe default).
- **Zod payload validation (P1+P3):** 65 Zod schemas in `schemas.ts`, validated at CLI
  (pre-daemon) and daemon-side (`protectAction`). Required-argument check runs first, then
  Zod type validation.
- **Auto-wrapped envelope examples (P4):** `--help` output now shows full `{"meta":{...},"data":{...}}`
  envelope for every example.
- **Registration audit tests (P2+P6):** `tests/audit.test.ts` — 8 tests: count, kebab-case,
  meta.action, ≥3 examples, help sections, registry↔policies coherence, schema completeness.
- **New action `send-batch`:** Unified multi-recipient multi-part send. Sends any content type
  (text, image, video, audio, document, sticker, location, contact, poll) to one or more
  recipients in a single call. Each part becomes one WhatsApp message; every part is sent to
  every recipient. Text parts support `@mentions`. Any part can override the global `quoted_id`
  to reply to a different message. Return shape: `{ total, sent, failed, results }`. 65 actions
  total (was 65).
- **CONTRACT.md rewritten:** Full architecture contract, dense and complete, matching tick-proxy's
  documentation standard.
- **HITL xdg-open guard:** `WHATS_PROXY_NO_BROWSER` env var suppresses browser auto-open
  during tests/CI (was opening Edge tabs during `make check`).
- **Teardown noise suppressed:** `resolved` flag + `finish()` helper prevent spurious
  "Transient close" logs after deliberate socket teardown.
- **setup.ts stale auth wipe:** `admin setup` wipes stale auth files before fresh pairing
  to avoid 428 from version-mismatched credentials.

## 0.4.0 — 2026-08-30

- **Zod payload validation (P1+P3):** Every action now has a Zod schema (`schemas.ts`, 65 schemas)
  that validates payloads before HITL and daemon dispatch. Catches type errors (e.g.
  `priority: "banana"`) that previously passed silently. Validation runs at two levels: CLI
  (pre-daemon, `cli.ts`) and daemon-side (`protectAction` in `policies.ts`).
- **Auto-wrapped envelope examples (P4):** `--help` output now shows the full `{"meta":{...},"data":{...}}`
  envelope for every example, so agents see exactly what they'll receive. `buildReturnData()`
  parses `meta.returns` to construct placeholder output shapes.
- **Registration audit tests (P2+P6):** New `tests/audit.test.ts` with 8 tests: action count,
  kebab-case naming, meta.action consistency, ≥3 examples, help sections, registry↔policies
  bidirectional coherence, and Zod schema completeness (every action has a schema, schema keys
  match meta.arguments). Added `media-download` policy (was missing).
- Validation order: `validateRequiredArguments` runs first (clear "Missing required: X, Y" message),
  then Zod type validation (catches wrong types after presence check).

## 0.3.0 — 2026-08-12

- Adopted `../tick_proxy/` as the sole proxy-standard reference while retaining the Bun/Baileys
  daemon required for WhatsApp's persistent local store.
- Added declarative action policies as the single source of truth for mandatory human approval,
  destructive preflight identity locks, and local read-back verification proofs.
- Added local-only editable HITL review served on an OS-assigned port, with a 600-second fail-closed
  timeout, browser launch, JSON validation, and approved/rejected `meta` outcomes.
- Removed the obsolete `config.json` and file-logging layers: one documented `.env` supplies
  optional overrides, while diagnostics are stderr-only and stdout remains machine-safe.
- Added safety-policy and real local HTTP HITL tests; the complete suite now has 37 passing tests.
- Fixed a real concurrent-daemon regression found by `make stress`: contenders now treat a live PID
  in the O_EXCL lock as authoritative before probing the not-yet-bound socket, closing the lock-to-
  socket stale-lock recovery race.
- Extended destructive preflights to remote group, channel, and Business-label targets; conditional
  preflights now lock identities only when they actually protected a destructive operation.
- Root-fixed live pairing failure: Bun's missing `ws` upgrade-event implementation prevented a
  Baileys handshake/QR. Bun remains the package and test toolchain, while the production entrypoint
  and daemon now use Node.js; `make runtime-smoke` validates that exact installed path.
- Exercised the real Node pairing lifecycle in `ubuntu:0.2`: it stayed safely pending until the
  three-minute timeout without a physical scan, then emitted the normal fail-closed envelope.
- Every one of the 65 `do` help pages now renders at least three concrete executable examples from
  its central action payload, with extra HITL and destructive-preflight branches where relevant.
- Expanded per-action help with a fail-fast validation branch for every required-argument action;
  documented the internal `WaClient.raw()` escape hatch with three lifecycle examples and its
  deliberate inability to bypass public action safety.
- Added distinct action-owned semantic scenarios for messaging media, batch broadcasts, group
  membership/invites, and analytics search; pairing remains deliberately outside offline checks.
- Declared the intentional Bun-toolchain/Node-runtime split in package metadata and public
  documentation; the packaged Node + `tsx` launcher is included in the package dry run.
- Relocated the repo to `~/KpihX-Labs/proxies/whats-proxy` (dash naming, matching `tg-proxy`,
  `tick-proxy`, `mail-proxy`); config directory remains `~/.config/whats-proxy/`. Global Bun link
  re-pointed to the new path (`make install`).

## 0.2.0 — 2026-07-31

- Initial Bun/Baileys daemon implementation with 65 actions, local Store persistence, CLI help,
  isolated smoke testing, daemon ownership locking, and idle exit.
