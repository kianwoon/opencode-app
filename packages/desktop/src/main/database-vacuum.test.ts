import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("waits for an active writer before vacuuming", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-vacuum-test-"))
  const path = join(dir, "opencode.db")
  const script = String.raw`
    import { rmSync } from "node:fs"
    import { dirname } from "node:path"
    import { DatabaseSync } from "node:sqlite"
    import { vacuumDatabase } from "./src/main/database-vacuum.ts"

    const dbPath = process.argv[1]
    const writer = new DatabaseSync(dbPath)
    let transactionOpen = false
    let releaseTimer

    try {
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);")
      writer.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (2);")
      transactionOpen = true
      releaseTimer = setTimeout(() => {
        if (transactionOpen) {
          writer.exec("ROLLBACK")
          transactionOpen = false
        }
      }, 100)

      const result = await vacuumDatabase(dbPath)
      process.stdout.write(JSON.stringify(result))
    } finally {
      if (releaseTimer) clearTimeout(releaseTimer)
      try {
        if (transactionOpen) writer.exec("ROLLBACK")
      } finally {
        try {
          writer.close()
        } finally {
          rmSync(dirname(dbPath), { recursive: true, force: true })
        }
      }
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

    if (exitCode !== 0) {
      throw new Error(`Node harness failed (${exitCode}): ${stderr || stdout}`)
    }

    const result = JSON.parse(stdout) as { before: number; after: number }
    expect(result.before).toBeGreaterThan(0)
    expect(result.after).toBeGreaterThan(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
