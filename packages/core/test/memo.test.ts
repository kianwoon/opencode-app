import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { memo } from "../src/memo"
import { it } from "./lib/effect"

describe("memo", () => {
  it.effect("reuses one fetch for repeated keys inside the TTL", () =>
    Effect.gen(function* () {
      const clock = { at: 0 }
      const calls = { count: 0 }
      const load = memo<number>(1000, () => clock.at)
      const fetch = () => Effect.sync(() => ++calls.count)
      const first = yield* load("/repo", fetch)
      const second = yield* load("/repo", fetch)
      expect(calls.count).toBe(1)
      expect(second).toBe(first)
    }),
  )

  it.effect("refetches once the TTL has elapsed", () =>
    Effect.gen(function* () {
      const clock = { at: 0 }
      const calls = { count: 0 }
      const load = memo<number>(1500, () => clock.at)
      const fetch = () => Effect.sync(() => ++calls.count)
      yield* load("/repo", fetch)
      clock.at += 1600
      const second = yield* load("/repo", fetch)
      expect(calls.count).toBe(2)
      expect(second).toBe(2)
    }),
  )

  it.effect("fetches distinct keys independently", () =>
    Effect.gen(function* () {
      const clock = { at: 0 }
      const calls = { count: 0 }
      const load = memo<number>(1000, () => clock.at)
      const fetch = () => Effect.sync(() => ++calls.count)
      yield* load("/repo-a", fetch)
      yield* load("/repo-b", fetch)
      yield* load("/repo-a", fetch)
      expect(calls.count).toBe(2)
    }),
  )

  // The cache write sits AFTER the fetch, so a failed (e.g. aborted) call is never
  // stored — the next caller re-runs instead of reading a poisoned entry.
  it.effect("does not cache a failed fetch", () =>
    Effect.gen(function* () {
      const calls = { count: 0 }
      const load = memo<number, string>(1000, () => 0)
      const fetch = () =>
        Effect.sync(() => ++calls.count).pipe(
          Effect.flatMap((attempt) => (attempt === 1 ? Effect.fail("boom") : Effect.succeed(7))),
        )
      expect(Exit.isFailure(yield* Effect.exit(load("/repo", fetch)))).toBe(true)
      expect(yield* load("/repo", fetch)).toBe(7)
      expect(calls.count).toBe(2)
    }),
  )
})
