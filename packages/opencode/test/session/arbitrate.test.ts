import { describe, expect, test } from "bun:test"
import {
  ARBITRATE_STATE_MAX_CHARS,
  ARBITRATE_THRESHOLD_DEFAULT,
  arbitrate,
  arbitrateLogRows,
  arbitrateState,
} from "@/session/arbitrate"

const entry = (callID: string, output: string) => ({ callID, output })

describe("arbitrate — turn-level batch join for task results", () => {
  test("ranks scored outputs by descending score, argmax first", () => {
    const result = arbitrate({
      entries: [entry("a", "out-a"), entry("b", "out-b"), entry("c", "out-c")],
      scores: new Map([
        ["a", 0.61],
        ["b", 0.93],
        ["c", 0.72],
      ]),
    })
    expect(result.ranked).toBe(true)
    expect([...result.order]).toEqual(["b", "c", "a"])
    expect(result.ranks).toEqual([
      { callID: "b", rank: 1, score: 0.93 },
      { callID: "c", rank: 2, score: 0.72 },
      { callID: "a", rank: 3, score: 0.61 },
    ])
  })

  test("keeps an advisory float score — never integer-folds it", () => {
    // jev.md §5: the `score >= 2` integer fold drops near-useful rows (1.76).
    const result = arbitrate({
      entries: [entry("low", "x"), entry("high", "y")],
      scores: new Map([
        ["low", 0.9],
        ["high", 1.76],
      ]),
    })
    expect(result.order[0]).toBe("high")
    // The raw float survives: rounding to 1 or 2 would be a silent re-rank.
    expect(result.ranks[0]!.score).toBe(1.76)
    expect(result.ranks[1]!.score).toBe(0.9)
    expect(result.ranks.every((row) => Number.isInteger(row.rank))).toBe(true)
  })

  test("fails open unranked when every score is absent", () => {
    const result = arbitrate({
      entries: [entry("a", "out-a"), entry("b", "out-b")],
      scores: undefined,
    })
    expect(result.ranked).toBe(false)
    expect([...result.order]).toEqual(["a", "b"])
    expect(result.ranks).toEqual([])
  })

  test("fails open unranked when rows are present but null/non-finite", () => {
    const result = arbitrate({
      entries: [entry("a", "out-a"), entry("b", "out-b")],
      scores: new Map<string, number | undefined>([
        ["a", undefined],
        ["b", Number.NaN],
      ]),
    })
    expect(result.ranked).toBe(false)
    expect([...result.order]).toEqual(["a", "b"])
    expect(result.ranks).toEqual([])
  })

  test("treats a below-threshold score as unranked and never drops the output", () => {
    const result = arbitrate({
      entries: [entry("a", "out-a"), entry("b", "out-b")],
      scores: new Map([
        ["a", ARBITRATE_THRESHOLD_DEFAULT - 0.01],
        ["b", ARBITRATE_THRESHOLD_DEFAULT],
      ]),
    })
    expect(result.order[0]).toBe("b")
    // The weak row is still present, just last — fail open, never drop.
    expect([...result.order]).toEqual(["b", "a"])
    expect(result.ranks).toEqual([{ callID: "b", rank: 1, score: ARBITRATE_THRESHOLD_DEFAULT }])
  })

  test("appends unranked entries after ranked ones in input order", () => {
    const result = arbitrate({
      entries: [entry("a", "out-a"), entry("b", "out-b"), entry("c", "out-c"), entry("d", "out-d")],
      scores: new Map<string, number | undefined>([
        ["a", undefined],
        ["c", 0.8],
        ["d", 0.0],
      ]),
    })
    expect([...result.order]).toEqual(["c", "a", "b", "d"])
    expect(result.ranks).toEqual([{ callID: "c", rank: 1, score: 0.8 }])
  })

  test("keeps input order on equal scores (stable, no arbitrary swap)", () => {
    const result = arbitrate({
      entries: [entry("a", "out-a"), entry("b", "out-b"), entry("c", "out-c")],
      scores: new Map([
        ["a", 0.8],
        ["b", 0.8],
        ["c", 0.8],
      ]),
    })
    expect([...result.order]).toEqual(["a", "b", "c"])
  })

  test("does not join a single result (nothing to arbitrate)", () => {
    const result = arbitrate({ entries: [entry("a", "out-a")], scores: new Map([["a", 0.99]]) })
    expect(result.ranked).toBe(false)
    expect([...result.order]).toEqual(["a"])
    expect(result.ranks).toEqual([])
  })

  test("never mutates the inputs — persisted output bytes are untouched", () => {
    const entries = Object.freeze([
      Object.freeze({ callID: "a", output: "out-a" }),
      Object.freeze({ callID: "b", output: "out-b" }),
    ])
    const scores = new Map([
      ["a", 0.2],
      ["b", 0.9],
    ])
    const before = entries.map((e) => e.output)
    const result = arbitrate({ entries, scores })
    // Frozen inputs would have thrown on any write; re-assert bytes anyway.
    expect(entries.map((e) => e.output)).toEqual(before)
    expect(entries[0]!.output).toBe("out-a")
    expect(entries[1]!.output).toBe("out-b")
    expect(entries.map((e) => e.callID)).toEqual(["a", "b"])
    expect([...result.order]).toEqual(["b", "a"])
    expect(scores.get("a")).toBe(0.2)
  })

  test("emits bounded telemetry rows with no result contents", () => {
    const result = arbitrate({
      entries: [entry("a", "SECRET-BODY-a"), entry("b", "SECRET-BODY-b")],
      scores: new Map([
        ["a", 0.95],
        ["b", 0.55],
      ]),
    })
    const rows = arbitrateLogRows(result)
    expect(rows).toEqual([
      { callID: "a", rank: 1, score: 0.95 },
      { callID: "b", rank: 2, score: 0.55 },
    ])
    for (const row of rows) expect(Object.keys(row).toSorted()).toEqual(["callID", "rank", "score"])
  })
})

describe("arbitrateState — goal when reachable, else a bounded output head", () => {
  test("uses the delegating goal when present", () => {
    expect(arbitrateState("ship the arbitration core", "x".repeat(900))).toBe("ship the arbitration core")
  })

  test("falls back to the output head, never the full contents", () => {
    const long = "h".repeat(ARBITRATE_STATE_MAX_CHARS + 250)
    const state = arbitrateState(undefined, long)
    expect(state.length).toBe(ARBITRATE_STATE_MAX_CHARS)
    expect(long.startsWith(state)).toBe(true)
  })

  test("treats a blank goal as absent", () => {
    expect(arbitrateState("   ", "out-head")).toBe("out-head")
  })

  test("keeps a short output whole", () => {
    expect(arbitrateState(undefined, "short")).toBe("short")
  })
})
