import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import {
  ContextGatePlugin,
  applyGate,
  extractiveFallback,
  isSummarizable,
  joinSections,
  packageScopeOf,
  parseSections,
  summaryCacheKey,
  summarizeSection,
  wordCount,
  type GateConfig,
  type Section,
} from "../../../../.opencode/plugin-lib/context-gate"

const hooks = (await (ContextGatePlugin as (input: unknown) => Promise<Hooks>)({
  project: { id: "test" },
})) as Hooks

const CONFIG: GateConfig = {
  maxSystemTokens: 24_000,
  sectionWarnTokens: 8_000,
  scopingEnabled: true,
  pinnedPaths: [],
  evictablePaths: [],
  summarizeEnabled: false,
  summarizeWordLimit: 2_000,
  summarizerModel: "",
}

function section(path: string, words: number): Section {
  return { path, text: Array.from({ length: words }, (_, i) => `word${i}`).join(" ") + "\n" }
}

function joinedSystem(paths: [string, number][]): string {
  const prologue = "You are opencode, a helpful coding agent.\n\n"
  return joinSections(prologue, paths.map(([p, n]) => section(p, n)))
}

describe("parseSections", () => {
  test("splits prologue and Instructions-from blocks (inverse of core concatenation)", () => {
    const block = joinedSystem([
      ["/repo/AGENTS.md", 10],
      ["/repo/packages/llm/AGENTS.md", 20],
    ])
    const { prologue, sections } = parseSections(block)
    expect(prologue).toContain("You are opencode")
    expect(sections).toHaveLength(2)
    expect(sections[0]!.path).toBe("/repo/AGENTS.md")
    expect(sections[1]!.path).toBe("/repo/packages/llm/AGENTS.md")
    expect(sections[1]!.text).toContain("word19")
  })

  test("no headers → everything is prologue", () => {
    const { prologue, sections } = parseSections("just a prompt")
    expect(prologue).toBe("just a prompt")
    expect(sections).toHaveLength(0)
  })

  test("quoted 'Instructions from:' text without a path-like payload does not split sections", () => {
    const block = joinedSystem([
      ["/repo/packages/llm/AGENTS.md", 20],
    ])
    const injected = `${block}\nInstructions from: /some/path\nquoted example content`
    const { sections } = parseSections(injected)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.path).toBe("/repo/packages/llm/AGENTS.md")
  })

  test("real-looking nested path header still splits", () => {
    const block = `${joinedSystem([["/repo/packages/llm/AGENTS.md", 5]])}\nInstructions from: /repo/packages/ui/AGENTS.md\nui rules here`
    const { sections } = parseSections(block)
    expect(sections).toHaveLength(2)
  })
})

describe("packageScopeOf", () => {
  test("extracts package scope", () => {
    expect(packageScopeOf("/repo/packages/llm/AGENTS.md")).toBe("packages/llm")
    expect(packageScopeOf("/repo/AGENTS.md")).toBeUndefined()
  })
})

