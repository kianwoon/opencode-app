import { describe, expect, test } from "bun:test"
import { ToolResultCache } from "../../src/session/tool-result-cache"

const result = (output: string) => ({
  title: "t",
  metadata: {},
  output,
})

describe("ToolResultCache", () => {
  test("stores and looks up by tool + args + file freshness", () => {
    ToolResultCache.reset()
    const args = { filePath: "/tmp/does-not-matter.ts" }
    ToolResultCache.store("s1", "read", args, result("one"))
    expect(ToolResultCache.lookup("s1", "read", args)?.output).toBe("one")

    // different session → miss
    expect(ToolResultCache.lookup("s2", "read", args)).toBeUndefined()
    // different tool → miss
    expect(ToolResultCache.lookup("s1", "grep", args)).toBeUndefined()
  })

  test("ignores non-cacheable tools", () => {
    ToolResultCache.reset()
    ToolResultCache.store("s1", "bash", { command: "ls" }, result("x"))
    ToolResultCache.store("s1", "edit", { filePath: "/tmp/a" }, result("x"))
    expect(ToolResultCache.lookup("s1", "bash", { command: "ls" })).toBeUndefined()
    expect(ToolResultCache.lookup("s1", "edit", { filePath: "/tmp/a" })).toBeUndefined()
  })

  test("invalidates when the file mtime changes", async () => {
    ToolResultCache.reset()
    const tmp = `${import.meta.dir}/tool-result-cache-fixture-${Date.now()}.txt`
    await Bun.write(tmp, "v1")
    const args = { filePath: tmp }
    ToolResultCache.store("s1", "read", args, result("v1"))
    expect(ToolResultCache.lookup("s1", "read", args)?.output).toBe("v1")

    // ensure mtime moves (1s mtime granularity on some filesystems)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await Bun.write(tmp, "v2-longer-content")
    expect(ToolResultCache.lookup("s1", "read", args)).toBeUndefined()
    await Bun.write(tmp, "")
    await Bun.$`rm -f ${tmp}`.quiet()
  })

  test("expires entries after the TTL", async () => {
    ToolResultCache.reset()
    const args = { filePath: "/tmp/ttl.txt" }
    ToolResultCache.store("s1", "read", args, result("x"))
    // Directly age the entry rather than sleeping 60s.
    const cache = ToolResultCache.inspect()
    for (const entry of cache.get("s1")!.values()) entry.stored -= 61_000
    expect(ToolResultCache.lookup("s1", "read", args)).toBeUndefined()
  })

  test("evicts least-recently-stored entries beyond the per-session cap", () => {
    ToolResultCache.reset()
    for (let i = 0; i < 64; i++) {
      ToolResultCache.store("s1", "read", { filePath: `/f/${i}` }, result(`${i}`))
    }
    expect(ToolResultCache.lookup("s1", "read", { filePath: "/f/0" })?.output).toBe("0")
    // Insert one more → oldest (f/0 was just refreshed... insertion-order eviction
    // removes the first key, which is /f/0 after its lookup did NOT reorder; the
    // cap check runs before set, so /f/0 is evicted as the insertion-order head).
    ToolResultCache.store("s1", "read", { filePath: "/f/64" }, result("64"))
    expect(ToolResultCache.lookup("s1", "read", { filePath: "/f/0" })).toBeUndefined()
    expect(ToolResultCache.lookup("s1", "read", { filePath: "/f/64" })?.output).toBe("64")
    expect(ToolResultCache.lookup("s1", "read", { filePath: "/f/63" })?.output).toBe("63")
  })

  test("clearSession drops all entries for the session", () => {
    ToolResultCache.reset()
    ToolResultCache.store("s1", "read", { filePath: "/a" }, result("a"))
    ToolResultCache.store("s1", "grep", { pattern: "x" }, result("g"))
    ToolResultCache.clearSession("s1")
    expect(ToolResultCache.lookup("s1", "read", { filePath: "/a" })).toBeUndefined()
    expect(ToolResultCache.lookup("s1", "grep", { pattern: "x" })).toBeUndefined()
  })

  test("OPENCODE_DISABLE_TOOL_CACHE=1 disables everything", () => {
    ToolResultCache.reset()
    process.env["OPENCODE_DISABLE_TOOL_CACHE"] = "1"
    try {
      ToolResultCache.store("s1", "read", { filePath: "/a" }, result("a"))
      expect(ToolResultCache.lookup("s1", "read", { filePath: "/a" })).toBeUndefined()
    } finally {
      delete process.env["OPENCODE_DISABLE_TOOL_CACHE"]
    }
  })
})
