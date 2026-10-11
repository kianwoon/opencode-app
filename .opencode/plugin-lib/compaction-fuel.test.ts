import { describe, expect, test } from "bun:test"
import { fuelKeeps } from "./compaction-fuel.ts"

// INVARIANT (acceptance gate): only a MEASURED score row whose
// probabilities["2"] (load-bearing) or probabilities["1"] (background) clears
// max(threshold, floor) earns a directive, and the two tiers together never
// exceed maxKeeps. (b) below-threshold, (c) missing row, and (d) degraded row
// are the failing instances of that invariant.
//
// UNSEEN input the fold also handles: `answers` keyed by ids that are NOT in
// `turns` are ignored — the fold iterates turns and looks up answers, never the
// reverse.

const opts = { threshold: 0.6, floor: 0.3, maxKeeps: 5 }

/** user text embeds the id so the directive's digest head also carries it. */
const turn = (id: string, extra = "") => ({
  id,
  user: `${id} request ${extra}`.trim(),
  assistant: `${id} answer`,
})

const score = (p1: number | undefined, p2: number | undefined) => ({
  probabilities: {
    ...(p1 !== undefined ? { "1": p1 } : {}),
    ...(p2 !== undefined ? { "2": p2 } : {}),
  },
})

describe("fuelKeeps — pure relevance fold", () => {
  test("(a) a measured load-bearing row earns a VERBATIM directive with id + digest head", () => {
    const { loadBearing, background } = fuelKeeps({ "turn:t1": score(undefined, 0.9) }, [turn("t1", "alpha")], opts)
    expect(loadBearing).toHaveLength(1)
    expect(loadBearing[0]).toContain("t1")
    expect(loadBearing[0]).toContain("t1 request alpha")
    expect(loadBearing[0]).toContain("VERBATIM")
    expect(background).toHaveLength(0)
  })

  test("(b) a row below max(threshold, floor) earns nothing", () => {
    const { loadBearing, background } = fuelKeeps({ "turn:t1": score(undefined, 0.5) }, [turn("t1")], opts)
    expect(loadBearing).toHaveLength(0)
    expect(background).toHaveLength(0)
  })

  test("(c) a missing row earns nothing, and answer ids absent from turns are ignored", () => {
    const { loadBearing, background } = fuelKeeps({ "turn:ghost": score(undefined, 0.99) }, [turn("t1")], opts)
    expect(loadBearing).toHaveLength(0)
    expect(background).toHaveLength(0)
  })

  test("(d) a degraded row without a probabilities object earns nothing", () => {
    const { loadBearing, background } = fuelKeeps(
      { "turn:t1": { confidence: 0.99 }, "turn:t2": { probabilities: { "2": "high" } } },
      [turn("t1"), turn("t2")],
      opts,
    )
    expect(loadBearing).toHaveLength(0)
    expect(background).toHaveLength(0)
  })

  test("(e) maxKeeps caps load-bearing by descending probability", () => {
    const turns = [turn("t1"), turn("t2"), turn("t3")]
    const answers = {
      "turn:t1": score(undefined, 0.7),
      "turn:t2": score(undefined, 0.95),
      "turn:t3": score(undefined, 0.8),
    }
    const { loadBearing } = fuelKeeps(answers, turns, { ...opts, maxKeeps: 2 })
    expect(loadBearing).toHaveLength(2)
    expect(loadBearing[0]).toContain("t2")
    expect(loadBearing[1]).toContain("t3")
  })

  test("(f) background fills only the slots remaining after load-bearing", () => {
    const turns = [turn("t1"), turn("t2"), turn("t3")]
    const answers = {
      "turn:t1": score(undefined, 0.9),
      "turn:t2": score(0.9, undefined),
      "turn:t3": score(0.7, undefined),
    }
    const { loadBearing, background } = fuelKeeps(answers, turns, { ...opts, maxKeeps: 2 })
    expect(loadBearing).toHaveLength(1)
    expect(background).toHaveLength(1)
    expect(background[0]).toContain("t2")
  })

  test("(g) the rule generalizes across a second set of ids, digests, and thresholds", () => {
    const run = (prefix: string, threshold: number, gate: number) => {
      const turns = [turn(`${prefix}a`, "alpha"), turn(`${prefix}b`, "beta")]
      const answers = {
        [`turn:${prefix}a`]: score(undefined, gate + 0.05),
        [`turn:${prefix}b`]: score(undefined, gate - 0.05),
      }
      return fuelKeeps(answers, turns, { threshold, floor: 0.3, maxKeeps: 5 })
    }
    const first = run("x", 0.5, 0.5)
    const second = run("zz", 0.8, 0.8)
    expect(first.loadBearing).toHaveLength(1)
    expect(first.loadBearing[0]).toContain("xa request alpha")
    expect(second.loadBearing).toHaveLength(1)
    expect(second.loadBearing[0]).toContain("zza request alpha")
  })
})
