/**
 * Auto-snapshot builder — lets jev_label run from a bare sessionID; the
 * snapshot is the exact enriched shape that passed the 2026-09-25 A/B live gate.
 */
import {
  computeRepetitionScore,
  computeTodoChurn,
  extractTemporalFeatures,
  type PromptRow,
} from "./features.ts"

interface SessionRow {
  readonly title: string
  readonly time_created: number
  readonly time_updated: number
  readonly cost: number
  readonly tokens_input: number
  readonly tokens_output: number
  readonly tokens_cache_read: number
  readonly tokens_cache_write: number
}

interface ToolCountRow {
  readonly tool: string | null
  readonly count: number
}

type SessionIDBindings = readonly string[]

interface DatabaseAccessor {
  readonly all: (sql: string, bindings: SessionIDBindings) => unknown[]
  readonly get: (sql: string, bindings: SessionIDBindings) => unknown
  readonly close: () => void
}

const MS_PER_HOUR = 3_600_000

export interface SessionSnapshotBuild {
  readonly sessionID: string
  readonly title: string
  readonly snapshot: string
}

async function openDatabase(dbPath: string): Promise<DatabaseAccessor> {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite")
    const database = new Database(dbPath, { readonly: true })
    return {
      all: (sql, bindings) => database.query(sql).all(...bindings),
      get: (sql, bindings) => database.query(sql).get(...bindings),
      close: () => database.close(),
    }
  }

  const { DatabaseSync } = await import("node:sqlite")
  const database = new DatabaseSync(dbPath, { readOnly: true })
  return {
    all: (sql, bindings) => database.prepare(sql).all(...bindings),
    get: (sql, bindings) => database.prepare(sql).get(...bindings),
    close: () => database.close(),
  }
}

export async function buildSessionSnapshot(dbPath: string, sessionID: string): Promise<SessionSnapshotBuild | null> {
  const database = await openDatabase(dbPath)
  try {
    const session = database.get(
      `SELECT title, time_created, time_updated, cost, tokens_input, tokens_output,
              tokens_cache_read, tokens_cache_write
         FROM session
        WHERE id = ?
        LIMIT 1`,
      [sessionID],
    ) as SessionRow | undefined
    if (!session) return null

    const prompts = database.all(
      `SELECT m.time_created AS time,
              COALESCE(GROUP_CONCAT(CASE WHEN json_extract(p.data, '$.type') = 'text'
                                          THEN json_extract(p.data, '$.text') END, ' '), '') AS text
         FROM message m
         LEFT JOIN part p ON p.message_id = m.id
        WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
        GROUP BY m.id, m.time_created
        ORDER BY m.time_created`,
      [sessionID],
    ) as PromptRow[]
    const toolRows = database.all(
      `SELECT json_extract(data, '$.tool') AS tool, count(*) AS count
         FROM part
        WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
          AND json_extract(data, '$.tool') IS NOT NULL
        GROUP BY json_extract(data, '$.tool')`,
      [sessionID],
    ) as ToolCountRow[]
    const toolCounts = Object.fromEntries(
      toolRows.filter((row) => row.tool !== null).map((row) => [row.tool!, row.count]),
    ) as Record<string, number>
    const title = session.title.slice(0, 80)
    const temporal = extractTemporalFeatures(session.time_created, session.time_updated, prompts)
    const snapshot = JSON.stringify({
      title,
      duration_hours: (session.time_updated - session.time_created) / MS_PER_HOUR,
      prompt_count: prompts.length,
      tokens: {
        input: session.tokens_input,
        output: session.tokens_output,
        cache_read: session.tokens_cache_read,
        cache_write: session.tokens_cache_write,
      },
      cost: session.cost,
      output_input_ratio: session.tokens_input === 0 ? 0 : session.tokens_output / session.tokens_input,
      wall_hours: temporal.wall_hours,
      active_span_hours: temporal.active_span_hours,
      max_idle_hours: temporal.max_idle_hours,
      idle_ratio: temporal.idle_ratio,
      repetition_score: computeRepetitionScore(prompts.map((prompt) => prompt.text)),
      todo_churn: computeTodoChurn(toolCounts, prompts.length),
    })
    return { sessionID, title, snapshot }
  } finally {
    database.close()
  }
}
