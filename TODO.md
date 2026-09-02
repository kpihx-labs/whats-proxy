# TODO

## Active

- [ ] Run `whats-proxy admin setup` and the live-account smoke only when an operator is present to
  approve the physical WhatsApp pairing flow. This is intentionally excluded from automated checks.
- [ ] Live validation of `community-link` and `community-leave` (not tested yet as of 2026-09-02).
- [ ] Update `k-whats` skill to reflect 68-action catalog and new actions (raw, media-upload, etc.).

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
- [x] Raw Baileys + Store API escape hatch (`do raw`) with atomic protocols (2026-09-02).
- [x] Secure pairing lifecycle (0700 auth dirs, --start-service) (2026-09-02).
- [x] Community create + join live-tested successfully (2026-09-02).
- [x] Documentation audit — all counts fixed to 68 (2026-09-02).
