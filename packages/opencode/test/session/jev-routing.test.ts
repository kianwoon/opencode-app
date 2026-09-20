import { describe, expect, test } from "bun:test"
import { jevBelowFloor, jevFoldTools, jevKeepTools, jevVerdict } from "@/session/prompt"

// Shapes below are verbatim captures from the live decisions endpoint
// (answers keyed q1..qN, choice + probabilities + confidence per row).
const round = (answers: Record<string, unknown>, names: string[], threshold = 0.7) =>
  jevKeepTools({ answers }, names, threshold)

describe("jevKeepTools", () => {
  test("keeps a confident use and drops a confident skip", () => {
    const keep = round(
      {
        read: { type: "choice", choice: "use", probabilities: { skip: 0.13, use: 0.87 }, confidence: 0.87 },
        edit: { type: "choice", choice: "skip", probabilities: { skip: 0.93, use: 0.07 }, confidence: 0.93 },
      },
      ["read", "edit"],
    )
    expect(keep?.has("read")).toBe(true)
    expect(keep?.has("edit")).toBe(false)
  })

  test("drops a confident skip even though its confidence clears the threshold", () => {
    // Regression: gating on `confidence` kept this row and stripped delegation.
    const keep = round(
      { edit: { type: "choice", choice: "skip", probabilities: { skip: 0.87, use: 0.13 }, confidence: 0.74 } },
      ["edit"],
      undefined,
    )
    expect(keep?.has("edit")).toBe(false)
  })

  test("drops a weak use below the threshold", () => {
    const keep = round(
      { read: { type: "choice", choice: "use", probabilities: { skip: 0.44, use: 0.56 }, confidence: 0.11 } },
      ["read"],
    )
    expect(keep?.has("read")).toBe(false)
  })

  test("never routes away task, StructuredOutput, or invalid", () => {
    const keep = round(
      {
        task: { type: "choice", choice: "skip", probabilities: { skip: 0.99, use: 0.01 }, confidence: 0.99 },
        StructuredOutput: { type: "choice", choice: "skip", probabilities: { skip: 1, use: 0 }, confidence: 1 },
        invalid: { type: "choice", choice: "skip", probabilities: { skip: 1, use: 0 }, confidence: 1 },
      },
      ["task", "StructuredOutput", "invalid"],
    )
    expect(keep?.has("task")).toBe(true)
    expect(keep?.has("StructuredOutput")).toBe(true)
    expect(keep?.has("invalid")).toBe(true)
  })

  test("discards answers whose id was never asked about instead of pairing by position", () => {
    // Regression: positional fallback (names[i]) paired q1→read, q2→bash, so a
    // verdict the endpoint never gave about `bash` removed `bash` from the
    // turn's tool list. Unknown ids are now counted and dropped, and the tools
    // they would have been misattributed to fail open (stay in the list).
    const keep = round(
      {
        q1: { type: "choice", choice: "use", probabilities: { skip: 0.1, use: 0.9 }, confidence: 0.9 },
        q2: { type: "choice", choice: "skip", probabilities: { skip: 0.9, use: 0.1 }, confidence: 0.9 },
      },
      ["read", "bash"],
    )
    // Neither tool is removed: the rows name no tool this request asked about,
    // and an unattributable verdict is never evidence to strip a tool.
    expect(keep?.has("read")).toBe(true)
    expect(keep?.has("bash")).toBe(true)
    expect(jevFoldTools({ answers: { q1: {}, q2: {} } }, ["read", "bash"], 0.7)?.dropped.unknownId).toBe(2)
    // The all-unknown case keeps everything: with no attributable row there is
    // no opinion to act on, and an empty keep-set would strip the turn's tools.
    const allUnknown = jevFoldTools({ answers: { q1: { type: "choice", choice: "skip" } } }, ["read", "bash"], 0.7)
    expect(allUnknown?.keep.has("read")).toBe(true)
    expect(allUnknown?.keep.has("bash")).toBe(true)
    expect(allUnknown?.dropped.unknownId).toBe(1)
  })

  test("pairs by id when the endpoint echoes the tool names it was asked about", () => {
    const keep = round(
      {
        read: { type: "choice", choice: "use", probabilities: { skip: 0.1, use: 0.9 }, confidence: 0.9 },
        bash: { type: "choice", choice: "skip", probabilities: { skip: 0.9, use: 0.1 }, confidence: 0.9 },
      },
      ["read", "bash"],
    )
    expect(keep?.has("read")).toBe(true)
    expect(keep?.has("bash")).toBe(false)
  })

  test("fails open on a row with no probabilities instead of grouping an assumed score", () => {
    // A `use` with no measured probability must not be treated as strength 1:
    // the fold reports it as unmeasured and keeps the tool (fail-open).
    const fold = jevFoldTools({ answers: { read: { type: "choice", choice: "use" } } }, ["read"], 0.7)
    expect(fold?.keep.has("read")).toBe(true)
    expect(fold?.dropped.unmeasured).toBe(1)
  })

  test("keeps exempt tools even when a partial response omits their answer", () => {
    // Regression: a truncated endpoint echo (answers without `task`) must not
    // drop `task` from the narrowed set — exempt names are seeded up front.
    const keep = round(
      { read: { type: "choice", choice: "use", probabilities: { skip: 0.1, use: 0.9 }, confidence: 0.9 } },
      ["read", "task"],
    )
    expect(keep?.has("read")).toBe(true)
    expect(keep?.has("task")).toBe(true)
  })

  test("fails open when the payload carries no answers", () => {
    expect(jevKeepTools({}, ["read"], 0.7)).toBeUndefined()
    expect(jevKeepTools(null, ["read"], 0.7)).toBeUndefined()
  })
})

describe("floor guard — a confident skip-all must not strip the turn", () => {
  test("a confident skip-all fold is refused when it lands below the floor", () => {
    // Live regression (ses_f4545cf6): 35 tools, threshold 0.7, every row a
    // confident skip → the fold legitimately keeps too few to act with. The fold
    // is still a real decision; the GUARD is what refuses to apply it.
    const names = [
      "bash",
      "edit",
      "read",
      "glob",
      "grep",
      "write",
      "webfetch",
      "task",
      "StructuredOutput",
      "cua-driver_click",
      "cua-driver_type_text",
    ]
    const answers = Object.fromEntries(
      names.map((name) => [name, { type: "choice", choice: "skip", probabilities: { skip: 1, use: 0 } }]),
    )
    const keep = jevKeepTools({ answers }, names, 0.7)
    // Exempts survive; everything routable drops — a genuinely tiny keep-set.
    expect(keep).toBeDefined()
    const after = keep?.size ?? 0
    expect(after).toBeLessThan(8)
    // The guard is what stops the turn from running with that set.
    expect(jevBelowFloor(after, 8)).toBe(true)
  })

  test("a fold at or above the floor is applied, not refused", () => {
    const names = ["read", "edit", "bash", "glob", "grep", "write", "webfetch", "task"]
    const answers = Object.fromEntries(
      names.map((name) => [name, { type: "choice", choice: "use", probabilities: { use: 0.9, skip: 0.1 } }]),
    )
    const keep = jevKeepTools({ answers }, names, 0.7)
    const after = keep?.size ?? 0
    expect(after).toBeGreaterThanOrEqual(8)
    expect(jevBelowFloor(after, 8)).toBe(false)
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
