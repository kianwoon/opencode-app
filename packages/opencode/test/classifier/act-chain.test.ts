/**
 * End-to-end act chain (Phase 2): a REAL classifier verdict is produced, published
 * through the REAL session-keyed verdict store, and the REAL `SessionRetry.policy`
 * schedule halts EARLY — proven against a negative control that reaches the cap.
 *
 * What `retry-act.test.ts` pins in isolation is the pure gate + a hand-made verdict.
 * This file closes the last gap: the verdict is produced by the real classifier
 * service (`ClassifierService.ruleBasedLayer` — real production code, no network,
 * no mock) and the publish/short-circuit/clear wiring is transcriptionally the same
 * as `processor.ts:176-186` and `processor.ts:852-910`.
 *
 * No mocks, no `any`, no `globalThis`.
 */
import { beforeEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer, Logger, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

import { ClassifierClient } from "@/classifier/client"
import { ClassifierOpenRouter } from "@/classifier/openrouter"
import { ClassifierRetry } from "@/classifier/retry"
import { ClassifierService } from "@/classifier/service"
import { ClassifierTelemetry } from "@/classifier/telemetry"
import { ClassifierVerdict } from "@/classifier/verdict"
import type { Verdict } from "@/classifier/verdict"
import type { ClassifierDecision, RetryDecision } from "@/classifier/schema"
import { SessionRetry } from "@/session/retry"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(ClassifierService.ruleBasedLayer)

/** LIVE leg: opt-in only, so the suite stays offline and deterministic by default. */
const liveEnabled = process.env.OPENCODE_CLASSIFIER_LIVE === "1"
const liveModel = "typesafe/jev-1.13"
const liveIt = testEffect(
  ClassifierService.systemOneLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        LayerNode.compile(LayerNode.group([ClassifierOpenRouter.node])),
        TestConfig.layer({ get: () => Effect.succeed({ classifier: { model: liveModel } }) }),
      ),
    ),
  ),
)

const sessionID = "session-act-chain"
/** A real retryable provider failure message — the exact text both sides fingerprint. */
const message = "Rate limited (429): too many requests"
const failureSignature = ClassifierRetry.fingerprint({ error: message })
const threshold = ClassifierRetry.DEFAULT_THRESHOLDS.retry_act.accept
const capRuns = SessionRetry.RETRY_MAX_RETRIES + 1

function apiError(): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message,
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "0" },
    }).toObject(),
  )
}

/** The realistic repeated-failure state the shadow run builds (processor.ts:151-168). */
const repeatedFailureState = (attempt: number) =>
  ClassifierRetry.buildDecisionState({
    goal: "complete the assistant turn on anthropic/claude-sonnet",
    step: attempt,
    latestAction: `retry attempt ${attempt}`,
    latestResult: message,
    previousFailures: [{ signature: failureSignature, count: 3 }],
  })

/** The REAL classifier producer. Returns the real `ClassifierDecision`. */
const classifyRepeatedFailure = (attempt: number) =>
  Effect.gen(function* () {
    const classifier = yield* ClassifierService.Service
    return yield* classifier.classify("retry", {
      state: repeatedFailureState(attempt),
      attempt,
      maxAttempts: SessionRetry.RETRY_MAX_RETRIES,
      thresholds: ClassifierRetry.DEFAULT_THRESHOLDS,
    })
  })

/** processor.ts:178-186 — a real verdict is published, a fallback one never is. */
const publishVerdict = (
  attempt: number,
  result: ClassifierDecision<RetryDecision>,
  fingerprint = failureSignature,
): boolean => {
  if (result.fallbackUsed) return false
  ClassifierVerdict.put(sessionID, {
    decision: result.decision,
    confidence: result.confidence,
    reasonCode: result.reasonCode,
    fingerprint,
    attempt,
  })
  return true
}

interface GateConfig {
  enabled?: boolean | undefined
  act?: boolean | undefined
  threshold?: number
}

/** Halt recorder: `verdict` stays undefined unless the gate actually acted. */
interface Acted {
  readonly verdicts: Verdict[]
}

/** processor.ts:852-910 — the exact synchronous gate, including the clear-on-halt. */
function makeGate(config: GateConfig, acted: Acted) {
  return (input: { attempt: number; fingerprint: string }): boolean => {
    if (config.enabled !== true || config.act !== true) return false
    const verdict = ClassifierVerdict.get(sessionID)
    const outcome = ClassifierRetry.shouldStopRetries({
      enabled: true,
      act: true,
      verdict,
      fingerprint: input.fingerprint,
      attempt: input.attempt,
      threshold: config.threshold ?? threshold,
    })
    if (!outcome.stop) return false
    acted.verdicts.push(outcome.verdict)
    // Consumed: a stale verdict must never halt a later failure.
    ClassifierVerdict.clear(sessionID)
    return true
  }
}

