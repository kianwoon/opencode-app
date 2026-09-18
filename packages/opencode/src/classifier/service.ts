/**
 * Provider-agnostic decision seam.
 *
 * `DecisionClassifier.Service` is the single abstraction the loop will eventually
 * talk to. Two explicit layers implement it:
 *  - `ruleBasedLayer`  — deterministic, network-free (`RuleBasedClassifier`).
 *  - `systemOneLayer`  — Jev/System One backed, with a deterministic fallback.
 *
 * Layer composition is explicit; nothing is provisioned implicitly. Phase 1 is
 * infrastructure only — the seam is never invoked by the agent loop.
 *
 * @module @opencode-ai/opencode/classifier/service
 */
export * as ClassifierService from "./service"

import { Clock, Effect, Layer, Context } from "effect"

import { Config } from "@/config/config"
import { ClassifierClient } from "./client"
import { type ClassifierDecision, type RetryDecision } from "./schema"
import {
  DEFAULT_THRESHOLDS,
  type RetryInput,
  type Thresholds,
  classifyRetry,
  resolveClassifierModel,
  ruleBasedDecision,
  toDecision,
} from "./retry"

/** Only `retry` is a live seam in Phase 1. */
export type ClassifierName = "retry"

export interface ClassifyOptions {
  /** Overrides the configured thresholds (e.g. tests). */
  readonly thresholds?: Thresholds
  readonly maxAttempts?: number
  /** System One model id; falls back to the configured model. */
  readonly model?: string
  readonly taskID?: string
  readonly sessionID?: string
}

export interface Interface {
  /**
   * Produce a decision for `classifier`. Never fails: any client error or
   * missing key resolves to the deterministic decision with `fallbackUsed`.
   */
  readonly classify: (
    classifier: ClassifierName,
    input: RetryInput,
    options?: ClassifyOptions,
  ) => Effect.Effect<ClassifierDecision<RetryDecision>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ClassifierDecision") {}

/** Deterministic, dependency-free layer. */
export const ruleBasedLayer: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({
    classify: Effect.fn("DecisionClassifier.ruleBased")(function* (_classifier, input, options) {
      const started = yield* Clock.currentTimeMillis
      const result = ruleBasedDecision({
        state: input.state,
        attempt: input.attempt,
        maxAttempts: options?.maxAttempts ?? input.maxAttempts,
        thresholds: options?.thresholds ?? input.thresholds ?? DEFAULT_THRESHOLDS,
      })
      return toDecision("rule-based", result, {
        latencyMs: (yield* Clock.currentTimeMillis) - started,
        fallbackUsed: false,
      })
    }),
  }),
)

/**
 * Jev-backed layer. On any `SystemOneError` (missing key, non-2xx, decode,
 * timeout) it transparently falls back to the rule-based decision and flags
 * `fallbackUsed`. It never throws into the caller.
 */
export const systemOneLayer: Layer.Layer<Service, never, ClassifierClient.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* ClassifierClient.Service
    const config = yield* Config.Service

    // The Jev path was unavailable (missing key / http / decode / timeout) or no
    // model is configured. We still emit a real deterministic decision, but
    // override `reasonCode` to `CLASSIFIER_UNAVAILABLE` so plan §19/§21
    // fallback-rate telemetry can observe the outage from the decision alone.
    const fallback = (input: RetryInput, started: number, maxAttempts: number, thresholds: Thresholds) =>
      Effect.map(Clock.currentTimeMillis, (end) => ({
        ...toDecision(
          "rule-based",
          ruleBasedDecision({ state: input.state, attempt: input.attempt, maxAttempts, thresholds }),
          { latencyMs: end - started, fallbackUsed: true },
        ),
        reasonCode: "CLASSIFIER_UNAVAILABLE" as const,
      }))

    const classify = Effect.fn("DecisionClassifier.systemOne")(function* (
      _classifier: ClassifierName,
      input: RetryInput,
      options?: ClassifyOptions,
    ) {
      const started = yield* Clock.currentTimeMillis
      const cfg = yield* config.get()
      const thresholds = options?.thresholds ?? input.thresholds ?? DEFAULT_THRESHOLDS
      const maxAttempts = options?.maxAttempts ?? input.maxAttempts
      const model = resolveClassifierModel({
        override: options?.model,
        brainModel: cfg.brain?.classifier_model,
        classifierModel: cfg.classifier?.model,
      })

      if (!model) return yield* fallback(input, started, maxAttempts, thresholds)

      return yield* classifyRetry({
        client,
        model,
        state: input.state,
        attempt: input.attempt,
        maxAttempts,
        thresholds,
      }).pipe(
        Effect.flatMap((result) =>
          Effect.map(Clock.currentTimeMillis, (end) =>
            toDecision("jev", result, { latencyMs: end - started, fallbackUsed: false }),
          ),
        ),
        Effect.catch(() => fallback(input, started, maxAttempts, thresholds)),
      )
    })

    return Service.of({ classify })
  }),
)
