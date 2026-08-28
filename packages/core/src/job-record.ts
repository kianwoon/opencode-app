export * as JobRecord from "./job-record"

import { desc, eq, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "./database/database"
import { BackgroundJobTable } from "./background-job-record.sql"
import type { Status } from "./background-job"

type Row = typeof BackgroundJobTable.$inferSelect

type RecordedInfo = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

const fromRow = (row: Row): RecordedInfo => ({
  id: row.id,
  type: row.type,
  ...(row.title === null ? {} : { title: row.title }),
  status: row.status as Status,
  started_at: row.started_at,
  ...(row.completed_at === null ? {} : { completed_at: row.completed_at }),
  ...(row.output === null ? {} : { output: row.output }),
  ...(row.error === null ? {} : { error: row.error }),
  ...(row.metadata === null ? {} : { metadata: row.metadata }),
})

/**
 * Durable lifecycle records for background jobs. Best-effort by contract:
 * every writer swallows failures so the record can never break live work.
 * The in-memory registry stays the live-work authority; this slice makes
 * job status survive a restart (stale running rows sweep to "cancelled").
 */
export type Ops = {
  record: (info: RecordedInfo) => Effect.Effect<void, never, Database.Service>
  get: (id: string) => Effect.Effect<RecordedInfo | undefined, never, Database.Service>
  list: () => Effect.Effect<RecordedInfo[], never, Database.Service>
  sweepStale: () => Effect.Effect<string[], never, Database.Service>
}

export type BoundOps = {
  record: (info: RecordedInfo) => Effect.Effect<void>
  get: (id: string) => Effect.Effect<RecordedInfo | undefined>
  list: () => Effect.Effect<RecordedInfo[]>
  sweepStale: () => Effect.Effect<string[]>
}

export const ops: Ops = {
  /**
   * Insert or overwrite the record for one job. Status transitions are
   * serialized: a "running" record never overwrites a terminal row (guards
   * against a slow start-record landing after the completion-record from a
   * different fiber). Preserve-on-update keeps fields written by earlier
   * transitions (title/metadata from start, output from completion).
   */
  record: (info) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(BackgroundJobTable)
        .values({
          id: info.id,
          type: info.type,
          title: info.title ?? null,
          status: info.status,
          started_at: info.started_at,
          completed_at: info.completed_at ?? null,
          output: info.output ?? null,
          error: info.error ?? null,
          metadata: info.metadata ?? null,
        })
        .onConflictDoUpdate({
          target: BackgroundJobTable.id,
          set: {
            status: sql`CASE WHEN ${BackgroundJobTable.status} = 'running' OR ${info.status} <> 'running' THEN ${info.status} ELSE ${BackgroundJobTable.status} END`,
            ...(info.completed_at !== undefined ? { completed_at: info.completed_at } : {}),
            ...(info.output !== undefined ? { output: info.output } : {}),
            ...(info.error !== undefined ? { error: info.error } : {}),
          },
        })
        .run()
        .pipe(Effect.orElseSucceed(() => undefined))
    }).pipe(Effect.asVoid),

  get: (id: string) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const row = yield* db.select().from(BackgroundJobTable).where(eq(BackgroundJobTable.id, id)).get()
      return row ? fromRow(row) : undefined
    }).pipe(Effect.orElseSucceed(() => undefined)),

  list: () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const rows = yield* db.select().from(BackgroundJobTable).orderBy(desc(BackgroundJobTable.started_at)).limit(200)
      return rows.map(fromRow)
    }).pipe(Effect.orElseSucceed(() => [] as RecordedInfo[])),

  /**
   * Startup sweep: rows still "running" belong to a dead process. Mark them
   * cancelled so list/get never report ghost work. Returns swept ids.
   */
  sweepStale: () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const stale = yield* db
        .select({ id: BackgroundJobTable.id })
        .from(BackgroundJobTable)
        .where(eq(BackgroundJobTable.status, "running"))
      if (stale.length === 0) return [] as string[]
      const ids = stale.map((row) => row.id)
      yield* db
        .update(BackgroundJobTable)
        .set({ status: "cancelled", completed_at: Date.now(), error: "interrupted by restart" })
        .where(inArray(BackgroundJobTable.id, ids))
        .pipe(Effect.orElseSucceed(() => undefined))
      return ids
    }).pipe(Effect.orElseSucceed(() => [] as string[])),
}

/** Bind the ops to one database handle (no per-call service requirement). */
export const provided = (database: Database.Interface): BoundOps => {
  const bound = <A, E>(effect: Effect.Effect<A, E, Database.Service>): Effect.Effect<A, E> =>
    effect.pipe(Effect.provideService(Database.Service, database))
  return {
    record: (info) => bound(ops.record(info)),
    get: (id) => bound(ops.get(id)),
    list: () => bound(ops.list()),
    sweepStale: () => bound(ops.sweepStale()),
  }
}
