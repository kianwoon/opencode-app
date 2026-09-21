/**
 * Turn-level arbitration for task results (Phase 3b item 1).
 *
 * A turn may fan out up to `MAX_PARALLEL_TASKS_PER_TURN` (5) `task` calls; the AI
 * SDK settles them independently and opencode persists each result the moment it
 * lands (`SessionTools.resolve` -> `processor.completeToolCall`). There is no
 * join. This module is the MINIMAL join: a pure fold over the settled results of
 * ONE turn that produces an advisory ranking plus bounded telemetry rows.
 *
 * Cache + persistence invariants (do not weaken):
 *   - PURE: no fetch, no Effect, no clock. The score per callID is INJECTED, so
 *     the fold is deterministic and unit-testable.
 *   - The fold NEVER rewrites persisted bytes. It returns a NEW ordering array
 *     and never mutates an entry's `output`, so a caller may rank AFTER persist
 *     (log only) or BEFORE persist (order emission) without a byte change.
 *   - `score` is an ADVISORY FLOAT (jev.md §3: "score for ordering, never for
 *     gating"). Never integer-fold it, never compare it with `===` to a rounded
 *     value. Only the integer `rank` (position) is derived.
 *   - Fail open: absent scores (null/undefined/map with no finite value) ⇒ every
 *     output passes through UNRANKED in its original order. Never drop a result.
 */

/** Default cut below which an advisory score is not trusted for ordering. */
export const ARBITRATE_THRESHOLD_DEFAULT = 0.5

/** Per-entry question state budget: the delegate goal, else this output head. */
export const ARBITRATE_STATE_MAX_CHARS = 400

export interface ArbitrateEntry {
  readonly callID: string
  readonly output: string
}

export interface ArbitrateRank {
  readonly callID: string
  readonly rank: number
  readonly score: number
}

export interface ArbitrateResult {
  /** False when no entry carried a usable score (fail open, original order). */
  readonly ranked: boolean
  /** callID order; ranked entries first (desc score), unranked tail in input order. */
  readonly order: readonly string[]
  /** Scored entries only, bounded to `order.length`; `score` stays a float. */
  readonly ranks: readonly ArbitrateRank[]
}

/**
 * The JEV question state for ONE result: the delegating goal when reachable,
 * else the output's first `ARBITRATE_STATE_MAX_CHARS`. NEVER the full contents —
 * a 100k-char child transcript would be shipped as state on every batch.
 */
export const arbitrateState = (goal: string | undefined, output: string): string => {
  const trimmed = goal?.trim() ?? ""
  if (trimmed.length > 0) return trimmed
  return output.length <= ARBITRATE_STATE_MAX_CHARS ? output : output.slice(0, ARBITRATE_STATE_MAX_CHARS)
}

/**
 * Fold the settled results of one turn into an advisory ordering.
 *
 * `scores` is the per-callID JEV Score (see `jevScoreRank`); a value that is
 * absent, non-finite, or below `threshold` leaves its entry UNRANKED. Never
 * drops an entry, never mutates the input, never rewrites `output`.
 */
export function arbitrate(input: {
  readonly entries: readonly ArbitrateEntry[]
  readonly scores: ReadonlyMap<string, number | undefined> | undefined
  readonly threshold?: number
}): ArbitrateResult {
  const order = input.entries.map((entry) => entry.callID)
  if (!input.scores || input.entries.length < 2) return { ranked: false, order, ranks: [] }
  const threshold = input.threshold ?? ARBITRATE_THRESHOLD_DEFAULT
  const scored: Array<{ callID: string; score: number; index: number }> = []
  for (let i = 0; i < input.entries.length; i++) {
    const entry = input.entries[i]!
    const score = input.scores.get(entry.callID)
    // Below the threshold the row is not stood behind: unranked, never dropped.
    if (typeof score !== "number" || !Number.isFinite(score) || score < threshold) continue
    scored.push({ callID: entry.callID, score, index: i })
  }
  if (scored.length === 0) return { ranked: false, order, ranks: [] }
  // Stable descending by score: ties keep input order, so two equal scores never
  // swap between calls (a swap would reorder injected results for no signal).
  const ranked = scored.toSorted((a, b) => b.score - a.score || a.index - b.index)
  const rankedIDs = new Set(ranked.map((row) => row.callID))
  const unranked = input.entries.filter((entry) => !rankedIDs.has(entry.callID)).map((entry) => entry.callID)
  return {
    ranked: true,
    order: [...ranked.map((row) => row.callID), ...unranked],
    ranks: ranked.map((row, i) => ({ callID: row.callID, rank: i + 1, score: row.score })),
  }
}

/**
 * Bounded telemetry rows for the `arbitrate` log line. Intentionally carries
 * ONLY {callID, rank, score} — never result contents, never the question state.
 */
export const arbitrateLogRows = (result: ArbitrateResult): readonly ArbitrateRank[] => result.ranks
