export * as TaskScheduler from "./scheduler"

import { Cause, Context, Effect, Layer, Schedule, Scope } from "effect"
import { Task } from "@opencode-ai/core/task"
import { RunID } from "@opencode-ai/core/task"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionPrompt } from "@/session/prompt"
import { InstanceStore } from "@/project/instance-store"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Cron } from "./cron"

/** How often the scheduler wakes to claim due tasks. */
const TICK_INTERVAL = "15 seconds"

export interface Interface {
  /** Runs one scheduler tick: claims due tasks and starts their runs. Exposed for tests. */
  readonly tick: () => Effect.Effect<number>
  /** Fires a specific task now, bypassing the schedule (manual run). */
  readonly run: (id: Task.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskScheduler") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const tasks = yield* Task.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const prompts = yield* SessionPrompt.Service
    const instances = yield* InstanceStore.Service
    // Fire fibers and the tick loop are forked into the layer scope so they are
    // interrupted when the scheduler layer shuts down.
    const scope = yield* Scope.Scope

    // Invalid cron yields undefined so the task idles with no next_run_at until edited.
    const computeNext = (task: Task.Info, from: number): number | undefined =>
      task.enabled ? Cron.nextRunAfter(task.cron, from) : undefined

    // Crash recovery: run rows left "running" by a previous process can never finish.
    // Mark them failed. Their tasks were re-armed at startRun time, and newly created
    // or disarmed tasks are re-armed by tick() from the task's own schedule.
    const reconcile = Effect.fn("TaskScheduler.reconcile")(function* () {
      const orphaned = yield* tasks.pendingRuns()
      for (const run of orphaned) {
        yield* tasks.finishRun({ runID: run.id, ended_at: Date.now(), error: "interrupted by restart" })
      }
    })
    yield* Effect.catchCause(reconcile(), (cause) => Effect.logError("task scheduler reconcile failed", { cause }))

    const fire = (task: Task.Info, started_at: number) =>
      Effect.gen(function* () {
        const runID = RunID.create()
        // Next fire is computed from the scheduled time so tick drift does not accumulate.
        const next = computeNext(task, started_at)

        // Resolve or lazily create the bound session inside the task's directory context.
        // The binding is persisted so every fire reuses the same session.
        const sessionID =
          task.sessionID ??
          (yield* instances.provide({ directory: task.directory }, sessions.create({ title: task.title }))).id
        if (task.sessionID !== sessionID) {
          yield* tasks.update(task.id, { sessionID })
        }

        // Busy session: count a skip and re-arm the schedule without consuming a run.
        // SessionStatus is instance-scoped, so the check must run in the directory context.
        const state = yield* instances.provide({ directory: task.directory }, status.get(sessionID))
        if (state.type === "busy") {
          yield* tasks.recordMissed([task.id], Date.now())
          if (next) yield* tasks.reschedule(task.id, next, Date.now())
          return "skipped-busy" as const
        }

      yield* tasks.startRun({ id: task.id, runID, sessionID, started_at, next })

      // The model run can take minutes; fork so ticks keep flowing. The fiber lives in
      // the layer scope and records the run outcome when the prompt settles.
      const errorMessage = (cause: Cause.Cause<unknown>): string | undefined => {
        const error = Cause.squash(cause)
        return error instanceof Error ? error.message : error === undefined ? undefined : String(error)
      }
      yield* instances
        .provide(
          { directory: task.directory },
          prompts.prompt({ sessionID, parts: [{ type: "text", text: task.prompt.text }] }),
        )
        .pipe(
          Effect.map(() => undefined),
          Effect.catchCause((cause) => Effect.succeed(errorMessage(cause))),
          Effect.flatMap((error) => tasks.finishRun({ runID, ended_at: Date.now(), error })),
          Effect.forkIn(scope),
          Effect.asVoid,
        )
      return "started" as const
      })

    const tick = Effect.fn("TaskScheduler.tick")(function* () {
      const now = Date.now()
      // Arm tasks that have no next fire (new, disarmed after invalid cron, or
      // unarmed while paused). Tasks stay disarmed until enabled.
      const all = yield* tasks.all()
      for (const task of all) {
        if (task.next_run_at !== undefined || !task.enabled) continue
        const next = computeNext(task, now)
        if (next === undefined) continue
        yield* tasks
          .reschedule(task.id, next, now)
          .pipe(Effect.catchCause((cause) => Effect.logError("task arm failed", { task: task.id, cause })))
      }

      const due = yield* tasks.claimDue(now)
      for (const { task } of due) {
        yield* fire(task, now).pipe(
          Effect.catchCause((cause) => Effect.logError("task fire failed", { task: task.id, cause })),
        )
      }
      return due.length
    })

    yield* Effect.forkIn(tick().pipe(Effect.repeat(Schedule.spaced(TICK_INTERVAL)), Effect.ignore), scope)

    return Service.of({
      tick,
      run: (id) =>
        Effect.gen(function* () {
          const task = yield* tasks.get(id)
          if (!task) return
          yield* fire(task, Date.now()).pipe(
            Effect.catchCause((cause) => Effect.logError("manual task run failed", { task: id, cause })),
          )
        }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Task.node, Session.node, SessionStatus.node, SessionPrompt.node, InstanceStore.node],
})
