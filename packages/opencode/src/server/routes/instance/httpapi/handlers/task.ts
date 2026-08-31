import { Task } from "@opencode-ai/core/task"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { TaskNotFoundError } from "../errors"
import { TaskScheduler } from "@/task/scheduler"

export const taskHandlers = HttpApiBuilder.group(InstanceHttpApi, "task", (handlers) =>
  Effect.gen(function* () {
    const tasks = yield* Task.Service
    const scheduler = yield* TaskScheduler.Service

    const notFound = (taskID: Task.ID) =>
      new TaskNotFoundError({ taskID, message: `Task not found: ${taskID}` })

    return handlers
      .handle("list", () => tasks.all())
      .handle("get", (ctx) =>
        tasks.get(ctx.params.taskID).pipe(Effect.flatMap((task) => (task ? Effect.succeed(task) : Effect.fail(notFound(ctx.params.taskID))))),
      )
      .handle("create", (ctx) => tasks.create(ctx.payload))
      .handle("update", (ctx) =>
        tasks.update(ctx.params.taskID, ctx.payload).pipe(
          Effect.flatMap((task) => (task ? Effect.succeed(task) : Effect.fail(notFound(ctx.params.taskID)))),
        ),
      )
      .handle("remove", (ctx) =>
        Effect.gen(function* () {
          const task = yield* tasks.get(ctx.params.taskID)
          if (!task) return yield* Effect.fail(notFound(ctx.params.taskID))
          yield* tasks.remove(ctx.params.taskID)
          return true
        }),
      )
      .handle("runs", (ctx) => tasks.runs(ctx.params.taskID, 50))
      .handle("run", (ctx) =>
        Effect.gen(function* () {
          const task = yield* tasks.get(ctx.params.taskID)
          if (!task) return yield* Effect.fail(notFound(ctx.params.taskID))
          yield* scheduler.run(ctx.params.taskID)
          return true
        }),
      )
  }),
)
