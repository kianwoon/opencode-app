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

import type { ClassifierDecision, ReasonCode, RetryDecision, RelevanceDecision } from "./schema"

/** Any seam verdict: retry today, relevance (and future seams) alongside it. */
export type AnyDecision = ClassifierDecision<RetryDecision | RelevanceDecision>

export interface DecisionEventInput {
  decision: AnyDecision
  taskID?: string
  sessionID?: string
  /**
   * Retry-family seams only. The relevance seam makes exactly ONE classification
   * per turn, so it has no attempt and must omit this field rather than log an
   * unrelated counter (it previously logged the agent turn index here).
   */
  attempt?: number
  cached?: boolean
  /** Phase 2: whether the retry path actually acted on this verdict. */
  actedOn?: boolean
  /**
   * Phase 2: why a REAL, eligible verdict was seen but not acted upon. Currently
   * only ever `"ACTION_OVERRIDDEN"`, emitted for a stale/fingerprint-mismatched
   * verdict. The disabled-gate case emits nothing (no verdict was in play), so
   * this field is absent rather than a placeholder constant.
   */
  overrideReason?: string
  /** The threshold the verdict was actually evaluated against. */
  threshold?: number
  /** Section counts for a relevance decision: truncation of `evidence` stays visible here. */
  sections?: { total: number; kept: number; pruned: number }
  /** Bounded per-section detail (see EVIDENCE_CAP); the true totals live in `sections`. */
  evidence?: { id: string; noul: number; keep: boolean }[]
}

/**
 * Max per-section rows logged. A long conversation has unbounded sections;
 * logging them all is how the log flooded before. `sections` still reports the
 * true totals so a capped `evidence` array is visibly truncated, not silent.
 */
export const EVIDENCE_CAP = 12

/** Emits one `classifier.decision` log line. Never fails; pure observation. */
export const decision = (input: DecisionEventInput): Effect.Effect<void> => {
  const evidence = input.evidence?.slice(0, EVIDENCE_CAP)
  return Effect.logInfo("classifier.decision", {
    classifier: input.decision.classifier,
    decision: input.decision.decision,
    confidence: input.decision.confidence,
    reasonCode: input.decision.reasonCode satisfies ReasonCode,
    latencyMs: input.decision.latencyMs,
    cached: input.cached ?? false,
    fallback: input.decision.fallbackUsed,
    ...(input.attempt != null ? { attempt: input.attempt } : {}),
    ...(input.taskID ? { "task.id": input.taskID } : {}),
    ...(input.sessionID ? { "session.id": input.sessionID } : {}),
    ...(input.actedOn != null ? { actedOn: input.actedOn } : {}),
    ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
    ...(input.threshold != null ? { threshold: input.threshold } : {}),
    ...(input.sections ? { sections: input.sections } : {}),
    ...(evidence ? { evidence } : {}),
  })
}
