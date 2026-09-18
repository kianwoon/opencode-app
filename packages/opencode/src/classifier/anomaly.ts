/**
 * Trace-anomaly classifier (#9 anomaly detection over traces).
 *
 * The seam classifies a run/trace as normal/stuck/suspicious/expensive/off-policy
 * and whether it needs human review or is urgent — all in ONE batched request.
 * The trace carried in `state` is bounded (steps are excerpted), never a dump.
 *
 * Nothing calls this yet; wiring it into the loop is a later piece.
 *
 * @module @opencode-ai/opencode/classifier/anomaly
 */
export * as ClassifierAnomaly from "./anomaly"

import { Effect } from "effect"

import { type Answer, type Question } from "./schema"
import { ClassifierClient } from "./client"

// --- Pure state --------------------------------------------------------------

/** The anomaly classes a trace can be folded into. */
export const ANOMALY_CLASSES = ["normal", "stuck", "suspicious", "expensive", "off_policy"] as const

export const ANOMALY_KEYS = {
  class: "class",
  needsHumanReview: "needs_human_review",
  urgent: "urgent",
} as const

/** Keep the trace compact: at most this many steps, each excerpted. */
const MAX_STEPS = 40
const STEP_EXCERPT_CHARS = 200

/** Bound one step's text so a trace summarises rather than floods `state`. */
export const stepExcerpt = (text: string): string =>
  text.length <= STEP_EXCERPT_CHARS ? text : `${text.slice(0, STEP_EXCERPT_CHARS)}…`

/** A compact, bounded rendering of the trace — never the full trace. */
export const summarizeTrace = (steps: readonly string[]): string =>
  steps.slice(0, MAX_STEPS).map((step, index) => `${index}: ${stepExcerpt(step)}`).join("\n")

/**
 * The batched question map for a trace. One `choice` for the class plus two
 * `noul` questions phrased so YES means "needs review" / "urgent".
 */
export function buildAnomalyQuestions(input: { steps: readonly string[] }): Record<string, Question> {
  const trace = summarizeTrace(input.steps)
  return {
    [ANOMALY_KEYS.class]: {
      type: "choice",
      instructions: `Classify this agent trace as one class: ${ANOMALY_CLASSES.join(", ")}. Trace:\n${trace}`,
      criteria: Object.fromEntries(ANOMALY_CLASSES.map((cls) => [cls, cls])),
    },
    [ANOMALY_KEYS.needsHumanReview]: {
      type: "noul",
      instructions: `Does this trace need human review? Trace:\n${trace}`,
      criteria: { true: "needs review", false: "no review" },
    },
    [ANOMALY_KEYS.urgent]: {
      type: "noul",
      instructions: `Is this trace urgent (needs immediate attention)? Trace:\n${trace}`,
      criteria: { true: "urgent", false: "not urgent" },
    },
  }
}

/** Extract the `noul` probability (0..1); absent/unrecognised → `undefined`. */
export function anomalyProbability(answer: Answer | undefined): number | undefined {
  if (!answer || answer.type !== "noul") return undefined
  return Number.isFinite(answer.noul) ? answer.noul : undefined
}

const YES = 0.5

const yes = (answer: Answer | undefined): boolean => {
  const p = anomalyProbability(answer)
  return p !== undefined && p >= YES
}

export interface AnomalyResult {
  class: string
  needsHumanReview: boolean
  urgent: boolean
  confidence: number
}

/**
 * Fold answers into the anomaly verdict. Fail-open: an absent/unknown class ⇒
 * `"normal"`, absent `needs_human_review` ⇒ `false`, absent `urgent` ⇒ `false`
 * — we NEVER escalate (or spend a human's attention) on no signal. Confidence
 * is the class choice's confidence when present, else 0.
 */
export function evaluateAnomaly(input: { answers: Record<string, Answer> }): AnomalyResult {
  const classAnswer = input.answers[ANOMALY_KEYS.class]
  const rawClass = classAnswer?.type === "choice" ? classAnswer.choice : undefined
  const cls = (ANOMALY_CLASSES as readonly string[]).includes(rawClass ?? "") ? rawClass! : "normal"
  return {
    class: cls,
    needsHumanReview: yes(input.answers[ANOMALY_KEYS.needsHumanReview]),
    urgent: yes(input.answers[ANOMALY_KEYS.urgent]),
    confidence: classAnswer?.type === "choice" && Number.isFinite(classAnswer.confidence) ? classAnswer.confidence : 0,
  }
}

// --- Deterministic fallback --------------------------------------------------

/**
 * Network-free anomaly verdict: `"normal"`. There is no offline signal that can
 * justify escalation, so the safe deterministic answer is "nothing anomalous".
 */
export function ruleBasedAnomaly(): AnomalyResult {
  return { class: "normal", needsHumanReview: false, urgent: false, confidence: 0 }
}

// --- Effectful half (one Jev batch) ------------------------------------------

/**
 * Ask all anomaly questions in ONE `client.ask` call and fold the answers.
 * Deliberately not a loop: batching is the whole point of this seam.
 */
export const classifyAnomaly = (input: {
  client: ClassifierClient.Interface
  model: string
  state: string
  steps: readonly string[]
}): Effect.Effect<AnomalyResult, ClassifierClient.SystemOneError> =>
  Effect.gen(function* () {
    const questions = buildAnomalyQuestions({ steps: input.steps })
    const response = yield* input.client.ask({
      model: input.model,
      state: input.state,
      questions,
    })
    return evaluateAnomaly({ answers: response.answers })
  })
