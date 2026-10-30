/**
 * Auto-snapshot builder — lets jev_label run from a bare sessionID; the
 * snapshot is the exact enriched shape that passed the 2026-09-25 A/B live gate.
 */
import {
  computeRepetitionScore,
  computeTodoChurn,
  extractRecencyFeatures,
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

interface CountRow {
  readonly n: number
}

interface TimeRow {
  readonly time: number
}

type SqlBindings = readonly (string | number)[]

interface DatabaseAccessor {
  readonly all: (sql: string, bindings: SqlBindings) => unknown[]
  readonly get: (sql: string, bindings: SqlBindings) => unknown
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

// The feature array is a RECENT WINDOW, not the whole session: the time-series
// features describe current activity, and an unbounded GROUP_CONCAT over a
// 600k-token session materialises every user message into memory. Session-wide
// facts (prompt_count, the todo_churn denominator) must NOT read from it.
const SNAPSHOT_PROMPTS_MAX = 200

export async function buildSessionSnapshot(dbPath: string, sessionID: string): Promise<SessionSnapshotBuild | null> {
  // A missing, corrupt, locked or unwritable DB is a normal "no snapshot"
  // outcome, not a throw — callers cannot tell a broken DB from an absent one.
  try {
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
          ORDER BY m.time_created DESC
          LIMIT ?`,
        [sessionID, SNAPSHOT_PROMPTS_MAX],
      ) as PromptRow[]
      prompts.reverse()

      // Unbounded on purpose: a narrow integer column with no text, no join and
      // no GROUP_CONCAT cannot reproduce the blowup the 200-row window exists to
      // prevent, and the span/idle features must describe the WHOLE session.
      // Do NOT add a LIMIT here — that reintroduces the windowed-metric bug.
      const times = (
        database.all(
          `SELECT m.time_created AS time
             FROM message m
            WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
            ORDER BY m.time_created`,
          [sessionID],
        ) as TimeRow[]
      ).map((row) => row.time)

      // Exact session-wide user-message count, independent of the window above.
      const totalRow = database.get(
        `SELECT count(*) AS n
           FROM message
          WHERE session_id = ? AND json_extract(data, '$.role') = 'user'`,
        [sessionID],
      ) as CountRow | undefined
      const promptCount = totalRow?.n ?? 0

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
      const temporal = extractTemporalFeatures(session.time_created, session.time_updated, times)
      const recency = extractRecencyFeatures(session.time_updated, prompts, 60)
      // Recency keys separate user-absence gaps from mid-work stalls.
      const snapshot = JSON.stringify({
        title,
        duration_hours: (session.time_updated - session.time_created) / MS_PER_HOUR,
        prompt_count: promptCount,
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
        trailing_idle_hours: recency.trailing_idle_hours,
        recent_prompts: recency.recent_prompts,
        recent_repetition_score: recency.recent_repetition_score,
        // Window-scoped by design — see SNAPSHOT_PROMPTS_MAX above.
        repetition_score: computeRepetitionScore(prompts.map((prompt) => prompt.text)),
        todo_churn: computeTodoChurn(toolCounts, promptCount),
      })
      return { sessionID, title, snapshot }
    } finally {
      try {
        database.close()
      } catch {
        // A throwing close must not discard an already-built snapshot.
      }
    }
  } catch {
    return null
  }
}
