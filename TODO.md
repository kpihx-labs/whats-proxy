# TODO

## Active

- [ ] Run `whats-proxy admin setup` and the live-account smoke only when an operator is present to
  approve the physical WhatsApp pairing flow. This is intentionally excluded from automated checks.

## Done

- [x] Adopted `../tick_proxy/` as the sole standard reference for proxy structure, envelopes,
  documentation, stderr discipline, and mandatory action safety policy (2026-08-12).
- [x] Added a local editable HITL review for consequential WhatsApp operations, with fail-closed
  timeout, immutable destructive target identities, and review-state output (2026-08-12).
- [x] Re-audited parity against `../tick_proxy/`: strengthened remote destructive preflights,
  required-argument validation before daemon spawn, and final package/link/smoke verification
  (2026-08-12).
- [x] Added and enforced at least three central executable examples for every `do` action, plus
  review, preflight, validation, and table branches where applicable (2026-08-12).
- [x] Removed `config.json` and state-directory file logging: `.env` is the one optional override
  surface; stderr is the sole diagnostics transport (2026-08-12).