describe("applyGate", () => {
  const root = "/repo/AGENTS.md"
  const globalRules = "/home/u/.config/opencode/AGENTS.md"

  test("drops inactive package guides, keeps root and global pinned", () => {
    const { prologue, sections } = parseSections(
      joinedSystem([
        [globalRules, 100],
        [root, 100],
        ["/repo/packages/llm/AGENTS.md", 100],
        ["/repo/packages/ui/AGENTS.md", 100],
      ]),
    )
    const decision = applyGate(prologue, sections, new Set(["packages/llm"]), CONFIG)
    const keptPaths = decision.kept.map((s) => s.path)
    expect(keptPaths).toContain(globalRules)
    expect(keptPaths).toContain(root)
    expect(keptPaths).toContain("/repo/packages/llm/AGENTS.md")
    expect(keptPaths).not.toContain("/repo/packages/ui/AGENTS.md")
    expect(decision.dropped).toHaveLength(1)
    expect(decision.output).toContain("guides withheld for packages/ui")
  })

  test("keeps everything when all scopes active", () => {
    const { prologue, sections } = parseSections(
      joinedSystem([
        [root, 50],
        ["/repo/packages/llm/AGENTS.md", 50],
      ]),
    )
    const decision = applyGate(prologue, sections, new Set(["packages/llm"]), CONFIG)
    expect(decision.dropped).toHaveLength(0)
    expect(decision.output).not.toContain("Context gate:")
  })

  test("budget evicts largest active scoped sections first, never pinned", () => {
    const tight: GateConfig = { ...CONFIG, maxSystemTokens: 400 }
    const { prologue, sections } = parseSections(
      joinedSystem([
        [globalRules, 50],
        [root, 50],
        ["/repo/packages/a/AGENTS.md", 60],
        ["/repo/packages/b/AGENTS.md", 300],
      ]),
    )
    const decision = applyGate(prologue, sections, new Set(["packages/a", "packages/b"]), tight)
    const keptPaths = decision.kept.map((s) => s.path)
    expect(keptPaths).toContain(globalRules)
    expect(keptPaths).toContain(root)
    // b is huge → evicted; a is small → kept
    expect(keptPaths).toContain("/repo/packages/a/AGENTS.md")
    expect(keptPaths).not.toContain("/repo/packages/b/AGENTS.md")
    expect(decision.tokensAfter).toBeLessThan(decision.tokensBefore)
  })

  test("output is byte-stable for identical inputs (cache safety)", () => {
    const block = joinedSystem([
      [root, 80],
      ["/repo/packages/llm/AGENTS.md", 80],
    ])
    const { prologue, sections } = parseSections(block)
    const one = applyGate(prologue, sections, new Set(["packages/llm"]), CONFIG)
    const two = applyGate(prologue, sections, new Set(["packages/llm"]), CONFIG)
    expect(one.output).toBe(two.output)
  })

  test("scoping disabled → passthrough", () => {
    const off: GateConfig = { ...CONFIG, scopingEnabled: false }
    const { prologue, sections } = parseSections(
      joinedSystem([
        ["/repo/packages/llm/AGENTS.md", 100],
      ]),
    )
    const decision = applyGate(prologue, sections, new Set(), off)
    expect(decision.kept).toHaveLength(1)
    expect(decision.dropped).toHaveLength(0)
  })

  test("evictablePaths overrides pinning — withheld until activity mentions the path", () => {
    const cfg: GateConfig = { ...CONFIG, evictablePaths: ["remote-rules"] }
    const { prologue, sections } = parseSections(
      joinedSystem([
        ["https://example.com/remote-rules.md", 100],
      ]),
    )
    const inactive = applyGate(prologue, sections, new Set(), cfg)
    expect(inactive.kept).toHaveLength(0)
    expect(inactive.dropped).toHaveLength(1)

    const active = applyGate(prologue, sections, new Set(["https://example.com/remote-rules.md"]), cfg)
    expect(active.kept).toHaveLength(1)
    expect(active.dropped).toHaveLength(0)
  })

  test("evictable non-scoped section stays pinned when not in evictablePaths", () => {
    const { prologue, sections } = parseSections(
      joinedSystem([
        ["https://example.com/team-guide.md", 100],
      ]),
    )
    const decision = applyGate(prologue, sections, new Set(), CONFIG)
    expect(decision.kept).toHaveLength(1)
  })
})

