export * as ScheduleTaskTool from "./schedule-task"

import { ToolFailure } from "@opencode-ai/llm"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { Task } from "../task"
import { Cron } from "../task/cron"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "schedule_task"

export const Input = Schema.Struct({
  title: Schema.String.annotate({ description: "Short human-readable name for the scheduled task" }),
  prompt: Schema.String.annotate({ description: "Prompt text submitted to the bound session on each fire" }),
  cron: Schema.String.annotate({
    description:
      "Schedule as a 5-field cron expression or one of the presets: yearly, monthly, weekly, daily, hourly, minutely",
  }),
  sessionID: Schema.optional(
    Schema.String.annotate({
      description: "Existing session to continue on each fire; omit to create a session on first fire",
    }),
  ),
})

export const Output = Schema.Struct({
  taskID: Task.ID,
  next_run_at: Schema.optional(Schema.Number),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const tasks = yield* Task.Service
    const permission = yield* PermissionV2.Service
    const mutation = yield* LocationMutation.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Create a recurring scheduled task. Each fire submits the prompt to a bound session (created automatically on first fire) and runs it in the background on the given cron schedule.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: JSON.stringify(output) },
          ],
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

              const cron = yield* Cron.parse(input.cron).pipe(
                Effect.mapError((error) => new ToolFailure({ message: error.message })),
              )

              const target = yield* mutation.resolve({ path: ".", kind: "directory" })
              const created = yield* tasks.create({
                title: input.title,
                prompt: { text: input.prompt },
                cron,
                directory: AbsolutePath.make(target.canonical),
                sessionID: input.sessionID ? SessionID.descending(input.sessionID) : undefined,
              })
              return { taskID: created.id, next_run_at: created.next_run_at }
            }).pipe(
              Effect.mapError(
                () => new ToolFailure({ message: "Unable to create the scheduled task" }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/schedule-task",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Task.node, LocationMutation.node],
})
