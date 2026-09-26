import { describe, expect, test } from "bun:test"
// Import order matters: filesystem.ts dereferences `FileSystemSearch.node` at
// module-evaluation time, so search.ts must be entered second (as the app does).
import "../src/filesystem"
import { filterPaths, REPO_LIST_MAX } from "../src/filesystem/search"

describe("filterPaths", () => {
  test("returns every path sorted when no filter is given", () => {
    expect(filterPaths(["b.ts", "a.ts", "c.ts"], undefined, 10)).toEqual(["a.ts", "b.ts", "c.ts"])
  })

  test("matches a case-insensitive substring", () => {
    expect(filterPaths(["src/App.ts", "src/app.test.ts", "README.md"], "app", 10)).toEqual([
      "src/App.ts",
      "src/app.test.ts",
    ])
  })

  test("returns nothing when no path matches the filter", () => {
    expect(filterPaths(["src/App.ts"], "zzz", 10)).toEqual([])
  })

  test("truncates to the requested limit", () => {
    expect(filterPaths(["a", "b", "c"], undefined, 2)).toEqual(["a", "b"])
  })

  test("never returns more than the index cap even for a larger limit", () => {
    const paths = Array.from({ length: REPO_LIST_MAX + 25 }, (_, index) => `f${index}.ts`)
    expect(filterPaths(paths, undefined, Number.MAX_SAFE_INTEGER)).toHaveLength(REPO_LIST_MAX)
  })

  test("returns nothing for an empty index", () => {
    expect(filterPaths([], undefined, 10)).toEqual([])
  })
})
