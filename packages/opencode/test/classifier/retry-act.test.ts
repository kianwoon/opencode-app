/**
 * Phase 2 Piece 2: the retry schedule consults the cached classifier verdict and
 * halts when a real, matching, above-threshold STOP/ESCALATE verdict says so.
 *
 * No mocks: the real `SessionRetry.policy`, the real session-keyed verdict store,
 * and the real pure gates.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Effect, Exit, Schema } from "effect"

import { ClassifierRetry } from "@/classifier/retry"
import { ClassifierVerdict } from "@/classifier/verdict"
import type { Verdict } from "@/classifier/verdict"
import { SessionRetry } from "@/session/retry"
import { it } from "../lib/effect"

const sessionID = "session-retry-act"
const message = "boom"
const current = ClassifierRetry.fingerprint({ error: message })
const threshold = ClassifierRetry.DEFAULT_THRESHOLDS.retry_act.accept

function apiError(): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message,
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "0" },
    }).toObject(),
  )
}

const verdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  decision: "STOP",
  confidence: 0.95,
  reasonCode: "NO_PROGRESS_REPEATED_FAILURE",
  fingerprint: current,
  attempt: 1,
  ...overrides,
})

/** The exact predicate `processor.ts` hands to `policy.shouldStop`. */
const fromStore = (config: { enabled?: boolean; act?: boolean }) => () => {
  const cached = ClassifierVerdict.get(sessionID)
  return ClassifierRetry.shouldStopRetries({
    enabled: config.enabled,
    act: config.act,
    verdict: cached,
    fingerprint: current,
    attempt: 3,
    threshold,
  }).stop
}

