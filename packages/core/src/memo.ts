import { Effect } from "effect"

// Search/snapshot results are re-requested per event, so an identical burst of
// requests otherwise recomputes once per call; the TTL bounds staleness.
export const memo = <A, E = never>(ttlMs: number, now: () => number = Date.now) => {
  const cache = new Map<string, { value: A; at: number }>()
  return (key: string, fetch: () => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const hit = cache.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.value
      const value = yield* fetch()
      cache.set(key, { value, at: now() })
      return value
    })
}