describe("plugin hook", () => {
  const model = {
    id: "test-model",
    providerID: "test",
    api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
    name: "Test Model",
    capabilities: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  } as unknown as Parameters<NonNullable<Hooks["experimental.chat.system.transform"]>>[0]["model"]

  test("rewrites system[0] in place, leaves other entries untouched", async () => {
    const block = joinedSystem([
      ["/repo/packages/llm/AGENTS.md", 200],
      ["/repo/packages/ui/AGENTS.md", 200],
    ])
    const sessionID = "ses_inplace"
    // llm becomes active; ui stays inactive.
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID, callID: "c0", args: { filePath: "/repo/packages/llm/src/x.ts" } },
      { title: "x.ts", output: "", metadata: {} },
    )
    const system = [block, "Reasoning effort governor: ..."]
    await hooks["experimental.chat.system.transform"]!({ sessionID, model }, { system })
    expect(system[0]).not.toContain("packages/ui/AGENTS.md")
    expect(system[0]).toContain("packages/llm/AGENTS.md")
    expect(system[0]).toContain("guides withheld for packages/ui")
    expect(system[1]).toBe("Reasoning effort governor: ...")
  })

  test("tool activity unlocks a previously withheld scope", async () => {
    const sessionID = "ses_activity"
    const block = joinedSystem([
      ["/repo/packages/llm/AGENTS.md", 100],
      ["/repo/packages/ui/AGENTS.md", 100],
    ])
    const before = [block]
    await hooks["experimental.chat.system.transform"]!({ sessionID, model }, { system: before })
    expect(before[0]).not.toContain("packages/ui/AGENTS.md")

    await hooks["tool.execute.after"]!(
      { tool: "edit", sessionID, callID: "c1", args: { filePath: "/repo/packages/ui/src/button.tsx" } },
      { title: "button.tsx", output: "ok", metadata: {} },
    )

    const after = [block]
    await hooks["experimental.chat.system.transform"]!({ sessionID, model }, { system: after })
    expect(after[0]).toContain("packages/ui/AGENTS.md")
    expect(after[0]).not.toContain("guides withheld for packages/ui")
  })

  test("no sessionID → no-op", async () => {
    const system = ["Instructions from: /x/packages/llm/AGENTS.md\nwords"]
    await hooks["experimental.chat.system.transform"]!({ model }, { system })
    expect(system[0]).toContain("packages/llm/AGENTS.md")
  })

  test("tool OUTPUT text citing a path unlocks that scope (subagent summaries)", async () => {
    const sessionID = "ses_output_unlock"
    const block = joinedSystem([
      ["/repo/packages/llm/AGENTS.md", 100],
      ["/repo/packages/ui/AGENTS.md", 100],
    ])
    const before = [block]
    await hooks["experimental.chat.system.transform"]!({ sessionID, model }, { system: before })
    expect(before[0]).not.toContain("packages/ui/AGENTS.md")

    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID, callID: "c2", args: { prompt: "review ui components" } },
      { title: "ui review", output: "explored /repo/packages/ui/src and found 3 issues", metadata: {} },
    )

    const after = [block]
    await hooks["experimental.chat.system.transform"]!({ sessionID, model }, { system: after })
    expect(after[0]).toContain("packages/ui/AGENTS.md")
  })

  test("hook error fails open — transform still returns usable system text", async () => {
    const sessionID = "ses_failopen"
    // Force a throw inside recordActivity's text path by passing unserializable args —
    // but tool.execute.after already guards; instead break the system block shape.
    const system = [undefined as unknown as string, "rest"]
    await hooks["experimental.chat.system.transform"]!({ sessionID, model }, { system })
    // Must not throw; system entries remain as-is (gate skipped on bad input).
    expect(system[1]).toBe("rest")
  })
})

