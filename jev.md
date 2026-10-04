# Jev — TypeSafe System One decision model (learnings)

## 1. What Jev is

- **Model class**: TypeSafe "System One" decision model. Default model spec `typesafe/jev-latest`.
- **One endpoint**: `POST https://api.typesafe.ai/v1/systemone` — a *decision* API, not a chat completion. A configured `openrouter/...` spec routes to `https://openrouter.ai/api/alpha/decisions` (same wire model, proxied); an OpenRouter key is used as a fallback transport when the `typesafe/*` default has no typesafe key.
- **One call = one batch**: all question types go in a single request.
- **3 question types**: `noul` (no/unknown/null-like cheap answer), `choice`, `score`.
- **Pricing**: `$0.042 / M input tokens`, `$0` output. Usage cost = what you paid.
- **Latency**: ~330–650 ms per batch.

## 2. Wire contract

Request:

```json
{
  "model": "jev-latest",
  "state": "<situation / context text>",
  "questions": {
    "<id>": {
      "type": "choice | score | noul",
      "instructions": "<what to decide>",
      "criteria": { "<label>": "<meaning>" }
    }
  }
}
```

Rules on the request shape:

- `questions` is a **record keyed by question id**, never an array. Answers come
  back under the same ids, so ids are the pairing contract (use the tool/field
  name as the id when available).
- `criteria` shape is **per question type**: `choice` takes a **record
  `label → description`**, while `score` takes an **ordered string array** of
  level descriptions (lowest first). The record form on a score question is
  rejected with HTTP 422 `list_type ... Input should be a valid list`. Rich
  descriptions are the accuracy lever (see §4.2).
- The **wire model id is bare** (`jev-latest`): a provider prefix such as
  `typesafe/` selects the transport and is stripped before the request.

Response:

```json
{
  "model": "...",
  "answers": {
    "<id>": {
      "type": "choice | score | noul",
      "noul": 0.91,
      "choice": "<label>",
      "probabilities": { "<label>": 0.83 },
      "confidence": 0.83,
      "score": 1.76,
      "legend": { "0": "...", "1": "...", "2": "..." }
    }
  },
  "usage": { "input_tokens": 0, "output_tokens": 0, "cost": 0.0001 }
}
```

Rules:

- `noul` is a **numeric 0..1** score (cheap-answer likelihood), **NOT a boolean**
  — `true`/`false` never appear on the wire. Do not `if (row.noul)`; threshold it
  (`row.noul >= 0.7`). It accompanies the `choice` row, it does not replace it.
- `noul` answers carry **NO** `confidence` / `probabilities`.
- The **transport marker IS the envelope `model` echo** — the resolved id the
  response came from (e.g. `"jev-1.13.0"`), and the only marker field there is.
  An envelope without a non-empty `model` string is not a decision response:
  fail open rather than folding whatever `answers` happens to hold.
- Upstream log fields `tokens_prompt` / `tokens_completion` are **0 — ignore them**; `native_tokens_*` are the real counts; `usage` is the cost actually paid.
- `finish_reason: null` is **normal**.
- `choice` answers include `probabilities` per label + a top-level `confidence`.

## 3. Question types compared (live evidence)

| Type | Verdict | Evidence |
|------|---------|----------|
| `choice` (binary keep/drop) | **Best gate** | categorical + per-row `confidence` 0.41–0.99 |
| `score` | **Advisory rank only** | floats not ints; `confidence` 0 on most rows |
| `noul` | Cheap prefilter @0.7 | no `confidence` emitted |
| extras (`still_relevant`, `duplicate`, …) | **HURT** | `still_relevant` 0.54–0.57 flat; `include_in_context` false-drops keepers |

