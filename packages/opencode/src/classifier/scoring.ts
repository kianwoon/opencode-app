/**
 * Ordered scoring classifier (decision seam #1).
 *
 * The seam asks ONE batched `score` question per dimension so a governor can
 * threshold every dimension at once; N dimensions cost one request. This is the
 * first real construction of the `score` wire primitive. The decisive logic is
 * PURE and fail-open: a missing or malformed answer leaves its dimension
 * `undefined` and never throws.
 *
 * Nothing calls this yet; wiring it into the loop is a later piece.
 *
 * @module @opencode-ai/opencode/classifier/scoring
 */
export * as ClassifierScoring from "./scoring"

import { Effect } from "effect"

import { type Answer, type ReasonCode, type ScoreDecision } from "./schema"
import { ClassifierClient } from "./client"

// --- Pure state --------------------------------------------------------------

/** Ordered criteria levels shared by every score question. */
export const SCORE_LEVELS = ["low", "medium", "high"] as const

/** A single dimension's resolved score: label, normalised value, confidence. */
export interface DimensionScore {
  readonly level: string
  readonly value: number
  readonly confidence: number
}

export type ScoreResult = Record<string, DimensionScore>

/**
 * One `score` question per dimension, keyed by the dimension name. Pure: the
 * ONLY input is the dimension list, so batching costs are visible and testable
 * at the call site. `criteria` is the ORDERED level list (index == score).
 */
export function buildScoreQuestions(
  subject: string,
  dimensions: readonly string[],
  levels: readonly string[] = SCORE_LEVELS,
): Record<string, { type: "score"; instructions: string; criteria: (string | null)[] }> {
  return Object.fromEntries(
    dimensions.map((dimension) => [
      dimension,
      {
        type: "score" as const,
        instructions: `Rate the ${dimension} of the following on the ordered scale: ${subject}`,
        criteria: [...levels],
      },
    ]),
  )
}

/**
 * Map a `score` answer to its label + normalised 0..1 value. The label comes
 * from the returned `legend` when present, else the ordered criteria. Fail-open:
 * absent, wrong-typed or non-finite answers return `undefined`.
 */
export function scoreValue(
  answer: Answer | undefined,
  levels: readonly string[],
): { level: string; value: number; confidence: number } | undefined {
  if (!answer || answer.type !== "score") return undefined
  if (!Number.isFinite(answer.score)) return undefined
  const index = Math.max(0, Math.min(levels.length - 1, Math.round(answer.score)))
  const level = answer.legend[String(index)] ?? levels[index] ?? String(index)
  const span = levels.length - 1
  const value = span <= 0 ? 0 : index / span
  const confidence = Number.isFinite(answer.confidence) ? answer.confidence : 0
  return { level, value, confidence }
}

/**
 * Fold answers into per-dimension scores. Fail-open: a dimension whose answer is
 * missing or malformed is simply absent from the result (never a throw, never a
 * fabricated score). Unknown answer keys are ignored.
 */
export function evaluateScores(input: {
  answers: Record<string, Answer>
  dimensions: readonly string[]
  levels?: readonly string[]
}): ScoreResult {
  const levels = input.levels ?? SCORE_LEVELS
  const result: ScoreResult = {}
  for (const dimension of input.dimensions) {
    const scored = scoreValue(input.answers[dimension], levels)
    if (scored) result[dimension] = scored
  }
  return result
}

/**
 * Collapse a score result into the seam decision. `RATED` is reached only from
 * REAL scores, so an empty or entirely unanswered batch folds to `UNSURE`.
 */
export function toScoresResult(scores: ScoreResult): {
  decision: ScoreDecision
  reasonCode: ReasonCode
  confidence: number
} {
  const values = Object.values(scores)
  if (values.length === 0) return { decision: "UNSURE", reasonCode: "SCORES_UNKNOWN", confidence: 0 }
  const confidence = values.reduce((acc, score) => acc + score.confidence, 0) / values.length
  return { decision: "RATED", reasonCode: "SCORES_RATED", confidence }
}

/** Deterministic no-network score: every dimension neutral and unlabelled. */
export function ruleBasedScores(dimensions: readonly string[]): ScoreResult {
  return Object.fromEntries(
    dimensions.map((dimension) => [dimension, { level: "unknown", value: 0.5, confidence: 0 }]),
  )
}

/** Wrap a pure score result in the domain envelope; caller supplies the meta. */
export function toDecision(
  classifier: string,
  result: { decision: ScoreDecision; reasonCode: ReasonCode; confidence: number },
  meta: { latencyMs: number; fallbackUsed: boolean },
): {
  decision: ScoreDecision
  confidence: number
  reasonCode: ReasonCode
  classifier: string
  latencyMs: number
  fallbackUsed: boolean
} {
  return {
    decision: result.decision,
    confidence: result.confidence,
    reasonCode: result.reasonCode,
    classifier,
    latencyMs: meta.latencyMs,
    fallbackUsed: meta.fallbackUsed,
  }
}

// --- Effectful half (one Jev batch) ------------------------------------------

export interface ScoresInput {
  readonly subject: string
  readonly dimensions: readonly string[]
  readonly levels?: readonly string[]
}

/**
 * Ask about EVERY dimension in ONE `client.ask` call and fold the answers.
 * Deliberately not a loop: batching is the whole point of this seam.
 */
export const classifyScores = (input: {
  client: ClassifierClient.Interface
  model: string
  state: string
  subject: string
  dimensions: readonly string[]
  levels?: readonly string[]
}): Effect.Effect<
  { decision: ScoreDecision; reasonCode: ReasonCode; confidence: number; scores: ScoreResult },
  ClassifierClient.SystemOneError
> =>
  Effect.gen(function* () {
    const questions = buildScoreQuestions(input.subject, input.dimensions, input.levels ?? SCORE_LEVELS)
    const response = yield* input.client.ask({
      model: input.model,
      state: input.state,
      questions,
    })
    const scores = evaluateScores({
      answers: response.answers,
      dimensions: input.dimensions,
      levels: input.levels ?? SCORE_LEVELS,
    })
    return { ...toScoresResult(scores), scores }
  })