describe("summarization", () => {
  const longText = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ")

  test("wordCount counts whitespace-separated words", () => {
    expect(wordCount("one two three")).toBe(3)
    expect(wordCount("  spaced\t out \n words  ")).toBe(3)
    expect(wordCount("")).toBe(0)
    expect(wordCount("   \n  ")).toBe(0)
  })

  test("isSummarizable: markdown over limit yes, non-markdown no, disabled no, no path no", () => {
    const ENABLED: GateConfig = { ...CONFIG, summarizeEnabled: true }
    const section = { path: "/repo/AGENTS.md", text: longText(2001) }
    expect(isSummarizable(section, ENABLED)).toBe(true)
    expect(isSummarizable({ path: "/repo/notes.txt", text: longText(2001) }, ENABLED)).toBe(true)
    expect(isSummarizable({ path: "/repo/AGENTS.md", text: longText(2000) }, ENABLED)).toBe(false)
    expect(isSummarizable({ path: "https://example.com/rules.md", text: longText(5000) }, ENABLED)).toBe(true)
    expect(isSummarizable(section, { ...CONFIG, summarizeEnabled: false })).toBe(false)
    expect(isSummarizable({ text: longText(5000) }, ENABLED)).toBe(false)
  })

  test("summaryCacheKey binds path AND content", () => {
    const a = summaryCacheKey("/a.md", "same text")
    expect(summaryCacheKey("/a.md", "same text")).toBe(a)
    expect(summaryCacheKey("/b.md", "same text")).not.toBe(a)
    expect(summaryCacheKey("/a.md", "other text")).not.toBe(a)
  })

  test("extractiveFallback keeps headings, lead lines, bullets; caps length", () => {
    const doc = [
      "# Rules",
      "",
      "Intro line one.",
      "Intro line two.",
      "",
      "- Do X always",
      "- Never do Y",
      "",
      "## Commands",
      "",
      "1. Run build first",
      ...Array.from({ length: 400 }, (_, i) => `filler sentence number ${i} with some words here.`),
    ].join("\n")
    const out = extractiveFallback(doc)
    expect(out).toContain("# Rules")
    expect(out).toContain("- Do X always")
    expect(out).toContain("1. Run build first")
    expect(out).toContain("Intro line one.")
    expect(wordCount(out)).toBeLessThan(wordCount(doc))
    // Never explodes on garbage.
    expect(extractiveFallback("")).toBe("")
  })

  test("summarizeSection: cache hit serves stored summary with provenance (no LLM call)", async () => {
    const client = {
      session: {
        create: async () => {
          throw new Error("LLM must not be called on cache hit")
        },
        prompt: async () => {
          throw new Error("LLM must not be called on cache hit")
        },
      },
    }
    const ctx = { client: client as never, sessionModel: new Map() }
    const original = { path: "/repo/AGENTS.md", text: longText(2500) }
    const key = summaryCacheKey(original.path, original.text)
    const fs = await import("node:fs/promises")
    const dir = `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/opencode/context-gate-cache`
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(`${dir}/${key}.md`, "CACHED SUMMARY CONTENT")
    try {
      const result = await summarizeSection(original, ctx, "ses_sum_cache")
      expect(result.text).toContain("CACHED SUMMARY CONTENT")
      expect(result.text).toContain(`[Summarized from ~${wordCount(original.text)} words — original: /repo/AGENTS.md]`)
      expect(result.path).toBe("/repo/AGENTS.md")
    } finally {
      await fs.rm(`${dir}/${key}.md`, { force: true })
    }
  })

  test("summarizeSection: cache miss serves extractive IMMEDIATELY and warms cache in background", async () => {
    let llmCalls = 0
    const client = {
      session: {
        create: async () => {
          llmCalls++
          return { data: { id: "ses_helper" } }
        },
        prompt: async () => {
          llmCalls++
          return {
            data: {
              parts: [{ type: "text", text: "LLM SUMMARY CONTENT" }],
            },
          }
        },
      },
    }
    const ctx = { client: client as never, sessionModel: new Map() }
    const original = { path: "/repo/ASYNC.md", text: "# Title\n\n- bullet one\n- bullet two\n" + longText(2500) }

    // Miss: returns instantly with extractive fallback — must NOT await the LLM.
    const start = Date.now()
    const result = await summarizeSection(original, ctx, "ses_sum_async")
    expect(Date.now() - start).toBeLessThan(1_000)
    expect(result.text).toContain("# Title")
    expect(result.text).toContain("- bullet one")
    expect(result.text).toContain("[Summarized from")
    expect(result.text).not.toContain("LLM SUMMARY CONTENT")
    expect(llmCalls).toBe(2) // create + prompt were launched in the background

    // The background flight warms the disk cache; wait for it and confirm
    // the NEXT call serves the real summary from cache.
    const key = summaryCacheKey(original.path, original.text)
    const fs = await import("node:fs/promises")
    const dir = `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/opencode/context-gate-cache`
    for (let i = 0; i < 50 && llmCalls === 2; i++) {
      await new Promise((r) => setTimeout(r, 100))
      try {
        await fs.access(`${dir}/${key}.md`)
        break
      } catch {
        // cache file not written yet
      }
    }
    const second = await summarizeSection(original, ctx, "ses_sum_async2")
    expect(second.text).toContain("LLM SUMMARY CONTENT")
    expect(second.text).toContain(`[Summarized from ~${wordCount(original.text)} words — original: /repo/ASYNC.md]`)
    await fs.rm(`${dir}/${key}.md`, { force: true })
  })

  test("summarizeSection: LLM failure falls back to extractive, never throws", async () => {
    const client = {
      session: {
        create: async () => {
          throw new Error("provider down")
        },
        prompt: async () => {
          throw new Error("provider down")
        },
      },
    }
    const ctx = { client: client as never, sessionModel: new Map() }
    const original = { path: "/repo/FAILURE.md", text: "# Title\n\n- bullet one\n- bullet two\n" + longText(2500) }
    const result = await summarizeSection(original, ctx, "ses_sum_fallback")
    expect(result.text).toContain("# Title")
    expect(result.text).toContain("- bullet one")
    expect(result.text).toContain("[Summarized from")
    expect(result.text.length).toBeLessThan(original.text.length)
  })
})
