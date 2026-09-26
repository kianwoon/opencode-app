import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import path from "path"
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@opencode-ai/core/config"
import { EventV2 } from "@opencode-ai/core/event"
// Import order matters: filesystem.ts dereferences `FileSystemSearch.node` at
// module-evaluation time, so filesystem must be entered before search.ts (as the
// app does) or the namespace is still in TDZ.
import "../src/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Symbols } from "../src/repo/symbols"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }

const describeSymbols = Watcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

const ENABLED = { OPENCODE_EXPERIMENTAL_FILEWATCHER: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false" }

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const itSymbols = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, EventV2.node])))

function provide(directory: string, vcs: Location.Interface["vcs"]) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { vcs })),
  )
  return Effect.provide(
    AppNodeBuilder.build(LayerNode.group([Watcher.node, Symbols.node]), [
      [Config.node, configLayer],
      [Location.node, locationLayer],
    ]).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(ENABLED)))),
  )
}

function withGit<A, E, R>(f: (directory: string, vcs: Location.Interface["vcs"]) => Effect.Effect<A, E, R>) {
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
  ).pipe(Effect.flatMap(({ tmp, vcs }) => f(tmp.path, vcs).pipe(provide(tmp.path, vcs))))
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

// A ripgrep fallback hit carries kind "text"; a real index hit is a declaration node.
const indexHit = (symbols: Symbols.Interface, name: string) =>
  Effect.gen(function* () {
    const found = yield* symbols.query({ name, limit: 10 })
    return found.symbols.find((hit) => hit.kind !== "text")
  })

// The watcher coalesces (~100ms) and the index updates on the next query, so poll
// for the expected line instead of asserting on the first read after the write.
const eventuallyLine = (symbols: Symbols.Interface, name: string, line: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const hit = yield* indexHit(symbols, name)
      if (hit?.line === line) return hit
      yield* Effect.sleep("50 millis")
    }
    return yield* indexHit(symbols, name)
  })

describeSymbols("Symbols incremental index", () => {
  itSymbols.live("re-parses a changed file so a moved symbol reports its new line", () =>
    withGit((directory) =>
      Effect.gen(function* () {
        const symbols = yield* Symbols.Service
        const fs = yield* FSUtil.Service
        const file = path.join(directory, "moved.ts")
        yield* fs.writeFileString(file, "function alpha() {}\n")
        expect((yield* eventuallyLine(symbols, "alpha", 1))?.line).toBe(1)

        yield* nextUpdate(
          (event) => event.event === "change" && event.file === file,
          fs.writeFileString(file, "// pad\n// pad\n// pad\nfunction alpha() {}\n"),
        )

        expect((yield* eventuallyLine(symbols, "alpha", 4))?.line).toBe(4)
      }),
    ),
  )

  itSymbols.live("drops a removed file from the index instead of re-parsing it", () =>
    withGit((directory) =>
      Effect.gen(function* () {
        const symbols = yield* Symbols.Service
        const fs = yield* FSUtil.Service
        const file = path.join(directory, "removed.ts")
        yield* fs.writeFileString(file, "function removable() {}\n")
        expect((yield* eventuallyLine(symbols, "removable", 1))?.line).toBe(1)

        yield* nextUpdate(
          (event) => event.event === "unlink" && event.file === file,
          fs.remove(file, { force: true }),
        )

        for (let attempt = 0; attempt < 100; attempt++) {
          if (!(yield* indexHit(symbols, "removable"))) break
          yield* Effect.sleep("50 millis")
        }
        expect(yield* indexHit(symbols, "removable")).toBeUndefined()
      }),
    ),
  )

  // populate filters on SOURCE_EXTENSIONS, so the drain must apply the same filter:
  // a .md change re-parsed with the JS grammar would land a junk entry in the index.
  itSymbols.live("ignores a watcher event for a non-source path", () =>
    withGit((directory) =>
      Effect.gen(function* () {
        const symbols = yield* Symbols.Service
        const fs = yield* FSUtil.Service
        const anchor = path.join(directory, "anchor.ts")
        yield* fs.writeFileString(anchor, "function anchor() {}\n")
        expect((yield* eventuallyLine(symbols, "anchor", 1))?.line).toBe(1)

        const doc = path.join(directory, "notes.md")
        yield* nextUpdate(
          (event) => event.event === "add" && event.file === doc,
          fs.writeFileString(doc, "function markdownFn() {}\n"),
        )

        // A real .ts change re-dirties the index; draining it proves a drain ran AFTER
        // the .md event landed, so the absence below is the filter, not a timing miss.
        yield* nextUpdate(
          (event) => event.event === "change" && event.file === anchor,
          fs.writeFileString(anchor, "// pad\nfunction anchor() {}\n"),
        )
        expect((yield* eventuallyLine(symbols, "anchor", 2))?.line).toBe(2)

        expect(yield* indexHit(symbols, "markdownFn")).toBeUndefined()
      }),
    ),
  )
})
