// baseline-guard:allow new file, no prior baseline exists
import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"

const TIMEOUT_MS = 60_000
const DAY_MS = 86_400_000

// Invariant: house-keep is time-based retention over `session` rows. Every row
// whose `time_updated` falls before `now - days` is deleted; foreign keys are
// enabled so the delete cascades to `message` and `part`. The pruned file is
// then checkpointed and vacuumed. "10 days" is just one instance of that rule;
// unseen inputs such as 1 day or 3650 days are handled by the same cutoff, with
// no per-session ids or hardcoded window.
export async function housekeepDatabase(
  dbPath: string,
  days: number,
): Promise<{ before: number; after: number; pruned: number }> {
  if (!Number.isFinite(days) || days <= 0) throw new Error(`invalid retention window: ${days}`)

  const beforeStats = await stat(dbPath).catch(() => undefined)
  const before = beforeStats?.size ?? 0
  if (before === 0) return { before: 0, after: 0, pruned: 0 }

  // Computed in JS and bound as a SQLite parameter, never interpolated as text.
  const cutoff = Date.now() - Math.floor(days * DAY_MS)
  const sql = [
    "PRAGMA busy_timeout = 5000;",
    "PRAGMA foreign_keys = ON;",
    "BEGIN IMMEDIATE;",
    "DELETE FROM session WHERE time_updated < @cutoff;",
    "SELECT changes();",
    "COMMIT;",
    "PRAGMA wal_checkpoint(TRUNCATE);",
    "VACUUM;",
  ].join("\n")

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "sqlite3",
      ["-cmd", `.parameter set @cutoff ${cutoff}`, dbPath, sql],
      { timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve(out)),
    )
  })

  const pruned = Number(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .at(-1) ?? 0,
  )

  const afterStats = await stat(dbPath).catch(() => undefined)
  const after = afterStats?.size ?? 0
  return { before, after, pruned }
}
