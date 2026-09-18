/**
 * State-extraction classifier (decision seam #4).
 *
 * Turn messy agent state into COMPACT STRUCTURED FACTS rather than free-form
 * prose: one batched `choice` question per categorical field plus one `noul`
 * (P(yes)) question per boolean flag. This is the first real construction of the
 * `choice` wire primitive. N fields cost one request; the decisive logic is PURE
 * and fail-open — a missing or malformed answer simply omits that fact.
 *
 * Nothing calls this yet; wiring it into the loop is a later piece.
 *
 * @module @opencode-ai/opencode/classifier/state-extraction
 */
export * as ClassifierStateExtraction from "./state-extraction"

import { Effect } from "effect"

import { type Answer, type ExtractionDecision, type ReasonCode } from "./schema"
import { ClassifierClient } from "./client"

// --- Pure state --------------------------------------------------------------

/** Categorical fields and the explicit label set the model must choose from. */
export const KNOWN_FIELD_OPTIONS: Record<string, readonly string[]> = {
  task_type: ["bugfix", "feature", "refactor", "investigation", "other"],
  error_category: ["compile", "test", "runtime", "network", "permission", "other"],
  deployment_target: ["local", "staging", "production", "other"],
  user_intent: ["ask", "implement", "review", "explain", "other"],
}

/** Boolean flags asked as `noul` (calibrated P(yes)). */
export const KNOWN_FLAGS = ["has_test_failure", "has_unresolved_blocker", "risk_flag"] as const

/** Label set for a field: the known table, else a generic yes/no/unclear trio. */
export const fieldOptions = (field: string): readonly string[] =>
  KNOWN_FIELD_OPTIONS[field] ?? ["yes", "no", "unclear"]

/**
 * One `choice` question per categorical field (keyed by field name) plus one
 * `noul` question per boolean flag. Pure: the ONLY inputs are the two lists.
 */
export function buildExtractionQuestions(
  fields: readonly string[],
  flags: readonly string[] = KNOWN_FLAGS,
): Record<
  string,
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
> {
  const choices = Object.fromEntries(
    fields.map((field) => [
      field,
      {
        type: "choice" as const,
        instructions: `Classify the ${field} of the agent state. Choose exactly one option.`,
        criteria: Object.fromEntries(fieldOptions(field).map((option) => [option, option])),
      },
    ]),
  )
  const bools = Object.fromEntries(
    flags.map((flag) => [
      flag,
      {
        type: "noul" as const,
        instructions: `What is the probability that ${flag} is true for the agent state?`,
        criteria: { true: flag, false: `not ${flag}` },
      },
    ]),
  )
  return { ...choices, ...bools }
}

/** Extract a `choice` key; absent/unrecognised answers → `undefined`. */
export function choiceField(answer: Answer | undefined, options: readonly string[]): string | undefined {
  if (!answer || answer.type !== "choice") return undefined
  return options.includes(answer.choice) ? answer.choice : undefined
}

/** Extract a boolean from a `noul` P(yes) at the 0.5 midpoint; absent → `undefined`. */
export function flagFromAnswer(answer: Answer | undefined): boolean | undefined {
  if (!answer || answer.type !== "noul") return undefined
  return Number.isFinite(answer.noul) ? answer.noul >= 0.5 : undefined
}

export interface ExtractionResult {
  readonly fields: Record<string, string>
  readonly flags: Record<string, boolean>
}

/**
 * Fold answers into the compact typed struct. Fail-open: a field/flag whose
 * answer is missing or malformed is omitted, never fabricated, never a throw.
 */
export function evaluateExtraction(input: {
  answers: Record<string, Answer>
  fields: readonly string[]
  flags: readonly string[]
}): ExtractionResult {
  const fields: Record<string, string> = {}
  for (const field of input.fields) {
    const value = choiceField(input.answers[field], fieldOptions(field))
    if (value !== undefined) fields[field] = value
  }
  const flags: Record<string, boolean> = {}
  for (const flag of input.flags) {
    const value = flagFromAnswer(input.answers[flag])
    if (value !== undefined) flags[flag] = value
  }
  return { fields, flags }
}

/** Collapse an extraction into the seam decision; empty → fail-open `UNSURE`. */
export function toExtractionResult(result: ExtractionResult): {
  decision: ExtractionDecision
  reasonCode: ReasonCode
  confidence: number
} {
  const extracted = Object.keys(result.fields).length + Object.keys(result.flags).length
  if (extracted === 0) return { decision: "UNSURE", reasonCode: "FACTS_UNKNOWN", confidence: 0 }
  return { decision: "EXTRACTED", reasonCode: "FACTS_EXTRACTED", confidence: 1 }
}

/** Deterministic no-network extraction: no facts, no throws. */
export const ruleBasedExtraction = (): ExtractionResult => ({ fields: {}, flags: {} })

// --- Effectful half (one Jev batch) ------------------------------------------

/**
 * Ask about EVERY field and flag in ONE `client.ask` call and fold the answers.
 * Deliberately not a loop: batching is the whole point of this seam.
 */
export const classifyExtraction = (input: {
  client: ClassifierClient.Interface
  model: string
  state: string
  fields: readonly string[]
  flags?: readonly string[]
}): Effect.Effect<
  { decision: ExtractionDecision; reasonCode: ReasonCode; confidence: number; extraction: ExtractionResult },
  ClassifierClient.SystemOneError
> =>
  Effect.gen(function* () {
    const flags = input.flags ?? KNOWN_FLAGS
    const questions = buildExtractionQuestions(input.fields, flags)
    const response = yield* input.client.ask({
      model: input.model,
      state: input.state,
      questions,
    })
    const extraction = evaluateExtraction({
      answers: response.answers,
      fields: input.fields,
      flags,
    })
    return { ...toExtractionResult(extraction), extraction }
  })
