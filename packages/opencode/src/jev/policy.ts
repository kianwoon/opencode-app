import {
  JEV_DEFAULT_NOUL_THRESHOLD,
  JEV_DEFAULT_THRESHOLD,
  type JevChoiceDecision,
  type JevNoulDecision,
  type JevParsedDecision,
  type JevScoreDecision,
  type JevUnavailableReason,
} from "./client.ts"

export type BrainPolicyAction = "continue" | "verify" | "switch" | "finish" | "contradiction" | "escalate"
export type BrainPolicySource = "choice" | "noul" | "fallback"
export type BrainPolicyReason = "choice-accepted" | "noul-rejected" | "choice-rejected" | "choice-not-allowed" | "choice-unavailable"

export interface BrainPolicyInput {
  readonly choice?: JevParsedDecision
  readonly score?: JevParsedDecision
  readonly noul?: JevParsedDecision
  readonly allowedActions: readonly BrainPolicyAction[]
  readonly fallbackAction: BrainPolicyAction
  readonly choiceThreshold?: number
  readonly noulThreshold?: number
}

export interface BrainPolicyDecisions {
  readonly choice?: JevChoiceDecision
  readonly score?: JevScoreDecision
  readonly noul?: JevNoulDecision
}

export interface BrainPolicyUnavailable {
  readonly question: "choice" | "score" | "noul"
  readonly reason: JevUnavailableReason
}

export interface BrainPolicyResult {
  readonly action: BrainPolicyAction
  readonly source: BrainPolicySource
  readonly reason: BrainPolicyReason
  /** Only validated decisions are retained; raw rows are never returned. */
  readonly decisions: BrainPolicyDecisions
  readonly unavailable: readonly BrainPolicyUnavailable[]
}

const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

const isBrainPolicyAction = (value: string): value is BrainPolicyAction =>
  value === "continue" ||
  value === "verify" ||
  value === "switch" ||
  value === "finish" ||
  value === "contradiction" ||
  value === "escalate"

const parsedDecisions = (
  choice: BrainPolicyInput["choice"],
  score: BrainPolicyInput["score"],
  noul: BrainPolicyInput["noul"],
): BrainPolicyDecisions => ({
  ...(choice?.type === "choice" ? { choice } : {}),
  ...(score?.type === "score" ? { score } : {}),
  ...(noul?.type === "noul" ? { noul } : {}),
})

const unavailableMetadata = (
  choice: BrainPolicyInput["choice"],
  score: BrainPolicyInput["score"],
  noul: BrainPolicyInput["noul"],
): readonly BrainPolicyUnavailable[] => [
  ...(choice?.type === "unavailable" ? [{ question: "choice" as const, reason: choice.reason }] : []),
  ...(score?.type === "unavailable" ? [{ question: "score" as const, reason: score.reason }] : []),
  ...(noul?.type === "unavailable" ? [{ question: "noul" as const, reason: noul.reason }] : []),
]

/**
 * Resolve a bounded brain action from typed JEV rows.
 *
 * Noul is a fail-closed numeric prefilter only when it is valid. Choice is the
 * measured routing gate; score is retained as advisory metadata and never
 * influences the returned action. Unavailable rows are not guessed or repaired.
 */
export function resolveBrainPolicy(input: BrainPolicyInput): BrainPolicyResult {
  const decisions = parsedDecisions(input.choice, input.score, input.noul)
  const unavailable = unavailableMetadata(input.choice, input.score, input.noul)
  const noulThreshold = finiteOr(input.noulThreshold, JEV_DEFAULT_NOUL_THRESHOLD)
  const choiceThreshold = finiteOr(input.choiceThreshold, JEV_DEFAULT_THRESHOLD)
  const allowed = new Set(input.allowedActions)
  const fallback = (source: BrainPolicySource, reason: BrainPolicyReason): BrainPolicyResult => ({
    action: input.fallbackAction,
    source,
    reason,
    decisions,
    unavailable,
  })

  const noul = input.noul
  if (
    noul?.type === "noul" &&
    typeof noul.noul === "number" &&
    Number.isFinite(noul.noul) &&
    noul.noul >= 0 &&
    noul.noul <= 1 &&
    noul.noul < noulThreshold
  ) {
    return fallback("noul", "noul-rejected")
  }

  if (input.choice?.type === "choice") {
    const choice = input.choice
    if (!isBrainPolicyAction(choice.choice) || !Number.isFinite(choice.probability)) {
      return fallback("fallback", "choice-unavailable")
    }
    if (!allowed.has(choice.choice)) return fallback("fallback", "choice-not-allowed")
    if (choice.probability < choiceThreshold) return fallback("fallback", "choice-rejected")
    return { action: choice.choice, source: "choice", reason: "choice-accepted", decisions, unavailable }
  }

  return fallback("fallback", "choice-unavailable")
}

export const resolveJevPolicy = resolveBrainPolicy

export type BrainPolicyResolverInput = BrainPolicyInput
export type BrainPolicyResolverResult = BrainPolicyResult
