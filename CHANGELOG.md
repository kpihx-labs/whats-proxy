# Changelog

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
