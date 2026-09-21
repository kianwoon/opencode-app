import { describe, expect, test } from "bun:test"
import { joinSections, parseSections } from "./context-gate.ts"

// Documents the lossiness that justifies context-gate's both-off early return:
// parse/join is NOT a byte-identity round-trip, so a guard placed after the
// mutation would rewrite system[0] and break the cached prefix.
describe("parseSections/joinSections is lossy (why both-off must return early)", () => {
  test("provenance trailer on a section is stripped by the round-trip", () => {
    const block = [
      "Instructions from: /tmp/a.md",
      "hello world",
      "[Summarized from ~5 words — original: /tmp/a.md]",
    ].join("\n")
    const { prologue, sections } = parseSections(block)
    const out = joinSections(prologue, sections)
    expect(sections[0]?.text).not.toContain("[Summarized from")
    expect(out).not.toContain("[Summarized from")
  })

  test("trailing blank lines are collapsed, so output bytes differ from input", () => {
    const block = "Instructions from: /tmp/b.md\nline one\n\n\n\n"
    const { prologue, sections } = parseSections(block)
    const out = joinSections(prologue, sections)
    expect(out).not.toBe(block)
    expect(out).toBe("Instructions from: /tmp/b.md\nline one")
    expect(out).not.toMatch(/\n+$/)
  })

  test("no headers -> prologue is the whole block, sections empty (pass-through)", () => {
    const block = "just plain text\nno headers here"
    expect(parseSections(block)).toEqual({ prologue: block, sections: [] })
  })
})
