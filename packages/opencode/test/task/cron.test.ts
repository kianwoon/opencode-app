import { describe, expect, test } from "bun:test"
import { Cron } from "@/task/cron"
import { Effect } from "effect"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Fixed reference: 2026-08-31 10:30:15 UTC
const FROM = Date.UTC(2026, 7, 31, 10, 30, 15)

const next = (expression: string, from = FROM) => Cron.nextRunAfter(expression, from)

describe("Cron presets", () => {
  test("normalizes presets to cron expressions", () => {
    expect(Cron.normalize("daily")).toBe("0 0 * * *")
    expect(Cron.normalize("DAILY")).toBe("0 0 * * *")
    expect(Cron.normalize("minutely")).toBe("* * * * *")
    expect(Cron.normalize("0 9 * * 1-5")).toBe("0 9 * * 1-5")
  })

  test("accepts valid presets and expressions", async () => {
    expect(await Effect.runPromise(Cron.parse("weekly"))).toBe("0 0 * * 0")
    expect(await Effect.runPromise(Cron.parse("*/5 * * * *"))).toBe("*/5 * * * *")
  })

  test("rejects invalid expressions", () => {
    expect(Effect.runPromise(Cron.parse("not a cron"))).rejects.toThrow(/Invalid cron expression/)
    expect(Effect.runPromise(Cron.parse("99 * * * *"))).rejects.toThrow(/Invalid cron expression/)
  })
})

describe("Cron.nextRunAfter", () => {
  test("minutely fires on the next minute boundary", () => {
    // 10:30:15 -> 10:31:00
    expect(next("minutely")).toBe(FROM - 15_000 + MINUTE)
  })

  test("hourly fires at the top of the next hour", () => {
    expect(next("hourly")).toBe(Date.UTC(2026, 7, 31, 11, 0, 0))
  })

  test("daily fires at midnight the next day", () => {
    expect(next("daily")).toBe(Date.UTC(2026, 7, 31, 23, 59, 59) + 1000)
    expect(new Date(next("daily")!).getUTCHours()).toBe(0)
  })

  test("strictly-after semantics: a boundary timestamp advances to the next occurrence", () => {
    // Exactly midnight is already due, so the next fire is the following midnight.
    const midnight = Date.UTC(2026, 7, 31, 0, 0, 0)
    expect(next("daily", midnight)).toBe(Date.UTC(2026, 8, 1, 0, 0, 0))
  })

  test("day-of-week expression", () => {
    // 2026-08-31 is a Monday; next Monday 09:00
    expect(next("0 9 * * 1")).toBe(Date.UTC(2026, 8, 7, 9, 0, 0))
  })

  test("returns undefined for invalid expressions", () => {
    expect(next("garbage")).toBeUndefined()
  })

  test("interval expressions", () => {
    expect(next("*/15 * * * *")).toBe(Date.UTC(2026, 7, 31, 10, 45, 0))
  })

  test("yearly fires on Jan 1", () => {
    expect(next("yearly")).toBe(Date.UTC(2027, 0, 1, 0, 0, 0))
  })

  test("monthly fires on the 1st", () => {
    expect(next("monthly")).toBe(Date.UTC(2026, 8, 1, 0, 0, 0))
  })

  test("next fire is at least one tick after `from`", () => {
    const value = next("minutely", Date.now())
    expect(value).toBeGreaterThan(Date.now())
    expect(value! - Date.now()).toBeLessThanOrEqual(MINUTE + 5_000)
  })
})
