# Jev surface map + fold doctrine enforcement (2026-10-04 rework)

## Live vs dead surfaces (verified by call-site grep, then removed)
- LIVE: `client.jevBatch` + `batchToolKeep` + `jevVerdict` + `jevGaugeKeep` + `jevBelowFloor`
  (consumed by `session/prompt.ts` frozen-decision path), `boosterPush` + `applyDrops`
  (prompt.ts imports), `controller.jevControlDetailed` (jev_decide tool + ui-run reads
  `target`+`strength`).
- REMOVED as zero-consumer dead code: `governorKeep`, `foldDrops`, `boosterVerdict`,
  `boosterAdvisory`, `boosterPolicyMetadata`, `policy.ts` (+test), `client.jevDecide`,
  `jevKeepTools`, `jevFoldTools` + memo infra. Their tests were deleted or re-pointed at
  live code — do NOT re-add these surfaces without first wiring a consumer.
- The dead chain hid behind a prompt.ts re-export (`export {...} from "@/jev/client"`):
  a re-export is NOT a consumer. Grep src call sites, not export lines.

## Fold doctrine (jev.md is the spec; violations fixed 2026-10-04)
- Gate on the measured choice row + `probabilities[choice]` (or `probabilities.use` for
  tool keep/drop — jevVerdict folds strength as `probabilities["use"]`). NEVER on
  `confidence` (confidence in the label chosen) and never on `noul` alone.
- noul is a prefilter/display value: it may not veto a strong choice (old accept.ts veto
  bug) and may not accept alone (old noul-only `accept:true` bug).
- `criteria` on the wire is per question type (live-probed 2026-10-04): CHOICE = record `label → description`; SCORE = ORDERED STRING ARRAY of level descriptions (record form → HTTP 422 `list_type`, which silently fail-opens the whole call). jev.md §2's "never an array" applies to choice only. An envelope WITHOUT the `model` echo is not a decision response — `hasTransportMarker` gates every fold (fail open).
- Meta-classification questions ("is the classification reliable?") are noise per §3 —
  label.ts now sends exactly one `label` choice question.
- Tool-wrapper gotchas fixed: `objective: params.objective ?? built?.title` in
  tool/jev-label.ts (sessionID path must never overwrite the caller's objective);
  display `strength=` not `confidence=`.

## Acceptance gate
`bun typecheck` + `bun test test/jev test/tool/jev-decide.test.ts test/session/jev-routing.test.ts`
from packages/opencode — all green (134 pass at rework time).
