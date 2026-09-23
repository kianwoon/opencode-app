# Jev: ONE-integration rule + Phase 1 stale-gate record (2026-09-23)

## Gotcha (why the ten-seam classifier died)
A default-OFF parallel decision integration in core (`packages/opencode/src/classifier/`,
commit `d77dcda216` "ten Jev decision seams") duplicated the live Jev path → two sources of
truth → the whole build was reverted (`ee99014769`, 114 files, 8101 deletions). The revert
message states the rationale outright: one Jev integration should exist, and it is the
plugin/`jev` path; the core classifier was an inert duplicate.

## Rule
Extend the LIVE module (`packages/opencode/src/jev/*` + the `prompt.ts` booster batch) —
never add a parallel classifier/gate subsystem, even default-OFF.

## Phase 1 record (knowledge-staleness gate at PLAN)
- `BOOST_STALE_ADVISORY` const: `packages/opencode/src/session/prompt.ts:217-221`.
- Fired only at step 1: `batchBoostOptions` conditional at `prompt.ts:2261`
  (`boostBatchOn ? (step === 1 ? [...BOOST_ADVISORIES, BOOST_STALE_ADVISORY] : [...])`).
- The sentence doubles as the Jev question's pass-criteria (`client.ts` boost question
  `criteria.use`) AND the delivered advisory text (`BOOSTER_ADVISORY_PREFIX + label`).
- Delivery: existing advisory → trailing-user-message TAIL path (`prompt.ts:2513-2521`
  verdict compose; append after `:2573`). NEVER `output.system` (prefix-cache invariant).
- Telemetry: `jev.booster verdict` (`:2524`). `boosterPush` change-detection suppresses a
  repeated label on consecutive turns — built-in hysteresis.
- Batch is choices-only (`client.ts` has no freeform question type) → structured
  claim/query capture = Phase 2.
- No config schema change → no SDK regen needed.

## Verification commands
- `bun typecheck` from `packages/opencode` → exit 0.
- `bun test jev` from `packages/opencode` → 80 pass (2026-09-23).
- `git diff | grep -c "output.system"` → 0.
- Live: whole-file `grep -c "jev.booster verdict" ~/.local/share/opencode/log/opencode.log`
  (filter `grep -v "evaluated permission"`); the stale choice appears as its label text on
  `step=1` lines.

## Acceptance gate for future edits on this path
The batch verdict must be READ at `prompt.ts:2513` and flow into `advisory`. Any new
decision variable needs a grep for its READER before claiming an effect (turnTools lesson:
`:2313` writes `turnTools`, `:2556` emits frozen `headTools` — inert write with telemetry).
