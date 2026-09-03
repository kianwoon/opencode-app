import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import {
  ContextGatePlugin,
  applyGate,
  joinSections,
  packageScopeOf,
  parseSections,
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
})
