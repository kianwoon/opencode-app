import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSessionSnapshot } from "../../src/jev/snapshot"

const directory = mkdtempSync(join(tmpdir(), "jev-snapshot-"))
const dbPath = join(directory, "fixture.db")

const userMessages = [
  { id: "msg_1", time: 0, text: "fix the failing test" },
  { id: "msg_2", time: 600_000, text: "fix the failing test" },
  { id: "msg_3", time: 3_600_000, text: "fix the failing test and add docs" },
  { id: "msg_4", time: 7_200_000, text: "fix the failing test and add cli docs" },
]

beforeAll(() => {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY,
      parent_id text,
      title text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      cost real NOT NULL,
      tokens_input integer NOT NULL,
      tokens_output integer NOT NULL,
      tokens_cache_read integer NOT NULL,
      tokens_cache_write integer NOT NULL
    );
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      data text NOT NULL
    );
  `)
  db.run(
    "INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["ses_fix", null, "Fixture", 0, 7_200_000, 0.5, 1000, 100, 2000, 0],
  )
  userMessages.forEach((message) => {
    db.run("INSERT INTO message VALUES (?, ?, ?, ?)", [message.id, "ses_fix", message.time, JSON.stringify({ role: "user" })])
    db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?)", [
      `part_${message.id}`,
      message.id,
      "ses_fix",
      message.time,
      JSON.stringify({ type: "text", text: message.text }),
    ])
  })
  const tools = ["todowrite", "todowrite", "read", "read", "read", "read", "read"]
  tools.forEach((tool, index) => {
    db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?)", [
      `part_tool_${index + 1}`,
      "msg_1",
      "ses_fix",
      index + 1,
      JSON.stringify({ type: "tool", tool }),
    ])
  })
  db.close()
})

afterAll(() => {
  unlinkSync(dbPath)
  rmdirSync(directory)
})

describe("buildSessionSnapshot", () => {
  test("returns enriched temporal features and session identity", async () => {
    const built = await buildSessionSnapshot(dbPath, "ses_fix")
    expect(built).not.toBeNull()
    expect(built?.sessionID).toBe("ses_fix")
    expect(built?.title).toBe("Fixture")
    const snapshot = JSON.parse(built?.snapshot ?? "{}") as Record<string, unknown>
    expect(snapshot["wall_hours"]).toBeCloseTo(2)
    expect(snapshot["max_idle_hours"]).toBeCloseTo(1)
    expect(snapshot["idle_ratio"]).toBeCloseTo(0.5)
    expect(snapshot["prompt_count"]).toBe(4)
  })

  test("returns null for an unknown session", async () => {
    expect(await buildSessionSnapshot(dbPath, "missing")).toBeNull()
  })

  test("includes near-identical prompt repetition", async () => {
    const built = await buildSessionSnapshot(dbPath, "ses_fix")
    const snapshot = JSON.parse(built?.snapshot ?? "{}") as Record<string, unknown>
    expect(snapshot["repetition_score"]).toBeGreaterThanOrEqual(0.5)
  })

  test("includes todo churn", async () => {
    const built = await buildSessionSnapshot(dbPath, "ses_fix")
    const snapshot = JSON.parse(built?.snapshot ?? "{}") as Record<string, unknown>
    expect(snapshot["todo_churn"]).toBe(0.5)
  })

  test("preserves token aggregates, cost, and output-input ratio", async () => {
    const built = await buildSessionSnapshot(dbPath, "ses_fix")
    const snapshot = JSON.parse(built?.snapshot ?? "{}") as Record<string, unknown>
    expect(snapshot["tokens"]).toEqual({ input: 1000, output: 100, cache_read: 2000, cache_write: 0 })
    expect(snapshot["cost"]).toBe(0.5)
    expect(snapshot["output_input_ratio"]).toBeCloseTo(0.1)
  })

  test("emits all twelve enriched snapshot keys", async () => {
    const built = await buildSessionSnapshot(dbPath, "ses_fix")
    const snapshot = JSON.parse(built?.snapshot ?? "{}") as Record<string, unknown>
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "title",
        "duration_hours",
        "prompt_count",
        "tokens",
        "cost",
        "output_input_ratio",
        "wall_hours",
        "active_span_hours",
        "max_idle_hours",
        "idle_ratio",
        "repetition_score",
        "todo_churn",
      ].sort(),
    )
  })
})
