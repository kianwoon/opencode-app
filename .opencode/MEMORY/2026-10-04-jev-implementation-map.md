# 2026-10-04 — jev implementation map (repo + wire + gates)

Complete map of the jev/SystemOne implementation in this repo. Read before touching anything under `packages/opencode/src/jev/`, `packages/opencode/src/tool/jev-*`, or the jev user plugins.

## Wire (vendor: docs.typesafe.ai, model jev-1.13.0 / alias jev-latest)

- `POST https://api.typesafe.ai/v1/systemone` — headers: `Authorization: Bearer <key>`, `content-type: application/json`, `HTTP-Referer: https://opencode.ai/`, `X-Title: opencode`. Body: `{model, state, questions}`. GET returns 405 — that means ALIVE, not broken.
- Key resolution (`controller.ts` `jevKey`): `~/.local/share/opencode/auth.json` → `typesafe.key`, fallback env `TYPESAFE_API_KEY`. Key present in auth.json does NOT mean the tool is healthy (see below-gate lesson).
- Three question types ONLY (`client.ts:264-292`): `choice` (choice/probabilities/confidence), `score` (score/legend/probabilities/confidence, may land between levels), `noul` (bare probability, NO confidence field). Shape guard `mismatchedShape` (:332). Everything else (`measured`, floors, gates) is policy layered on these.

## Files (packages/opencode/src/jev/)

- `client.ts` — transport registry (`jevTransport`, default `typesafe/jev-latest` :22, endpoints typesafe|openrouter), `jevFetchRetry`, `jevMeasuredChoice` (requires explicit `probabilities[choice]`; a bare label with no map is an echo, strength must never be fabricated), constants `JEV_DEFAULT_THRESHOLD 0.7`, timeouts.
- `controller.ts` — `jevKey` (:104-124 auth.json→env), `buildControllerQuestions` (action: click/type/scroll/key/wait/done + target over FULL control set, order preserved, count never truncated), `buildState` (clipped to STATE_MAX 4000), `ControllerOutcome` union **`accepted | below_gate{choice,action,strength} | unmeasured`** (fix `20e63dba15`), `foldController` (gate: measured action row ≥ max(floor, threshold=0.7); unknown-choice action row → unmeasured, NOT below_gate; target gated by threshold only — deliberate asymmetry), `jevControlDetailed` (full union) / `jevControl` (legacy `ControllerDecision | null` for UI drivers), memo TTL 60s / max 200, ACCEPTED-only.
- `accept.ts` — handoff acceptance: `gate_ok` noul = fail-closed PREFILTER (noul 0 never passes, even at threshold 0), `verdict` choice = the verdict; unmeasured → `measured:false`, never accept.
- `gate.ts` — booster (reasoning label choice: switch|verify|contradiction|finish|continue) + gauge, change-detect `boosterPush`, all fail-open emit-nothing.
- `rank.ts` — `score` question, below-threshold = unranked tail kept in input order, never dropped.
- `label.ts` — session-state choice (thrive|stall|bloat|drift).
- `features.ts`, `snapshot.ts` — supporting.
- Tools (`src/tool/`): `jev-decide.ts` (control table → labels, CONTROLS_MAX 60, truncation marker, formats: decision / `below_gate` / unavailable), `jev-accept.ts`, + rank/label tools; wired in `tool/registry.ts`; `config/brain.ts` reads thresholds (`cfg.jev.threshold`).
- Arbitration: `session/arbitrate.ts` (below-threshold = unranked tail, never dropped).
- Brain gates consuming these: `~/.config/opencode/agent/brain.md` ROUTING + PLANNING sections (user-approved 2026-10-04) — act thresholds 0.6 / 0.75 / 0.85 by stakes; below_gate counts as BELOW its number ("uncertain", not absent); audit log `~/.local/share/opencode/brain-shadow/decisions.jsonl`.
- User plugins mirroring across the plugin boundary (no repo imports): `ocu-jev.ts` (action/target/need_screenshot; success/stuck DERIVED from harness truth, never asked of the model), `ocu-guards.ts` (deterministic GUI guards — keep).

## Doctrine (vendor: docs.typesafe.ai — index at /llms.txt; .md pages embed Mintlify JS, strip with `awk '/^export function/{skip=1} skip && /^\}$/{skip=0; next}'`)

- One batched POST per state: all questions parallel + independent; speculative questions are ~free; second request ONLY when an answer changes what state exists next.
- Confidence ≠ probability: confidence = peakedness of the distribution (choice: `(p_max − 1/n)/(1 − 1/n)`); neighbor-level mass costs little, far-level mass destroys it. Noul has no confidence — `|2p−1|` if you must.
- Thresholds scale with stakes (0.5 floor → human; destructive >0.85–0.9 else confirm). Start conservative, tune on your own data. Below-gate = "uncertain → human/confirm" tier — NEVER collapse to unavailable (see companion lesson `2026-10-04-jev-below-gate-distinct-from-unavailable.md`).
- Patterns: speculative fan-out; confidence-gated routing; intent routing (classify → deterministic code | specialist LLM | human); composite scoring (atomic scores × code-owned weights).

## Pitfalls learned live (2026-10-04)

- Endpoint 405-on-GET = alive. auth.json key present = key fine. `unavailable` can still mean below_gate — check the fold, not the network.
- Identical inputs straddle the 0.7 gate within normal variance — a single verdict is a sample, not a verdict.
- Hand-written probe JSON gets rejected (422 `json_invalid`) — replicate `buildControllerQuestions`' exact record shape.
- Desktop app runs `Resources/app.asar`; fresh code on disk ≠ running process (restart to pick up rebuilds).
