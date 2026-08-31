import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { Task } from "@opencode-ai/schema/task"

// session_id is deliberately not a foreign key: V2 sessions are event-sourced and
// the projector may populate the session table after a task binds one, and a task
// must stay readable even if its bound session was hard-deleted.
export const TaskTable = sqliteTable(
  "task",
  {
    id: text().$type<Task.ID>().primaryKey(),
    title: text().notNull(),
    prompt: text().notNull(),
    cron: text().notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    session_id: text().$type<Task.Info["sessionID"]>(),
    directory: text().notNull(),
    next_run_at: integer(),
    last_run_at: integer(),
    missed_runs: integer().notNull().default(0),
    run_count: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [index("task_next_run_idx").on(table.next_run_at), index("task_directory_idx").on(table.directory)],
)

export const TaskRunTable = sqliteTable(
  "task_run",
  {
    id: text().$type<Task.RunID>().primaryKey(),
    task_id: text()
      .$type<Task.ID>()
      .notNull()
      .references(() => TaskTable.id, { onDelete: "cascade" }),
    session_id: text().$type<Task.Run["sessionID"]>().notNull(),
    status: text().$type<Task.RunStatus>().notNull(),
    started_at: integer().notNull(),
    ended_at: integer(),
    error: text(),
  },
  (table) => [index("task_run_task_started_idx").on(table.task_id, table.started_at)],
)
