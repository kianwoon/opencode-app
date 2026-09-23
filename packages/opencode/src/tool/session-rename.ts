import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "../session/session"
import { InstanceState } from "../effect/instance-state"

export const Parameters = Schema.Struct({
  title: Schema.String.annotate({
    description: "The new title for the current root/main session. This tool cannot target another session or project.",
  }),
})

type Metadata = {}

export const SessionRenameTool = Tool.define<typeof Parameters, Metadata, Session.Service>(
  "session_rename",
  Effect.gen(function* () {
    const session = yield* Session.Service

    return {
      description:
        "Rename only the current root/main session in the active project. This tool cannot target a subagent, another session, or another project.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const current = yield* session.get(ctx.sessionID).pipe(Effect.orDie)
          const context = yield* InstanceState.context
          if (current.parentID) {
            return yield* Effect.die(
              new Error("Session rename is only allowed for the current root/main session; subagent sessions cannot be renamed."),
            )
          }
          if (current.projectID !== context.project.id) {
            return yield* Effect.die(
              new Error("Session rename is only allowed for the active project; refusing a session from another project."),
            )
          }
          yield* session.setTitle({ sessionID: ctx.sessionID, title: params.title })

          return {
            title: "Renamed session",
            output: params.title,
            metadata: {},
          }
        }),
    }
  }),
)
