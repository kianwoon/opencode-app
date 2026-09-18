/**
 * Best-candidate matching classifier (#5 matching).
 *
 * The seam selects the single BEST option for the current need from a set
 * (tool / subagent / skill / memory / retrieval item), in ONE batched request.
 * N options cost one request, exactly like the retry/relevance batches.
 *
 * Small sets use a single `choice` over option ids (exact-one semantics, cheap
 * and unambiguous). Large sets (> 8) use one `score` per option and rank, since
 * a many-option choice list is fragile and gives no ordering signal.
 *
 * Nothing calls this yet; wiring it into the loop is a later piece.
 *
 * @module @opencode-ai/opencode/classifier/matching
 */
export * as ClassifierMatching from "./matching"

import { Effect } from "effect"

import { type Answer, type Question } from "./schema"
import { ClassifierClient } from "./client"

// --- Pure state --------------------------------------------------------------

/** One candidate option competing to be the match. */
export interface MatchOption {
  readonly id: string
  readonly description: string
}

/** Above this many options, ranking scores beat a single choice list. */
export const CHOICE_MAX_OPTIONS = 8

/** Ordered relevance levels; the index is the `score` value. */
export const MATCH_LEVELS = ["irrelevant", "marginal", "useful", "essential"] as const

/** Question key used by the `choice` strategy (large sets use option ids). */
export const MATCH_CHOICE_KEY = "match"

const DESCRIPTION_EXCERPT_CHARS = 200

/** Bound the excerpt carried in the instruction; `state` holds the fuller text. */
export const optionExcerpt = (text: string): string =>
  text.length <= DESCRIPTION_EXCERPT_CHARS ? text : `${text.slice(0, DESCRIPTION_EXCERPT_CHARS)}…`

/** The strategy chosen for an option set: small ⇒ `choice`, large ⇒ `score`. */
export type MatchMode = "choice" | "score"

export const matchMode = (options: readonly MatchOption[]): MatchMode =>
  options.length <= CHOICE_MAX_OPTIONS ? "choice" : "score"

/**
 * The batched question map for a need/option set. Pure: the ONLY input is the
 * option list, so the chosen strategy and cost are visible at the call site.
 */
export function buildMatchQuestions(need: string, options: readonly MatchOption[]): Record<string, Question> {
  if (options.length === 0) return {}
  if (matchMode(options) === "choice") {
    return {
      [MATCH_CHOICE_KEY]: {
        type: "choice",
        instructions: `Pick the single best-matching option for this need: ${need}. Options: ${options
          .map((option) => `${option.id}=${optionExcerpt(option.description)}`)
          .join("; ")}`,
        criteria: Object.fromEntries(options.map((option) => [option.id, optionExcerpt(option.description)])),
      },
    }
  }
  return Object.fromEntries(
    options.map((option) => [
      option.id,
      {
        type: "score" as const,
        instructions: `Rate the relevance of option "${option.id}" to this need: ${need}. Option: ${optionExcerpt(option.description)}`,
        criteria: [...MATCH_LEVELS],
      },
    ]),
  )
}

/** Extract the `score` level; absent/malformed answers → `undefined`. */
export function matchScore(answer: Answer | undefined): number | undefined {
  if (!answer || answer.type !== "score") return undefined
  return Number.isFinite(answer.score) ? answer.score : undefined
}

export interface MatchResult {
  winner: MatchOption | undefined
  ranked: { id: string; score: number }[]
}

/**
 * Fold answers into a ranked list plus the single winner. Fail-open: with no
 * confident winner the result is `winner: undefined` ("no match") — the seam
 * NEVER guesses. A `choice` answer names the winner directly (if it is a real
 * option id); a `score` batch needs a top score above the lowest level (> 0).
 */
export function evaluateMatch(input: {
  answers: Record<string, Answer>
  options: readonly MatchOption[]
}): MatchResult {
  const mode = matchMode(input.options)
  const byId = new Map(input.options.map((option) => [option.id, option]))

  if (mode === "choice") {
    const answer = input.answers[MATCH_CHOICE_KEY]
    const chosen = answer?.type === "choice" ? byId.get(answer.choice) : undefined
    // An unrecognised or absent choice is not a match — fail open.
    return {
      winner: chosen,
      ranked: chosen ? [{ id: chosen.id, score: 1 }] : [],
    }
  }

  const ranked = input.options
    .map((option, index) => ({
      id: option.id,
      score: matchScore(input.answers[option.id]) ?? -1,
      index,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ id, score }) => ({ id, score }))

  // Score 0 is the lowest level ("irrelevant"): treat it as no signal.
  const top = ranked[0]
  const winner = top && top.score > 0 ? byId.get(top.id) : undefined
  return { winner, ranked }
}

// --- Deterministic fallback --------------------------------------------------

/**
 * Network-free matching: there is no offline signal that ranks options, so the
 * safe deterministic answer is "no match" (`undefined`) — never a guess.
 */
export function ruleBasedMatch(): MatchResult {
  return { winner: undefined, ranked: [] }
}

// --- Effectful half (one Jev batch) ------------------------------------------

/**
 * Ask about the options in ONE `client.ask` call and fold the answers.
 * Deliberately not a loop: batching is the whole point of this seam.
 */
export const classifyMatch = (input: {
  client: ClassifierClient.Interface
  model: string
  state: string
  need: string
  options: readonly MatchOption[]
}): Effect.Effect<MatchResult, ClassifierClient.SystemOneError> =>
  Effect.gen(function* () {
    const questions = buildMatchQuestions(input.need, input.options)
    const response = yield* input.client.ask({
      model: input.model,
      state: input.state,
      questions,
    })
    return evaluateMatch({ answers: response.answers, options: input.options })
  })
