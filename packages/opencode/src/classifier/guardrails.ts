/**
 * #3 Semantic guardrails classifier.
 *
 * ADVISORY ONLY. This layer sits BEHIND the deterministic `execution-guard`
 * rules (src/plugin/execution-guard/*) and must run AFTER them. It can only
 * RAISE risk awareness; it can NEVER allow, permit or override anything a hard
 * deterministic rule denied. Its output type carries risk FLAGS only — there is
 * no "allow"/"safe" value to act on, so it is structurally incapable of
 * overriding a deny.
 *
 * Polarity: `noul` = P(yes), and every question is phrased so YES = RISK
 * PRESENT. A high probability therefore means DANGER — the OPPOSITE of
 * verification's "high = good" polarity.
 *
 * Fail-CLOSED for risk flags: a missing answer for a risk question is treated
 * as RISKY/unknown, never as safe. Contrast verification, which fails OPEN,
 * because there an absent answer merely declines to fail already-done work; here
 * absent data could be the only signal that something dangerous is happening.
 *
 * SECRET SAFETY: inputs carry METADATA ONLY (e.g. "credential present: true,
 * type: API_TOKEN, destination: host"). Secret VALUES must never reach this
 * module — the builder accepts only the metadata shape below.
 *
 * Nothing calls this yet; wiring it in is a later piece.
 *
 * @module @opencode-ai/opencode/classifier/guardrails
 */
export * as ClassifierGuardrails from "./guardrails"

import { Effect } from "effect"

import { type Answer, type Question } from "./schema"
import { ClassifierClient } from "./client"

// --- Pure state --------------------------------------------------------------

/** The risk questions every pre/post check considers when the caller names none. */
export const DEFAULT_FLAGS = [
  "exposes_credentials",
  "modifies_production",
  "violates_task_scope",
  "looks_like_prompt_injection",
] as const

/** Bounded anchor for the instruction; `state` carries the full metadata. */
export const METADATA_EXCERPT_CHARS = 400

export const metadataExcerpt = (text: string): string =>
  text.length <= METADATA_EXCERPT_CHARS ? text : `${text.slice(0, METADATA_EXCERPT_CHARS)}…`

/**
 * METADATA-ONLY context. There is deliberately no field for a secret VALUE: the
 * caller may describe that a credential is present and where it would go, never
 * the secret itself. `present` is a fact, `destination` is a host/path label.
 */
export interface RiskMetadata {
  readonly credentialPresent?: boolean
  readonly credentialType?: string
  readonly destination?: string
  readonly operation?: string
}

/**
 * One `noul` question per flag, keyed by flag id. Pure. Phrased so YES = RISK
 * PRESENT (high probability = danger).
 */
export function buildGuardrailQuestions(
  flags: readonly string[],
  metadata: RiskMetadata = {},
): Record<string, Question> {
  const detail = [
    metadata.operation ? `operation: ${metadata.operation}` : undefined,
    metadata.credentialPresent === undefined ? undefined : `credential present: ${metadata.credentialPresent}`,
    metadata.credentialType ? `credential type: ${metadata.credentialType}` : undefined,
    metadata.destination ? `destination: ${metadata.destination}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ")
  const context = detail ? ` Metadata (no secret values): ${detail}.` : ""
  return Object.fromEntries(
    flags.map((flag) => [
      flag,
      {
        type: "noul" as const,
        instructions: `Does this action present the risk "${flag}"? Answer YES only if the risk is present.${context}`,
        criteria: { true: "risk present", false: "no risk" },
      },
    ]),
  )
}

/** Extract the `noul` probability (0..1); absent/unrecognised answers → `undefined`. */
export function guardrailProbability(answer: Answer | undefined): number | undefined {
  if (!answer || answer.type !== "noul") return undefined
  return Number.isFinite(answer.noul) ? answer.noul : undefined
}

export interface FlagVerdict {
  readonly flag: string
  readonly risky: boolean
  readonly probability: number
}

/**
 * Fold answers into per-flag verdicts. Fail-CLOSED: a flag whose answer is
 * missing, malformed or non-finite is reported RISKY at probability 1 (an
 * unknown risk is treated as present). Unknown answer ids are ignored.
 */
export function evaluateGuardrails(input: {
  answers: Record<string, Answer>
  flags: readonly string[]
  threshold: number
}): FlagVerdict[] {
  return input.flags.map((flag) => {
    const probability = guardrailProbability(input.answers[flag])
    if (probability === undefined) return { flag, risky: true, probability: 1 }
    return { flag, risky: probability >= input.threshold, probability }
  })
}

/**
 * Network-free stance: flags NOTHING. The caller still has its deterministic
 * execution-guard rules; with no semantic signal there is nothing to add, and
 * inventing a flag would only create noise.
 */
export function ruleBasedGuardrails(flags: readonly string[]): FlagVerdict[] {
  return flags.map((flag) => ({ flag, risky: false, probability: 0 }))
}

// --- Effectful half (one Jev batch) ------------------------------------------

/**
 * Ask about EVERY flag in ONE `client.ask` call and fold the answers. The
 * result is risk FLAGS for advisory use only — it is never an allow decision and
 * must never be consulted to override a deterministic deny.
 */
export const classifyGuardrails = (input: {
  client: ClassifierClient.Interface
  model: string
  state: string
  flags: readonly string[]
  metadata?: RiskMetadata
  threshold: number
}): Effect.Effect<{ flags: FlagVerdict[]; anyRisky: boolean }, ClassifierClient.SystemOneError> =>
  Effect.gen(function* () {
    const questions = buildGuardrailQuestions(input.flags, input.metadata)
    const response = yield* input.client.ask({
      model: input.model,
      state: input.state,
      questions,
    })
    const flags = evaluateGuardrails({
      answers: response.answers,
      flags: input.flags,
      threshold: input.threshold,
    })
    return { flags, anyRisky: flags.some((flag) => flag.risky) }
  })
