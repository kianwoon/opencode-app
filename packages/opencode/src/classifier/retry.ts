/**
 * Retry / death-spiral classifier.
 *
 * The decisive logic is PURE: `buildDecisionState`, fingerprint helpers, and
 * `evaluateThresholds` take plain data and return plain data. That keeps the
 * deterministic `RuleBasedClassifier` usable with no network and makes the
 * threshold boundaries trivially testable.
 *
 * The EFFECTFUL half (`classifyRetry`) is only responsible for asking Jev the
 * plan's multi-question batch in ONE call — all questions ride the same `state`
 * and are evaluated in parallel — then handing the answers to the pure mapping.
 *
 * @module @opencode-ai/opencode/classifier/retry
 */
export * as ClassifierRetry from "./retry"

import { Effect } from "effect"

import {
  type ClassifierDecision,
  type ReasonCode,
  type RetryDecision,
  type Answer,
} from "./schema"
import { ClassifierClient } from "./client"

// --- Pure state --------------------------------------------------------------

/**
 * Shadow-run gate. Config is authoritative (user-facing switch); the env flag is
 * a dev force-on escape. Pure so the exact predicate `processor.ts` evaluates at
 * the fork site is directly testable.
 */
export const shadowEnabled = (input: { enabled: boolean | undefined; flag: boolean }): boolean =>
  input.enabled === true || input.flag

/**
 * Classifier model precedence. The Settings → Orchestration model row writes
 * `brain.classifier_model`, so it must win over the explicit `classifier.model`;
 * an explicit argument outranks both. Empty strings count as absent.
 * Pure so both read sites share exactly one precedence implementation.
 */
export const resolveClassifierModel = (input: {
  override?: string | undefined
  brainModel?: string | undefined
  classifierModel?: string | undefined
}): string | undefined =>
  [input.override, input.brainModel, input.classifierModel].find((model) => model != null && model !== "")

export interface FailureRecord {
  /** Stable fingerprint of error+action,+result — the repeat detector. */
  signature: string
  count: number
}

export interface DecisionState {
  goal: string
  step: number
  latestAction: string
  latestResult: string
  previousFailures: FailureRecord[]
  progressSignals: string[]
  changedResources: string[]
}

export interface DecisionStateInput {
  goal: string
  step: number
  latestAction: string
  latestResult: string
  previousFailures?: FailureRecord[]
  progressSignals?: string[]
  changedResources?: string[]
}

/**
 * Deterministic fingerprint of the (error, action, result) triple. Two failures
 * collide only when all three inputs are byte-identical, which is exactly the
 * "repeated the exact same thing" signal we want.
 */
export function fingerprint(input: { error?: string; action?: string; result?: string }): string {
  // djb2 — small, stable, dependency-free; collisions are acceptable here
  // because we feed the same triple shape every time.
  const text = `${input.error ?? ""}\u0000${input.action ?? ""}\u0000${input.result ?? ""}`
  let hash = 5381
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16)
}

/** Compress the live loop context into the bounded `state` we send to Jev. */
export function buildDecisionState(input: DecisionStateInput): DecisionState {
  return {
    goal: input.goal,
    step: input.step,
    latestAction: input.latestAction,
    latestResult: input.latestResult,
    previousFailures: input.previousFailures ?? [],
    progressSignals: input.progressSignals ?? [],
    changedResources: input.changedResources ?? [],
  }
}

/** True when a signature has now failed at least twice. */
export function repeatedExactFailure(state: DecisionState, signature: string): boolean {
  return state.previousFailures.some((failure) => failure.signature === signature && failure.count >= 2)
}

/** Highest repeat count for any single fingerprint in the state. */
export function maxFailureCount(state: DecisionState): number {
  return state.previousFailures.reduce((max, failure) => Math.max(max, failure.count), 0)
}

// --- Pure threshold evaluation ----------------------------------------------

export interface Thresholds {
  /** Minimum confidence for `retry_switch.accept` to change a RETRY into a switch. */
  retry_switch: {
    accept: number
  }
  /** Minimum confidence for a STOP/ESCALATE verdict to actually halt retries. */
  retry_act: {
    accept: number
  }
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  retry_switch: { accept: 0.8 },
  retry_act: { accept: 0.8 },
}

