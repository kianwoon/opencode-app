/**
 * Phase 1 decision-seam schemas.
 *
 * Two families live here and must not be conflated:
 * - System One wire types (`Question`, `Answer`, request/response) — a faithful
 *   mapping of the TypeSafe System One contract. `state` is TEXT ONLY.
 * - Decision domain types (`RetryDecision`, `ReasonCode`, `ClassifierDecision`)
 *   — provider-agnostic vocabulary the agent loop can eventually consume.
 *
 * Infrastructure only: nothing here changes agent behavior.
 *
 * @module @opencode-ai/opencode/classifier/schema
 */
export * as ClassifierSchema from "./schema"

import { Schema } from "effect"

// --- System One wire types ---------------------------------------------------

/** question instructions accept text or a structured/array form. */
const Instructions = Schema.Union([Schema.String, Schema.Json])

/**
 * A `choice` question: the model picks exactly one of `criteria`'s option keys.
 * Each option maps to an optional label; the max is 255 options.
 */
export const ChoiceQuestion = Schema.Struct({
  type: Schema.Literal("choice"),
  instructions: Instructions,
  criteria: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
})

/** A `score` question: the model returns an ordered integer level. */
export const ScoreQuestion = Schema.Struct({
  type: Schema.Literal("score"),
  instructions: Instructions,
  criteria: Schema.Array(Schema.NullOr(Schema.String)),
})

/** A `noul` (yes/no-ish) question: calibrated numeric judgement, no confidence. */
export const NoulQuestion = Schema.Struct({
  type: Schema.Literal("noul"),
  instructions: Instructions,
  criteria: Schema.optional(
    Schema.Struct({ true: Schema.optional(Schema.String), false: Schema.optional(Schema.String) }),
  ),
})

export const Question = Schema.Union([ChoiceQuestion, ScoreQuestion, NoulQuestion]).annotate({
  identifier: "Classifier.Question",
})

/**
 * Provenance of an answer.
 * "openrouter" is the OpenRouter decisions endpoint, which proxies the real Jev
 * model, so its numbers ARE native (not self-reported); the marker exists for
 * provenance and cost attribution only. Absent means the native TypeSafe
 * transport.
 */
const Transport = Schema.optional(Schema.Literals(["native", "openrouter"]))

export const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
  transport: Transport,
})

/** `legend` keys are stringified level indices ("0", "1", …). */
export const ScoreAnswer = Schema.Struct({
  type: Schema.Literal("score"),
  score: Schema.Number,
  legend: Schema.Record(Schema.String, Schema.String),
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
  transport: Transport,
})

/** Notably has NO `confidence` and NO `probabilities`. */
export const NoulAnswer = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Schema.Number,
  transport: Transport,
})

export const Answer = Schema.Union([ChoiceAnswer, ScoreAnswer, NoulAnswer]).annotate({
  identifier: "Classifier.Answer",
})

export const SystemOneRequest = Schema.Struct({
  state: Schema.Union([Schema.String, Schema.Json]),
  model: Schema.String,
  questions: Schema.Record(Schema.String, Question),
})

export const Usage = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
})

export const SystemOneResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, Answer),
  usage: Usage,
  transport: Transport,
})

export type Question = Schema.Schema.Type<typeof Question>
export type Answer = Schema.Schema.Type<typeof Answer>
export type Usage = Schema.Schema.Type<typeof Usage>
export type SystemOneRequest = Schema.Schema.Type<typeof SystemOneRequest>
export type SystemOneResponse = Schema.Schema.Type<typeof SystemOneResponse>
export type Json = Schema.Schema.Type<typeof Schema.Json>
// --- Decision domain types ---------------------------------------------------

/**
 * Escape hatch free vocabulary for the retry/death-spiral seam. Not every code
 * is reachable in Phase 1; the union is the shared language the loop will use.
 */
export const RetryDecision = Schema.Literals([
  "CONTINUE",
  "RETRY",
  "SWITCH_STRATEGY",
  "SWITCH_MODEL",
  "ROLLBACK",
  "STOP",
  "ESCALATE",
  "ASK_USER",
])
export type RetryDecision = Schema.Schema.Type<typeof RetryDecision>

/**
 * Names of the decision seams the service can dispatch. `ClassifierService`
 * re-exports this as `ClassifierName`; the union is declared here so the schema
 * module stays the single vocabulary owner.
 */
export type ClassifierName =
  | "retry"
  | "relevance"
  | "scoring"
  | "state-extraction"
  | "batch"
  | "verification"
  | "guardrails"
  | "matching"
  | "screening"
  | "memory"
  | "anomaly"

/**
 * Context-relevance seam verdict, one per batch of context sections. `UNSURE`
 * is the fail-open answer (nothing prunable was decided) and is what an empty or
 * entirely unanswered batch folds to.
 */
export const RelevanceDecision = Schema.Literals(["KEEP", "PRUNE", "UNSURE"])
export type RelevanceDecision = Schema.Schema.Type<typeof RelevanceDecision>

/**
 * Scoring seam verdict, one per subject/dimension batch. `RATED` means at least
 * one dimension produced a real score; `UNSURE` is the fail-open answer (nothing
 * scored) and is what an empty or entirely unanswered batch folds to.
 */
export const ScoreDecision = Schema.Literals(["RATED", "UNSURE"])
export type ScoreDecision = Schema.Schema.Type<typeof ScoreDecision>

/**
 * State-extraction seam verdict. `EXTRACTED` means at least one field/flag came
 * back as a real fact; `UNSURE` is the fail-open answer for an empty batch.
 */
export const ExtractionDecision = Schema.Literals(["EXTRACTED", "UNSURE"])
export type ExtractionDecision = Schema.Schema.Type<typeof ExtractionDecision>

/**
 * Batch/map-reduce seam verdict. `AGGREGATED` means at least one item resolved;
 * `UNSURE` is the fail-open answer when every chunk failed.
 */
export const BatchDecision = Schema.Literals(["AGGREGATED", "UNSURE"])
export type BatchDecision = Schema.Schema.Type<typeof BatchDecision>

export const ReasonCode = Schema.Literals([
  "NO_PROGRESS_REPEATED_FAILURE",
  "NEW_INFORMATION",
  "STRATEGY_EXHAUSTED",
  "MODEL_INCAPABLE",
  "PROGRESS_MADE",
  "MAX_ATTEMPTS",
  "REPEATED_EXACT_FAILURE",
  "CLASSIFIER_UNAVAILABLE",
  "ACTION_OVERRIDDEN",
  "CONTEXT_RELEVANT",
  "CONTEXT_IRRELEVANT",
  "CONTEXT_UNKNOWN",
  "SCORES_RATED",
  "SCORES_UNKNOWN",
  "FACTS_EXTRACTED",
  "FACTS_UNKNOWN",
  "BATCH_AGGREGATED",
  "BATCH_UNKNOWN",
])
export type ReasonCode = Schema.Schema.Type<typeof ReasonCode>

/**
 * Provider-agnostic decision envelope. `classifier` names the producer (e.g.
 * "jev" | "rule-based"), `fallbackUsed` is true whenever the deterministic
 * path supplied the decision.
 */
export const ClassifierDecision = <A extends Schema.Top>(decision: A) =>
  Schema.Struct({
    decision,
    confidence: Schema.Number,
    reasonCode: ReasonCode,
    classifier: Schema.String,
    latencyMs: Schema.Number,
    fallbackUsed: Schema.Boolean,
  })

export type ClassifierDecision<A> = {
  decision: A
  confidence: number
  reasonCode: ReasonCode
  classifier: string
  latencyMs: number
  fallbackUsed: boolean
}