- Use **`choice` keep/drop** as the decision gate.
- **Gate on `choice`, never on `confidence`.** `confidence` is confidence in the *label chosen*, so a confident `skip` (0.74–0.97 observed live) clears any `>=0.7` test and gets KEPT while a low-confidence `use` (task 0.42) gets DROPPED — silently stripping delegation. Correct rule: keep iff `choice === "use" && probabilities.use >= threshold`.
- Exempt `task` / `StructuredOutput` / `invalid` from routing; a unanimous `skip` on `task` must still keep it.
- `score` for ordering, never for gating.
- `noul` as a cheap first pass with a 0.7 cut.
- Do **not** add meta-classification extras (`still_relevant`, `include_in_context`) — they produce flat/noisy verdicts and hurt.

## 4. Proven recipe

1. **Precise task sentence** naming the artifact + priority is the dominant lever: a fix took accuracy `0.40 → 0.96`.
2. **Rich criteria labels** beat generic ones: score span `0.04–0.92` (rich) vs `0.40–0.67` (generic cluster). On a `score` question write them as the ordered array of levels (see §2).
3. **Threshold `0.7`** is stable: range ≤ 0.06, zero flips across reruns.
4. **`confidenceFloor 0.3`** — below this, don't trust the row.
5. **Exempt tool-output and `>800`-char sections** — fail-open keep them.
6. **Front-load decisive text in the first 200 chars** — 200-char head excerpt causes blindness: `f4` scored 0.17 → false drop.

## 5. Failures catalog

| Failure | Effect |
|---------|--------|
| Placeholder-token exhibits | meaningless verdicts |
| Meta-classification wording ("what role…") | noise |
| Label-only rescue | −0.09 (worse) |
| Conclusion-first | +0.03 only |
| `score >= 2` integer fold | drops near-useful rows (1.76) |
| Overrule path | untested (14/14 agreements) |
| Duplicate handling | blind — both copies kept |
| False-relevance claim | correctly defeated (0.25) |

## 6. Cache-first rules (priority 1)

1. **Middle-window only** — cache the compressible middle; freeze prefix + `tailTurns: 3`.
2. **Never reorder survivors** — preserve order for byte-identical reuse.
3. **Memo by `id` + content-hash**, 500-entry FIFO.
4. **Detached execution + 3 s timeout + fail-open keep** — a miss/timeout never drops content.
5. On a memo hit, output must be **byte-identical**.

## 7. Integration

- The plugin **CANNOT import the classifier** — it carries Effect/Auth deps and the `@/` alias; importing pulls the whole runtime.
- **Raw-fetch** the endpoint instead; copy request/response *shapes only*.
- The hook is async but the `await` is **off the critical path** (detached).
- **No reusable mapper** exists — write ~10 lines inline; handle **`TextParts` only**.

## 8. Real 500k validation

- Session `ses_f6bdc0a53ffeXEgF5Tb9K4g7kB`.
- **5/5 stale turns dropped** at confidence 0.91–0.98.
- **Task-shift detected** correctly.
- Cost: **$0.0001 / batch**.

## 9. Config snippet

```json
{
  "jevDefault": { "model": "typesafe/jev-latest" },
  "jev": {
    "enabled": true,
    "model": "typesafe/jev-latest",
    "threshold": 0.7,
    "confidenceFloor": 0.3,
    "timeoutMs": 3000
  },
  "governor": { "enabled": true, "model": "typesafe/jev-latest", "threshold": 0.7, "timeoutMs": 3000 },
  "brainBooster": { "enabled": true, "model": "typesafe/jev-latest", "threshold": 0.7, "timeoutMs": 3000 }
}
```

Schema keys (source of truth: `packages/core/src/v1/config/config.ts`): `jevDefault.model`;
`jev.{enabled,model,threshold,confidenceFloor,timeoutMs}`; `governor.{enabled,model,threshold,timeoutMs}`;
`brainBooster.{enabled,model,threshold,timeoutMs}`. `confidenceFloor` (default 0.3, range 0..1) is
the minimum score strength a row must carry to be trusted and IS enforced in the folds — a
measured row below the floor fails open (keep / null) instead of gating on a score the model did
not stand behind. The old `endpoint` / `keepTailTurns` / `memoSize` / `exemptOverChars` keys are
not part of the schema (the transport endpoint is derived from the model spec prefix).

`contextCap` math: `280000 / 1.35 ≈ 207407`.
