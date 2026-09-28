import { describe, expect, test } from "bun:test"
import {
  computeRepetitionScore,
  computeTodoChurn,
  extractRecencyFeatures,
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

describe("extractRecencyFeatures", () => {
  test("computes trailing idle and recent prompt features", () => {
    const features = extractRecencyFeatures(10_800_000, prompts, 60)
    expect(features.trailing_idle_hours).toBeCloseTo(1)
    expect(features.recent_prompts).toBe(1)
    expect(features.recent_repetition_score).toBe(0)
  })

  test("uses a wider window and scores repeated recent prompts", () => {
    const recentPrompts: PromptRow[] = [
      { time: 0, text: "first" },
      { time: 600_000, text: "second" },
      { time: 3_600_000, text: "fix the failing auth test" },
      { time: 7_200_000, text: "fix the failing auth test again" },
    ]
    const features = extractRecencyFeatures(10_800_000, recentPrompts, 120)
    expect(features.recent_prompts).toBe(2)
    expect(features.recent_repetition_score).toBeGreaterThanOrEqual(0.5)
  })

  test("handles empty prompts and prompts outside the window", () => {
    expect(extractRecencyFeatures(10_800_000, [])).toEqual({
      trailing_idle_hours: 0,
      recent_prompts: 0,
      recent_repetition_score: 0,
    })
    const oldPrompt = extractRecencyFeatures(10_800_000, [{ time: 0, text: "old" }])
    expect(oldPrompt.recent_prompts).toBe(0)
    expect(oldPrompt.recent_repetition_score).toBe(0)
    expect(oldPrompt.trailing_idle_hours).toBeCloseTo(3)
  })

  test("clamps trailing idle when the session end precedes the last prompt", () => {
    const features = extractRecencyFeatures(3_600_000, [{ time: 7_200_000, text: "late" }])
    expect(features.trailing_idle_hours).toBe(0)
  })
})

describe("non-finite prompt times", () => {
  test("a NaN time yields no NaN in either feature object", () => {
    // A non-numeric sqlite `time` must not poison the derived arithmetic.
    const rows: PromptRow[] = [
      { time: 0, text: "first" },
      { time: Number.NaN, text: "broken" },
      { time: 7_200_000, text: "last" },
    ]
    const temporal = extractTemporalFeatures(0, 7_200_000, rows)
    expect(Object.values(temporal).some((value) => Number.isNaN(value))).toBe(false)
    const recency = extractRecencyFeatures(7_200_000, rows, 60)
    expect(Object.values(recency).some((value) => Number.isNaN(value))).toBe(false)
  })
})
