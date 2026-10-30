import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileSystem } from "@opencode/core/filesystem"
import { FileSystemSearch } from "@opencode/core/filesystem/search"
import { Location } from "@opencode/core/location"
import { Ripgrep } from "@opencode/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const files = ["a.ts", "b.md", "src/c.ts"]

const ripgrepStub = Layer.succeed(
  Ripgrep.Service,
  Ripgrep.Service.of({
    find: (input) =>
      Effect.gen(function* () {
        for (const file of files) {
          if (input.onEntry) yield* input.onEntry(FileSystem.Entry.make({ path: RelativePath.make(file), type: "file" }))
        }
        return []
      }),
    glob: () => Effect.succeed([]),
    grep: () => Effect.succeed([]),
  }),
)

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/indexed") })),
)

const build = () =>
  AppNodeBuilder.build(FileSystemSearch.node, [
    Location.node.replace(locationLayer),
    Ripgrep.node.replace(ripgrepStub),
  ])

const it = testEffect(Layer.empty)

describe("FileSystemSearch.find", () => {
  it.live("lists every file in the location index", () =>
    Effect.gen(function* () {
      const search = yield* FileSystemSearch.Service
      const found = yield* search.find({ query: ".", limit: 1_000, type: "file" })
      expect(found.map((entry) => String(entry.path)).sort()).toEqual(["a.ts", "b.md", "src/c.ts"])
    }).pipe(Effect.provide(build())),
  )

  it.live("derives directories from indexed file paths", () =>
    Effect.gen(function* () {
      const search = yield* FileSystemSearch.Service
      const directories = yield* search.find({ query: "src", limit: 1_000, type: "directory" })
      expect(directories.map((entry) => String(entry.path))).toEqual(["src/"])
    }).pipe(Effect.provide(build())),
  )

  it.live("filters by a query against indexed paths", () =>
    Effect.gen(function* () {
      const search = yield* FileSystemSearch.Service
      const found = yield* search.find({ query: "a.ts", limit: 10, type: "file" })
      expect(found.map((entry) => String(entry.path))).toEqual(["a.ts"])
    }).pipe(Effect.provide(build())),
  )

  it.live("honors the requested limit", () =>
    Effect.gen(function* () {
      const search = yield* FileSystemSearch.Service
      const found = yield* search.find({ query: ".", limit: 1, type: "file" })
      expect(found).toHaveLength(1)
    }).pipe(Effect.provide(build())),
  )
})
