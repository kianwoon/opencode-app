export * as ScheduleTaskTool from "./schedule-task"

import { ToolFailure } from "@opencode/ai/effect"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { LocationMutation } from "../location-mutation"
import { Permission } from "../permission"
import { Task } from "../task"
import { Cron } from "../task/cron"

export const name = "schedule_task"

export const Input = Schema.Struct({
  title: Schema.String.annotate({ description: "Short human-readable name for the scheduled task" }),
  prompt: Schema.String.annotate({ description: "Prompt text submitted to the bound session on each fire" }),
  cron: Schema.String.annotate({
    description:
      "Schedule as a 5-field cron expression or one of the presets: yearly, monthly, weekly, daily, hourly, minutely",
  }),
  sessionID: Schema.optional(
    SessionID.annotate({
      description: "Existing session to continue on each fire; omit to create a session on first fire",
    }),
  ),
})

export const Output = Schema.Struct({
  taskID: Task.ID,
  next_run_at: Schema.optional(Schema.Number),
})

export const Plugin = {
  id: "opencode.tool.schedule_task",
  effect: Effect.fn("ScheduleTaskTool.Plugin")(function* (ctx: Context) {
    const tasks = yield* Task.Service
    const permission = yield* Permission.Service
    const mutation = yield* LocationMutation.Service

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name,
        options: { codemode: false },
        description:
          "Create a recurring scheduled task. Each fire submits the prompt to a bound session (created automatically on first fire) and runs it in the background on the given cron schedule.",
        input: Input,
        output: Output,
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* permission.assert({
              action: name,
              resources: ["*"],
              save: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool" as const, messageID: context.messageID, id: context.id },
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
              sessionID: input.sessionID,
            })
            const output = { taskID: created.id, next_run_at: created.next_run_at }
            return { output, content: JSON.stringify(output) }
          }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to create the scheduled task" }))),
      }),
    )
  }),
}
