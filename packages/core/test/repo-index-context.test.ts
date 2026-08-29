import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { RepoIndexContext } from "@opencode-ai/core/repo-index-context"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("/repo")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory }, { projectDirectory: directory })),
)

const file = (path: string) => FileSystem.Entry.make({ path: RelativePath.make(path), type: "file" })

const fsWith = (entries: readonly FileSystem.Entry[]) =>
  Layer.succeed(
    FileSystem.Service,
    FileSystem.Service.of({
      glob: (input: FileSystem.GlobInput) => Effect.succeed(entries.slice(0, input.limit ?? entries.length)),
    } as never),
  )

const failingFs = Layer.succeed(
  FileSystem.Service,
  FileSystem.Service.of({ glob: () => Effect.fail(new Error("rg exploded")) } as never),
)

const build = (filesystem: Layer.Layer<FileSystem.Service>) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([RepoIndexContext.node, SystemContextRegistry.node]), [
      [Location.node, locationLayer],
      [FileSystem.node, filesystem],
    ]),
  )

const KEY = "core/repo-index"

describe("RepoIndexContext", () => {
  const grouped = build(
    fsWith([file("README.md"), file("src/a.ts"), file("src/deep/b.ts")]),
  )
  const empty = build(fsWith([]))
  const failing = build(failingFs)

  grouped.effect("renders a grouped file map baseline", () =>
    Effect.gen(function* () {
      const registry = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* registry.load())
      expect(initialized.baseline).toBe(
        ["Repository file map:", "./", "  README.md", "src/", "  a.ts", "src/deep/", "  b.ts"].join("\n"),
      )
      expect(initialized.snapshot[KEY]).toBeDefined()
    }),
  )

  empty.effect("empty workspace registers no source", () =>
    Effect.gen(function* () {
      const registry = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* registry.load())
      expect(initialized.baseline).not.toContain("Repository file map")
      expect(initialized.snapshot[KEY]).toBeUndefined()
    }),
  )

  failing.effect("failed observation blocks initialization so the runner retries later", () =>
    Effect.gen(function* () {
      const registry = yield* SystemContextRegistry.Service
      const exit = yield* Effect.exit(SystemContext.initialize(yield* registry.load()))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const blocked = Cause.squash(exit.cause) as SystemContext.InitializationBlocked
        expect(blocked.keys).toEqual([SystemContext.Key.make(KEY)])
      }
    }),
  )

  test("render caps the map and reports the unlisted remainder", () => {
    const many = Array.from({ length: RepoIndexContext.MAX_RENDERED + 50 }, (_, index) => `f/${index}.ts`)
    const rendered = RepoIndexContext.render(many)
    const lines = rendered.split("\n")
    expect(rendered).toContain("(partial;")
    expect(lines.length).toBeLessThanOrEqual(RepoIndexContext.MAX_RENDERED + 2)
    expect(rendered).toContain("more paths not listed")
  })

  test("large maps claim partial coverage while small maps do not", () => {
    const many = Array.from({ length: RepoIndexContext.MAX_RENDERED + 10 }, (_, index) => `f/${index}.ts`)
    expect(RepoIndexContext.render(many)).toContain("(partial;")
    expect(RepoIndexContext.render(["a.ts"])).not.toContain("(partial;")
  })

  test("reconcile detects path drift: Unchanged for equal maps, Updated for changed maps", async () => {
    const before = ["a.ts", "src/b.ts"]
    const paths = Schema.toCodecJson(Schema.Array(Schema.String))
    const first = RepoIndexContext.source(before)
    const generation = await Effect.runPromise(SystemContext.initialize(first))
    const stored = generation.snapshot[KEY]?.value

    // Same observation → Unchanged.
    const same = await Effect.runPromise(
      SystemContext.reconcile(RepoIndexContext.source(before), generation.snapshot),
    )
    expect(same._tag).toBe("Unchanged")

    // Different observation → Updated with rendered map text.
    const changed = await Effect.runPromise(
      SystemContext.reconcile(RepoIndexContext.source(["a.ts", "src/c.ts", "README.md"]), generation.snapshot),
    )
    expect(changed._tag).toBe("Updated")
    if (changed._tag !== "Updated") throw new Error("expected Updated")
    expect(changed.text).toContain("The repository file map is now:")
    expect(changed.text).toContain("c.ts")

    // The stored snapshot value round-trips through the codec.
    expect(Schema.decodeUnknownSync(paths)(stored)).toEqual(before)
  })
})
