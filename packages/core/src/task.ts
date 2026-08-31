export * as Task from "./task"

import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Task } from "@opencode-ai/schema/task"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { TaskRunTable, TaskTable } from "./task/sql"

export const ID = Task.ID
export type ID = Task.ID
export const RunID = Task.RunID
export type RunID = Task.RunID
export const Info = Task.Info
export type Info = Task.Info
export const Run = Task.Run
export type Run = Task.Run
export const CreateInput = Task.CreateInput
export type CreateInput = Task.CreateInput
export const UpdateInput = Task.UpdateInput
export type UpdateInput = Task.UpdateInput
export const Event = Task.Event

const decodeInfo = Schema.decodeUnknownSync(Info)

type Row = typeof TaskTable.$inferSelect
type RunRow = typeof TaskRunTable.$inferSelect

const fromRow = (row: Row): Task.Info =>
  decodeInfo({
    id: row.id,
    title: row.title,
    prompt: { text: row.prompt },
    cron: row.cron,
    enabled: row.enabled,
    ...(row.session_id ? { sessionID: row.session_id } : {}),
    directory: AbsolutePath.make(row.directory),
    ...(row.next_run_at != null ? { next_run_at: row.next_run_at } : {}),
    ...(row.last_run_at != null ? { last_run_at: row.last_run_at } : {}),
    missed_runs: row.missed_runs,
    run_count: row.run_count,
    time_created: row.time_created,
    time_updated: row.time_updated,
  })

const runFromRow = (row: RunRow): Task.Run => ({
  id: row.id,
  taskID: row.task_id,
  sessionID: row.session_id,
  status: row.status,
  started_at: row.started_at,
  ...(row.ended_at != null ? { ended_at: row.ended_at } : {}),
  ...(row.error ? { error: row.error } : {}),
})

export interface ClaimedTask {
  readonly task: Task.Info
}

