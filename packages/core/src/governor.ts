import { Effect } from "effect"

/**
 * Runtime workload governor. The event loop is the scarce resource: when it
 * lags, admitting NEW work deepens the lag, so admission slows down instead of
 * concurrency growing. In-flight work is never interrupted.
 */
export const GOVERNOR_TICK_MS = 2000
export const GOVERNOR_DEGRADED_LAG_MS = 150
export const GOVERNOR_STRESSED_LAG_MS = 500
export const GOVERNOR_ESCALATE_TICKS = 2
export const GOVERNOR_RECOVER_TICKS = 3
export const GOVERNOR_DEGRADED_STAGGER_MS = 300
export const GOVERNOR_STRESSED_POLL_MS = 250

export type GovernorLevel = "healthy" | "degraded" | "stressed"

export const resolveGovernorEnabled = (raw?: string) => {
  const value = raw?.trim().toLowerCase()
  if (value === "0" || value === "off" || value === "false") return false
  return true
}

export type GovernorOptions = {
  tickMs?: number
  now?: () => number
  schedule?: (callback: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  enabled?: () => boolean
}

export type Governor = {
  level: () => GovernorLevel
  start: () => void
  stop: () => void
  admit: () => Effect.Effect<void>
  tick: () => void
}

export const createGovernor = (options: GovernorOptions = {}): Governor => {
  const tickMs = options.tickMs ?? GOVERNOR_TICK_MS
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const enabled = options.enabled ?? (() => resolveGovernorEnabled(process.env["OPENCODE_GOVERNOR"]))

  let state: {
    level: GovernorLevel
    lag: number
    hot: number
    critical: number
    clean: number
    handle: unknown
    dueAt: number
  } = { level: "healthy", lag: 0, hot: 0, critical: 0, clean: 0, handle: undefined, dueAt: 0 }

  const level = () => state.level

  const tick = () => {
    // Drift probe: `dueAt` is the fire time the timer promised, so the delta is
    // real event-loop delay. Deliberately no `node:perf_hooks` and no
    // `Bun.*` — this module must behave identically under Bun and Node/Electron.
    const lag = now() - state.dueAt
    const hot = lag > GOVERNOR_DEGRADED_LAG_MS ? state.hot + 1 : 0
    const critical = lag > GOVERNOR_STRESSED_LAG_MS ? state.critical + 1 : 0
    const clean = hot > 0 ? 0 : state.clean + 1
    const escalated: GovernorLevel =
      critical >= GOVERNOR_ESCALATE_TICKS
        ? "stressed"
        : hot >= GOVERNOR_ESCALATE_TICKS && state.level === "healthy"
          ? "degraded"
          : state.level
    // Fast up, slow down: one level per GOVERNOR_RECOVER_TICKS clean ticks.
    const next: GovernorLevel = clean >= GOVERNOR_RECOVER_TICKS ? (escalated === "stressed" ? "degraded" : "healthy") : escalated
    state = { ...state, level: next, lag, hot, critical, clean: clean >= GOVERNOR_RECOVER_TICKS ? 0 : clean }
  }

  const start = () => {
    if (state.handle !== undefined || !enabled()) return
    const dueAt = now() + tickMs
    const fire = () => {
      tick()
      if (!enabled()) {
        // A stopped sampler must stay restartable: leaving the handle set makes
        // every later start() a no-op and freezes the level forever.
        state = { ...state, handle: undefined }
        return
      }
      state = { ...state, dueAt: now() + tickMs, handle: schedule(fire, tickMs) }
    }
    state = { ...state, dueAt, handle: schedule(fire, tickMs) }
  }

  const stop = () => {
    if (state.handle === undefined) return
    cancel(state.handle)
    state = { ...state, handle: undefined }
  }

  const admit = () =>
    Effect.gen(function* () {
      if (!enabled()) return
      start()
      if (state.level === "stressed") {
        // Presumes a live sampler to clear `stressed`, which the restart fix guarantees.
        while (state.level === "stressed") yield* Effect.sleep(GOVERNOR_STRESSED_POLL_MS)
        return
      }
      if (state.level === "degraded") yield* Effect.sleep(GOVERNOR_DEGRADED_STAGGER_MS)
    })

  return { level, start, stop, admit, tick }
}

export const governor = createGovernor()
