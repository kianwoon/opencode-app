// baseline-guard:allow fork-owned tables restored from removed v2 core schema; migrations remain authoritative
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

import type { SessionID } from "./schema"

// Local definitions for fork-owned tables that were dropped from the upstream
// core schema during the v2 merge. The migrations still create these tables.
export const FollowupTable = sqliteTable(
  "session_followup",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull(),
    admitted_seq: integer().notNull(),
    deliver_at: integer().notNull(),
    promoted_seq: integer(),
    payload: text({ mode: "json" }).notNull().$type<{ messageID: string; text: string }>(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_followup_session_promoted_deliver_idx").on(table.session_id, table.promoted_seq, table.deliver_at),
  ],
)

export const SessionStableHeadTable = sqliteTable("session_stable_head", {
  session_id: text().$type<SessionID>().primaryKey(),
  system: text({ mode: "json" }).notNull().$type<string[]>(),
  tools: text({ mode: "json" }).notNull().$type<string[]>(),
  seen: text({ mode: "json" }).notNull().$type<string[]>().default([]),
  time_created: integer().notNull(),
})

export const WorkflowAttemptTable = sqliteTable("workflow_attempt", {
  part_id: text().primaryKey(),
  attempts: integer().notNull(),
  time_updated: integer().notNull(),
})

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text().$type<SessionID>().notNull(),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.position] }), index("todo_session_idx").on(table.session_id)],
)