export interface Interface {
  /** Returns every task, oldest first. */
  readonly all: () => Effect.Effect<Task.Info[]>
  /** Returns one task by ID. */
  readonly get: (id: ID) => Effect.Effect<Task.Info | undefined>
  /** Creates a task and schedules its first fire. */
  readonly create: (input: CreateInput) => Effect.Effect<Task.Info>
  /** Updates mutable task fields and reschedules when the cron changes. */
  readonly update: (id: ID, updates: UpdateInput) => Effect.Effect<Task.Info | undefined>
  /** Removes a task and its run history. */
  readonly remove: (id: ID) => Effect.Effect<void>
  /**
   * Atomically claims every enabled task whose `next_run_at` is due at or before `now`.
   * A task claimed by one process cannot be claimed again until it is rescheduled,
   * which is what prevents double-firing across concurrent server processes.
   */
  readonly claimDue: (now: number) => Effect.Effect<ClaimedTask[]>
  /**
   * Marks a claimed fire as started, records the run row, and advances the schedule.
   * `next` is the recomputed next fire time; pass `undefined` when the task should idle (paused).
   */
  readonly startRun: (input: {
    readonly id: ID
    readonly runID: RunID
    readonly sessionID: Task.Run["sessionID"]
    readonly started_at: number
    readonly next: number | undefined
  }) => Effect.Effect<Task.Info | undefined>
  /** Marks a run finished. `error` present means the run failed. */
  readonly finishRun: (input: {
    readonly runID: RunID
    readonly ended_at: number
    readonly error?: string
  }) => Effect.Effect<void>
  /** Increments the missed-fire counter for tasks that were due while no process was awake. */
  readonly recordMissed: (ids: ID[], now: number) => Effect.Effect<void>
  /** Returns recent runs for a task, newest first. */
  readonly runs: (id: ID, limit?: number) => Effect.Effect<Task.Run[]>
  /** Returns the claimed run for a task, if any. Used by the scheduler to detect restarts. */
  readonly pendingRuns: () => Effect.Effect<Task.Run[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Task") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const publishUpdated = (task: Task.Info) =>
      events.publish(Event.Updated, { task }, { location: { directory: task.directory } }).pipe(Effect.asVoid)

    const publishRemoved = (id: ID, directory: Task.Info["directory"]) =>
      events.publish(Event.Removed, { taskID: id }, { location: { directory } }).pipe(Effect.asVoid)

    const create = Effect.fn("Task.create")(function* (input: CreateInput) {
      const now = Date.now()
      const id = ID.create()
      const row: Row = {
        id,
        title: input.title,
        prompt: input.prompt.text,
        cron: input.cron,
        enabled: input.enabled ?? true,
        session_id: input.sessionID,
        directory: input.directory,
        next_run_at: null,
        last_run_at: null,
        missed_runs: 0,
        run_count: 0,
        time_created: now,
        time_updated: now,
      }
      yield* db.insert(TaskTable).values(row).run().pipe(Effect.orDie)
      const task = fromRow(row)
      yield* publishUpdated(task)
      return task
    })

    const update = Effect.fn("Task.update")(function* (id: ID, updates: UpdateInput) {
      const current = yield* get(id)
      if (!current) return undefined
      const next: Row = {
        id: current.id,
        title: updates.title ?? current.title,
        prompt: updates.prompt?.text ?? current.prompt.text,
        cron: updates.cron ?? current.cron,
        enabled: updates.enabled ?? current.enabled,
        session_id: current.sessionID,
        directory: updates.directory ?? current.directory,
        next_run_at: null,
        last_run_at: current.last_run_at ?? null,
        missed_runs: current.missed_runs,
        run_count: current.run_count,
        time_created: current.time_created,
        time_updated: Date.now(),
      }
      yield* db.update(TaskTable).set(next).where(eq(TaskTable.id, id)).run().pipe(Effect.orDie)
      const task = fromRow(next)
      yield* publishUpdated(task)
      return task
    })

    const remove = Effect.fn("Task.remove")(function* (id: ID) {
      const current = yield* get(id)
      if (!current) return
      yield* db.delete(TaskTable).where(eq(TaskTable.id, id)).run().pipe(Effect.orDie)
      yield* publishRemoved(id, current.directory)
    })

    const get = Effect.fn("Task.get")(function* (id: ID) {
      const row = yield* db.select().from(TaskTable).where(eq(TaskTable.id, id)).get().pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const all = Effect.fn("Task.all")(function* () {
      const rows = yield* db.select().from(TaskTable).orderBy(asc(TaskTable.time_created)).all().pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const claimDue = Effect.fn("Task.claimDue")(function* (now: number) {
      const claimed: ClaimedTask[] = []
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* tx
              .select()
              .from(TaskTable)
              .where(
                and(
                  eq(TaskTable.enabled, true),
                  isNotNull(TaskTable.next_run_at),
                  lte(TaskTable.next_run_at, now),
                ),
              )
              .orderBy(asc(TaskTable.next_run_at))
              .all()
              .pipe(Effect.orDie)
            // Clearing next_run_at inside the same transaction is the claim: a concurrent
            // process running the same WHERE clause sees the rows only before this commits.
            for (const row of rows) {
              yield* tx
                .update(TaskTable)
                .set({ next_run_at: null, time_updated: now })
                .where(eq(TaskTable.id, row.id))
                .run()
                .pipe(Effect.orDie)
              claimed.push({ task: fromRow(row) })
            }
          }),
        )
        .pipe(Effect.orDie)
      return claimed
    })

    const startRun = Effect.fn("Task.startRun")(function* (input: {
      readonly id: ID
      readonly runID: RunID
      readonly sessionID: Task.Run["sessionID"]
      readonly started_at: number
      readonly next: number | undefined
    }) {
      let task: Task.Info | undefined
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx.select().from(TaskTable).where(eq(TaskTable.id, input.id)).get().pipe(Effect.orDie)
            if (!row) return
            yield* tx
              .insert(TaskRunTable)
              .values({
                id: input.runID,
                task_id: input.id,
                session_id: input.sessionID,
                status: "running",
                started_at: input.started_at,
              })
              .run()
              .pipe(Effect.orDie)
            const updated: Row = {
              ...row,
              next_run_at: input.next ?? null,
              last_run_at: input.started_at,
              run_count: row.run_count + 1,
              time_updated: input.started_at,
            }
            yield* tx.update(TaskTable).set(updated).where(eq(TaskTable.id, input.id)).run().pipe(Effect.orDie)
            task = fromRow(updated)
          }),
        )
        .pipe(Effect.orDie)
      if (task) yield* publishUpdated(task)
      return task
    })

    const finishRun = Effect.fn("Task.finishRun")(function* (input: {
      readonly runID: RunID
      readonly ended_at: number
      readonly error?: string
    }) {
      yield* db
        .update(TaskRunTable)
        .set({ status: input.error ? "failed" : "completed", ended_at: input.ended_at, error: input.error })
        .where(eq(TaskRunTable.id, input.runID))
        .run()
        .pipe(Effect.orDie)
    })

    const recordMissed = Effect.fn("Task.recordMissed")(function* (ids: ID[], now: number) {
      if (ids.length === 0) return
      yield* db
        .update(TaskTable)
        .set({ missed_runs: sql`${TaskTable.missed_runs} + 1`, time_updated: now })
        .where(
          and(
            eq(TaskTable.enabled, true),
            isNotNull(TaskTable.next_run_at),
            lte(TaskTable.next_run_at, now),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const runs = Effect.fn("Task.runs")(function* (id: ID, limit = 50) {
      const rows = yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.task_id, id))
        .orderBy(desc(TaskRunTable.started_at))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows.map(runFromRow)
    })

    const pendingRuns = Effect.fn("Task.pendingRuns")(function* () {
      const rows = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.status, "running")).all().pipe(
        Effect.orDie,
      )
      return rows.map(runFromRow)
    })

    return Service.of({
      all,
      get,
      create,
      update,
      remove,
      claimDue,
      startRun,
      finishRun,
      recordMissed,
      runs,
      pendingRuns,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
