import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import {
  createGovernor,
  GOVERNOR_DEGRADED_LAG_MS,
  GOVERNOR_DEGRADED_STAGGER_MS,
  GOVERNOR_STRESSED_LAG_MS,
  GOVERNOR_STRESSED_POLL_MS,
  GOVERNOR_TICK_MS,
  resolveGovernorEnabled,
} from "../src/governor"
import { it } from "./lib/effect"

// Manual drift probe: the injected clock only moves when `fire` says so and the
// scheduled callback is invoked by hand, so lag is exact and nothing real sleeps.
const probe = () => {
  const clock = { now: 0, scheduled: [] as Array<() => void> }
  const governor = createGovernor({
    now: () => clock.now,
    schedule: (callback) => {
      clock.scheduled.push(callback)
      return clock.scheduled
    },
    cancel: () => {
      clock.scheduled.pop()
    },
  })
  const fire = (lag: number) => {
    const callback = clock.scheduled.pop()
    if (!callback) throw new Error("no tick scheduled")
    clock.now += GOVERNOR_TICK_MS + lag
    callback()
  }
  return { governor, fire, scheduled: () => clock.scheduled.length }
}

describe("governor", () => {
  it.effect("admits new work immediately while the loop keeps its cadence", () =>
    Effect.gen(function* () {
      const p = probe()
      p.governor.start()
      p.fire(0)
      expect(p.governor.level()).toBe("healthy")
      // TestClock only moves when adjusted, so a completing admit() proves no sleep.
      yield* p.governor.admit()
      expect(p.scheduled()).toBe(1)
      p.governor.stop()
      expect(p.scheduled()).toBe(0)
    }),
  )

  it.effect("staggers new work after two consecutive late ticks", () =>
    Effect.gen(function* () {
      const p = probe()
      p.governor.start()
      p.fire(GOVERNOR_DEGRADED_LAG_MS + 50)
      expect(p.governor.level()).toBe("healthy")
      p.fire(GOVERNOR_DEGRADED_LAG_MS + 50)
      expect(p.governor.level()).toBe("degraded")

      const admitted = yield* Deferred.make<boolean>()
      const fiber = yield* Effect.forkChild(
        Effect.andThen(p.governor.admit(), Deferred.succeed(admitted, true)),
      )
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(admitted)).toBe(false)
      yield* TestClock.adjust(GOVERNOR_DEGRADED_STAGGER_MS)
      yield* Fiber.join(fiber)
      expect(yield* Deferred.isDone(admitted)).toBe(true)
      p.governor.stop()
    }),
  )

  it.effect("holds new work while stressed, then releases one level at a time", () =>
    Effect.gen(function* () {
      const p = probe()
      p.governor.start()
      p.fire(GOVERNOR_STRESSED_LAG_MS + 100)
      p.fire(GOVERNOR_STRESSED_LAG_MS + 100)
      expect(p.governor.level()).toBe("stressed")

      const admitted = yield* Deferred.make<boolean>()
      const fiber = yield* Effect.forkChild(
        Effect.andThen(p.governor.admit(), Deferred.succeed(admitted, true)),
      )
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(admitted)).toBe(false)
      yield* TestClock.adjust(GOVERNOR_STRESSED_POLL_MS)
      expect(yield* Deferred.isDone(admitted)).toBe(false)
      p.fire(0)
      p.fire(0)
      yield* TestClock.adjust(GOVERNOR_STRESSED_POLL_MS)
      expect(yield* Deferred.isDone(admitted)).toBe(false)
      p.fire(0)
      expect(p.governor.level()).toBe("degraded")
      yield* TestClock.adjust(GOVERNOR_STRESSED_POLL_MS)
      yield* Fiber.join(fiber)
      expect(yield* Deferred.isDone(admitted)).toBe(true)
      p.governor.stop()
    }),
  )

  it.effect("passes admission through and never starts the loop when disabled", () =>
    Effect.gen(function* () {
      let scheduled = 0
      const governor = createGovernor({
        schedule: () => {
          scheduled += 1
          return undefined
        },
        cancel: () => {},
        enabled: () => false,
      })
      yield* governor.admit()
      expect(scheduled).toBe(0)
      expect(governor.level()).toBe("healthy")
    }),
  )

  // A sampler stopped by the kill switch must be restartable: fire() on the disabled
  // path has to release the handle, or every later start() no-ops and the level stays
  // frozen forever (a stressed admit() then waits indefinitely).
  it.effect("restarts the sampler after a disabled fire releases the handle", () =>
    Effect.gen(function* () {
      let enabled = true
      let scheduled = 0
      const handles: Array<() => void> = []
      const governor = createGovernor({
        schedule: (callback) => {
          scheduled += 1
          handles.push(callback)
          // A real non-undefined handle, or start() would reschedule even while broken.
          return handles
        },
        cancel: () => {},
        enabled: () => enabled,
      })
      governor.start()
      expect(scheduled).toBe(1)
      // Disable, then let the already-scheduled callback run: it must NOT reschedule.
      enabled = false
      handles[0]()
      expect(scheduled).toBe(1)
      // The restart proof: re-enabling and starting schedules a fresh callback.
      enabled = true
      governor.start()
      expect(scheduled).toBe(2)
    }),
  )

  test("resolves the governor kill switch", () => {
    expect(resolveGovernorEnabled("0")).toBe(false)
    expect(resolveGovernorEnabled("off")).toBe(false)
    expect(resolveGovernorEnabled("OFF")).toBe(false)
    expect(resolveGovernorEnabled("false")).toBe(false)
    expect(resolveGovernorEnabled(undefined)).toBe(true)
    expect(resolveGovernorEnabled("")).toBe(true)
    expect(resolveGovernorEnabled("1")).toBe(true)
  })
})
