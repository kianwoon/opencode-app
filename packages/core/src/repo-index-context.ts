export * as RepoIndexContext from "./repo-index-context"

import { Effect, Layer, Schema } from "effect"
import { FileSystem } from "./filesystem"
import { Location } from "./location"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import { makeLocationNode } from "./effect/app-node"

/**
 * A cheap filename -> purpose map of the workspace, advertised to the model so
 * targeted reads replace exploratory listing/greping. Paths only: the index
 * stays bounded regardless of repository size; the model opens what it needs.
 *
 * Bounded twice: observation caps the glob result, rendering caps the visible
 * text. Beyond either bound the map says it is partial rather than lying with
 * a truncated fragment.
 */

/** Maximum files observed into the durable snapshot value. */
export const MAX_ENTRIES = 4_000
/** Maximum file paths rendered into model-visible text. */
export const MAX_RENDERED = 400
/** File count above which the rendered map claims partial coverage. */
const PARTIAL_THRESHOLD = MAX_RENDERED

const Paths = Schema.Array(Schema.String)
const key = SystemContext.Key.make("core/repo-index")

/** Render the bounded grouped file map for model-visible context. */
export const render = (paths: ReadonlyArray<string>) => {
  if (paths.length === 0) return "Repository file map is empty."
  const grouped = new Map<string, string[]>()
  for (const path of paths) {
    const slash = path.lastIndexOf("/")
    const directory = slash === -1 ? "." : path.slice(0, slash)
    grouped.set(directory, [...(grouped.get(directory) ?? []), path.slice(slash + 1)])
  }
  const directories = Array.from(grouped.keys()).sort()
  const lines: string[] = []
  let rendered = 0
  let truncated = false
  for (const directory of directories) {
    if (rendered + 1 > MAX_RENDERED) {
      truncated = true
      break
    }
    lines.push(`${directory}/`)
    rendered++
    for (const name of grouped.get(directory) ?? []) {
      if (rendered + 1 > MAX_RENDERED) {
        truncated = true
        break
      }
      lines.push(`  ${name}`)
      rendered++
    }
    if (truncated) break
  }
  const summary =
    paths.length > PARTIAL_THRESHOLD
      ? `Repository file map (partial; ${paths.length} files total):`
      : "Repository file map:"
  return [
    summary,
    ...lines,
    ...(truncated
      ? [`  ... ${paths.length - rendered} more paths not listed; use search tools for anything unlisted`]
      : []),
  ].join("\n")
}

/** Build the source over an already-observed path list. Exposed for tests and alternative observers. */
export const source = (value: ReadonlyArray<string> | SystemContext.Unavailable) =>
  SystemContext.make({
    key,
    codec: Schema.toCodecJson(Paths),
    load: Effect.succeed(value),
    baseline: render,
    update: (_previous, current) => `The repository file map is now:\n\n${render(current)}`,
    removed: () => "The repository file map is no longer available.",
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* SystemContextRegistry.Service
    const filesystem = yield* FileSystem.Service
    const location = yield* Location.Service

    const observe = Effect.fn("RepoIndexContext.observe")(function* () {
      const entries = yield* filesystem.glob({ pattern: "**/*", limit: MAX_ENTRIES }).pipe(Effect.option)
      if (entries._tag === "None") return SystemContext.unavailable
      return entries.value
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.path)
        .sort()
    })

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.map((paths) =>
          paths === SystemContext.unavailable
            ? source(paths)
            : paths.length === 0
              ? SystemContext.empty
              : source(paths),
        ),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "repo-index-context",
  layer,
  deps: [FileSystem.node, Location.node, SystemContextRegistry.node],
})
