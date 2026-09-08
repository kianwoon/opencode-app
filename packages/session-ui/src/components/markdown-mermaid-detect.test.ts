import { describe, expect, test } from "bun:test"
import { isMermaidLanguage } from "./markdown-mermaid-detect"

describe("isMermaidLanguage", () => {
  test("detects mermaid language code blocks", () => {
    expect(isMermaidLanguage("language-mermaid")).toBe(true)
    expect(isMermaidLanguage("language-Mermaid")).toBe(true)
    expect(isMermaidLanguage("shiki language-mermaid")).toBe(true)
  })

  test("rejects other languages and non-mermaid classes", () => {
    expect(isMermaidLanguage("language-typescript")).toBe(false)
    expect(isMermaidLanguage("")).toBe(false)
    expect(isMermaidLanguage("language-mermaidish")).toBe(false)
    expect(isMermaidLanguage("mermaid")).toBe(false)
  })
})
