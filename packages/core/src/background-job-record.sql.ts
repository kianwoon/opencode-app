import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Durable lifecycle record for background jobs. The in-memory BackgroundJob
 * registry remains the live-work authority (fibers, Deferreds, scopes); this
 * table persists status transitions best-effort so a restart can show what
 * was running and mark stale entries interrupted.
 */
export const BackgroundJobTable = sqliteTable("background_job", {
  id: text().primaryKey(),
  type: text().notNull(),
  title: text(),
  status: text().notNull(),
  started_at: integer().notNull(),
  completed_at: integer(),
  output: text(),
  error: text(),
  metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
})
