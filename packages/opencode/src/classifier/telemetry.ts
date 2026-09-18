/**
 * Classifier telemetry — plan §19 `classifier.decision`.
 *
 * Reuses the repo's existing Effect logging convention (`Effect.logInfo` with a
 * stable event name and a structured payload); it does NOT introduce a new sink.
 * `cacheHit` is carried for Phase 2 where answers may be memoized; it is always
 * false today.
 *
 * @module @opencode-ai/opencode/classifier/telemetry
 */
export * as ClassifierTelemetry from "./telemetry"

import { Effect } from "effect"

import type { ClassifierDecision, ReasonCode, RetryDecision } from "./schema"

export interface DecisionEventInput {
  decision: ClassifierDecision<RetryDecision>
  taskID?: string
  sessionID?: string
  attempt: number
  cached?: boolean
  /** Phase 2: whether the retry path actually acted on this verdict. */
  actedOn?: boolean
  /** Phase 2: why an eligible verdict was not acted upon (or why the loop continued). */
  overrideReason?: string
}

/** Emits one `classifier.decision` log line. Never fails; pure observation. */
export const decision = (input: DecisionEventInput): Effect.Effect<void> =>
  Effect.logInfo("classifier.decision", {
    classifier: input.decision.classifier,
    decision: input.decision.decision satisfies RetryDecision,
    confidence: input.decision.confidence,
    reasonCode: input.decision.reasonCode satisfies ReasonCode,
    latencyMs: input.decision.latencyMs,
    cached: input.cached ?? false,
    fallback: input.decision.fallbackUsed,
    attempt: input.attempt,
    ...(input.taskID ? { "task.id": input.taskID } : {}),
    ...(input.sessionID ? { "session.id": input.sessionID } : {}),
    ...(input.actedOn != null ? { actedOn: input.actedOn } : {}),
    ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
  })
