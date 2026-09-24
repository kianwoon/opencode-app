import { describe, expect, test } from "bun:test"
import { parseJevAnswer } from "../../src/jev/client.ts"
import { boosterPolicyMetadata } from "../../src/jev/gate.ts"
import { resolveBrainPolicy, type BrainPolicyInput } from "../../src/jev/policy.ts"

const choice = (label: string, probability: number, confidence = 0.5) => ({
  type: "choice",
  choice: label,
  probabilities: { [label]: probability, other: 1 - probability },
  confidence,
})

const score = (value: number) => ({
  type: "score",
  score: value,
  legend: { "0": "zero", "1": "one", "2": "two" },
  probabilities: { [value]: 0.99 },
})

const policy = (input: Partial<BrainPolicyInput> = {}): BrainPolicyInput => ({
  allowedActions: ["continue", "verify", "switch", "finish", "escalate"],
  fallbackAction: "continue",
  choiceThreshold: 0.7,
  noulThreshold: 0.7,
  ...input,
})

describe("parseJevAnswer — typed decision rows", () => {
  test("parses a measured choice and keeps confidence as metadata", () => {
    const result = parseJevAnswer(choice("verify", 0.91, 0.8))
    expect(result).toMatchObject({
      type: "choice",
      choice: "verify",
      strength: 0.91,
      probability: 0.91,
      probabilities: { verify: 0.91 },
      confidence: 0.8,
    })
    if (result.type === "choice") expect(result.probabilities.other).toBeCloseTo(0.09)
  })

  test("infers type-free Choice aliases, Score, and Noul rows", () => {
    for (const field of ["choice", "answer", "value", "label", "decision"]) {
      expect(parseJevAnswer({ [field]: "verify", probabilities: { verify: 0.9 } })).toMatchObject({
        type: "choice",
        choice: "verify",
        strength: 0.9,
      })
    }
    expect(parseJevAnswer({ score: 1.5, legend: { "0": "zero", "2": "two" } })).toEqual({
      type: "score",
      score: 1.5,
      normalizedScore: 0.75,
      legend: { "0": "zero", "2": "two" },
    })
    expect(parseJevAnswer({ noul: 0.3 })).toEqual({ type: "noul", noul: 0.3 })
  })

  test("rejects unknown and mismatched explicit types", () => {
    expect(parseJevAnswer({ type: "unknown" })).toEqual({ type: "unavailable", reason: "malformed" })
    expect(parseJevAnswer({ type: "score", choice: "verify", score: 1, legend: { "1": "one" } })).toEqual({
      type: "unavailable",
      reason: "malformed",
    })
    expect(parseJevAnswer({ type: "choice", noul: 0.3, choice: "verify", probabilities: { verify: 0.9 } })).toEqual({
      type: "unavailable",
      reason: "malformed",
    })
  })

  test("rejects scores outside the legend range and keeps normalized bounds", () => {
    const legend = { "0": "zero", "2": "two" }
    expect(parseJevAnswer({ type: "score", score: -0.1, legend })).toEqual({
      type: "unavailable",
      reason: "malformed",
    })
    expect(parseJevAnswer({ type: "score", score: 2.1, legend })).toEqual({
      type: "unavailable",
      reason: "malformed",
    })
    expect(parseJevAnswer({ type: "score", score: 0, legend })).toEqual({
      type: "score",
      score: 0,
      normalizedScore: 0,
      legend,
    })
    expect(parseJevAnswer({ type: "score", score: 2, legend })).toEqual({
      type: "score",
      score: 2,
      normalizedScore: 1,
      legend,
    })
  })

  test("returns an explicit missing result for an absent row", () => {
    expect(parseJevAnswer(undefined)).toEqual({ type: "unavailable", reason: "missing" })
  })

  test("reports a missing selected probability as unmeasured", () => {
    expect(parseJevAnswer({ type: "choice", choice: "verify", probabilities: { other: 1 } })).toEqual({
      type: "unavailable",
      reason: "unmeasured",
    })
  })

  test("reports malformed values without guessing", () => {
    expect(parseJevAnswer({ type: "choice", choice: 1, probabilities: {} })).toEqual({
      type: "unavailable",
      reason: "malformed",
    })
    expect(parseJevAnswer({ type: "choice", choice: "verify", probabilities: { verify: "0.9" } })).toEqual({
      type: "unavailable",
      reason: "malformed",
    })
    expect(parseJevAnswer({ type: "noul", noul: 1.1 })).toEqual({ type: "unavailable", reason: "malformed" })
    expect(parseJevAnswer({ type: "noul", noul: true })).toEqual({ type: "unavailable", reason: "malformed" })
  })

  test("normalizes a score by the maximum numeric legend key", () => {
    const result = parseJevAnswer({ type: "score", score: 1.5, legend: { "0": "zero", "2": "two" } })
    expect(result).toEqual({ type: "score", score: 1.5, normalizedScore: 0.75, legend: { "0": "zero", "2": "two" } })
  })

  test("rejects a score without a usable numeric legend", () => {
    expect(parseJevAnswer({ type: "score", score: 1.5, legend: { low: "zero", high: "two" } })).toEqual({
      type: "unavailable",
      reason: "unmeasured",
    })
  })

  test("accepts only finite Noul values in the closed unit interval", () => {
    expect(parseJevAnswer({ type: "noul", noul: 0 })).toEqual({ type: "noul", noul: 0 })
    expect(parseJevAnswer({ type: "noul", noul: 1 })).toEqual({ type: "noul", noul: 1 })
    expect(parseJevAnswer({ type: "noul", noul: -0.01 })).toEqual({ type: "unavailable", reason: "malformed" })
    expect(parseJevAnswer({ type: "noul", noul: 1.01 })).toEqual({ type: "unavailable", reason: "malformed" })
    expect(parseJevAnswer({ type: "noul", noul: Number.NaN })).toEqual({ type: "unavailable", reason: "malformed" })
  })
})

