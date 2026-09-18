import { describe, expect, test } from "bun:test"
import { Effect, Logger } from "effect"

import { ClassifierTrigger } from "@/classifier/trigger"
import type { ClassifierDecision, RetryDecision } from "@/classifier/schema"
import { it } from "../lib/effect"

const decision: ClassifierDecision<RetryDecision> = {
  decision: "RETRY",
  confidence: 0.9,
  reasonCode: "NEW_INFORMATION",
  classifier: "jev",
  latencyMs: 1,
  fallbackUsed: false,
}

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

describe("isEnabled gate (pure)", () => {
  test("disabled master switch is false even with the per-trigger switch on", () => {
    expect(ClassifierTrigger.isEnabled("retry", { enabled: false, retry: true })).toBe(false)
  })

  test("per-trigger switch off is false even with the master on", () => {
    expect(ClassifierTrigger.isEnabled("retry", { enabled: true, retry: false })).toBe(false)
  })

  test("true only when both switches are explicitly true", () => {
    expect(ClassifierTrigger.isEnabled("retry", { enabled: true, retry: true })).toBe(true)
    expect(ClassifierTrigger.isEnabled("relevance", { enabled: true, relevance: true })).toBe(true)
  })

  test("cross-trigger switches do not leak", () => {
    expect(ClassifierTrigger.isEnabled("relevance", { enabled: true, retry: true })).toBe(false)
  })

  test("absent and empty config are disabled, never a throw", () => {
    expect(ClassifierTrigger.isEnabled("retry", undefined)).toBe(false)
    expect(ClassifierTrigger.isEnabled("retry", {})).toBe(false)
  })

  test("unknown name is false", () => {
    expect(ClassifierTrigger.isEnabled("nope" as never, { enabled: true, retry: true })).toBe(false)
  })

  test("a throwing config getter is not swallowed by the pure predicate", () => {
    const hostile = {
      get enabled(): boolean {
        throw new Error("hostile config")
      },
    }
    expect(() => ClassifierTrigger.isEnabled("retry", hostile)).toThrow()
  })
})

describe("run gate", () => {
  it.effect("disabled ⇒ no work at all and nothing is logged", () => {
    const captured = collectDecisions()
    return Effect.gen(function* () {
      yield* ClassifierTrigger.run("retry", { decision, attempt: 1 }, { enabled: true, retry: false }).pipe(
        Effect.provide(captured.layer),
      )
      expect(captured.events).toHaveLength(0)
    })
  })

  it.effect("enabled ⇒ the trigger runs and emits telemetry with actedOn", () => {
    const captured = collectDecisions()
    return Effect.gen(function* () {
      yield* ClassifierTrigger.run(
        "retry",
        { decision, attempt: 3, actedOn: true, sessionID: "ses_1" },
        { enabled: true, retry: true },
      ).pipe(Effect.provide(captured.layer))
      expect(captured.events).toHaveLength(1)
      expect(captured.events[0]).toMatchObject({
        classifier: "jev",
        decision: "RETRY",
        attempt: 3,
        actedOn: true,
        "session.id": "ses_1",
      })
    })
  })

  it.effect("a triggering config getter fails open — the guarded entry point survives", () =>
    ClassifierTrigger.run(
      "retry",
      { decision, attempt: 1 },
      {
        get enabled(): boolean {
          throw new Error("hostile config")
        },
      },
    ))

  it.effect("unknown name ⇒ no-op, no throw", () =>
    ClassifierTrigger.run("nope" as never, { decision, attempt: 1 }, { enabled: true }))

  it.effect("absent config ⇒ no-op", () => ClassifierTrigger.run("retry", { decision, attempt: 1 }, undefined))
})
