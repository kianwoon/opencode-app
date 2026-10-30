export * as SessionRenameTool from "./session-rename.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Location } from "../location.js"
import { Session } from "../session.js"

export const Parameters = Schema.Struct({
  title: Schema.String.annotate({
    description: "The new title for the current root/main session. This tool cannot target another session or project.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

export const Plugin = {
  id: "opencode.tool.session_rename",
  effect: Effect.fn("SessionRenameTool.Plugin")(function* (ctx: PluginContext) {
    const session = yield* Session.Service
    const location = yield* Location.Service

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "session_rename",
        options: { codemode: false },
        description:
          "Rename only the current root/main session in the active project. This tool cannot target a subagent, another session, or another project.",
        input: Parameters,
        execute: (params: Params, context) =>
          Effect.gen(function* () {
            const current = yield* session.get(context.sessionID).pipe(Effect.orDie)
            if (current.parentID) {
              return yield* Effect.fail(
                new ToolFailure({
                  message:
                    "Session rename is only allowed for the current root/main session; subagent sessions cannot be renamed.",
                }),
              )
            }
            if (`${current.projectID}` !== `${location.project.id}`) {
              return yield* Effect.fail(
                new ToolFailure({
                  message:
                    "Session rename is only allowed for the active project; refusing a session from another project.",
                }),
              )
            }
            yield* session.rename({ sessionID: context.sessionID, title: params.title }).pipe(Effect.orDie)
            return { content: params.title, metadata: {} }
          }),
      }),
    )
  }),
}