/** Drive the REAL policy with a permanently failing body; report how often it ran. */
const runPolicy = (shouldStop?: (input: { attempt: number; fingerprint: string }) => boolean) => {
  const runs = { count: 0 }
  return Effect.retry(
    Effect.sync(() => {
      runs.count += 1
    }).pipe(Effect.flatMap(() => Effect.fail(apiError()))),
    SessionRetry.policy({
      provider: "test",
      parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
      set: () => Effect.void,
      ...(shouldStop ? { shouldStop } : {}),
    }),
  ).pipe(
    Effect.exit,
    Effect.map((exit) => ({
      runs: runs.count,
      failed: Exit.isFailure(exit),
      pretty: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "",
    })),
  )
}

/** Captures `classifier.decision` payloads (same sink `telemetry.ts` writes to). */
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

describe("classifier act chain (end to end)", () => {
  beforeEach(() => ClassifierVerdict.clear())

  it.effect("A: a real verdict, published, halts the real schedule early and clears itself", () => {
    const acted: Acted = { verdicts: [] }
    const { events, layer } = collectDecisions()
    return Effect.gen(function* () {
      // 1. REAL classifier verdict for a realistic repeated-failure state.
      const decision = yield* classifyRepeatedFailure(3)
      expect(decision.fallbackUsed).toBe(false)
      expect(decision.classifier).toBe("rule-based")
      expect(decision.decision).toBe("ESCALATE")
      expect(decision.reasonCode).toBe("NO_PROGRESS_REPEATED_FAILURE")
      expect(decision.confidence).toBeGreaterThanOrEqual(threshold)

      // 2. Published through the real session-keyed store.
      const publishedAttempt = 3
      expect(publishVerdict(publishedAttempt, decision)).toBe(true)
      expect(ClassifierVerdict.get(sessionID)?.fingerprint).toBe(failureSignature)

      // 3. The REAL schedule consults it and halts before the cap.
      const { runs, failed, pretty } = yield* runPolicy(makeGate({ enabled: true, act: true }, acted))
      expect(runs).toBeLessThan(capRuns)
      // The schedule terminates on the step whose attempt exceeds the verdict's.
      expect(runs).toBe(publishedAttempt + 1)
      expect(acted.verdicts).toHaveLength(1)
      expect(acted.verdicts[0].decision).toBe("ESCALATE")
      // The ORIGINAL error still surfaces through the existing halt path.
      expect(failed).toBe(true)
      expect(pretty).toContain(message)

      // The verdict was consumed, so it cannot halt a later failure.
      expect(ClassifierVerdict.get(sessionID)).toBeUndefined()

      // 4. `actedOn: true` telemetry, emitted by the real telemetry function with
      // the same payload shape `processor.ts:871-886` forks on stop.
      const stop = acted.verdicts[0]
      yield* ClassifierTelemetry.decision({
        decision: {
          decision: stop.decision,
          confidence: stop.confidence,
          reasonCode: stop.reasonCode,
          classifier: "verdict-store",
          latencyMs: 0,
          fallbackUsed: false,
        },
        sessionID,
        attempt: stop.attempt + 1,
        cached: true,
        actedOn: true,
      })

      expect(events).toHaveLength(1)
      expect(events[0]?.actedOn).toBe(true)
      expect(events[0]?.cached).toBe(true)
      expect(events[0]?.classifier).toBe("verdict-store")
      expect(events[0]?.decision).toBe("ESCALATE")
      expect(events[0]?.fallback).toBe(false)
    }).pipe(Effect.provide(layer))
  })

  it.effect("B: negative control — the SAME setup without a published verdict runs to the cap", () => {
    const acted: Acted = { verdicts: [] }
    return Effect.gen(function* () {
      // Identical real classifier run; the verdict is deliberately NOT published.
      const decision = yield* classifyRepeatedFailure(3)
      expect(decision.decision).toBe("ESCALATE")
      expect(ClassifierVerdict.get(sessionID)).toBeUndefined()

      const { runs, failed } = yield* runPolicy(makeGate({ enabled: true, act: true }, acted))
      expect(runs).toBe(capRuns)
      expect(failed).toBe(true)
      expect(acted.verdicts).toHaveLength(0)
    })
  })

  it.effect("C: stale verdict (fingerprint mismatch) fails open and runs to the cap", () => {
    const acted: Acted = { verdicts: [] }
    return Effect.gen(function* () {
      const decision = yield* classifyRepeatedFailure(3)
      // A verdict computed for a DIFFERENT failure state — realistic staleness.
      expect(publishVerdict(3, decision, ClassifierRetry.fingerprint({ error: "different failure" }))).toBe(true)

      const { runs, failed } = yield* runPolicy(makeGate({ enabled: true, act: true }, acted))
      expect(runs).toBe(capRuns)
      expect(failed).toBe(true)
      expect(acted.verdicts).toHaveLength(0)
      // Untouched: a non-acting read never consumes the verdict.
      expect(ClassifierVerdict.get(sessionID)).toBeDefined()
    })
  })

  it.effect("D: a real fallback verdict is never published and never halts", () => {
    const acted: Acted = { verdicts: [] }
    // The REAL client on a real fetch transport; with no configured classifier
    // model `classify` resolves the fallback before ever reaching it.
    const realTransport = ClassifierClient.layer.pipe(Layer.provide(FetchHttpClient.layer))
    return Effect.gen(function* () {
      // REAL systemOneLayer with no configured classifier model → the real
      // deterministic fallback with `fallbackUsed: true`.
      const classifier = yield* ClassifierService.Service
      const decision = yield* classifier.classify("retry", {
        state: repeatedFailureState(3),
        attempt: 3,
        maxAttempts: SessionRetry.RETRY_MAX_RETRIES,
        thresholds: ClassifierRetry.DEFAULT_THRESHOLDS,
      })
      expect(decision.fallbackUsed).toBe(true)
      expect(decision.reasonCode).toBe("CLASSIFIER_UNAVAILABLE")
      // The underlying answer IS halt-eligible — only `fallbackUsed` forbids acting.
      expect(decision.decision).toBe("ESCALATE")
      expect(decision.confidence).toBeGreaterThanOrEqual(threshold)
      expect(
        ClassifierRetry.shouldActOnRetry({
          decision: decision.decision,
          confidence: decision.confidence,
          threshold,
          fallbackUsed: decision.fallbackUsed,
        }),
      ).toBe(false)
      expect(publishVerdict(3, decision)).toBe(false)
      expect(ClassifierVerdict.get(sessionID)).toBeUndefined()

      const { runs, failed } = yield* runPolicy(makeGate({ enabled: true, act: true }, acted))
      expect(runs).toBe(capRuns)
      expect(failed).toBe(true)
      expect(acted.verdicts).toHaveLength(0)
    }).pipe(
      Effect.provide(
        ClassifierService.systemOneLayer.pipe(Layer.provide(Layer.mergeAll(realTransport, TestConfig.layer()))),
      ),
    )
  })
})

