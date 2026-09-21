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

import { jevAsk, jevGaugeKeep, jevMeasuredChoice, JEV_DEFAULT_MODEL, JEV_DEFAULT_THRESHOLD, JEV_DEFAULT_TIMEOUT_MS } from "./client"

const SECTION_TEXT_MAX = 600

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max))

export interface GateConfig {
  readonly enabled?: boolean
  readonly model?: string
  readonly threshold?: number
  readonly timeoutMs?: number
}

export interface GateInput {
  readonly key: string
  readonly state: string
  readonly config: GateConfig
}

/**
 * Drop-only relevance gate over already-assembled system blocks. Returns the
 * blocks to KEEP, or the input unchanged when disabled / no key / any
 * fail-open path. Sections are addressed by index so an un-attributed echo
 * cannot remove the wrong block.
 */
export async function governorKeep(input: GateInput, sections: readonly string[]): Promise<readonly string[]> {
  if (input.config.enabled !== true || sections.length === 0) return sections
  const questions: Record<string, unknown> = {}
  sections.forEach((text, i) => {
    questions[`s${i}`] = {
      type: "choice",
      instructions:
        "Is this context section relevant to the user's request? Keep it only if it helps answer the request.",
      criteria: { keep: "Relevant to the request", drop: "Irrelevant to the request" },
      context: clip(text, SECTION_TEXT_MAX),
    }
  })
  const answers = await jevAsk({
    key: input.key,
    state: input.state,
    questions,
    timeoutMs: input.config.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS,
    model: input.config.model ?? JEV_DEFAULT_MODEL,
  })
  const ids = sections.map((_, i) => `s${i}`)
  const keep = jevGaugeKeep(answers, ids, input.config.threshold ?? JEV_DEFAULT_THRESHOLD)
  if (!keep) return sections
  return sections.filter((_, i) => keep.has(`s${i}`))
}

const BOOSTER_LABELS: Record<string, string> = {
  switch: "The current approach is off track; switch strategy",
  verify: "A claim in the last step needs verification before continuing",
  contradiction: "The last step contradicts the goal or an earlier step",
  finish: "The goal is already satisfied; finish instead of continuing",
  continue: "No advisory; the approach is sound",
}

/**
 * Advisory-only reasoning judgement: one categorical question folded to a
 * `switch|verify|contradiction|finish|continue` label. Returns the advisory
 * text to inject as an ephemeral system block, or `undefined` to emit nothing.
 * `continue` and every fail-open path emit nothing — the block never carries
 * an instruction the turn would not otherwise have.
 */
export async function boosterAdvisory(input: GateInput): Promise<string | undefined> {
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
    model: input.config.model ?? JEV_DEFAULT_MODEL,
  })
  // Require an EXPLICIT measured `probabilities[choice]`: `jevChoice` fabricates
  // strength=1 on a label without a probability map, which would clear this gate
  // and emit an unmeasured advisory. Mirrors jevGaugeKeep — an unmeasured row
  // fails open (emit nothing), never gates on a fabricated strength.
  const row = answers ? jevMeasuredChoice(answers["advice"]) : undefined
  if (!row || row.choice === "continue" || row.strength < (input.config.threshold ?? JEV_DEFAULT_THRESHOLD)) return undefined
  const text = BOOSTER_LABELS[row.choice]
  return text ? `[Jev reasoning advisory] ${text}.` : undefined
}
