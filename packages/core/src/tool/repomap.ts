export * as RepoMapTool from "./repomap"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FileSystemSearch } from "../filesystem/search"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { PositiveInt, RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "repomap"

export const Input = Schema.Struct({
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to map. Defaults to the active Location.",
  }),
  filter: Schema.String.pipe(Schema.optional).annotate({
    description: "Case-insensitive substring applied to the file paths.",
  }),
  limit: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum files to return.",
  }),
})

export const Output = Schema.Array(FileSystem.Entry)
type ModelOutput = typeof Output.Encoded

/** Format the mapped file paths into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.length === 0 ? ["No files found"] : output.map((item) => item.path)
  return lines.join("\n")
}

/** Bounded file listing leaf that answers from the already-populated per-Location index. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const search = yield* FileSystemSearch.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "List files that exist in the active Location from the prebuilt index, without walking the repo. Returns concise relative file resources. Use filter to narrow by name and path to scope to a subdirectory.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput(
                output.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })),
              ),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.path ?? "."],
                save: ["*"],
                metadata: {
                  root: input.path ?? ".",
                  path: input.path,
                  filter: input.filter,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const directory = path.resolve(location.directory, input.path ?? ".")
              const relative = path.relative(location.directory, directory).replaceAll("\\", "/")
              const prefix = relative === "" || relative === "." ? undefined : relative
              const limit = input.limit ?? 1000
              const found = yield* search.list({ filter: input.filter, limit })
              // Segment-respecting: "src" must not match "srcgen", so compare on a
              // separator boundary rather than a raw prefix.
              const paths = prefix
                ? found.paths.filter((entry) => entry === prefix || entry.startsWith(prefix + "/"))
                : found.paths
              return paths.map((entry) =>
                FileSystem.Entry.make({
                  path: RelativePath.make(entry),
                  type: "file",
                }),
              )
            }).pipe(
              Effect.mapError(() => new ToolFailure({ message: "Unable to map the repository" })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/repomap",
  layer,
  deps: [ToolRegistry.node, FileSystemSearch.node, Location.node, PermissionV2.node],
})
