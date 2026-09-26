import { Deferred, Effect } from "effect"

const MEMO_MAX_ENTRIES = 128

// Search/snapshot results are re-requested per event, so an identical burst of
// requests otherwise recomputes once per call; the TTL bounds staleness.
export const memo = <A, E = never>(ttlMs: number, now: () => number = Date.now) => {
  const cache = new Map<string, { value: A; at: number }>()
  const inflight = new Map<string, Deferred.Deferred<A, E>>()
  return (key: string, fetch: () => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const hit = cache.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.value
      // Single-flight: the first caller on a cold key owns the fetch, and every
      // concurrent caller on that key awaits its Deferred instead of stampeding.
      const pending = inflight.get(key)
      if (pending) return yield* Deferred.await(pending)
      const deferred = yield* Deferred.make<A, E>()
      inflight.set(key, deferred)
      return yield* fetch().pipe(
        // Cache BEFORE releasing the waiters, so a caller that arrives once the
        // inflight entry clears still reads the value instead of re-fetching.
        Effect.tap((value) =>
          Effect.sync(() => {
            cache.set(key, { value, at: now() })
            // Map iterates in insertion order, so the first key is the oldest.
            if (cache.size >= MEMO_MAX_ENTRIES) {
              const oldest = cache.keys().next().value
              if (oldest !== undefined) cache.delete(oldest)
            }
          }),
        ),
        Effect.flatMap((value) => Deferred.succeed(deferred, value).pipe(Effect.as(value))),
        // Failures reach every awaiter AND re-raise in this fiber; nothing is
        // cached, so the next caller re-fetches instead of replaying a failure.
        Effect.tapCause((cause) => Deferred.failCause(deferred, cause)),
        Effect.ensuring(Effect.sync(() => inflight.delete(key))),
      )
    })
}
