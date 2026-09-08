import { describe, expect, test } from "bun:test"
// happy-dom is only declared in packages/app; import the hoisted store copy.
// GlobalRegistrator defines window/document so DOMPurify reports supported.
import { GlobalRegistrator } from "../../../../node_modules/.bun/@happy-dom+global-registrator@20.12.0/node_modules/@happy-dom/global-registrator/lib/index.js"

// Import order matters: markdown-sanitize statically imports DOMPurify, whose
// instance binds to the real window at module load. Register the DOM before
// that import (hoisted above) — and guard double registration since bun runs
// all test files in one process.
if (typeof window === "undefined") GlobalRegistrator.register()

const { mermaidConfig, sanitizeMermaidSvg } = await import("./markdown-sanitize")

describe("sanitizeMermaidSvg", () => {
  test("allows style tags (pinned at config level)", () => {
    // happy-dom drops style text inside SVG under text/html parsing, so style
    // retention cannot be asserted here — verified in a real browser instead.
    // Pin the production fix at config level: style is not forbidden.
    expect(!mermaidConfig.FORBID_TAGS.includes("style")).toBe(true)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>.node rect { fill: #21262d; color: #e6edf3; }</style><g><rect fill="#21262d"/><text fill="#e6edf3">ok</text></g></svg>`
    const clean = sanitizeMermaidSvg(svg)
    expect(clean).toContain("<svg")
    expect(clean).not.toContain("<script")
    expect(clean).not.toContain("onclick")
  })

  test("strips script tags and handlers", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><style>.x{fill:red}</style><rect onclick="alert(1)"/></svg>`
    const clean = sanitizeMermaidSvg(svg)
    expect(clean).not.toContain("<script")
    expect(clean).not.toContain("onclick")
  })
})
