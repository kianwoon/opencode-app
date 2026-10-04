import { describe, expect, test } from "bun:test"
import { SessionID } from "@/session/schema"
import { freezeHead, jevBelowFloor, jevVerdict } from "@/session/prompt"

describe("freezeHead", () => {
  test("a non-nested JEV verdict never re-adopts or drops frozen ids", () => {
    // The verifier trace. `C` is registered in the registry but the t2 verdict
    // keeps {A,C} — a keep-set NOT nested with the frozen {A,B}. The evolution
    // probe reads the FULL registry, so `C` is not a fresh id and the frozen
    // head survives byte-identical; probing the gated subset would adopt
    // {A,C}, drop `B`, and bust the prefix cache every turn.
    const id = SessionID.make("ses_jev-non-nested")
    const registry = { A: {}, B: {}, C: {} }
    const t1 = freezeHead(id, registry, undefined, { A: {}, B: {} })
    expect(t1.adopted).toBe(false)
    expect(Object.keys(t1.head)).toEqual(["A", "B"])
    // t2: verdict narrows to a NON-NESTED set while the registry is unchanged.
    const t2 = freezeHead(id, registry, undefined, { A: {}, C: {} })
    expect(t2.adopted).toBe(false)
    expect(Object.keys(t2.head)).toEqual(["A", "B"])
    // t3: the verdict swings back to the frozen set; still byte-identical.
    const t3 = freezeHead(id, registry, undefined, { A: {}, B: {} })
    expect(t3.adopted).toBe(false)
    expect(Object.keys(t3.head)).toEqual(["A", "B"])
  })

  test("a genuinely new registry tool still adopts the FULL set on the next turn", () => {
    // The growth exception must survive the probe's switch to the full registry:
    // `D` is in neither the memo nor the exempt set, so the head adopts EVERY
    // live id (A,B,D) — never the narrowed gate — and the caller's
    // `frozen.adopted` branch writes the grown list to the durable row.
    const id = SessionID.make("ses_jev-registry-grow")
    const first = freezeHead(id, { A: {}, B: {} }, undefined, { A: {} })
    expect(first.adopted).toBe(false)
    expect(Object.keys(first.head)).toEqual(["A"])
    const second = freezeHead(id, { A: {}, B: {}, D: {} }, undefined, { A: {} })
    expect(second.adopted).toBe(true)
    expect(Object.keys(second.head)).toEqual(["A", "B", "D"])
  })

  test("a restart keeps the frozen head when persisted seen covers the registry", () => {
    // The restart trace. t1 gated to {A,B} while the registry was {A,B,C}, so
    // the durable row recorded tools=["A","B"] but seen=["A","B","C"]. After a
    // restart the memo is gone: probing against `tools` alone reports `C` fresh
    // and adopts {A,B,C}, losing the verdict. `seen` makes the probe answer the
    // same before and after the restart.
    const { head, adopted } = freezeHead(SessionID.make("ses_jev-restart-seen"), { A: {}, B: {}, C: {} }, {
      system: [],
      tools: ["A", "B"],
      seen: ["A", "B", "C"],
    })
    expect(adopted).toBe(false)
    expect(Object.keys(head)).toEqual(["A", "B"])
  })

  test("a legacy row with no seen falls back to persisted tools", () => {
    // A row written before the column existed: `seen` is empty, so the probe
    // behaves exactly as it did before — `C` is genuinely fresh and adopts the
    // full set rather than being silently swallowed.
    const { head, adopted } = freezeHead(SessionID.make("ses_jev-legacy-no-seen"), { A: {}, B: {}, C: {} }, {
      system: [],
      tools: ["A", "B"],
      seen: [],
    })
    expect(adopted).toBe(true)
    expect(Object.keys(head)).toEqual(["A", "B", "C"])
  })

  test("a genuinely new registry tool after a restart adopts and widens seen", () => {
    // The growth exception still fires post-restart, and the caller persists the
    // union so the next relaunch does not re-adopt `D` a second time.
    const id = SessionID.make("ses_jev-restart-grow")
    const persisted = { system: [], tools: ["A", "B"], seen: ["A", "B", "C"] }
    const grown = freezeHead(id, { A: {}, B: {}, C: {}, D: {} }, persisted)
    expect(grown.adopted).toBe(true)
    expect(Object.keys(grown.head)).toEqual(["A", "B", "C", "D"])
    expect(grown.seen).toEqual(["A", "B", "C", "D"])
    // The written head covers D and the written seen is the union, so a further
    // restart reaches the same head without re-adopting.
    const again = freezeHead(SessionID.make("ses_jev-restart-grow-2"), { A: {}, B: {}, C: {}, D: {} }, {
      system: [],
      tools: grown.seen,
      seen: grown.seen,
    })
    expect(again.adopted).toBe(false)
    expect(Object.keys(again.head)).toEqual(["A", "B", "C", "D"])
  })

  test("the initial freeze records every observed id in seen, not just the head", () => {
    // The writer's contract: the first freeze persists the FULL registry as seen
    // even though the gate shaped the emitted head, which is what makes the
    // post-restart probe above correct.
    const result = freezeHead(SessionID.make("ses_jev-initial-seen"), { A: {}, B: {}, C: {} }, undefined, { A: {}, B: {} })
    expect(Object.keys(result.head)).toEqual(["A", "B"])
    expect(result.seen).toEqual(["A", "B", "C"])
  })

  test("preserves exempt tools missing from a legacy persisted head", () => {
    const head = freezeHead(SessionID.make("ses_jev-legacy-head"), { read: {}, session_rename: {} }, {
      system: [],
      tools: ["read", "removed_tool"],
    }).head
    expect(Object.keys(head).toSorted()).toEqual(["read", "session_rename"])
  })

  test("adopts the full live set when a tool was registered after the head froze", () => {
    // The frozen flaw: jev_ask shipped while this session already had a head, so
    // the persisted filter could never admit it. A genuinely NEW live id (in
    // neither the persisted list nor the exempt set) grows the head instead.
    const persisted = { system: [], tools: ["read", "write"] }
    const { head, adopted } = freezeHead(SessionID.make("ses_jev-adopt-new"), { read: {}, write: {}, jev_ask: {} }, persisted)
    expect(adopted).toBe(true)
    expect(Object.keys(head)).toEqual(["jev_ask", "read", "write"])
  })

  test("exempt live tools absent from the persisted head never trigger adoption", () => {
    // JEV_EXEMPT_TOOLS are excluded from the fresh-id probe, so a persisted head
    // that predates them still keeps filtering exactly as before.
    const { head, adopted } = freezeHead(
      SessionID.make("ses_jev-exempt-only"),
      { read: {}, session_rename: {}, grep: {} },
      { system: [], tools: ["read"] },
    )
    expect(adopted).toBe(false)
    expect(Object.keys(head)).toEqual(["grep", "read", "session_rename"])
  })

  test("the memo path adopts when the live toolset grows", () => {
    const id = SessionID.make("ses_jev-memo-grow")
    const first = freezeHead(id, { read: {}, write: {} }, undefined)
    expect(first.adopted).toBe(false)
    // Same session, later turn: a tool appeared after the first freeze.
    const second = freezeHead(id, { read: {}, write: {}, jev_ask: {} }, undefined)
    expect(second.adopted).toBe(true)
    expect(Object.keys(second.head)).toEqual(["jev_ask", "read", "write"])
  })

  test("an unchanged toolset is byte-identical and never re-adopts", () => {
    const id = SessionID.make("ses_jev-stable-memo")
    const first = freezeHead(id, { write: {}, read: {} }, undefined)
    expect(first.adopted).toBe(false)
    expect(Object.keys(first.head)).toEqual(["read", "write"])
    // A per-turn JEV fold NARROWS the live set; that is the oscillation the
    // freeze exists to stop, so the wide head must survive untouched.
    const narrowed = freezeHead(id, { read: {} }, undefined)
    expect(narrowed.adopted).toBe(false)
    expect(Object.keys(narrowed.head)).toEqual(["read", "write"])
    const same = freezeHead(id, { write: {}, read: {} }, undefined)
    expect(same.adopted).toBe(false)
    expect(Object.keys(same.head)).toEqual(["read", "write"])
  })

  test("a persisted head covering the live set filters and sorts exactly as before", () => {
    // Every live id is in the persisted head, so nothing is fresh: the frozen
    // result is the persisted filter, sorted, with adopted=false — the
    // pre-fix behavior byte-for-byte.
    const { head, adopted } = freezeHead(
      SessionID.make("ses_jev-covered-head"),
      { write: {}, read: {} },
      { system: [], tools: ["read", "write", "removed_tool"] },
    )
    expect(adopted).toBe(false)
    expect(Object.keys(head)).toEqual(["read", "write"])
  })

  test("after adopting a grown toolset, later turns stay frozen on it", () => {
    // Turn 1: `question` is live, in neither the persisted head nor the exempt
    // set, so the head adopts the full live set and the row is rewritten.
    const id = SessionID.make("ses_jev-adopt-then-stable")
    const persisted = { system: [], tools: ["read"] }
    const first = freezeHead(id, { read: {}, question: {} }, persisted)
    expect(first.adopted).toBe(true)
    expect(Object.keys(first.head)).toEqual(["question", "read"])
    // Turn 2: identical live set, so nothing is fresh and the adopted head is
    // re-emitted unchanged — adoption happens once, not every turn.
    const second = freezeHead(id, { read: {}, question: {} }, persisted)
    expect(second.adopted).toBe(false)
    expect(Object.keys(second.head)).toEqual(["question", "read"])
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