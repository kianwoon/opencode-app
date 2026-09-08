import { describe, expect, test } from "bun:test"
import { createRoot, getOwner, onCleanup } from "solid-js"
import { createTabMemory } from "./tab-memory"
import { nextTabAfterClose, pushClosedTab, removeClosedTabs, takeClosedTab, type ClosedTab } from "./closed-tabs"
import { projectSessionIDs } from "./project-tabs"
import type { SessionTab, Tab } from "./tabs"
import { migrateTabs } from "./tab-migration"
import type { ServerConnection } from "./server"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key

function sessionTab(sessionId: string): SessionTab {
  return { type: "session", server, sessionId }
}

describe("tab migration", () => {
  test("drops null and malformed persisted tabs", () => {
    expect(
      migrateTabs([null, sessionTab("a"), { type: "session", server }, { type: "unknown", server }, "invalid"], server),
    ).toEqual([sessionTab("a")])
  })

  test("adds the fallback server to valid legacy tabs", () => {
    expect(migrateTabs([{ type: "session", sessionId: "a", dirBase64: "legacy" }], server)).toEqual([sessionTab("a")])
  })

  test("replaces invalid top-level persisted data", () => {
    expect(migrateTabs(null, server)).toEqual([])
    expect(migrateTabs({}, server)).toEqual([])
  })
})

describe("tab memory", () => {
  test("keeps state until its tab is removed", () => {
    createRoot((dispose) => {
      const memory = createTabMemory(getOwner())
      let disposed = 0
      const first = memory.ensure("tab", "prompt", () => {
        onCleanup(() => disposed++)
        return { value: "prompt" }
      })

      expect(memory.ensure("tab", "prompt", () => ({ value: "other" }))).toBe(first)
      expect(memory.get<typeof first>("tab", "prompt")).toBe(first)
      expect(memory.get("missing", "prompt")).toBeUndefined()
      expect(memory.ensure("other", "prompt", () => ({ value: "other" }))).not.toBe(first)

      memory.remove("tab")
      expect(disposed).toBe(1)
      expect(memory.ensure("tab", "prompt", () => ({ value: "new" }))).not.toBe(first)
      dispose()
    })
  })
})

describe("closed tab stack", () => {
  test("records session tabs with their index", () => {
    const stack = pushClosedTab([], sessionTab("a"), 2)

    expect(stack).toEqual([{ tab: sessionTab("a"), index: 2 }])
  })

  test("ignores draft tabs", () => {
    const draft: Tab = { type: "draft", draftID: "d1", server, directory: "/tmp" }

    expect(pushClosedTab([], draft, 0)).toEqual([])
  })

  test("caps the stack size", () => {
    const stack = Array.from({ length: 30 }, (_, i) => i).reduce<ClosedTab[]>(
      (acc, i) => pushClosedTab(acc, sessionTab(`s${i}`), i),
      [],
    )

    expect(stack).toHaveLength(25)
    expect(stack[0]?.tab.sessionId).toBe("s5")
    expect(stack.at(-1)?.tab.sessionId).toBe("s29")
  })

  test("pops the most recently closed tab", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [])

    expect(result.entry?.tab.sessionId).toBe("b")
    expect(result.stack).toEqual([{ tab: sessionTab("a"), index: 0 }])
  })

  test("skips entries whose tab is already open", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [sessionTab("b")])

    expect(result.entry?.tab.sessionId).toBe("a")
    expect(result.stack).toEqual([])
  })

  test("returns no entry when everything is open or empty", () => {
    expect(takeClosedTab([], []).entry).toBeUndefined()

    const result = takeClosedTab([{ tab: sessionTab("a"), index: 0 }], [sessionTab("a")])
    expect(result.entry).toBeUndefined()
    expect(result.stack).toEqual([])
  })

  test("purges removed sessions", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]

    expect(removeClosedTabs(stack, server, ["a"])).toEqual([{ tab: sessionTab("b"), index: 1 }])
  })

  test("does not navigate when a background tab closes", () => {
    const tabs = [sessionTab("a"), sessionTab("b"), sessionTab("c")]

    expect(nextTabAfterClose(tabs, 1, false)).toBeUndefined()
    expect(nextTabAfterClose(tabs, 1, true)).toEqual(sessionTab("c"))
    expect(nextTabAfterClose([sessionTab("a")], 0, true)).toBeNull()
  })
})

