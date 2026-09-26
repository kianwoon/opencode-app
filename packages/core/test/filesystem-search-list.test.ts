import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import path from "path"
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@opencode-ai/core/config"
import { EventV2 } from "@opencode-ai/core/event"
// Import order matters: filesystem.ts dereferences `FileSystemSearch.node` at
// module-evaluation time, so search.ts must be entered second (as the app does).
import "../src/filesystem"
import { FileSystemSearch, filterPaths, REPO_LIST_MAX } from "../src/filesystem/search"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }

const describeSearch = Watcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const itSearch = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, EventV2.node])))
const itFlag = testEffect(ConfigProvider.layer(ConfigProvider.fromUnknown({})))

function provide(directory: string, flags: Record<string, string>, vcs: Location.Interface["vcs"]) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { vcs })),
  )
  return Effect.provide(
    AppNodeBuilder.build(LayerNode.group([Watcher.node, FileSystemSearch.node]), [
      [Config.node, configLayer],
      [Location.node, locationLayer],
    ]).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(flags)))),
  )
}

function withGit<A, E, R>(
  flags: Record<string, string>,
  f: (directory: string, vcs: Location.Interface["vcs"]) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const tmp = await tmpdir()
      await $`git init`.cwd(tmp.path).quiet()
      await $`git config core.fsmonitor false`.cwd(tmp.path).quiet()
      await $`git config commit.gpgsign false`.cwd(tmp.path).quiet()
      await $`git config user.email test@opencode.test`.cwd(tmp.path).quiet()
      await $`git config user.name Test`.cwd(tmp.path).quiet()
      await $`git commit --allow-empty -m root`.cwd(tmp.path).quiet()
      return {
        tmp,
        vcs: { type: "git" as const, store: AbsolutePath.make(path.join(tmp.path, ".git")) },
      }
    }),
    ({ tmp }) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap(({ tmp, vcs }) => f(tmp.path, vcs).pipe(provide(tmp.path, flags, vcs))))
}

function nextUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const deferred = yield* Deferred.make<WatcherEvent>()
      const fiber = yield* events
        .subscribe(Watcher.Event.Updated)
        .pipe(
          Stream.runForEach((event) =>
            check(event.data) ? Deferred.succeed(deferred, event.data).pipe(Effect.asVoid) : Effect.void,
          ),
          Effect.forkScoped,
        )
      yield* Effect.yieldNow
      return { deferred, fiber }
    }),
    ({ deferred }) =>
      trigger.pipe(
        Effect.andThen(Deferred.await(deferred)),
        Effect.timeoutOption("5 seconds"),
        Effect.flatMap((result) =>
          Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(new Error("timed out waiting for watcher")),
        ),
      ),
    ({ fiber }) => Fiber.interrupt(fiber),
  )
}

// The search service's dirty-mark is a SEPARATE consumer of the same watcher
// PubSub, so our own nextUpdate does not prove it already processed the event.
const eventuallyListed = (search: FileSystemSearch.Interface, expected: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const listed = yield* search.list({ limit: 1_000 })
      if (listed.paths.includes(expected)) return listed
      yield* Effect.sleep("50 millis")
    }
    return yield* search.list({ limit: 1_000 })
  })

const ENABLED = { OPENCODE_EXPERIMENTAL_FILEWATCHER: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false" }
const DISABLED = { OPENCODE_EXPERIMENTAL_FILEWATCHER: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true" }

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

describeSearch("FileSystemSearch live invalidation", () => {
  itSearch.live("reflects a new file without waiting out the index TTL", () =>
    withGit(ENABLED, (directory) =>
      Effect.gen(function* () {
        const search = yield* FileSystemSearch.Service
        const fs = yield* FSUtil.Service
        const before = yield* search.list({ limit: 1_000 })
        expect(before.paths).not.toContain("watcher-new.txt")

        const file = path.join(directory, "watcher-new.txt")
        yield* nextUpdate((event) => event.event === "add" && event.file === file, fs.writeFileString(file, "hi"))

        const after = yield* eventuallyListed(search, "watcher-new.txt")
        expect(after.paths).toContain("watcher-new.txt")
      }),
    ),
  )

  itSearch.live("leaves staleness to the TTL when the watcher is disabled", () =>
    withGit(DISABLED, (directory) =>
      Effect.gen(function* () {
        const search = yield* FileSystemSearch.Service
        const fs = yield* FSUtil.Service
        const before = yield* search.list({ limit: 1_000 })
        expect(before.paths).not.toContain("watcher-disabled.txt")

        const file = path.join(directory, "watcher-disabled.txt")
        yield* fs.writeFileString(file, "hi")

        const after = yield* search.list({ limit: 1_000 })
        expect(after.paths).not.toContain("watcher-disabled.txt")
        expect(after.total).toBe(before.total)
      }),
    ),
  )
})

describe("file watcher flag", () => {
  itFlag.effect("is enabled by default when no env is set", () =>
    Effect.gen(function* () {
      expect(yield* Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBe(true)
      expect(yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER).toBe(false)
    }),
  )
})
