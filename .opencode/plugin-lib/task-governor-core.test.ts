import { describe, expect, test } from "bun:test"
import {
  buildWorkerContext,
  detectTier,
  driftNudge,
  scoreActive,
  shouldPromote,
  tailStartWithTaskBoundary,
  WORKING_SET_CAP_CHARS,
  type TaskRecord,
} from "./task-governor-core.ts"

const task = (id: string): TaskRecord => ({
  id,
  goal: `goal ${id}`,
  decisions: [],
  files_changed: [],
  known_failures: [],
  status: "active",
})

describe("detectTier", () => {
  test("tier1 explicit acts", () => {
    expect(detectTier("/task-new refactor auth")).toBe("tier1-explicit")
    expect(detectTier("/task-done")).toBe("tier1-explicit")
    expect(detectTier("let's switch to the caching work")).toBe("tier1-explicit")
    expect(detectTier("git checkout feature/x")).toBe("tier1-explicit")
  })

  test("tier2 suggestive nudge only", () => {
    expect(detectTier("by the way, the build script changed")).toBe("tier2-suggestive")
    expect(detectTier("forget that, never mind")).toBe("tier2-suggestive")
  })

  test("default same-task on ambiguous", () => {
    expect(detectTier("keep going with the tests", task("t1"))).toBe("same-task")
    expect(detectTier("", task("t1"))).toBe("same-task")
  })
})

describe("scoreActive", () => {
  test("active=1.0, other=0.2, pinned keep", () => {
    expect(scoreActive("t1", "t1")).toBe(1.0)
    expect(scoreActive("t2", "t1")).toBe(0.2)
    expect(scoreActive("t2", "t1", { taskId: "t2", pinned: true })).toBe(1.0)
  })
})

describe("tailStartWithTaskBoundary", () => {
  test("task_id change extends tail boundary", () => {
    const msgs = [
      { info: { id: "m1" }, meta: { task_id: "t1" } },
      { info: { id: "m2" }, meta: { task_id: "t1" } },
      { info: { id: "m3" }, meta: { task_id: "t2" } },
      { info: { id: "m4" }, meta: { task_id: "t2" } },
    ]
    // Base tail start of 0 (protect everything) must be pushed to the newest
    // transition into the active task → index 2 → old-task content prunable.
    expect(tailStartWithTaskBoundary(0, msgs, "t2")).toBe(2)
    // Without an active id, the generic task change boundary (index 2) applies.
    expect(tailStartWithTaskBoundary(0, msgs)).toBe(2)
    // Base boundary never shrinks below the base tail.
    expect(tailStartWithTaskBoundary(3, msgs, "t2")).toBe(3)
  })
})

describe("buildWorkerContext", () => {
  test("caps working set and filters pins by task_id", () => {
    const active = { ...task("t1"), decisions: ["use bun"], known_failures: ["flaky test A"] }
    const stableCore = "x".repeat(1000)
    const bigFile = "y".repeat(WORKING_SET_CAP_CHARS)
    const pkg = buildWorkerContext(stableCore, active, [bigFile], [
      { taskId: "t1", pinned: true },
      { taskId: "t2", pinned: true },
    ])
    expect(pkg.pins.length).toBe(1)
    expect(pkg.pins[0].taskId).toBe("t1")
    expect(pkg.brief).toContain("use bun")
    expect(pkg.brief).toContain("flaky test A")
    expect(pkg.outputContract).toContain("task_id")
    // Working set truncated under cap.
    let total = 0
    for (const f of pkg.files) total += f.length
    expect(total + stableCore.length).toBeLessThanOrEqual(WORKING_SET_CAP_CHARS)
    // Deterministic.
    const again = buildWorkerContext(stableCore, active, [bigFile], [{ taskId: "t1", pinned: true }])
    expect(again.files).toEqual(pkg.files)
  })
})

describe("shouldPromote", () => {
  test("promote only on match and not stale", () => {
    expect(shouldPromote("t1", "t1", false)).toBe(true)
    expect(shouldPromote("t2", "t1", false)).toBe(false)
    expect(shouldPromote("t1", "t1", true)).toBe(false)
    expect(shouldPromote(undefined, "t1", false)).toBe(false)
  })
})

describe("driftNudge", () => {
  test("drift detected on disjoint sets (suggest-only, never evict)", () => {
    const r = driftNudge(["src/a/x.ts", "src/a/y.ts"], ["docs/m/1.md", "docs/n/2.md", "other/p/3.md"])
    expect(r.drifted).toBe(true)
    expect(r.overlap).toBe(0)
    expect(r.hint).toContain("[y/n]")
    expect(r.hint).toContain("overlap")
  })

  test("no drift when recent files overlap active task files", () => {
    const r = driftNudge(["src/a/x.ts", "src/a/y.ts", "src/a/z.ts"], ["src/a/w.ts", "src/a/v.ts", "src/a/x.ts"])
    expect(r.drifted).toBe(false)
    expect(r.overlap).toBeGreaterThan(0.1)
    expect(r.hint).toBe("")
  })

  test("empty or insufficient recent window → no drift", () => {
    expect(driftNudge(["src/a/x.ts"], []).drifted).toBe(false)
    expect(driftNudge(["src/a/x.ts"], ["a.ts", "b.ts"]).drifted).toBe(false)
  })
})