/** Run the REAL policy until it terminates; report how many times the body ran. */
const drain = (shouldStop?: (input: { attempt: number; fingerprint: string }) => boolean) => {
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

const capRuns = SessionRetry.RETRY_MAX_RETRIES + 1

describe("classifier retry actuation", () => {
  beforeEach(() => ClassifierVerdict.clear())

  it.effect("baseline: with no gate the schedule retries to the attempt cap", () =>
    Effect.gen(function* () {
      const { runs, failed } = yield* drain()
      expect(runs).toBe(capRuns)
      expect(failed).toBe(true)
    }),
  )

  it.effect("a THROWING shouldStop hook does NOT halt retries (fail-open)", () =>
    Effect.gen(function* () {
      const { runs, failed, pretty } = yield* drain(() => {
        throw new Error("hook exploded")
      })
      expect(runs).toBe(capRuns)
      expect(failed).toBe(true)
      // The provider error still surfaces — the hook's throw did not escape the schedule.
      expect(pretty).toContain("boom")
      expect(pretty).not.toContain("hook exploded")
    }),
  )

  it.effect("a throwing hook on an act-ON gate still lets a later real verdict halt", () =>
    Effect.gen(function* () {
      ClassifierVerdict.put(sessionID, verdict())
      let calls = 0
      const { runs } = yield* drain((input) => {
        calls += 1
        // first call throws; the guard must degrade to "do not stop", then recover
        if (calls === 1) throw new Error("hook exploded")
        return fromStore({ enabled: true, act: true })()
      })
      expect(runs).toBeLessThan(capRuns)
    }),
  )

  it.effect("act OFF (default): a stop-eligible verdict halts nothing", () =>
    Effect.gen(function* () {
      ClassifierVerdict.put(sessionID, verdict())
      const { runs, failed } = yield* drain(fromStore({ enabled: true }))
      expect(runs).toBe(capRuns)
      expect(failed).toBe(true)
    }),
  )

  it.effect("act OFF: the published verdict is left untouched (pure no-op)", () =>
    Effect.gen(function* () {
      ClassifierVerdict.put(sessionID, verdict())
      yield* drain(fromStore({ enabled: true }))
      expect(ClassifierVerdict.get(sessionID)).toEqual(verdict())
    }),
  )

  it.effect("act ON + matching fingerprint + STOP above threshold halts the schedule", () =>
    Effect.gen(function* () {
      ClassifierVerdict.put(sessionID, verdict())
      const { runs, failed, pretty } = yield* drain(fromStore({ enabled: true, act: true }))
      expect(runs).toBeLessThan(capRuns)
      expect(failed).toBe(true)
      // The ORIGINAL error still surfaces through the existing halt handler.
      expect(pretty).toContain("boom")
    }),
  )

  it.effect("act ON + a stale fingerprint for a different failure does NOT halt", () =>
    Effect.gen(function* () {
      ClassifierVerdict.put(sessionID, verdict({ fingerprint: "deadbeef" }))
      const { runs } = yield* drain(fromStore({ enabled: true, act: true }))
      expect(runs).toBe(capRuns)
    }),
  )

  it.effect("act ON + ESCALATE above threshold also halts", () =>
    Effect.gen(function* () {
      ClassifierVerdict.put(sessionID, verdict({ decision: "ESCALATE" }))
      const { runs } = yield* drain(fromStore({ enabled: true, act: true }))
      expect(runs).toBeLessThan(capRuns)
    }),
  )

  it.effect("act ON + confidence below threshold does NOT halt", () =>
    Effect.gen(function* () {
      ClassifierVerdict.put(sessionID, verdict({ confidence: 0.5 }))
      const { runs } = yield* drain(fromStore({ enabled: true, act: true }))
      expect(runs).toBe(capRuns)
    }),
  )

  it.effect("act ON + a non-STOP/ESCALATE decision does NOT halt", () =>
    Effect.gen(function* () {
      ClassifierVerdict.put(sessionID, verdict({ decision: "RETRY" }))
      const { runs } = yield* drain(fromStore({ enabled: true, act: true }))
      expect(runs).toBe(capRuns)
    }),
  )

  it.effect("act ON + no verdict at all does NOT halt (fail-open)", () =>
    Effect.gen(function* () {
      const { runs } = yield* drain(fromStore({ enabled: true, act: true }))
      expect(runs).toBe(capRuns)
    }),
  )

  it.effect("act ON + a verdict from the CURRENT attempt does NOT self-halt", () =>
    Effect.gen(function* () {
      ClassifierVerdict.put(sessionID, verdict({ attempt: 3 }))
      const { runs } = yield* drain(fromStore({ enabled: true, act: true }))
      expect(runs).toBe(capRuns)
    }),
  )
})

describe("shouldStopRetries (pure gate)", () => {
  test("fails open when the classifier is absent", () => {
    expect(
      ClassifierRetry.shouldStopRetries({
        enabled: undefined,
        act: undefined,
        verdict: verdict(),
        fingerprint: current,
        attempt: 3,
        threshold,
      }).stop,
    ).toBe(false)
  })

  test("a configured threshold is honoured inclusively", () => {
    expect(
      ClassifierRetry.shouldStopRetries({
        enabled: true,
        act: true,
        verdict: verdict({ confidence: 0.9 }),
        fingerprint: current,
        attempt: 3,
        threshold: 0.9,
      }).stop,
    ).toBe(true)
  })

  test("act:false refuses to halt and reports no override (safety invariant)", () => {
    // `processor.ts` pre-filters on `act`, so this guard is unreachable from the
    // acting path; call the pure gate directly to prove the invariant holds and
    // that a disabled gate does NOT masquerade as an ACTION_OVERRIDDEN verdict.
    const outcome = ClassifierRetry.shouldStopRetries({
      enabled: true,
      act: false,
      verdict: verdict(),
      fingerprint: current,
      attempt: 3,
      threshold,
    })
    expect(outcome.stop).toBe(false)
    expect(Object.hasOwn(outcome, "overrideReason")).toBe(false)
  })

  test("a stale (fingerprint-mismatched) verdict is a genuine override", () => {
    const outcome = ClassifierRetry.shouldStopRetries({
      enabled: true,
      act: true,
      verdict: verdict({ fingerprint: "different" }),
      fingerprint: current,
      attempt: 3,
      threshold,
    })
    expect(outcome.stop).toBe(false)
    expect(outcome).toMatchObject({ overrideReason: "ACTION_OVERRIDDEN" })
  })
})
