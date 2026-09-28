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
    expect(snapshot["trailing_idle_hours"]).toBe(0)
    expect(snapshot["recent_prompts"]).toBe(2)
    expect(snapshot["recent_repetition_score"]).toBeGreaterThanOrEqual(0.5)
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

  test("counts prompts session-wide, not through the 200-message window", async () => {
    // Regression: prompt_count and the todo_churn denominator must be exact
    // session-wide totals. The prompts array is a capped recent window.
    const database = new Database(dbPath)
    database.run("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      "ses_big",
      null,
      "Big",
      0,
      7_200_000,
      0.5,
      1000,
      100,
      2000,
      0,
    ])
    for (let index = 0; index < 201; index++)
      database.run("INSERT INTO message VALUES (?, ?, ?, ?)", [
        `msg_big_${index + 1}`,
        "ses_big",
        (index + 1) * 1_000,
        JSON.stringify({ role: "user" }),
      ])
    for (let index = 0; index < 2; index++)
      database.run("INSERT INTO part VALUES (?, ?, ?, ?, ?)", [
        `part_big_tool_${index + 1}`,
        "msg_big_1",
        "ses_big",
        index + 1,
        JSON.stringify({ type: "tool", tool: "todowrite" }),
      ])
    database.close()
    try {
      const built = await buildSessionSnapshot(dbPath, "ses_big")
      const snapshot = JSON.parse(built?.snapshot ?? "{}") as Record<string, unknown>
      expect(snapshot["prompt_count"]).toBe(201)
      // Precision 6 is mandatory: at the default 2, 2/201 and the buggy 2/200
      // both round to 0.01 and the assertion would pass against the bug.
      expect(snapshot["todo_churn"]).toBeCloseTo(2 / 201, 6)
    } finally {
      const cleanup = new Database(dbPath)
      cleanup.run("DELETE FROM part WHERE session_id = ?", ["ses_big"])
      cleanup.run("DELETE FROM message WHERE session_id = ?", ["ses_big"])
      cleanup.run("DELETE FROM session WHERE id = ?", ["ses_big"])
      cleanup.close()
    }
  })

  test("span and idle features read every user message, not the window", async () => {
    // The 200-row window drops index 0, so the 10h opening gap would vanish and
    // max_idle would read 0.0167. These assertions are the window regression.
    const database = new Database(dbPath)
    database.run("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      "ses_span",
      null,
      "Span",
      0,
      47_940_000,
      0.5,
      1000,
      100,
      2000,
      0,
    ])
    for (let index = 0; index < 201; index++) {
      const time = index === 0 ? 0 : index === 1 ? 36_000_000 : 36_000_000 + (index - 1) * 60_000
      database.run("INSERT INTO message VALUES (?, ?, ?, ?)", [
        `msg_span_${index + 1}`,
        "ses_span",
        time,
        JSON.stringify({ role: "user" }),
      ])
    }
    database.close()
    try {
      const built = await buildSessionSnapshot(dbPath, "ses_span")
      const snapshot = JSON.parse(built?.snapshot ?? "{}") as Record<string, unknown>
      expect(snapshot["max_idle_hours"]).toBeCloseTo(10, 6)
      expect(snapshot["active_span_hours"]).toBeCloseTo(47_940_000 / 3_600_000, 6)
      expect(snapshot["idle_ratio"]).toBeCloseTo(36_000_000 / 47_940_000, 6)
    } finally {
      const cleanup = new Database(dbPath)
      cleanup.run("DELETE FROM part WHERE session_id = ?", ["ses_span"])
      cleanup.run("DELETE FROM message WHERE session_id = ?", ["ses_span"])
      cleanup.run("DELETE FROM session WHERE id = ?", ["ses_span"])
      cleanup.close()
    }
  })

  test("preserves token aggregates, cost, and output-input ratio", async () => {
    const built = await buildSessionSnapshot(dbPath, "ses_fix")
    const snapshot = JSON.parse(built?.snapshot ?? "{}") as Record<string, unknown>
    expect(snapshot["tokens"]).toEqual({ input: 1000, output: 100, cache_read: 2000, cache_write: 0 })
    expect(snapshot["cost"]).toBe(0.5)
    expect(snapshot["output_input_ratio"]).toBeCloseTo(0.1)
  })

  test("emits all fifteen enriched snapshot keys", async () => {
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
        "trailing_idle_hours",
        "recent_prompts",
        "recent_repetition_score",
        "repetition_score",
        "todo_churn",
      ].sort(),
    )
  })

  test("a missing database resolves null instead of throwing", async () => {
    // The open is contained: a caller cannot tell a broken DB from an absent one.
    expect(await buildSessionSnapshot(join(directory, "absent.db"), "ses_fix")).toBeNull()
  })
})
