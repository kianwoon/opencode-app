import { describe, expect, test } from "bun:test"
import { Duration, Effect, Fiber, Layer, Logger, Schema } from "effect"

import { ConfigClassifierV1 } from "@opencode-ai/core/v1/config/classifier"
import { ClassifierClient } from "@/classifier/client"
import { ClassifierRetry } from "@/classifier/retry"
import { ClassifierService } from "@/classifier/service"
import type { ClassifierDecision, RetryDecision } from "@/classifier/schema"
import { ClassifierTelemetry } from "@/classifier/telemetry"
import { testEffect } from "../lib/effect"

/**
 * Shadow retry classifier hook (`observeShadowRetryClassifier`, processor.ts:122).
 *
 * NOT DIRECTLY REACHABLE: the helper is module-private by design ("must stay
 * uncallable from an effectful context so it can never be `yield*`ed into the
 * retry path", processor.ts:113-118) and the fork site lives inside the
 * `SessionRetry.policy` `set` callback (processor.ts:791-809), which needs a full
 * session turn to reach. Bun has no module-internals hook for that.
 *
 * So these tests pin the parts of the contract that ARE reachable against real
 * code: (1) the three-way gate expression and its schema default, (2) the exact
 * shadow pipeline shape — `:shadow`-suffixed classifier in `classifier.decision`
 * telemetry, produced by the REAL RuleBased classifier — and (3) that pipeline's
 * failure/hang legs, including the detached `Effect.runFork` dispatch used in
 * production. Nothing here can observe the `if (shadow)` fork decision itself.
 */

const it = testEffect(ClassifierService.ruleBasedLayer)

/** processor.ts:168 — the marker that separates a shadow decision from a real one. */
const shadowSuffix = ":shadow"

/** Captures `classifier.decision` payloads emitted by whatever runs under it. */
function collectDecisions() {
  const events: Array<Record<string, unknown>> = []
  const logger = Logger.make<unknown, void>((options) => {
    const [name, payload] = options.message as ReadonlyArray<unknown>
    if (name === "classifier.decision" && typeof payload === "object" && payload !== null) {
      events.push(payload as Record<string, unknown>)
    }
  })
  return { events, layer: Logger.layer([logger], { mergeWithExisting: true }) }
}

/**
 * The REAL predicate `processor.ts` evaluates at the fork site
 * (`ClassifierRetry.shadowEnabled`). `retry` is tolerated but not read — the
 * config `retry` block is not part of the gate.
 */
const shadowGate = (input: { enabled: boolean | undefined; retry: boolean | undefined; flag: boolean }) =>
  ClassifierRetry.shadowEnabled({ enabled: input.enabled, flag: input.flag })

/** processor.ts:151-164 — the classifier input the hook builds for one attempt. */
const shadowInput = (attempt: number, maxAttempts: number) => ({
  state: ClassifierRetry.buildDecisionState({
    goal: "complete the assistant turn on anthropic/claude-sonnet",
    step: attempt,
    latestAction: `retry attempt ${attempt}`,
    latestResult: "rate limited",
    previousFailures: [],
  }),
  attempt,
  maxAttempts,
  thresholds: ClassifierRetry.DEFAULT_THRESHOLDS,
})

/**
 * processor.ts:135-177 with only the classify call injected, so the die/hang legs
 * can be exercised at all. Production passes `ClassifierClient.SYSTEMONE_TIMEOUT`;
 * the other legs shorten only the bound to stay within wall-clock.
 */
const shadowPipeline = (
  classify: Effect.Effect<ClassifierDecision<RetryDecision>>,
  attempt: number,
  timeout: Duration.Input = ClassifierClient.SYSTEMONE_TIMEOUT,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const result = yield* classify
    yield* ClassifierTelemetry.decision({
      decision: { ...result, classifier: `${result.classifier}${shadowSuffix}`, latencyMs: 0 },
      attempt,
    })
  }).pipe(Effect.timeout(timeout), Effect.asVoid, Effect.catchCause(() => Effect.void))

describe("shadow retry classifier gate", () => {
  test("an absent classifier config block keeps the gate off", () => {
    // Real schema default: the config field the gate reads is undefined, so
    // `enabled === true` is already false and no shadow effect is ever built.
    const decoded = Schema.decodeUnknownSync(ConfigClassifierV1.Info)({})
    expect(decoded).toEqual({})
    expect(shadowGate({ enabled: decoded.enabled, retry: decoded.retry, flag: false })).toBe(false)
  })

  test("config is authoritative; the env flag is a dev force-on escape and `retry` is not required", () => {
    expect(shadowGate({ enabled: true, retry: true, flag: true })).toBe(true)
    // config alone, without the env flag
    expect(shadowGate({ enabled: true, retry: true, flag: false })).toBe(true)
    expect(shadowGate({ enabled: true, retry: undefined, flag: false })).toBe(true)
    // env flag alone, without config
    expect(shadowGate({ enabled: false, retry: true, flag: true })).toBe(true)
    expect(shadowGate({ enabled: false, retry: true, flag: false })).toBe(false)
    expect(shadowGate({ enabled: undefined, retry: undefined, flag: false })).toBe(false)
  })

  it.effect("gate ON emits a :shadow decision while the policy decision stays unchanged", () => {
    const { events, layer } = collectDecisions()
    return Effect.gen(function* () {
      const classifier = yield* ClassifierService.Service
      // attempt 1: the rule-based guardrail answers CONTINUE, so a shadow run is
      // observably distinguishable from the policy decision it shadows.
      const attempt = 1
      const policyAction: string | undefined = "retry"
      const policyDecision = policyAction ? "RETRY" : "STOP"

      yield* ClassifierTelemetry.decision({
        decision: ClassifierRetry.toDecision(
          "policy",
          { decision: policyDecision, reasonCode: "NEW_INFORMATION", confidence: 1 },
          { latencyMs: 0, fallbackUsed: false },
        ),
        attempt,
      })
      const result = yield* classifier.classify("retry", shadowInput(attempt, 5)).pipe(Effect.orDie)
      yield* ClassifierTelemetry.decision({
        decision: { ...result, classifier: `${result.classifier}${shadowSuffix}`, latencyMs: 0 },
        attempt,
      })

      expect(events).toHaveLength(2)
      expect(events[0].classifier).toBe("policy")
      expect(events[0].decision).toBe("RETRY")
      expect(events[1].classifier).toBe("rule-based:shadow")
      expect(events[1].classifier).not.toBe(events[0].classifier)
      // Divergence is allowed in the shadow and must be invisible to the policy.
      expect(events[1].decision).toBe("CONTINUE")
      expect(events[1].reasonCode).toBeDefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("a classifier frame that dies is swallowed and emits no shadow decision", () => {
    const { events, layer } = collectDecisions()
    return Effect.gen(function* () {
      yield* shadowPipeline(Effect.die(new Error("classifier exploded")), 1)
      expect(events).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("a hung classifier times out, emits no shadow decision, and the detached fiber terminates", () => {
    const { events, layer } = collectDecisions()
    return Effect.gen(function* () {
      // Production dispatch shape (processor.ts:809): fire-and-forget. The fiber
      // is deliberately given the LIVE clock — handing it the test layer's
      // TestClock would freeze `Effect.timeout` and the bound would never fire.
      const fiber = Effect.runFork(Effect.provide(shadowPipeline(Effect.never, 1, Duration.millis(20)), layer))
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* Effect.promise(() => Effect.runPromise(Fiber.join(fiber)))
      expect(events).toEqual([])
    })
  })
})
