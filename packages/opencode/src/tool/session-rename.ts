import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "../session/session"

export const Parameters = Schema.Struct({
  title: Schema.String.annotate({ description: "The new title for the current session" }),
})

type Metadata = {}

export const SessionRenameTool = Tool.define<typeof Parameters, Metadata, Session.Service>(
  "session_rename",
  Effect.gen(function* () {
    const session = yield* Session.Service

    return {
      description:
        "Rename the current session. Use this to give the session a short, descriptive title reflecting the work being done.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
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