/**
 * LIVE leg (opt-in: `OPENCODE_CLASSIFIER_LIVE=1 bun test test/classifier/act-chain.test.ts`).
 *
 * `test/preload.ts` deletes `OPENROUTER_API_KEY`, so the credential is read from
 * `auth.json` and fed into the adapter's documented env fallback. The key is never
 * logged — only its LENGTH is reported.
 */
describe.skipIf(!liveEnabled)("classifier act chain (LIVE Jev transport)", () => {
  const loadCredential = () =>
    Effect.promise(
      () =>
        Bun.file(`${process.env.HOME}/.local/share/opencode/auth.json`).json() as Promise<{
          openrouter?: { key?: string }
        }>,
    ).pipe(
      Effect.map((auth) => {
        const key = auth.openrouter?.key
        if (key) process.env.OPENROUTER_API_KEY = key
        console.log(`credential length: ${key?.length ?? 0}`)
        return key !== undefined
      }),
    )

  liveIt.effect("A-live: a real Jev verdict halts the real schedule early", () => {
    const acted: Acted = { verdicts: [] }
    return Effect.gen(function* () {
      expect(yield* loadCredential()).toBe(true)
      const decision = yield* classifyRepeatedFailure(3)
      console.log(`live decision: ${JSON.stringify(decision)}`)
      expect(decision.fallbackUsed).toBe(false)
      expect(decision.classifier).toBe("jev")
      expect(publishVerdict(3, decision)).toBe(true)
      const { runs } = yield* runPolicy(makeGate({ enabled: true, act: true }, acted))
      expect(runs).toBeLessThan(capRuns)
      expect(ClassifierVerdict.get(sessionID)).toBeUndefined()
    })
  })
})
