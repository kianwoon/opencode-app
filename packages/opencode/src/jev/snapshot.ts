/**
 * Auto-snapshot builder — lets jev_label run from a bare sessionID; the
 * snapshot is the exact enriched shape that passed the 2026-09-25 A/B live gate.
 */
import { Database } from "bun:sqlite"
import {
  computeRepetitionScore,
  computeTodoChurn,
  extractTemporalFeatures,
  type PromptRow,
} from "./features"

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

const MS_PER_HOUR = 3_600_000

export interface SessionSnapshotBuild {
  readonly sessionID: string
  readonly title: string
  readonly snapshot: string
}

export function buildSessionSnapshot(dbPath: string, sessionID: string): SessionSnapshotBuild | null {
  const database = new Database(dbPath, { readonly: true })
  try {
    const session = database
      .query(
        `SELECT title, time_created, time_updated, cost, tokens_input, tokens_output,
                tokens_cache_read, tokens_cache_write
           FROM session
          WHERE id = ?
          LIMIT 1`,
      )
      .get(sessionID) as SessionRow | undefined
    if (!session) return null

    const prompts = database
      .query(
        `SELECT m.time_created AS time,
                COALESCE(GROUP_CONCAT(CASE WHEN json_extract(p.data, '$.type') = 'text'
                                            THEN json_extract(p.data, '$.text') END, ' '), '') AS text
           FROM message m
           LEFT JOIN part p ON p.message_id = m.id
          WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
          GROUP BY m.id, m.time_created
          ORDER BY m.time_created`,
      )
      .all(sessionID) as PromptRow[]
    const toolRows = database
      .query(
        `SELECT json_extract(data, '$.tool') AS tool, count(*) AS count
           FROM part
          WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
            AND json_extract(data, '$.tool') IS NOT NULL
          GROUP BY json_extract(data, '$.tool')`,
      )
      .all(sessionID) as ToolCountRow[]
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