/** Per-question answer signals the effectful half reads off the Jev response. */
export interface RetrySignals {
  progressMade: number
  newInformation: number
  sameStrategy: number
  strategyExhausted: number
  retryUseful: number
  switchModel: number
}

export interface ThresholdInput {
  state: DecisionState
  signals: RetrySignals
  attempt: number
  maxAttempts: number
  thresholds: Thresholds
}

/**
 * Deterministic §6 guardrails, evaluated BEFORE any probability threshold:
 *  - attempt 1 → always CONTINUE (too early to judge);
 *  - attempt >= max → STOP;
 *  - the same exact failure repeated >= 3 times → prohibit a blind RETRY.
 * Only then does a calibrated signal choose among RETRY / STRATEGY / MODEL.
 */
export function evaluateThresholds(input: ThresholdInput): { decision: RetryDecision; reasonCode: ReasonCode; confidence: number } {
  const { state, signals, attempt, maxAttempts, thresholds } = input

  if (attempt >= maxAttempts) {
    return { decision: "STOP", reasonCode: "MAX_ATTEMPTS", confidence: 1 }
  }
  if (attempt <= 1) {
    return { decision: "CONTINUE", reasonCode: "PROGRESS_MADE", confidence: 1 }
  }

  const blindRetryProhibited = maxFailureCount(state) >= 3
  const repeat = signals.sameStrategy >= thresholds.retry_switch.accept
  const exhausted = signals.strategyExhausted >= thresholds.retry_switch.accept

  if (progressMade(signals) && !blindRetryProhibited) {
    return { decision: "CONTINUE", reasonCode: "PROGRESS_MADE", confidence: signals.progressMade }
  }
  if (signals.newInformation >= thresholds.retry_switch.accept && !exhausted && !blindRetryProhibited) {
    return { decision: "RETRY", reasonCode: "NEW_INFORMATION", confidence: signals.newInformation }
  }
  if (signals.switchModel >= thresholds.retry_switch.accept) {
    return { decision: "SWITCH_MODEL", reasonCode: "MODEL_INCAPABLE", confidence: signals.switchModel }
  }
  if (exhausted || repeat) {
    return { decision: "SWITCH_STRATEGY", reasonCode: "STRATEGY_EXHAUSTED", confidence: Math.max(signals.strategyExhausted, signals.sameStrategy) }
  }
  if (blindRetryProhibited || signals.retryUseful < thresholds.retry_switch.accept) {
    return { decision: "ESCALATE", reasonCode: "NO_PROGRESS_REPEATED_FAILURE", confidence: 1 - signals.retryUseful }
  }
  return { decision: "RETRY", reasonCode: "NEW_INFORMATION", confidence: signals.retryUseful }
}

/** A `noul` signal counts as "progress" above the midpoint. */
const progressMade = (signals: RetrySignals) => signals.progressMade >= 0.5

/**
 * Pure gate for Phase 2 actuation. Only STOP/ESCALATE may halt retries (strategy
 * switching is out of scope); a fallback verdict and an unknown confidence never
 * act, so the seam stays fail-open.
 */
export const shouldActOnRetry = (input: {
  decision: RetryDecision
  confidence: number
  threshold: number
  fallbackUsed?: boolean
}): boolean => {
  if (input.decision !== "STOP" && input.decision !== "ESCALATE") return false
  if (input.fallbackUsed === true) return false
  if (!Number.isFinite(input.confidence)) return false
  return input.confidence >= input.threshold
}

// --- Deterministic fallback classifier ---------------------------------------

export interface RetryInput {
  state: DecisionState
  attempt: number
  maxAttempts: number
  thresholds: Thresholds
}

/**
 * Network-free decision. Encodes the same §6 guardrails with no probability
 * signals: any repeat >= 2 with progress ≤ 0 escalates, and attempt 1 / max
 * bounds are honored. This is the safety fallback when Jev is unavailable.
 */
