export * as Cron from "./cron"

import { Cron as Croner } from "croner"
import { Effect } from "effect"

const presets: Record<string, string> = {
  yearly: "0 0 1 1 *",
  monthly: "0 0 1 * *",
  weekly: "0 0 * * 0",
  daily: "0 0 * * *",
  hourly: "0 * * * *",
  minutely: "* * * * *",
}

/** Expands named presets ("daily", "hourly", ...) to their 5-field cron expression. */
export const normalize = (expression: string): string => {
  const preset = presets[expression.toLowerCase()]
  return preset ?? expression
}

/**
 * Parses and validates a cron expression or named preset.
 * Returns the normalized expression, or an error effect when invalid.
 */
export const parse = (expression: string): Effect.Effect<string, Error> =>
  Effect.try({
    try: () => {
      const normalized = normalize(expression)
      // Cron throws on invalid patterns; construct without a callback so nothing is scheduled.
      new Croner(normalized, { paused: true })
      return normalized
    },
    catch: (cause) =>
      new Error(`Invalid cron expression "${expression}". Use a 5-field cron or one of: yearly, monthly, weekly, daily, hourly, minutely`, { cause }),
  })

/** Computes the next fire time strictly after `from`. Returns undefined for invalid expressions. */
export const nextRunAfter = (expression: string, from: number): number | undefined => {
  const normalized = normalize(expression)
  try {
    const job = new Croner(normalized, { paused: true })
    const next = job.nextRun(new Date(from))
    return next ? next.getTime() : undefined
  } catch {
    return undefined
  }
}
