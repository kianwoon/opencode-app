import { expect, test } from "bun:test"
import { createMarkdownParser } from "./marked-parser"

const parser = createMarkdownParser((code, language) => `<pre data-language="${language}">${code}</pre>`)

test("renders links with application attributes", async () => {
  expect(await parser.parse("[OpenCode](https://opencode.ai)")).toBe(
    '<p><a href="https://opencode.ai" class="external-link" target="_blank" rel="noopener noreferrer">OpenCode</a></p>\n',
  )
})

test("renders inline and block math", async () => {
  expect(await parser.parse("\\(x^2\\)")).toContain('<span class="katex">')
  expect(await parser.parse("$$\nx^2\n$$\n")).toContain('<span class="katex-display">')
})

test("uses the configured code highlighter", async () => {
  expect(await parser.parse("```ts\nconst value = 1\n```\n")).toBe('<pre data-language="ts">const value = 1</pre>\n')
})

test("renders mermaid blocks without highlighting", async () => {
  let highlighted = false
  const mermaidParser = createMarkdownParser(() => {
    highlighted = true
    return ""
  })
  const html = await mermaidParser.parse("```mermaid\nflowchart TD\n A-->B\n```\n")
  expect(highlighted).toBe(false)
  expect(html).toContain('<code class="language-mermaid">')
  expect(html).toContain("flowchart TD")
  expect(html).not.toContain("shiki")
})
