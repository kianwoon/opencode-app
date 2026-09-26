import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
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

  // Single-flight: the cold-key stampede. The invocation count is the proof — both
  // callers receive the value either way, so only the count can see the duplication.
  it.effect("runs one fetch for concurrent callers on a cold key", () =>
    Effect.gen(function* () {
      const calls = { count: 0 }
      const load = memo<number>(1000, () => 0)
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const fetch = () =>
        Effect.gen(function* () {
          calls.count++
          // `started` proves the first caller already owns the fetch, so the second
          // caller is genuinely concurrent rather than merely later in wall-clock time.
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(gate)
          return 42
        })
      const first = yield* Effect.forkChild(load("/repo", fetch))
      yield* Deferred.await(started)
      const second = yield* Effect.forkChild(load("/repo", fetch))
      yield* Effect.yieldNow
      expect(calls.count).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      expect(yield* Fiber.join(first)).toBe(42)
      expect(yield* Fiber.join(second)).toBe(42)
      expect(calls.count).toBe(1)
    }),
  )

  // A failure must reach EVERY concurrent awaiter and the owning fiber, and must never
  // be cached — the next call re-runs a real fetch instead of replaying the failure.
  it.effect("propagates a failure to every awaiter and re-fetches next time", () =>
    Effect.gen(function* () {
      const calls = { count: 0 }
      const load = memo<number, string>(1000, () => 0)
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const fetch = () =>
        Effect.gen(function* () {
          calls.count++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(gate)
          return yield* Effect.fail("boom")
        })
      const first = yield* Effect.forkChild(Effect.exit(load("/repo", fetch)))
      yield* Deferred.await(started)
      const second = yield* Effect.forkChild(Effect.exit(load("/repo", fetch)))
      yield* Effect.yieldNow
      expect(calls.count).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
      expect(Exit.isFailure(yield* Fiber.join(second))).toBe(true)
      // Not cached: this call really runs a fetch, so the count advances 1 -> 2.
      expect(yield* load("/repo", () => Effect.sync(() => ++calls.count))).toBe(2)
      expect(calls.count).toBe(2)
    }),
  )

  // MEMO_MAX_ENTRIES is 128, so the 128th insert evicts the oldest key: the first key
  // must re-fetch while a recent key still replays from cache.
  it.effect("evicts the oldest key once the cache reaches its cap", () =>
    Effect.gen(function* () {
      const calls = { count: 0 }
      const load = memo<number>(100_000, () => 0)
      const fetch = () => Effect.sync(() => ++calls.count)
      for (let index = 0; index < 128; index++) yield* load(`key-${index}`, fetch)
      expect(calls.count).toBe(128)
      yield* load("key-0", fetch)
      expect(calls.count).toBe(129)
      yield* load("key-127", fetch)
      expect(calls.count).toBe(129)
    }),
  )
})
