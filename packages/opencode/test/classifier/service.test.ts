import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { testEffect } from "../lib/effect"
import { ClassifierService } from "@/classifier/service"
import { ClassifierClient } from "@/classifier/client"
import { Config } from "@/config/config"
import { TestConfig } from "../fixture/config"
import { buildDecisionState, DEFAULT_THRESHOLDS } from "@/classifier/retry"

const it = testEffect(Layer.mergeAll(ClassifierService.ruleBasedLayer))

// If TYPESAFE_API_KEY happens to be set, the client still fails here on a 400
// (real SystemOneError kind "http", non-retryable); if unset, it fails earlier
// with "missing_api_key". Either way this stays offline and the fallback runs.
const failingHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("bad request", { status: 400 }))),
  ),
)

const systemOne = (config: Layer.Layer<Config.Service>) =>
  ClassifierService.systemOneLayer.pipe(
    Layer.provide(Layer.mergeAll(ClassifierClient.layer.pipe(Layer.provide(failingHttp)), config)),
  )

const input = (overrides: Partial<Parameters<typeof buildDecisionState>[0]> = {}) => ({
  state: buildDecisionState({
    goal: "fix the bug",
    step: 3,
    latestAction: "bun test",
    latestResult: "1 failing",
    ...overrides,
  }),
  attempt: 2,
  maxAttempts: 5,
  thresholds: DEFAULT_THRESHOLDS,
})

describe("RuleBasedClassifier via DecisionClassifier", () => {
  it.effect("returns a decision with no network", () =>
    Effect.gen(function* () {
      const classifier = yield* ClassifierService.Service
      const decision = yield* classifier.classify("retry", input())
      expect(decision.classifier).toBe("rule-based")
      expect(decision.fallbackUsed).toBe(false)
      expect(decision.reasonCode).toBeDefined()
      expect(typeof decision.latencyMs).toBe("number")
    }),
  )

  it.effect("honours the attempt==1 guardrail", () =>
    Effect.gen(function* () {
      const classifier = yield* ClassifierService.Service
      const decision = yield* classifier.classify("retry", { ...input(), attempt: 1 })
      expect(decision.decision).toBe("CONTINUE")
    }),
  )

  it.effect("stops at max attempts", () =>
    Effect.gen(function* () {
      const classifier = yield* ClassifierService.Service
      const decision = yield* classifier.classify("retry", { ...input(), attempt: 5, maxAttempts: 5 })
      expect(decision.decision).toBe("STOP")
      expect(decision.reasonCode).toBe("MAX_ATTEMPTS")
    }),
  )

  it.effect("escalates on repeated failures", () =>
    Effect.gen(function* () {
      const classifier = yield* ClassifierService.Service
      const decision = yield* classifier.classify(
        "retry",
        input({ previousFailures: [{ signature: "sig", count: 3 }] }),
      )
      expect(decision.decision).toBe("ESCALATE")
      expect(decision.reasonCode).toBe("NO_PROGRESS_REPEATED_FAILURE")
    }),
  )
})

describe("SystemOneClassifier fallback observability", () => {
  // No model is configured → immediate deterministic fallback.
  it.effect("emits CLASSIFIER_UNAVAILABLE with no configured model", () =>
    Effect.gen(function* () {
      const classifier = yield* ClassifierService.Service
      const decision = yield* classifier.classify("retry", input())
      expect(decision.fallbackUsed).toBe(true)
      expect(decision.reasonCode).toBe("CLASSIFIER_UNAVAILABLE")
      // The deterministic decision is still real, not a placeholder.
      expect(decision.decision).toBe("RETRY")
      expect(decision.classifier).toBe("rule-based")
      expect(typeof decision.latencyMs).toBe("number")
    }).pipe(Effect.provide(systemOne(TestConfig.layer()))),
  )

  // A model IS configured, but the client fails (missing TYPESAFE_API_KEY) —
  // exercises the `Effect.catch(() => fallback(...))` path with a real
  // SystemOneError rather than a hand-rolled double.
  it.effect("emits CLASSIFIER_UNAVAILABLE when the client fails", () =>
    Effect.gen(function* () {
      const classifier = yield* ClassifierService.Service
      const decision = yield* classifier.classify("retry", input())
      expect(decision.fallbackUsed).toBe(true)
      expect(decision.reasonCode).toBe("CLASSIFIER_UNAVAILABLE")
      expect(decision.decision).toBe("RETRY")
      expect(decision.classifier).toBe("rule-based")
    }).pipe(
      Effect.provide(
        systemOne(TestConfig.layer({ get: () => Effect.succeed({ classifier: { model: "jev-latest" } }) })),
      ),
    ),
  )
})
