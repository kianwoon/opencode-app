import { describe, expect, test } from "bun:test"
import { readPartText } from "./message-part-text"

describe("readPartText", () => {
  test("returns empty string when part text is undefined", () => {
    expect(readPartText({})).toBe("")
  })

  test("returns trimmed part text", () => {
    expect(readPartText({ text: "  hello  " })).toBe("hello")
  })

  test("falls back to part text", () => {
    expect(readPartText({ text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText({ text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText({ text: "\n  body  \n" })).toBe("body")
  })
})
