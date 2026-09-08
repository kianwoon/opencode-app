import { expect, test } from "bun:test"
// happy-dom is only declared in packages/app; import the hoisted store copy.
// GlobalRegistrator defines HTMLElement etc. globally, which
// markdown-mermaid-detect.ts relies on.
import { GlobalRegistrator } from "../../../../node_modules/.bun/@happy-dom+global-registrator@20.12.0/node_modules/@happy-dom/global-registrator/lib/index.js"

GlobalRegistrator.register()

import { isMermaidCodeElement } from "./markdown-mermaid-detect"

function parse(html: string): Element {
  const host = document.createElement("div")
  host.innerHTML = html
  const code = host.querySelector("code")
  if (!code) throw new Error("no code element")
  return code
}

test("matches code with language-mermaid class", () => {
  expect(isMermaidCodeElement(parse('<code class="language-mermaid">flowchart TD</code>'))).toBe(true)
})

test("matches code inside pre with data-language=mermaid", () => {
  expect(isMermaidCodeElement(parse('<pre data-language="mermaid"><code>flowchart TD</code></pre>'))).toBe(true)
})

test("rejects non-mermaid code", () => {
  expect(isMermaidCodeElement(parse('<pre><code class="language-ts">const x = 1</code></pre>'))).toBe(false)
  expect(isMermaidCodeElement(parse('<pre data-language="ts"><code>const x = 1</code></pre>'))).toBe(false)
})
