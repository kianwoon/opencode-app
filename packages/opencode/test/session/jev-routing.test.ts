import { describe, expect, test } from "bun:test"
import { SessionID } from "@/session/schema"
import { freezeHead, jevBelowFloor, jevVerdict } from "@/session/prompt"

describe("freezeHead", () => {
  test("preserves exempt tools missing from a legacy persisted head", () => {
    const head = freezeHead(
      SessionID.make("ses_jev-legacy-head"),
      { read: {}, session_rename: {} },
      { system: [], tools: ["read", "removed_tool"] },
    )
    expect(Object.keys(head).toSorted()).toEqual(["read", "session_rename"])
  })
})

describe("floor guard — a confident skip-all must not strip the turn", () => {
  test("a confident skip-all fold is refused when it lands below the floor", () => {
    // Live regression (ses_f4545cf6): 35 tools, threshold 0.7, every row a
    // confident skip. The fold is still a real decision; the GUARD is what
    // refuses to apply it, and exempt core tools keep the folded set bounded.
    const after = 9
    expect(jevBelowFloor(after, 11)).toBe(true)
  })

  test("a fold at or above the floor is applied, not refused", () => {
    expect(jevBelowFloor(8, 8)).toBe(false)
  })
})

describe("jevVerdict", () => {
  test("scores a categorical answer with the use probability", () => {
    expect(jevVerdict({ choice: "skip", probabilities: { use: 0.13 }, confidence: 0.74 })).toEqual({
      use: false,
      strength: 0.13,
    })
  })

  test("flags an absent probability map as assumed, not as a measured 1", () => {
    // `strength: 1` here stands in for "no score received"; `assumed` is what
    // stops the fold from gating that fabricated number through the threshold.
    expect(jevVerdict({ choice: "use" })).toEqual({ use: true, strength: 1, assumed: true })
  })

  test("ignores a non-categorical answer", () => {
    expect(jevVerdict({ type: "noul", noul: true })).toBeUndefined()
  })
})