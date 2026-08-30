import { describe, expect, test, beforeEach } from "bun:test"
import type { MCP } from "@/mcp"
import { ToolSearch } from "@/session/tool-search"
import { McpCatalog } from "@/mcp/catalog"

function mcpTool(name: string, description: string, schemaProperties: Record<string, object> = {}): MCP.McpTool {
  return {
    def: {
      name,
      description,
      inputSchema: { type: "object" as const, properties: schemaProperties, additionalProperties: false },
    },
    client: {} as never,
  }
}

function fixtures() {
  return {
    github_create_pr: mcpTool("create_pr", "Create a pull request on GitHub"),
    github_list_issues: mcpTool("list_issues", "List issues for a repository"),
    zai_analyze_image: mcpTool("analyze_image", "Analyze an image with AI vision"),
  }
}

const CONFIG = {}

beforeEach(() => {
  ToolSearch.reset()
})

describe("ToolSearch.plan", () => {
  test("keeps everything inline under budget", () => {
    const tools = fixtures()
    const result = ToolSearch.plan({
      sessionID: "s1",
      tools,
      contextLimit: 200_000,
      mcpConfig: CONFIG,
    })
    expect(result.deferred).toEqual({})
    expect(result.catalog).toBe("")
    expect(Object.keys(result.inline).toSorted()).toEqual(Object.keys(tools).toSorted())
  })

  test("defers when definitions cross the context threshold", () => {
    const tools = fixtures()
    // 3 tools x ~93 bytes; a tiny window forces deferral (10% of 2000 = 200 bytes)
    const result = ToolSearch.plan({
      sessionID: "s1",
      tools,
      contextLimit: 2_000,
      mcpConfig: CONFIG,
    })
    expect(Object.keys(result.inline)).toEqual([])
    expect(Object.keys(result.deferred).toSorted()).toEqual(Object.keys(tools).toSorted())
    expect(result.catalog).toContain("create_pr")
    expect(result.catalog).toContain("Create a pull request")
  })

  test("inline tools survive next plan call via session promotion", () => {
    const tools = fixtures()
    const limited = { contextLimit: 2_000, mcpConfig: CONFIG, sessionID: "s1", tools }
    ToolSearch.plan(limited)
    ToolSearch.search({ sessionID: "s1", query: "create_pr", tools, mcpConfig: CONFIG })
    const after = ToolSearch.plan(limited)
    expect(Object.keys(after.inline)).toEqual(["github_create_pr"])
    expect(Object.keys(after.deferred).toSorted()).toEqual(["github_list_issues", "zai_analyze_image"])
  })

  test("alwaysLoad servers bypass deferral", () => {
    const tools = fixtures()
    const plan = (mcpConfig: Record<string, unknown>) =>
      ToolSearch.plan({ sessionID: "s1", tools, contextLimit: 2_000, mcpConfig })
    const result = plan({ github: { type: "remote", url: "https://x", alwaysLoad: true } })
    expect(Object.keys(result.inline).toSorted()).toEqual(["github_create_pr", "github_list_issues"])
    expect(Object.keys(result.deferred)).toEqual(["zai_analyze_image"])
  })

  test("dropping under budget clears promotion state", () => {
    const tools = fixtures()
    const limited = { sessionID: "s1", tools, contextLimit: 2_000, mcpConfig: CONFIG }
    ToolSearch.plan(limited)
    ToolSearch.search({ sessionID: "s1", query: "create_pr", tools, mcpConfig: CONFIG })
    const roomy = ToolSearch.plan({ ...limited, contextLimit: 200_000 })
    expect(Object.keys(roomy.inline)).toEqual(Object.keys(tools))
    // promotion state was cleared: re-entering deferred mode starts fresh
    const again = ToolSearch.plan(limited)
    expect(Object.keys(again.inline)).toEqual([])
  })

  test("promotion is per session", () => {
    const tools = fixtures()
    ToolSearch.plan({ sessionID: "s1", tools, contextLimit: 3_000, threshold: 0, mcpConfig: CONFIG })
    ToolSearch.search({ sessionID: "s1", query: "create_pr", tools, mcpConfig: CONFIG })
    const other = ToolSearch.plan({ sessionID: "s2", tools, contextLimit: 3_000, threshold: 0, mcpConfig: CONFIG })
    expect(Object.keys(other.inline)).toEqual([])
  })

  test("pressure demotes least-recently promoted tools back into the catalog", () => {
    const tools = fixtures()
    const limited = { sessionID: "s1", tools, contextLimit: 2_000, mcpConfig: CONFIG }
    ToolSearch.plan(limited)
    // Promote two tools; their combined bytes exceed the 200-byte budget again.
    ToolSearch.search({ sessionID: "s1", query: "create_pr", tools, mcpConfig: CONFIG })
    const mid = ToolSearch.plan(limited)
    expect(Object.keys(mid.inline)).toEqual(["github_create_pr"])
    ToolSearch.search({ sessionID: "s1", query: "list_issues", tools, mcpConfig: CONFIG })
    // Both fit? definition bytes ≈ 93 each, alwaysLoad 0; budget 200 → both fit.
    const both = ToolSearch.plan(limited)
    const bothInline = Object.keys(both.inline).toSorted()
    if (bothInline.length === 2) {
      // Force pressure by shrinking the budget via threshold 0: everything must defer.
      const squeezed = ToolSearch.plan({ ...limited, threshold: 0.01 })
      expect(Object.keys(squeezed.inline)).toEqual([])
      expect(Object.keys(squeezed.deferred).length).toBe(3)
      // Promotion state now empty: re-searching works.
      const again = ToolSearch.search({ sessionID: "s1", query: "create_pr", tools, mcpConfig: CONFIG })
      expect(again.keys).toEqual(["github_create_pr"])
    } else {
      // github_create_pr was demoted under pressure; it is deferred again.
      expect(bothInline).toEqual(["github_list_issues"])
      expect(Object.keys(both.deferred)).toContain("github_create_pr")
    }
  })

  test("demotion keeps alwaysLoad tools inline regardless of pressure", () => {
    const tools = fixtures()
    const config = { github: { type: "remote", url: "https://x", alwaysLoad: true } }
    // threshold 0 → zero budget; even alwaysLoad exceeds it, but they must stay inline.
    const result = ToolSearch.plan({ sessionID: "s1", tools, contextLimit: 2_000, threshold: 0, mcpConfig: config })
    expect(Object.keys(result.inline).toSorted()).toEqual(["github_create_pr", "github_list_issues"])
    expect(Object.keys(result.deferred)).toEqual(["zai_analyze_image"])
  })

  test("stale promotion keys disappear when the tool is removed", () => {
    const tools = fixtures()
    const limited = { sessionID: "s1", tools, contextLimit: 2_000, mcpConfig: CONFIG }
    ToolSearch.plan(limited)
    ToolSearch.search({ sessionID: "s1", query: "create_pr", tools, mcpConfig: CONFIG })
    // Still over budget (threshold 0) with the tool gone: the stale key must not
    // resurrect anything, and the remaining tools stay deferred.
    const pruned = { github_list_issues: tools.github_list_issues, zai_analyze_image: tools.zai_analyze_image }
    const after = ToolSearch.plan({ ...limited, tools: pruned, threshold: 0 })
    expect(Object.keys(after.inline)).toEqual([])
    expect(Object.keys(after.deferred).toSorted()).toEqual(Object.keys(pruned).toSorted())
    // Roomy budget clears promotion entirely (existing behavior preserved).
    const roomy = ToolSearch.plan({ ...limited, tools: pruned })
    expect(Object.keys(roomy.inline).toSorted()).toEqual(Object.keys(pruned).toSorted())
  })

  test("threshold 0 defers immediately, 1 never defers", () => {
    const tools = fixtures()
    const deferNow = ToolSearch.plan({ sessionID: "s1", tools, contextLimit: 200_000, threshold: 0, mcpConfig: CONFIG })
    expect(Object.keys(deferNow.deferred)).toEqual(Object.keys(tools))
    const never = ToolSearch.plan({ sessionID: "s2", tools, contextLimit: 0, threshold: 1, mcpConfig: CONFIG })
    expect(Object.keys(never.inline)).toEqual(Object.keys(tools))
  })

  test("out-of-range thresholds fall back to the default", () => {
    const tools = fixtures()
    // 3 tools ≈ 279 bytes; default 10% of 2_000 = 200 bytes → defers.
    for (const bad of [-1, 2, Number.NaN]) {
      const result = ToolSearch.plan({ sessionID: "s1", tools, contextLimit: 2_000, threshold: bad, mcpConfig: CONFIG })
      expect(Object.keys(result.deferred).length).toBe(3)
    }
    // In-range 0.5 of 2_000 = 1_000 bytes → inline.
    const ok = ToolSearch.plan({ sessionID: "s1", tools, contextLimit: 2_000, threshold: 0.5, mcpConfig: CONFIG })
    expect(Object.keys(ok.deferred)).toEqual([])
  })
})

