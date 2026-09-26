export * as SymbolsTool from "./symbols"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { Symbols } from "../repo/symbols"
import { PositiveInt, RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "symbols"

export const Input = Schema.Struct({
  name: Schema.String.annotate({
    description: "Symbol name or fragment to locate, e.g. a function, class, interface, or type.",
  }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative subdirectory to scope the result. Defaults to the active Location.",
  }),
  limit: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum symbols to return.",
  }),
})

export const Output = Schema.Struct({
  symbols: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      line: Schema.Number,
      kind: Schema.String,
      name: Schema.String,
    }),
  ),
  building: Schema.Boolean.annotate({
    description: "True while the initial index build is still running; results may be incomplete.",
  }),
})
type ModelOutput = typeof Output.Encoded

/** Format symbol hits into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines =
    output.symbols.length === 0
      ? ["No symbols found"]
      : output.symbols.map((item) => `${item.path}:${item.line} ${item.kind} ${item.name}`)
  // Never let a partial index read as a complete one.
  const suffix = output.building ? ["(index still building; results may be incomplete)"] : []
  return [...lines, ...suffix].join("\n")
}

/** Declaration lookup leaf backed by a lazily-built tree-sitter index. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const symbols = yield* Symbols.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Find where a function, class, interface, type, or enum is defined in the active Location. Returns file:line declarations. Falls back to a text search when the index has no match, so this never reports a false absence.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput({
                ...output,
                symbols: output.symbols.map((item) => ({ ...item, path: path.resolve(location.directory, item.path) })),
              }),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.name],
                save: ["*"],
                metadata: {
                  root: input.path ?? ".",
                  path: input.path,
                  name: input.name,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const directory = path.resolve(location.directory, input.path ?? ".")
              const relative = path.relative(location.directory, directory).replaceAll("\\", "/")
              const prefix = relative === "" || relative === "." ? undefined : relative
              const found = yield* symbols.query({ name: input.name, limit: input.limit ?? 100 })
              // Segment-respecting: "src" must not match "srcgen", so compare on a
              // separator boundary rather than a raw prefix.
              const hits = prefix
                ? found.symbols.filter((hit) => hit.path === prefix || hit.path.startsWith(prefix + "/"))
                : found.symbols
              // Surface the service's own building flag: a partial index must not read
              // as a complete one once the hits are filtered and truncated.
              return { symbols: hits, building: found.building }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to look up symbols for ${input.name}` }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/symbols",
  layer,
  deps: [ToolRegistry.node, Symbols.node, Location.node, PermissionV2.node],
})
