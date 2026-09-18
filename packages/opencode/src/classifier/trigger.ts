/**
 * Reusable classifier trigger seam.
 *
 * Any decision module (retry, relevance, and future completion/anomaly/
 * tool-routing seams) is reached through ONE gate so registration replaces
 * copy-pasted `if (enabled)` forks in the loop:
 *
 *   - `enabled`  — the master switch (`classifier.enabled`);
 *   - `configKey` — the per-trigger switch (`classifier.retry` / `.relevance`);
 *   - `run`      — the effectful body, only ever invoked when both are on.
 *
 * FAIL-OPEN IS THE CONTRACT: an unknown name, an absent or throwing config
 * probe, or a descriptor that itself throws all resolve to a no-op. When a
 * trigger is disabled the body is never touched (no question building, no
 * client/service access) and telemetry is not emitted, because no verdict was
 * ever in play.
 *
 * Nothing in the loop calls this yet.
 *
 * @module @opencode-ai/opencode/classifier/trigger
 */
export * as ClassifierTrigger from "./trigger"

import { Effect } from "effect"

import { type ClassifierName, type ClassifierDecision, type RetryDecision, type RelevanceDecision } from "./schema"
import { ClassifierTelemetry } from "./telemetry"

/** The slice of the classifier config the gate reads; kept structural. */
export interface TriggerConfig {
  readonly enabled?: boolean | undefined
  readonly retry?: boolean | undefined
  readonly relevance?: boolean | undefined
  readonly scoring?: boolean | undefined
  readonly state_extraction?: boolean | undefined
  readonly batch?: boolean | undefined
  readonly verification?: boolean | undefined
  readonly guardrails?: boolean | undefined
  readonly matching?: boolean | undefined
  readonly screening?: boolean | undefined
  readonly memory?: boolean | undefined
  readonly anomaly?: boolean | undefined
}

export interface TriggerRunInput {
  readonly decision: ClassifierDecision<RetryDecision | RelevanceDecision>
  /** True when the caller actually acted on the verdict. */
  readonly actedOn?: boolean
  readonly attempt?: number
  readonly taskID?: string
  readonly sessionID?: string
}

export interface Trigger {
  readonly name: ClassifierName
  /** Per-trigger config switch; absent ⇒ disabled. */
  readonly configKey: keyof TriggerConfig
  /** Effectful seam body. Never invoked while the trigger is off. */
  readonly run: (input: TriggerRunInput) => Effect.Effect<void, never>
}

/** Emit one `classifier.decision` line for any seam verdict. */
const emit = (input: TriggerRunInput): Effect.Effect<void> =>
  ClassifierTelemetry.decision({
    decision: input.decision,
    attempt: input.attempt ?? 0,
    actedOn: input.actedOn,
    taskID: input.taskID,
    sessionID: input.sessionID,
  })

/**
 * The registry. `retry` and `relevance` are the only registered seams; adding a
 * future decision module is a descriptor + config key, not new gate logic.
 */
export const REGISTRY: Record<ClassifierName, Trigger> = {
  retry: { name: "retry", configKey: "retry", run: emit },
  relevance: { name: "relevance", configKey: "relevance", run: emit },
  scoring: { name: "scoring", configKey: "scoring", run: emit },
  "state-extraction": { name: "state-extraction", configKey: "state_extraction", run: emit },
  batch: { name: "batch", configKey: "batch", run: emit },
  verification: { name: "verification", configKey: "verification", run: emit },
  guardrails: { name: "guardrails", configKey: "guardrails", run: emit },
  matching: { name: "matching", configKey: "matching", run: emit },
  screening: { name: "screening", configKey: "screening", run: emit },
  memory: { name: "memory", configKey: "memory", run: emit },
  anomaly: { name: "anomaly", configKey: "anomaly", run: emit },
}

/**
 * Pure gate. True only when the master switch AND the per-trigger switch are
 * explicitly `true`. Unknown names, absent config and non-boolean values are all
 * false — never a throw, never an accidental opt-in.
 */
export function isEnabled(name: ClassifierName, config: TriggerConfig | undefined): boolean {
  const trigger = REGISTRY[name]
  if (!trigger) return false
  return config?.enabled === true && config[trigger.configKey] === true
}

/**
 * Centralized entry point. Runs the trigger's body only when `isEnabled` holds;
 * otherwise it is a no-op with zero work. Swallows EVERY cause (including
 * defects, mirroring the throw-safety guard around the foreign `shouldStop`
 * callback in `session/retry.ts`) so a broken trigger can never escape into the
 * caller's loop.
 */
export function run(
  name: ClassifierName,
  input: TriggerRunInput,
  config: TriggerConfig | undefined,
): Effect.Effect<void> {
  const trigger = REGISTRY[name]
  if (!trigger) return Effect.void
  // Config-access is inside the guard: a throwing/odd config object degrades to
  // "disabled" instead of escaping.
  const enabled = (() => {
    try {
      return config?.enabled === true && config[trigger.configKey] === true
    } catch {
      return false
    }
  })()
  if (!enabled) return Effect.void
  return trigger.run(input).pipe(
    Effect.catchCause(() => Effect.logDebug("classifier.trigger.failed", { classifier: name })),
  )
}