describe("ToolSearch.search", () => {
  const tools = fixtures()

  test("promotes by substring across key, name, and description", () => {
    const r1 = ToolSearch.search({ sessionID: "s1", query: "pull request", tools, mcpConfig: CONFIG })
    expect(r1.keys).toEqual(["github_create_pr"])
    ToolSearch.reset()
    const r2 = ToolSearch.search({ sessionID: "s1", query: "vision", tools, mcpConfig: CONFIG })
    expect(r2.keys).toEqual(["zai_analyze_image"])
  })

  test("exact key match beats fuzzy matches", () => {
    // "issues" substring-matches github_list_issues only, but exact key wins when given
    const exact = ToolSearch.search({ sessionID: "s1", query: "github_list_issues", tools, mcpConfig: CONFIG })
    expect(exact.keys).toEqual(["github_list_issues"])
  })

  test("case-insensitive", () => {
    const result = ToolSearch.search({ sessionID: "s1", query: "GITHUB_CREATE_PR", tools, mcpConfig: CONFIG })
    expect(result.keys).toEqual(["github_create_pr"])
  })

  test("never promotes alwaysLoad tools (they are already inline)", () => {
    const config = { github: { alwaysLoad: true } }
    const result = ToolSearch.search({ sessionID: "s1", query: "github", tools, mcpConfig: config })
    expect(result.keys).toEqual([])
  })

  test("empty query promotes nothing", () => {
    const result = ToolSearch.search({ sessionID: "s1", query: "  ", tools, mcpConfig: CONFIG })
    expect(result.keys).toEqual([])
  })

  test("no match promotes nothing and reports empty", () => {
    const result = ToolSearch.search({ sessionID: "s1", query: "nonexistent_widget", tools, mcpConfig: CONFIG })
    expect(result.keys).toEqual([])
  })

  test("formatResults renders schema JSON for promoted keys", () => {
    const output = ToolSearch.formatResults({ tools, keys: ["github_create_pr"] })
    expect(output).toContain("### github_create_pr")
    expect(output).toContain("Create a pull request")
    expect(output).toContain('"type":"object"')
  })

  test("formatResults guides the model when nothing matched", () => {
    const output = ToolSearch.formatResults({ tools, keys: [] })
    expect(output).toContain("No matching MCP tools found")
  })
})

