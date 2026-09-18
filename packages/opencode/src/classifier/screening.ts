/**
 * Candidate-screening classifier (#6 filtering / screening).
 *
 * The seam aggressively reduces a large candidate set BEFORE any expensive
 * model call: ONE batched `score` question per candidate, ranked, top-K kept.
 * N candidates cost one request, exactly like the retry/relevance batches.
 *
 * Nothing calls this yet; wiring it into the loop is a later piece.
 *
 * @module @opencode-ai/opencode/classifier/screening
 */
export * as ClassifierScreening from "./screening"

import { Effect } from "effect"

import { type Answer, type Question } from "./schema"
import { ClassifierClient } from "./client"

// --- Pure state --------------------------------------------------------------

/** One addressable candidate competing for the top-K budget. */
export interface ScreeningCandidate {
  readonly id: string
  readonly text: string
}

/** Ordered level vocabulary; the index is the `score` value. */
export const SCREENING_LEVELS = ["irrelevant", "marginal", "useful", "essential"] as const

/** How much of a candidate's text may travel inside the question instruction. */
const CANDIDATE_EXCERPT_CHARS = 200

/**
 * A candidate can be huge, so the question carries a bounded EXCERPT rather than
 * the whole text: `state` holds the same fuller material, so inlining it again
 * would double the request for no extra signal.
 */
export const candidateExcerpt = (text: string): string =>
  text.length <= CANDIDATE_EXCERPT_CHARS ? text : `${text.slice(0, CANDIDATE_EXCERPT_CHARS)}…`

/**
 * One `score` question per candidate, keyed by id. Pure: the ONLY input is the
 * candidate list, so batching costs are visible and testable at the call site.
 */
export function buildScreeningQuestions(
  task: string,
  candidates: readonly ScreeningCandidate[],
): Record<string, Question> {
  return Object.fromEntries(
    candidates.map((candidate) => [
      candidate.id,
      {
        type: "score" as const,
        instructions: `Rate the utility of candidate "${candidate.id}" toward the current task: ${task}. Candidate excerpt: ${candidateExcerpt(candidate.text)}`,
        criteria: [...SCREENING_LEVELS],
      },
    ]),
  )
}

/** Extract the `score` level; absent/malformed answers → `undefined`. */
export function screeningScore(answer: Answer | undefined): number | undefined {
  if (!answer || answer.type !== "score") return undefined
  return Number.isFinite(answer.score) ? answer.score : undefined
}

/** The level label for a numeric score, from the answer legend or the vocabulary. */
const levelFor = (answer: Answer | undefined, score: number): string => {
  const label = answer?.type === "score" ? answer.legend[String(score)] : undefined
  return label ?? SCREENING_LEVELS[score] ?? "irrelevant"
}

export interface ScreeningVerdict {
  id: string
  score: number
  level: string
}

/**
 * Rank candidates by score (descending) and return the top `keep`. Fail-open:
 * an answer that is missing or malformed gets the LOWEST score (-1) so it is
 * NOT promoted — never throw. This is deliberate: screening exists to reduce
 * cost, so an unreadable candidate should not consume a top-K slot on no
 * evidence. Ties keep input order (stable).
 */
export function evaluateScreening(input: {
  answers: Record<string, Answer>
  candidates: readonly ScreeningCandidate[]
  keep: number
}): ScreeningVerdict[] {
  const ranked = input.candidates.map((candidate, index) => {
    const answer = input.answers[candidate.id]
    const score = screeningScore(answer)
    return {
      id: candidate.id,
      // Missing answer ⇒ low score so it is not promoted (fail-open to exclusion).
      score: score ?? -1,
      level: score === undefined ? "irrelevant" : levelFor(answer, score),
      index,
    }
  })
  ranked.sort((a, b) => b.score - a.score || a.index - b.index)
  return ranked.slice(0, Math.max(0, input.keep)).map(({ id, score, level }) => ({ id, score, level }))
}

// --- Deterministic fallback --------------------------------------------------

/**
 * Network-free screening: keep the first `keep` candidates in input order. There
 * is no offline signal that ranks candidates, so this is a stable truncation
 * that never throws and never reorders.
 */
export function ruleBasedScreening(
  candidates: readonly ScreeningCandidate[],
  keep: number,
): ScreeningVerdict[] {
  return candidates
    .slice(0, Math.max(0, keep))
    .map((candidate) => ({ id: candidate.id, score: 0, level: SCREENING_LEVELS[0] }))
}

// --- Effectful half (one Jev batch) ------------------------------------------

/**
 * Ask about EVERY candidate in ONE `client.ask` call and fold the answers.
 * Deliberately not a loop: batching is the whole point of this seam.
 */
export const classifyScreening = (input: {
  client: ClassifierClient.Interface
  model: string
  state: string
  task: string
  candidates: readonly ScreeningCandidate[]
  keep: number
}): Effect.Effect<ScreeningVerdict[], ClassifierClient.SystemOneError> =>
  Effect.gen(function* () {
    const questions = buildScreeningQuestions(input.task, input.candidates)
    const response = yield* input.client.ask({
      model: input.model,
      state: input.state,
      questions,
    })
    return evaluateScreening({
      answers: response.answers,
      candidates: input.candidates,
      keep: input.keep,
    })
  })