export function ruleBasedDecision(input: RetryInput): { decision: RetryDecision; reasonCode: ReasonCode; confidence: number } {
  const { state, attempt, maxAttempts } = input
  if (attempt >= maxAttempts) return { decision: "STOP", reasonCode: "MAX_ATTEMPTS", confidence: 1 }
  if (attempt <= 1) return { decision: "CONTINUE", reasonCode: "PROGRESS_MADE", confidence: 1 }

  const maxCount = maxFailureCount(state)
  if (maxCount >= 3) {
    return { decision: "ESCALATE", reasonCode: "NO_PROGRESS_REPEATED_FAILURE", confidence: 1 }
  }
  if (state.progressSignals.length > 0) {
    return { decision: "CONTINUE", reasonCode: "PROGRESS_MADE", confidence: 1 }
  }
  if (maxCount >= 2) {
    // classifier required: we cannot tell strategy from model failure offline
    return { decision: "ESCALATE", reasonCode: "REPEATED_EXACT_FAILURE", confidence: 1 }
  }
  return { decision: "RETRY", reasonCode: "NEW_INFORMATION", confidence: 1 }
}

/**
 * Wrap a pure decision in the domain envelope. `fallbackUsed` and `latencyMs`
 * are supplied by the caller so this stays pure and testable.
 */
export function toDecision(
  classifier: string,
  result: { decision: RetryDecision; reasonCode: ReasonCode; confidence: number },
  meta: { latencyMs: number; fallbackUsed: boolean },
): ClassifierDecision<RetryDecision> {
  return {
    decision: result.decision,
    confidence: result.confidence,
    reasonCode: result.reasonCode,
    classifier,
    latencyMs: meta.latencyMs,
    fallbackUsed: meta.fallbackUsed,
  }
}

// --- Effectful half (Jev batch) ---------------------------------------------

export interface RetryQuestionSpec {
  readonly instructions: string
  readonly criteria: { readonly true: string; readonly false: string }
}

/**
 * The plan §6 question batch. All ride ONE request; isolation means adding
 * questions costs almost nothing, so we ask the full set every time.
 */
export const RETRY_QUESTIONS: Record<string, RetryQuestionSpec> = {
  progressMade: {
    instructions: "Did the latest action make measurable progress toward the goal?",
    criteria: { true: "yes", false: "no" },
  },
  newInformation: {
    instructions: "Did the latest result reveal new information that changes the next attempt?",
    criteria: { true: "yes", false: "no" },
  },
  sameStrategy: {
    instructions: "Is the next attempt likely to repeat the same strategy that already failed?",
    criteria: { true: "yes", false: "no" },
  },
  strategyExhausted: {
    instructions: "Have the plausible variations of the current strategy been exhausted?",
    criteria: { true: "yes", false: "no" },
  },
  retryUseful: {
    instructions: "Would a plain retry of the exact same action reasonably succeed?",
    criteria: { true: "yes", false: "no" },
  },
  switchModel: {
    instructions: "Is the current model plausibly incapable, such that switching models is warranted?",
    criteria: { true: "yes", false: "no" },
  },
}

/** Extract the `noul` score (0..1) from an answer; missing answers → 0. */
export function signalFromAnswer(answer: Answer | undefined): number {
  if (!answer) return 0
  if (answer.type === "noul") return answer.noul
  if (answer.type === "score") return answer.score
  // choice answers carry probabilities; use the max as a soft signal
  return Math.max(0, ...Object.values(answer.probabilities))
}

export const classifyRetry = (input: {
  client: ClassifierClient.Interface
  model: string
  state: DecisionState
  attempt: number
  maxAttempts: number
  thresholds: Thresholds
}): Effect.Effect<
  { decision: RetryDecision; reasonCode: ReasonCode; confidence: number },
  ClassifierClient.SystemOneError
> =>
  Effect.gen(function* () {
    const response = yield* input.client.ask({
      model: input.model,
      state: JSON.stringify(input.state),
      questions: Object.fromEntries(
        Object.entries(RETRY_QUESTIONS).map(([name, spec]) => [
          name,
          { type: "noul" as const, instructions: spec.instructions, criteria: spec.criteria },
        ]),
      ),
    })
    const signals: RetrySignals = {
      progressMade: signalFromAnswer(response.answers.progressMade),
      newInformation: signalFromAnswer(response.answers.newInformation),
      sameStrategy: signalFromAnswer(response.answers.sameStrategy),
      strategyExhausted: signalFromAnswer(response.answers.strategyExhausted),
      retryUseful: signalFromAnswer(response.answers.retryUseful),
      switchModel: signalFromAnswer(response.answers.switchModel),
    }
    return evaluateThresholds({
      signals,
      state: input.state,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      thresholds: input.thresholds,
    })
  })

