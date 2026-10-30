export * as RepoMapTool from "./repomap"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import path from "path"
import { FileSystem } from "../filesystem"
import { FileSystemSearch } from "../filesystem/search"
import { Location } from "../location"
import { Permission } from "../permission"
import { PositiveInt, RelativePath } from "../schema"

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
export const Plugin = {
  id: "opencode.tool.repomap",
  effect: Effect.fn("RepoMapTool.Plugin")(function* (ctx: Context) {
    const search = yield* FileSystemSearch.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name,
        options: { codemode: false },
        description:
          "List files that exist in the active Location from the prebuilt index, without walking the repo. Returns concise relative file resources. Use filter to narrow by name and path to scope to a subdirectory.",
        input: Input,
        output: Output,
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
              source: { type: "tool" as const, messageID: context.messageID, id: context.id },
            })
            const directory = path.resolve(location.directory, input.path ?? ".")
            const relative = path.relative(location.directory, directory).replaceAll("\\", "/")
            const prefix = relative === "" || relative === "." ? undefined : relative
            const limit = input.limit ?? 1000
            const found = yield* search.find({ query: input.filter ?? "", limit, type: "file" })
            // Segment-respecting: "src" must not match "srcgen", so compare on a
            // separator boundary rather than a raw prefix.
            const paths = prefix
              ? found.filter((entry) => entry.path === prefix || entry.path.startsWith(prefix + "/"))
              : found
            const output = paths.map((entry) =>
              FileSystem.Entry.make({
                path: RelativePath.make(entry.path),
                type: "file",
              }),
            )
            return {
              output,
              content: toModelOutput(
                output.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })),
              ),
            }
          }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to map the repository" }))),
      }),
    )
  }),
}
