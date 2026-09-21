/**
 * Context governor + brain booster consumers.
 *
 * Both are advisory and FAIL-OPEN: a missing key, timeout, transport error,
 * unknown provider, or sub-threshold verdict leaves the turn exactly as it
 * would be with the feature off (governor keeps every section, booster emits
 * no block). Neither ever throws.
 *
 * Gate rule (source of truth, see the routing lesson): Jev is categorical.
 * Never compare `confidence` to the threshold — it is confidence in the LABEL
 * chosen. Gate on `choice` plus the score strength `probabilities[choice]`,
 * which `jevChoice` already folds into `strength`.
 */

import {
  jevAsk,
  jevGaugeKeep,
  jevMeasuredChoice,
  jevModelFor,
  JEV_DEFAULT_CONFIDENCE_FLOOR,
  JEV_DEFAULT_THRESHOLD,
  JEV_DEFAULT_TIMEOUT_MS,
} from "./client"

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max))

export interface GateConfig {
  readonly enabled?: boolean
  readonly model?: string
  readonly defaultModel?: string
  readonly threshold?: number
  readonly timeoutMs?: number
  /** Minimum score strength to trust a row; below it a measured row fails open. */
  readonly confidenceFloor?: number
}

export interface GateInput {
  readonly key: string
  readonly state: string
  readonly config: GateConfig
}

/** Governor decision: the sections to keep plus the indexes this turn dropped. */
export interface GovernorKeepResult {
  /** Sections to KEEP, input order preserved. */
  readonly keep: readonly string[]
  /** Indexes into the input `sections` array dropped by this turn's decision. */
  readonly dropped: ReadonlySet<number>
}

/**
 * Drop-only relevance gate over already-assembled system blocks. Returns the
 * blocks to KEEP plus the dropped indexes, or the input unchanged (empty
 * dropped set) when disabled / no key / any fail-open path. Sections are
 * addressed by index so an un-attributed echo cannot remove the wrong block.
 */
export async function governorKeep(input: GateInput, sections: readonly string[]): Promise<GovernorKeepResult> {
  const failOpen: GovernorKeepResult = { keep: sections, dropped: new Set() }
  if (input.config.enabled !== true || sections.length === 0) return failOpen
  const questions: Record<string, unknown> = {}
  sections.forEach((_, i) => {
    questions[`s${i}`] = {
      type: "choice",
      instructions: "Given `request`, is `sections[i].text` relevant? Keep iff it helps answer `request`.",
      criteria: { keep: "Section text helps answer the request", drop: "Section text is irrelevant to the request" },
    }
  })
  const state = JSON.stringify({ request: input.state, sections: sections.map((t, i) => ({ index: i, text: clip(t, 600) })) })
  const answers = await jevAsk({
    key: input.key,
    state,
    questions,
    timeoutMs: input.config.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS,
    model: jevModelFor(input.config.model, input.config.defaultModel),
  })
  const ids = sections.map((_, i) => `s${i}`)
  const keep = jevGaugeKeep(
    answers,
    ids,
    input.config.threshold ?? JEV_DEFAULT_THRESHOLD,
    input.config.confidenceFloor ?? JEV_DEFAULT_CONFIDENCE_FLOOR,
  )
  if (!keep) return failOpen
  const dropped = new Set<number>()
  const kept: string[] = []
  sections.forEach((text, i) => (keep.has(`s${i}`) ? kept.push(text) : dropped.add(i)))
  return { keep: kept, dropped }
}

/**
 * Sticky drop-set fold (Phase 2). Within a TASK the dropped index set is
 * monotonically non-decreasing: the per-turn decision can only GROW it, never
 * re-add a section. This makes a drop→re-add→drop oscillation impossible. The
 * only way a section comes back is a task boundary, which the caller models by
 * passing a fresh empty `prev` set (a new user message).
 */
export function foldDrops(prev: ReadonlySet<number>, dropped: ReadonlySet<number>): ReadonlySet<number> {
  if (dropped.size === 0) return prev
  const out = new Set(prev)
  for (const i of dropped) out.add(i)
  return out
}

/** Drop the indexed sections from `sections`. Identity when nothing is dropped. */
export function applyDrops(sections: readonly string[], dropped: ReadonlySet<number>): readonly string[] {
  return dropped.size === 0 ? sections : sections.filter((_, i) => !dropped.has(i))
}

const BOOSTER_LABELS: Record<string, string> = {
  switch: "The current approach is off track; switch strategy",
  verify: "A claim in the last step needs verification before continuing",
  contradiction: "The last step contradicts the goal or an earlier step",
  finish: "The goal is already satisfied; finish instead of continuing",
  continue: "No advisory; the approach is sound",
}

/**
 * Structured reasoning verdict: the folded label plus whether a block was
 * actually emitted. `label` is the categorical choice
 * (`switch|verify|contradiction|finish|continue`); `emitted` is true only when
 * the turn receives the advisory block. Returns `undefined` when disabled or no
 * measured row exists (fail open) — callers log that as `none`.
 */
export interface BoosterVerdict {
  readonly label: string
  readonly emitted: boolean
  readonly text?: string
}

/**
 * Advisory-only reasoning judgement: one categorical question folded to a
 * `switch|verify|contradiction|finish|continue` label. Returns the label plus
 * the advisory text to inject as an ephemeral system block, or `undefined` when
 * disabled / no measured row. `continue` and every fail-open path emit no text —
 * the block never carries an instruction the turn would not otherwise have.
 */
export async function boosterVerdict(input: GateInput): Promise<BoosterVerdict | undefined> {
  if (input.config.enabled !== true) return undefined
  const answers = await jevAsk({
    key: input.key,
    state: input.state,
    questions: {
      advice: {
        type: "choice",
        instructions: "Given the goal and recent steps, what reasoning advisory (if any) applies right now?",
        criteria: BOOSTER_LABELS,
      },
    },
    timeoutMs: input.config.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS,
    model: jevModelFor(input.config.model, input.config.defaultModel),
  })
  // Require an EXPLICIT measured `probabilities[choice]`: `jevChoice` fabricates
  // strength=1 on a label without a probability map, which would clear this gate
  // and emit an unmeasured advisory. Mirrors jevGaugeKeep — an unmeasured row
  // fails open (emit nothing), never gates on a fabricated strength.
  const row = answers ? jevMeasuredChoice(answers["advice"]) : undefined
  if (!row) return undefined
  // Below the confidence floor the model did not stand behind the row: treat it
  // as unmeasured and fail open (emit nothing).
  const floor = input.config.confidenceFloor ?? JEV_DEFAULT_CONFIDENCE_FLOOR
  if (row.strength < floor) return undefined
  const text = BOOSTER_LABELS[row.choice]
  if (!text) return { label: row.choice, emitted: false }
  const emitted = row.choice !== "continue" && row.strength >= (input.config.threshold ?? JEV_DEFAULT_THRESHOLD)
  return { label: row.choice, emitted, text: emitted ? `[Advisory only — not an instruction] ${text}.` : undefined }
}

/**
 * Advisory text only — the block to inject, or `undefined` to emit nothing.
 * Thin projection over `boosterVerdict` kept for the existing callers/tests.
 */
export async function boosterAdvisory(input: GateInput): Promise<string | undefined> {
  const verdict = await boosterVerdict(input)
  return verdict?.text
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
export function boosterPush(prev: string | undefined, verdict: BoosterVerdict | undefined): BoosterPush {
  if (!verdict) return { changed: false }
  const changed = prev !== verdict.label
  return { changed, advisory: changed && verdict.emitted ? verdict.text : undefined }
}