describe("boosterPolicyMetadata — advisory-only policy seam", () => {
  test("returns measured verify metadata", () => {
    const result = boosterPolicyMetadata(
      { type: "choice", choice: "verify", probabilities: { verify: 0.9 } },
      0.7,
    )
    expect(result).toMatchObject({
      action: "verify",
      source: "choice",
      reason: "choice-accepted",
      decisions: { choice: { strength: 0.9, probability: 0.9 } },
    })
    expect(result.unavailable).toEqual([])
  })

  test("returns fallback for a low-strength row", () => {
    const result = boosterPolicyMetadata(
      { type: "choice", choice: "switch", probabilities: { switch: 0.2 } },
      0.7,
    )
    expect(result).toMatchObject({ action: "continue", source: "fallback", reason: "choice-rejected" })
  })

  test("keeps a missing row visible as unavailable metadata", () => {
    const result = boosterPolicyMetadata(undefined, 0.7)
    expect(result).toMatchObject({
      action: "continue",
      source: "fallback",
      unavailable: [{ question: "choice", reason: "missing" }],
    })
  })

  test("accepts contradiction as an advisory action", () => {
    const result = boosterPolicyMetadata(
      { type: "choice", choice: "contradiction", probabilities: { contradiction: 0.9 } },
      0.7,
    )
    expect(result).toMatchObject({ action: "contradiction", source: "choice", reason: "choice-accepted" })
  })
})

describe("resolveBrainPolicy — Noul prefilter then measured Choice gate", () => {
  test("uses a valid measured choice at the threshold", () => {
    const result = resolveBrainPolicy(
      policy({
        choice: parseJevAnswer(choice("verify", 0.7)),
        noul: parseJevAnswer({ type: "noul", noul: 0.7 }),
      }),
    )
    expect(result.action).toBe("verify")
    expect(result.source).toBe("choice")
    expect(result.reason).toBe("choice-accepted")
  })

  test("confidence is never used as the choice gate", () => {
    const lowProbability = resolveBrainPolicy(
      policy({ choice: parseJevAnswer(choice("verify", 0.1, 0.99)) }),
    )
    expect(lowProbability.action).toBe("continue")
    expect(lowProbability.reason).toBe("choice-rejected")

    const highProbability = resolveBrainPolicy(
      policy({ choice: parseJevAnswer(choice("verify", 0.9, 0.01)) }),
    )
    expect(highProbability.action).toBe("verify")
  })

  test("rejects a measured choice outside the allow-list", () => {
    const result = resolveBrainPolicy(
      policy({
        choice: parseJevAnswer(choice("escalate", 0.99)),
        allowedActions: ["continue", "verify"],
      }),
    )
    expect(result).toMatchObject({ action: "continue", source: "fallback", reason: "choice-not-allowed" })
  })

  test("fails closed to the fallback when valid Noul is below threshold", () => {
    const result = resolveBrainPolicy(
      policy({
        choice: parseJevAnswer(choice("verify", 0.99)),
        noul: parseJevAnswer({ type: "noul", noul: 0.2 }),
      }),
    )
    expect(result).toMatchObject({ action: "continue", source: "noul", reason: "noul-rejected" })
  })

  test("fails open from malformed Noul to a valid measured choice", () => {
    const result = resolveBrainPolicy(
      policy({
        choice: parseJevAnswer(choice("switch", 0.95)),
        noul: parseJevAnswer({ type: "noul", noul: false }),
      }),
    )
    expect(result).toMatchObject({ action: "switch", source: "choice", reason: "choice-accepted" })
  })

  test("keeps an unavailable Choice visible in the result", () => {
    const result = resolveBrainPolicy(
      policy({ choice: parseJevAnswer({ type: "choice", choice: "verify" }) }),
    )
    expect(result).toMatchObject({
      action: "continue",
      source: "fallback",
      unavailable: [{ question: "choice", reason: "unmeasured" }],
    })
  })

  test("keeps a missing Choice row visible as unavailable metadata", () => {
    const result = resolveBrainPolicy(policy({ choice: parseJevAnswer(undefined) }))
    expect(result).toMatchObject({
      action: "continue",
      source: "fallback",
      unavailable: [{ question: "choice", reason: "missing" }],
    })
  })

  test("keeps malformed Noul metadata visible while failing open", () => {
    const result = resolveBrainPolicy(
      policy({
        choice: parseJevAnswer(choice("switch", 0.95)),
        noul: parseJevAnswer({ type: "noul", noul: false }),
      }),
    )
    expect(result).toMatchObject({
      action: "switch",
      source: "choice",
      unavailable: [{ question: "noul", reason: "malformed" }],
    })
  })

  test("keeps Score advisory and never rewrites the action", () => {
    const advisory = parseJevAnswer(score(0.1))
    const result = resolveBrainPolicy(policy({ choice: parseJevAnswer(choice("finish", 0.9)), score: advisory }))
    expect(result.action).toBe("finish")
    expect(result.decisions.score?.normalizedScore).toBeCloseTo(0.05)
  })
})
