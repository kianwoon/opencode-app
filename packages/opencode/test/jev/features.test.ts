import { describe, expect, test } from "bun:test"
import {
  computeRepetitionScore,
  computeTodoChurn,
  extractTemporalFeatures,
  type PromptRow,
} from "../../src/jev/features"

const prompts: PromptRow[] = [
  { time: 0, text: "first" },
  { time: 600_000, text: "second" },
  { time: 3_600_000, text: "third" },
  { time: 7_200_000, text: "fourth" },
]

describe("extractTemporalFeatures", () => {
  test("decomposes wall time, active span, and idle gaps", () => {
    const features = extractTemporalFeatures(0, 7_200_000, prompts)
    expect(features.wall_hours).toBeCloseTo(2)
    expect(features.active_span_hours).toBeCloseTo(2)
    expect(features.max_idle_hours).toBeCloseTo(1)
    expect(features.idle_ratio).toBeCloseTo(0.5)
    expect(features.prompt_count).toBe(4)
  })

  test("handles empty prompts and non-positive wall time", () => {
    expect(extractTemporalFeatures(0, 7_200_000, [])).toEqual({
      wall_hours: 0,
      active_span_hours: 0,
      max_idle_hours: 0,
      idle_ratio: 0,
      prompt_count: 0,
    })
    const invalid = extractTemporalFeatures(100, 100, [{ time: 200, text: "late" }])
    expect(invalid.wall_hours).toBe(0)
    expect(invalid.idle_ratio).toBe(0)
  })
})

describe("computeRepetitionScore", () => {
  test("scores highly repetitive prompts", () => {
    expect(
      computeRepetitionScore([
        "fix the failing test",
        "fix the failing test",
        "fix the failing test again and also check lint",
      ]),
    ).toBeGreaterThanOrEqual(0.7)
  })

  test("scores distinct prompts low and identical pairs exactly one", () => {
    expect(computeRepetitionScore(["fix auth bug", "refactor database layer", "write docs for cli"])).toBeLessThanOrEqual(0.3)
    expect(computeRepetitionScore(["same prompt", "same prompt"])).toBe(1)
  })

  test("returns zero with fewer than two texts", () => {
    expect(computeRepetitionScore([])).toBe(0)
    expect(computeRepetitionScore(["only one"])).toBe(0)
  })
})

describe("computeTodoChurn", () => {
  test("divides todowrite count by prompt count with edge guards", () => {
    expect(computeTodoChurn({ todowrite: 10, read: 100 }, 40)).toBe(0.25)
    expect(computeTodoChurn({ read: 100 }, 0)).toBe(0)
    expect(computeTodoChurn({}, 40)).toBe(0)
  })
})