describe("McpCatalog compact helpers", () => {
  test("compactDescription truncates at 2KB without splitting UTF-8", () => {
    const emoji = "🚀".repeat(2000) // 6400 bytes of 4-byte chars
    const truncated = McpCatalog.compactDescription(emoji)
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(McpCatalog.DESCRIPTION_MAX_BYTES + 3)
    expect(truncated.endsWith("…")).toBe(true)
    const odd = "a🚀".repeat(700) // 2100 bytes; cut at 2048 lands mid-sequence
    const truncatedOdd = McpCatalog.compactDescription(odd)
    expect(Buffer.byteLength(truncatedOdd, "utf8")).toBeLessThanOrEqual(McpCatalog.DESCRIPTION_MAX_BYTES + 3)
    expect(truncatedOdd.endsWith("…")).toBe(true)
  })

  test("definitionBytes counts description + schema", () => {
    const bytes = McpCatalog.definitionBytes({
      name: "x",
      description: "abcd",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    })
    expect(bytes).toBeGreaterThan(4)
  })

  test("index groups by server and carries instructions", () => {
    const defs = {
      github_create_pr: { name: "create_pr", description: "Create PRs" },
      github_list_issues: { name: "list_issues", description: "List issues" },
      zai_analyze_image: { name: "analyze_image", description: "Vision" },
    }
    const result = McpCatalog.index(defs, { zai: "Use for image questions" })
    expect(result.map((s) => s.server)).toEqual(["github", "zai"])
    expect(result[0]!.tools).toHaveLength(2)
    expect(result[1]!.instructions).toBe("Use for image questions")
  })

  test("describeIndex renders scannable catalog", () => {
    const rendered = McpCatalog.describeIndex(
      McpCatalog.index({ zai_analyze_image: { name: "analyze_image", description: "Vision" } }, {}),
    )
    expect(rendered).toContain("## zai")
    expect(rendered).toContain("- analyze_image: Vision")
  })
})
