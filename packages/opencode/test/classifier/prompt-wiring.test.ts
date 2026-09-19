/**
 * Wiring tests for the three prompt-loop seams (#4 state-extraction, #2
 * verification, #7 gating extras).
 *
 * The seams themselves live inline in `session/prompt.ts` (not exported), so a
 * full turn-loop test is impractical here. These tests therefore exercise the
 * EXACT gates and pure verdict functions the wiring consults, which is what
 * decides whether the seam body is ever reached or whether a retry fires.
 *
 * NOT REACHABLE in a unit test (stated explicitly, not faked): the loop-local
 * `verificationRetried` flag and the `extractedFacts` producer variable. Those
 * are bounded inside `runLoop` and only observable through a driven session.
 */
import { describe, expect, test } from "bun:test"

import { ClassifierTrigger } from "@/classifier/trigger"
import { ClassifierVerification } from "@/classifier/verification"
import { ClassifierRelevance } from "@/classifier/relevance"

describe("gate default-OFF (all three seam flags)", () => {
  test("absent classifier config disables every seam", () => {
    expect(ClassifierTrigger.isEnabled("state-extraction", undefined)).toBe(false)
    expect(ClassifierTrigger.isEnabled("verification", undefined)).toBe(false)
    expect(ClassifierTrigger.isEnabled("relevance", undefined)).toBe(false)
  })

  test("empty classifier config disables every seam", () => {
    expect(ClassifierTrigger.isEnabled("state-extraction", {})).toBe(false)
    expect(ClassifierTrigger.isEnabled("verification", {})).toBe(false)
    expect(ClassifierTrigger.isEnabled("relevance", {})).toBe(false)
  })

  test("master on but per-seam flag absent ⇒ still off", () => {
    expect(ClassifierTrigger.isEnabled("state-extraction", { enabled: true })).toBe(false)
    expect(ClassifierTrigger.isEnabled("verification", { enabled: true })).toBe(false)
  })

  test("each seam flag turns ON exactly its own seam", () => {
    expect(ClassifierTrigger.isEnabled("state-extraction", { enabled: true, state_extraction: true })).toBe(true)
    expect(ClassifierTrigger.isEnabled("verification", { enabled: true, verification: true })).toBe(true)
    expect(ClassifierTrigger.isEnabled("relevance", { enabled: true, relevance: true })).toBe(true)
    // No leakage across seams.
    expect(ClassifierTrigger.isEnabled("verification", { enabled: true, state_extraction: true })).toBe(false)
    expect(ClassifierTrigger.isEnabled("relevance", { enabled: true, verification: true })).toBe(false)
  })
})

describe("verification seam (pure verdict the loop acts on)", () => {
  const checks = ClassifierVerification.DEFAULT_CHECKS

  test("an unsatisfied check folds to FAIL with the failed names — the retry trigger", () => {
    // A real answer below threshold ⇒ not satisfied ⇒ FAIL. This is the ONLY
    // input that can force the single corrective iteration.
    const verdicts = ClassifierVerification.evaluateVerification({
      answers: { addresses_request: { type: "noul", noul: 0.1 } },
      checks,
      threshold: 0.5,
    })
    const out = ClassifierVerification.verdict(verdicts)
    expect(out.decision).toBe("FAIL")
    expect(out.failed).toContain("addresses_request")
  })

  test("all satisfied folds to PASS — no corrective iteration", () => {
    const verdicts = ClassifierVerification.evaluateVerification({
      answers: {},
      checks,
      threshold: 0.5,
    })
    expect(ClassifierVerification.verdict(verdicts).decision).toBe("PASS")
  })

  test("fail-open: absent answers never fail an artifact (no spurious retry)", () => {
    // Missing answers default to satisfied — the seam can never retry on
    // absent data, which is what makes the corrective branch fail-open.
    for (const check of checks) {
      const verdicts = ClassifierVerification.evaluateVerification({
        answers: { [check]: undefined as never },
        checks: [check],
        threshold: 0.5,
      })
      expect(verdicts[0]?.satisfied).toBe(true)
    }
  })

  test("an empty check batch is UNCERTAIN, not a vacuous FAIL", () => {
    expect(ClassifierVerification.verdict([]).decision).toBe("UNCERTAIN")
  })
})

describe("gating-extras backward compatibility", () => {
  test("extras OFF ⇒ question set is byte-identical to the legacy shape", () => {
    const sections = [
      { id: "a", text: "alpha" },
      { id: "b", text: "beta" },
    ]
    const legacy = ClassifierRelevance.buildSectionQuestions("task", sections)
    const explicitEmpty = ClassifierRelevance.buildSectionQuestions("task", sections, [])
    // One question per section, keyed by section id — no `:extra` keys.
    expect(Object.keys(legacy)).toEqual(["a", "b"])
    expect(Object.keys(legacy)).toEqual(Object.keys(explicitEmpty))
  })

  test("extras ON adds exactly one keyed question per section per extra", () => {
    const sections = [{ id: "a", text: "alpha" }]
    const extras = Object.keys(ClassifierRelevance.GATING_EXTRAS) as ClassifierRelevance.GatingExtra[]
    const built = ClassifierRelevance.buildSectionQuestions("task", sections, extras)
    expect(Object.keys(built).length).toBe(1 + extras.length)
    for (const extra of extras) {
      expect(built[ClassifierRelevance.extraQuestionKey("a", extra)]).toBeDefined()
    }
  })

  test("gating fail-open: absent extra answers keep include=true and bad flags false", () => {
    const sections = [{ id: "a", text: "alpha" }]
    const gate = ClassifierRelevance.evaluateGating({ answers: {}, sections })[0]
    expect(gate).toMatchObject({ include: true, stillRelevant: true, duplicate: false, superseded: false })
  })
})
