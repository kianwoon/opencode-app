# jev_ask-missing-instructions-schemaerror-recurring-class

- **Date**: 2026-10-08T15:45+0800
- **Type**: lesson (2nd+ occurrence — recurring SchemaError class)

## What happened

`jev_ask` kept failing in production with `SchemaError(Missing key at ["questions"][N]["instructions"])` despite prior fixes (those added friendly messages for *criteria* mismatches). All three question arms (`choice`/`score`/`noul`) declared `instructions: Schema.String` as a hard-required key, so any caller omitting it rejected the ENTIRE batch. Callers naturally omit it whenever `criteria` looks self-explanatory (flash-tier models constantly; this session's own brain did it on the score arm).

## Root cause / fix

General invariant: **a missing descriptive field must never reject a batch — default it so the decoded payload stays wire-valid.** Message-only fixes don't stop caller-shape failures; the schema must tolerate the omission. Fix (commit `116e80d848`): `instructions` is optional-with-default on ALL THREE arms via effect v4's `Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed(<default>)))` (defaults exported as `INSTRUCTIONS_DEFAULTS`); hand-authored JSON-schema arms dropped `"instructions"` from `required`. Note: this effect version (4.0.0-beta.83) has NO `Schema.optionalWith` — `withDecodingDefaultType` accepts key-absent OR undefined and keeps the decoded type `string`.

## Acceptance gate

1. `bun test test/tool/jev-ask.test.ts` (from `packages/opencode`) passes incl. decode of a missing-instructions question on EACH arm + a mixed batch (not just the reported arm).
2. JSON-schema `required` arrays and the Effect decode schema agree (omission accepted in both).
3. Shipped: `strings <app>/Contents/Resources/app.asar | grep -c "<default instruction>"` ≥ 1.
4. Live check after app relaunch: a `jev_ask` call omitting `instructions` succeeds.

## Recurrence 2026-10-12 — same class, next key: `id`

The class recurred a third time: `SchemaError(Missing key at ["questions"][0]["id"])` — `id` was still hard-required on all three arms and in all three hand-authored JSON-schema `required` arrays. Same fix shape, plus two gaps the reviewer caught (both test-proven):

- **Derivation must be collision-safe**: naive `q${index}` clobbers an explicit `"q0"` elsewhere in the batch → `Object.fromEntries` silently DROPS a question. Fix: `wireIds(params)` pre-seeds a `taken` set with ALL explicit ids BEFORE deriving, then bump-until-free (`uniqueWireId`, mirrors `uniqueChoiceLabel`). Explicit ids always win, never rewritten.
- **Read-back must consume the same mapping**: `summarize`/`truncationMarker` originally read raw `question.id` (`": unmeasured"` while answers arrived keyed `q0`). All three now consume the one `wireIds` mapping — derivation lives at the single serialization point, read-side included.

Class invariant (refined): **a mechanically derivable field must never reject, lose, or mis-route a batch — derive it once, uniquely against explicit values, and route every reader through that one mapping.** Semantic keys (`type`, `criteria`, `goal`) stay required. Commit `430d81e7de`; shipped asar verified (`strings app.asar | grep -c uniqueWireId` = 3).
