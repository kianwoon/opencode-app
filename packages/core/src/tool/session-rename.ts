export * as SessionRenameTool from "./session-rename"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionV2 } from "../session"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "session_rename"

export const Input = Schema.Struct({
  title: Schema.String.annotate({ description: "The new session title." }),
})

export const Output = Schema.Struct({
  title: Schema.String,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => output.title

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const sessions = yield* SessionV2.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Rename the current session. Use this to give the session a short, descriptive title reflecting the work being done.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              yield* sessions.setTitle({ sessionID: context.sessionID, title: input.title })
              return { title: input.title }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to rename session" }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeGlobalNode({
  name: "tool/session-rename",
  layer,
  deps: [SessionV2.node],
})