describe("project session tab matching", () => {
  test("matches sessions whose directory is a project directory", () => {
    const tabs: Tab[] = [sessionTab("/repo/a"), sessionTab("/other")]
    const ids = projectSessionIDs(tabs, {
      server,
      directories: ["/repo"],
      sessionDirectory: (id) => (id === "/repo/a" ? "/repo" : "/other"),
    })

    expect(ids).toEqual(["/repo/a"])
  })

  test("matches sandbox directories and normalizes trailing slashes", () => {
    const tabs: Tab[] = [sessionTab("sandbox"), sessionTab("trailing")]
    const ids = projectSessionIDs(tabs, {
      server,
      directories: ["/repo", "/repo/sandbox"],
      sessionDirectory: (id) => (id === "sandbox" ? "/repo/sandbox/" : "/repo/"),
    })

    expect(ids).toEqual(["sandbox", "trailing"])
  })

  test("ignores other servers and draft tabs", () => {
    const otherServer = "local\nhttp://localhost:9999" as ServerConnection.Key
    const tabs: Tab[] = [
      sessionTab("local-session"),
      { type: "session", server: otherServer, sessionId: "remote-session" },
      { type: "draft", draftID: "d1", server, directory: "/repo" },
    ]
    const ids = projectSessionIDs(tabs, { server, directories: ["/repo"], sessionDirectory: () => "/repo" })

    expect(ids).toEqual(["local-session"])
  })

  test("drops sessions without a resolvable directory and no project match", () => {
    const tabs: Tab[] = [sessionTab("known"), sessionTab("unknown")]
    const ids = projectSessionIDs(tabs, {
      server,
      directories: ["/repo"],
      sessionDirectory: (id) => (id === "known" ? "/repo" : undefined),
    })

    expect(ids).toEqual(["known"])
  })

  test("matches unresolvable-directory sessions by projectID", () => {
    const tabs: Tab[] = [sessionTab("known"), sessionTab("orphan")]
    const ids = projectSessionIDs(tabs, {
      server,
      directories: ["/repo"],
      projectId: "proj-1",
      sessionDirectory: (id) => (id === "known" ? "/repo" : undefined),
      sessionProjectId: (id) => (id === "orphan" ? "proj-1" : undefined),
    })

    expect(ids).toEqual(["known", "orphan"])
  })

  test("does not match unresolvable-directory sessions from another project", () => {
    const tabs: Tab[] = [sessionTab("orphan")]
    const ids = projectSessionIDs(tabs, {
      server,
      directories: ["/repo"],
      projectId: "proj-1",
      sessionDirectory: () => undefined,
      sessionProjectId: () => "proj-2",
    })

    expect(ids).toEqual([])
  })

  test("matches by projectID even when the directory resolves to a different path", () => {
    const tabs: Tab[] = [sessionTab("diverged")]
    const ids = projectSessionIDs(tabs, {
      server,
      directories: ["/repo"],
      projectId: "proj-1",
      sessionDirectory: () => "/private/tmp/repo",
      sessionProjectId: () => "proj-1",
    })

    expect(ids).toEqual(["diverged"])
  })

  test("closes via cached info directory when the live peek misses", () => {
    // Simulates the tabs.info cache holding a directory warmed at tab
    // creation while sync.session.peek returns undefined (evicted session).
    const cached = new Map([
      ["cached-a", "/Users/kianwoonwong/Downloads/biology"],
      ["cached-b", "/Users/kianwoonwong/Downloads/other"],
    ])
    const tabs: Tab[] = [sessionTab("cached-a"), sessionTab("cached-b")]
    const ids = projectSessionIDs(tabs, {
      server,
      directories: ["/Users/kianwoonwong/Downloads/biology"],
      sessionDirectory: (id) => cached.get(id),
    })

    expect(ids).toEqual(["cached-a"])
  })

  test("closes via projectID when the cached directory diverges from the worktree", () => {
    const tabs: Tab[] = [sessionTab("biology-1"), sessionTab("unrelated")]
    const ids = projectSessionIDs(tabs, {
      server,
      directories: ["/Users/kianwoonwong/Downloads/biology"],
      projectId: "proj-biology",
      sessionDirectory: (id) => (id === "biology-1" ? "/private/tmp/biology-sandbox" : "/other/project"),
      sessionProjectId: (id) => (id === "biology-1" ? "proj-biology" : "proj-other"),
    })

    expect(ids).toEqual(["biology-1"])
  })

  test("leaves orphans alone when they resolve on another server", () => {
    const otherServer = "local\nhttp://localhost:9999" as ServerConnection.Key
    const tabs: Tab[] = [
      { type: "session", server: otherServer, sessionId: "remote-orphan" },
      sessionTab("local-orphan"),
    ]
    const ids = projectSessionIDs(tabs, {
      server,
      directories: ["/repo"],
      projectId: "proj-1",
      sessionDirectory: () => undefined,
      sessionProjectId: () => undefined,
    })

    expect(ids).toEqual([])
  })
})
