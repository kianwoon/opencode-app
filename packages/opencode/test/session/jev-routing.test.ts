import { describe, expect, test } from "bun:test"
import { jevKeepTools, jevVerdict } from "@/session/prompt"

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

  test("maps answers by id when the endpoint echoes tool names", () => {
    const keep = round(
      {
        q1: { type: "choice", choice: "use", probabilities: { skip: 0.1, use: 0.9 }, confidence: 0.9 },
        q2: { type: "choice", choice: "skip", probabilities: { skip: 0.9, use: 0.1 }, confidence: 0.9 },
      },
      ["read", "bash"],
    )
    expect(keep?.has("read")).toBe(true)
    expect(keep?.has("bash")).toBe(false)
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

describe("jevVerdict", () => {
  test("scores a categorical answer with the use probability", () => {
    expect(jevVerdict({ choice: "skip", probabilities: { use: 0.13 }, confidence: 0.74 })).toEqual({
      use: false,
      strength: 0.13,
    })
  })

  test("falls back to the choice when probabilities are absent", () => {
    expect(jevVerdict({ choice: "use" })).toEqual({ use: true, strength: 1 })
  })

  test("ignores a non-categorical answer", () => {
    expect(jevVerdict({ type: "noul", noul: true })).toBeUndefined()
  })
})
