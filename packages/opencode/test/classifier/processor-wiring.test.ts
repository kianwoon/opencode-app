/**
 * Processor wiring for scoring seam #1 (risk action at the retry point).
 *
 * Two things are pinned here, both against REAL production code (no mocks, no
 * `any`):
 *
 *  1. The DEFAULT-OFF gate: `ClassifierTrigger.isEnabled("scoring", config)`
 *     must be false unless BOTH `classifier.enabled` and `classifier.scoring`
 *     are exactly `true`. With it false the processor's `set` callback never
 *     forks the scoring fiber — zero work, zero latency.
 *
 *  2. The pure action mapping `scoringRiskDecision`: only an at/above-threshold
 *     `risk` dimension produces the ESCALATE/actedOn signal; an absent
 *     (unanswered/fail-open) or below-threshold risk produces `undefined`.
 *
 * SCOPE NOTE (stated explicitly): a full retry-path integration test would run
 * the real `SessionRetry.policy` schedule through `SessionProcessor` and is
 * impractical in isolation — the processor requires the whole session/service
 * graph. This suite therefore asserts the two units the wiring composes: the
 * gate and the decision mapping. The telemetry emit itself is exercised by
 * `act-chain.test.ts` against the real `ClassifierTelemetry.decision`.
 */
import { describe, expect, test } from "bun:test"

import { ClassifierTrigger } from "@/classifier/trigger"
import { scoringRiskDecision } from "@/session/processor"

describe("scoring seam gate (default OFF)", () => {
  test("flag absent ⇒ disabled, no scoring call", () => {
    expect(ClassifierTrigger.isEnabled("scoring", undefined)).toBe(false)
    expect(ClassifierTrigger.isEnabled("scoring", {})).toBe(false)
  })

  test("enabled but scoring absent ⇒ disabled", () => {
    expect(ClassifierTrigger.isEnabled("scoring", { enabled: true })).toBe(false)
    expect(ClassifierTrigger.isEnabled("scoring", { enabled: true, scoring: false })).toBe(false)
  })

  test("scoring true but master disabled ⇒ disabled", () => {
    expect(ClassifierTrigger.isEnabled("scoring", { enabled: false, scoring: true })).toBe(false)
  })

  test("BOTH true ⇒ enabled", () => {
    expect(ClassifierTrigger.isEnabled("scoring", { enabled: true, scoring: true })).toBe(true)
  })
})

describe("scoringRiskDecision (pure action mapping)", () => {
  const threshold = 0.8

  test("high-risk score at/above threshold ⇒ ESCALATE action", () => {
    const acted = scoringRiskDecision(
      { risk: { level: "high", value: 1, confidence: 0.9 } },
      threshold,
    )
    expect(acted).toEqual({ decision: "ESCALATE", confidence: 0.9, reasonCode: "SCORES_RATED", threshold })
  })

  test("risk exactly at threshold ⇒ acts", () => {
    expect(scoringRiskDecision({ risk: { level: "high", value: 0.8, confidence: 0.7 } }, threshold)).toBeDefined()
  })

  test("below-threshold risk ⇒ no action (fail-open)", () => {
    expect(scoringRiskDecision({ risk: { level: "low", value: 0.4, confidence: 0.9 } }, threshold)).toBeUndefined()
  })

  test("absent risk dimension (unanswered batch) ⇒ no action", () => {
    expect(scoringRiskDecision({}, threshold)).toBeUndefined()
    expect(scoringRiskDecision({ complexity: { level: "high", value: 1, confidence: 1 } }, threshold)).toBeUndefined()
  })
})
