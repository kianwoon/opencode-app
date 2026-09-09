import { describe, expect, test } from "bun:test"
import { dirtyAncestors } from "@/snapshot"

describe("snapshot dirtyAncestors", () => {
  test("terminates for a root worktree — one watcher event must not spin the loop", () => {
    // Regression 2026-09-09: with worktree "/", the old ancestor walk never
    // terminated (dirname("/") === "/") and pegged the server at 100% CPU.
    expect(dirtyAncestors("/a/b/c.conf", "/")).toEqual(new Set(["/a/b", "/a"]))
  })

  test("walks ancestors inside the worktree and stops at its boundary", () => {
    const worktree = "/Users/kianwoonwong/Downloads/zmk"
    expect(dirtyAncestors("/Users/kianwoonwong/Downloads/zmk/config/foo.conf", worktree)).toEqual(
      new Set(["/Users/kianwoonwong/Downloads/zmk/config", "/Users/kianwoonwong/Downloads/zmk"]),
    )
  })

  test("returns nothing for files outside the worktree", () => {
    expect(dirtyAncestors("/tmp/other/file.txt", "/Users/kianwoonwong/Downloads/zmk")).toEqual(new Set())
  })
})
