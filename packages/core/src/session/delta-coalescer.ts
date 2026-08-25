import { Effect } from "effect"

/**
 * Coalesces live-only stream delta fragments before they hit the event bus.
 *
 * Delta events (`session.next.*.delta`, legacy `message.part.delta`) are
 * explicitly non-durable: the replayable boundary is the matching `*.ended`
 * event carrying the full value, and downstream projectors fold deltas
 * associatively (`text += delta`). Merging adjacent fragments for the same
 * stream target therefore preserves both replay and projection semantics
 * while cutting publish/SSE/parse overhead per token.
 *
 * Ordering contract: any non-delta publish must flush pending deltas first
 * (see `publishGuarded`), so a delta can never be applied after a later
 * full-value boundary event for the same message.
 */
export interface DeltaCoalescer<Key extends string> {
  /** Buffer one delta fragment. Flushes when age or count thresholds pass. */
  readonly append: (key: Key, fragment: string) => Effect.Effect<void>
  /** Publish a non-delta event, flushing any pending deltas first. */
  readonly publishGuarded: <A>(publish: () => Effect.Effect<A>) => Effect.Effect<A>
  /** Flush all pending deltas now. An Effect value; `yield*` it. */
  readonly flush: Effect.Effect<void>
}

export const DELTA_COALESCE_MAX_AGE_MS = 12
export const DELTA_COALESCE_MAX_PARTS = 64

export function createDeltaCoalescer<Key extends string>(input: {
  readonly publish: (key: Key, fragment: string) => Effect.Effect<void>
  readonly now?: () => number
  readonly maxAgeMs?: number
  readonly maxParts?: number
}): DeltaCoalescer<Key> {
  const now = input.now ?? Date.now
  const maxAgeMs = input.maxAgeMs ?? DELTA_COALESCE_MAX_AGE_MS
  const maxParts = input.maxParts ?? DELTA_COALESCE_MAX_PARTS
  // `since` is the arrival time of the FIRST buffered fragment; age therefore
  // accrues across same-key appends, so a single continuously-streaming part
  // still flushes at the cadence instead of buffering until its boundary.
  const pending = new Map<Key, { fragment: string; since: number }>()

  const flush = Effect.suspend(() => {
    if (pending.size === 0) return Effect.void
    const entries = [...pending]
    pending.clear()
    return Effect.forEach(entries, ([key, item]) => input.publish(key, item.fragment), { discard: true })
  })

  const drain = (at: number) => {
    const expired: [Key, { fragment: string; since: number }][] = []
    for (const entry of pending) {
      if (at - entry[1].since < maxAgeMs) break
      expired.push(entry)
      pending.delete(entry[0])
    }
    return expired
  }

  const append = (key: Key, fragment: string) =>
    Effect.suspend(() => {
      const at = now()
      const existing = pending.get(key)
      if (existing) {
        existing.fragment += fragment
      } else {
        pending.set(key, { fragment, since: at })
      }
      const expired = drain(at)
      if (pending.size >= maxParts) {
        for (const entry of pending) expired.push(entry)
        pending.clear()
      }
      if (expired.length === 0) return Effect.void
      return Effect.forEach(expired, ([k, item]) => input.publish(k, item.fragment), { discard: true })
    })

  return {
    append,
    publishGuarded: (publish) => Effect.flatMap(flush, publish),
    flush,
  }
}
