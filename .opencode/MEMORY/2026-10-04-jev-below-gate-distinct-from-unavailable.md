# 2026-10-04 — jev below-gate verdicts are "uncertain", never "unavailable"

**Symptom**: `jev_decide` intermittently returned `{"decision":null,"reason":"unavailable"}` while the endpoint, auth key, and wire format were all healthy. Identical inputs sometimes measured (0.73–0.92), sometimes "unavailable".

**Root cause**: `foldController` (packages/opencode/src/jev/controller.ts) returned `null` for THREE distinct situations — unparseable body, unmeasured action row, AND a measured action row below the confidence gate — and `tool/jev-decide.ts` printed all three identically as `unavailable`. Per TypeSafe doctrine (docs.typesafe.ai/confidence + self-consistency cookbooks): "I don't know" is a first-class signal; a measured-but-weak verdict must surface its `choice` + `strength` as an explicit `uncertain`/`below_gate` outcome, never collapse into unavailability. Variance near a threshold is vendor-measured as normal (jev itself flips 2/8 borderline labels across identical repeats).

**Fix** (commit `20e63dba15`): `ControllerOutcome` union — `accepted | below_gate{choice,action,strength} | unmeasured`; new `jevControlDetailed` returns the full union; `jevControl` keeps its `ControllerDecision | null` contract (below_gate → null) so UI drivers fail open; `formatBelowGate` in `tool/jev-decide.ts` emits `{"reason":"below_gate","choice","strength"}`; memo still accepts-only (a weak verdict never sticks).

**Acceptance gate**: a measured action row with top probability < gate produces `below_gate` with carried choice+strength (test: 0.55 click fixture); garbage/unmeasured action rows produce `unmeasured`; `bun test test/jev/controller.test.ts test/tool/jev-decide.test.ts` all green; `bun typecheck` exit 0 from `packages/opencode`.

**Corollary for consumers (brain gates)**: treat `below_gate` as "uncertain", not absent — it counts as below the act threshold, never as a missing verdict to retry into existence.
