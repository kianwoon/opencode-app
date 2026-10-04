/**
 * Governor + brain-booster folds over the single-batch decision.
 *
 * Both surfaces are advisory and FAIL-OPEN: the batch fold produces no drop and
 * no advisory block unless the caller already measured a row, and every
 * fail-open path leaves the turn exactly as it would be with the feature off.
 */

/** Drop the indexed sections from `sections`. Identity when nothing is dropped. */
export function applyDrops(sections: readonly string[], dropped: ReadonlySet<number>): readonly string[] {
  return dropped.size === 0 ? sections : sections.filter((_, i) => !dropped.has(i))
}

/**
 * Structured reasoning verdict: the folded label plus whether a block was
 * actually emitted. `label` is the categorical choice
 * (`switch|verify|contradiction|finish|continue`); `emitted` is true only when
 * the turn receives the advisory block.
 */
export interface BoosterVerdict {
  readonly label: string
  readonly emitted: boolean
  readonly text?: string
}

/** Change-detect result: whether this turn's label flipped, and the text to push. */
export interface BoosterPush {
  readonly changed: boolean
  readonly advisory?: string
}

/**
 * Change-detect: an advisory block is re-injected only when this turn's folded
 * label differs from the previous turn's (`prev` = last observed label for the
 * session; `undefined` = first-ever turn, which always pushes). A repeated label
 * is a no-op — the request prefix stays byte-identical — and every fail-open
 * path (no measured row) emits nothing. `emitted` gates the text: a flipped but
 * sub-threshold / `continue` label still counts as `changed` for telemetry yet
 * pushes no block.
 */
export function boosterPush(
  prev: string | undefined,
  verdict: Pick<BoosterVerdict, "label" | "emitted" | "text"> | undefined,
): BoosterPush {
  if (!verdict) return { changed: false }
  const changed = prev !== verdict.label
  return { changed, advisory: changed && verdict.emitted ? verdict.text : undefined }
}