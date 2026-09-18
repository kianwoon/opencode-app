/**
 * #2 Verification / judging classifier.
 *
 * After the main model acts, ask ONE batched `noul` question per check about
 * whether the produced artifact satisfies the request. N checks cost one
 * request — batching is the whole point, exactly like relevance.
 *
 * Polarity: `noul` = P(yes), and every question is phrased so YES = the GOOD
 * outcome (satisfied). A high probability therefore means "the artifact is
 * fine", the OPPOSITE of guardrails' risk polarity.
 *
 * Fail-OPEN: an absent or undecodable answer NEVER fails an artifact — it is
 * treated as satisfied. We do not block good work on missing signal.
 *
 * Nothing calls this yet; wiring it into the loop is a later piece.
 *
 * @module @opencode-ai/opencode/classifier/verification
 */
export * as ClassifierVerification from "./verification"

import { Effect } from "effect"

import { type Answer, type Question } from "./schema"
import { ClassifierClient } from "./client"

// --- Pure state --------------------------------------------------------------

/** The checks every artifact is judged against when the caller names none. */
export const DEFAULT_CHECKS = ["tests_passed", "addresses_request", "scope_matches", "no_unresolved_blocker"] as const

/** Bounded anchor for the instruction; `state` carries the whole artifact. */
export const ARTIFACT_EXCERPT_CHARS = 400

export const artifactExcerpt = (text: string): string =>
  text.length <= ARTIFACT_EXCERPT_CHARS ? text : `${text.slice(0, ARTIFACT_EXCERPT_CHARS)}…`

export interface VerificationContext {
  /** The user request the artifact must satisfy. */
  readonly task?: string
  /** The produced artifact; only a bounded excerpt enters the instructions. */
  readonly artifact?: string
}

/**
 * One `noul` question per check, keyed by check id. Pure: the only inputs are
 * the check list and an optional bounded context, so batching cost is visible
 * and testable at the call site. Phrased so YES = satisfied.
 */
export function buildVerificationQuestions(
  checks: readonly string[],
  context: VerificationContext = {},
): Record<string, Question> {
  const task = context.task ? ` Task: ${context.task}.` : ""
  const artifact = context.artifact ? ` Artifact excerpt: ${artifactExcerpt(context.artifact)}` : ""
  return Object.fromEntries(
    checks.map((check) => [
      check,
      {
        type: "noul" as const,
        instructions: `Verify the check "${check}" passed for the completed work.${task}${artifact}`,
        criteria: { true: "satisfied", false: "not satisfied" },
      },
    ]),
  )
}

/** Extract the `noul` probability (0..1); absent/unrecognised answers → `undefined`. */
export function verificationProbability(answer: Answer | undefined): number | undefined {
  if (!answer || answer.type !== "noul") return undefined
  return Number.isFinite(answer.noul) ? answer.noul : undefined
}

export type VerificationDecision = "PASS" | "FAIL" | "UNCERTAIN"

export interface CheckVerdict {
  readonly check: string
  readonly satisfied: boolean
  readonly probability: number
}

/**
 * Fold answers into per-check verdicts. Fail-OPEN: a check whose answer is
 * missing, malformed or non-finite is reported as SATISFIED at probability 1 —
 * absent data must never fail an artifact. Unknown answer ids are ignored.
 */
export function evaluateVerification(input: {
  answers: Record<string, Answer>
  checks: readonly string[]
  threshold: number
}): CheckVerdict[] {
  return input.checks.map((check) => {
    const probability = verificationProbability(input.answers[check])
    if (probability === undefined) return { check, satisfied: true, probability: 1 }
    return { check, satisfied: probability >= input.threshold, probability }
  })
}

/**
 * Collapse verdicts into the seam decision. An empty check list is UNCERTAIN,
 * not a vacuous PASS — no evidence was gathered.
 */
export function verdict(checked: readonly CheckVerdict[]): { decision: VerificationDecision; failed: string[] } {
  if (checked.length === 0) return { decision: "UNCERTAIN", failed: [] }
  const failed = checked.filter((entry) => !entry.satisfied).map((entry) => entry.check)
  if (failed.length > 0) return { decision: "FAIL", failed }
  return { decision: "PASS", failed: [] }
}

/**
 * Network-free stance: every check passes. Without a real signal there is no
 * evidence a check failed, and failing work on no signal is unacceptable.
 */
export function ruleBasedVerification(checks: readonly string[]): CheckVerdict[] {
  return checks.map((check) => ({ check, satisfied: true, probability: 1 }))
}

// --- Effectful half (one Jev batch) ------------------------------------------

/**
 * Ask about EVERY check in ONE `client.ask` call and fold the answers.
 * Deliberately not a loop: batching is the whole point of this seam.
 */
export const classifyVerification = (input: {
  client: ClassifierClient.Interface
  model: string
  state: string
  artifact?: string
  checks: readonly string[]
  threshold: number
}): Effect.Effect<
  { decision: VerificationDecision; failed: string[]; checked: CheckVerdict[] },
  ClassifierClient.SystemOneError
> =>
  Effect.gen(function* () {
    const questions = buildVerificationQuestions(input.checks, { task: input.state, artifact: input.artifact })
    const response = yield* input.client.ask({
      model: input.model,
      state: input.state,
      questions,
    })
    const checked = evaluateVerification({
      answers: response.answers,
      checks: input.checks,
      threshold: input.threshold,
    })
    return { ...verdict(checked), checked }
  })
