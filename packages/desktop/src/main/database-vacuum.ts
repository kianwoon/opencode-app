import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"

const SQLITE_COMMAND = "PRAGMA busy_timeout = 5000; VACUUM;"
const VACUUM_TIMEOUT_MS = 30_000

export async function vacuumDatabase(dbPath: string): Promise<{ before: number; after: number }> {
  const beforeStats = await stat(dbPath).catch(() => undefined)
  const before = beforeStats?.size ?? 0
  if (before === 0) return { before: 0, after: 0 }

  await new Promise<void>((resolve, reject) => {
    execFile(
      "sqlite3",
      [dbPath, SQLITE_COMMAND],
      { timeout: VACUUM_TIMEOUT_MS, killSignal: "SIGKILL" },
      (err) => (err ? reject(err) : resolve()),
    )
  })

  const afterStats = await stat(dbPath).catch(() => undefined)
  const after = afterStats?.size ?? 0
  return { before, after }
}
