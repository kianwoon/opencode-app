// baseline-guard:allow new file, no prior baseline exists
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DAY_MS = 86_400_000

test("prunes sessions outside the retention window with their children", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-housekeep-test-"))
  const path = join(dir, "opencode.db")
  const script = String.raw`
    import { rmSync } from "node:fs"
    import { dirname } from "node:path"
    import { DatabaseSync } from "node:sqlite"
    import { housekeepDatabase } from "./src/main/database-housekeep.ts"

    const dbPath = process.argv[1]
    const DAY_MS = 86400000
    const now = Date.now()
    const db = new DatabaseSync(dbPath)

    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
      db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL);")
      db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE);")
      db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE);")

      const recent = "ses_recent"
      const stale = "ses_stale"
      db.prepare("INSERT INTO session (id, time_updated) VALUES (?, ?)").run(recent, now)
      db.prepare("INSERT INTO session (id, time_updated) VALUES (?, ?)").run(stale, now - 20 * DAY_MS)
      for (const id of [recent, stale]) {
        db.prepare("INSERT INTO message (id, session_id) VALUES (?, ?)").run("msg_" + id, id)
        db.prepare("INSERT INTO part (id, message_id) VALUES (?, ?)").run("part_" + id, "msg_" + id)
      }

      const result = await housekeepDatabase(dbPath, 10)
      const sessions = db.prepare("SELECT id FROM session ORDER BY id").all().map((row) => row.id)
      const parts = db.prepare("SELECT id FROM part ORDER BY id").all().map((row) => row.id)
      const invalid = await housekeepDatabase(dbPath, 0).then(
        () => "accepted",
        () => "rejected",
      )
      const afterInvalid = db.prepare("SELECT count(*) AS n FROM session").get().n

      process.stdout.write(JSON.stringify({ result, sessions, parts, invalid, afterInvalid }))
    } finally {
      db.close()
      rmSync(dirname(dbPath), { recursive: true, force: true })
    }
  `

  try {
    const child = Bun.spawn(["node", "--input-type=module", "-e", script, path], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    if (exitCode !== 0) throw new Error(`Node harness failed (${exitCode}): ${stderr || stdout}`)

    const out = JSON.parse(stdout) as {
      result: { before: number; after: number; pruned: number }
      sessions: string[]
      parts: string[]
      invalid: string
      afterInvalid: number
    }

    expect(out.result.pruned).toBe(1)
    expect(out.result.before).toBeGreaterThan(0)
    expect(out.sessions).toEqual(["ses_recent"])
    expect(out.parts).toEqual(["part_ses_recent"])
    expect(out.invalid).toBe("rejected")
    expect(out.afterInvalid).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
