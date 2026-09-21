/**
 * Rotation planner — DRY RUN ONLY.
 *
 * Emits a log-only carry/summarize/drop proposal for a session prefix that is
 * approaching the context cap. It is a PURE planner: it never returns a new
 * prefix, never writes `output.system`, `tools`, or history, and is not wired
 * into any plugin hook. Rotation is only viable because `contentCacheKey`
 * (packages/opencode/src/session/llm/request.ts) hashes CONTENT, not session
 * id — so a new session replaying a byte-identical system+tools head reuses
 * the provider cache, while an in-place chop shifts every kept byte to a new
 * position and invalidates the whole prefix.
 *
 * Run: bun .opencode/plugin-lib/rotation-planner.ts
 */

/** One span of the request prefix, in the order the provider sees it. */
export interface PrefixBlock {
  readonly id: string
  readonly kind: "system" | "tools" | "history"
  readonly tokens: number
  /** Byte-identical across a rotation (cacheable head). */
  readonly verbatim: boolean
}

/** JEV choice shape: one decision, ranked options, per-option criteria. */
export interface JevChoice {
  readonly type: "choice"
  readonly instructions: string
  readonly criteria: Record<string, string | null>
}

export interface BlockVerdict {
  readonly id: string
  readonly tokens: number
  readonly decision: "carry" | "summarize" | "drop"
  readonly jev: JevChoice
}

export interface RotationPlan {
  readonly measured: { readonly prefixTokens: number; readonly coreTokens: number; readonly historyTokens: number }
  readonly chop: { readonly keptTokens: number; readonly droppedTokens: number; readonly projectedHitRate: number; readonly coldTokens: number }
  readonly rotation: { readonly coreTokens: number; readonly summaryTokens: number; readonly coldFirstTurn: number; readonly projectedHitRate: number }
  readonly verdicts: readonly BlockVerdict[]
}

const ROTATION_CORE_CRITERIA = {
  carry: "byte-identical head: cache key matches, provider prefix cache is reused",
  summarize: "content is needed but its exact bytes are not: fold into the handoff brief",
  drop: "content is spent: re-derivable from disk, superseded, or stale",
} as const

const CHOP_CRITERIA = {
  chop: "removes oldest half in place; every kept byte shifts position, prefix hash changes",
  rotate: "new session replaying the same head bytes; core stays cacheable, history becomes a summary",
} as const

const choice = (instructions: string, criteria: Record<string, string | null>): JevChoice => ({ type: "choice", instructions, criteria })

/**
 * Split the prefix into the spans the provider caches separately. History is
 * segmented oldest → newest so each span gets its own carry/summarize/drop
 * verdict (one verdict per block, as the proposal must report counts).
 */
export function splitPrefix(coreTokens: number, historyTokens: number): PrefixBlock[] {
  const systemTokens = coreTokens - Math.round(coreTokens * 0.38)
  const toolTokens = Math.round(coreTokens * 0.38)
  const old = Math.round(historyTokens * 0.5)
  const mid = Math.round(historyTokens * 0.3)
  const recent = historyTokens - old - mid
  const blocks: PrefixBlock[] = [
    { id: "system[0]", kind: "system", tokens: systemTokens, verbatim: true },
    { id: "tools", kind: "tools", tokens: toolTokens, verbatim: true },
    { id: "history:old", kind: "history", tokens: old, verbatim: false },
    { id: "history:mid", kind: "history", tokens: mid, verbatim: false },
    { id: "history:recent", kind: "history", tokens: recent, verbatim: false },
  ]
  return blocks.filter((block) => block.tokens > 0)
}

/**
 * Classify each block. Verbatim blocks (system/tools) always carry — they are
 * the cacheable head and their bytes must not change. History is graded by
 * age: the recent working set carries, the mid band folds into the brief, the
 * oldest band is dropped (re-derivable from disk or superseded).
 */
export function planBlocks(blocks: readonly PrefixBlock[]): BlockVerdict[] {
  const historyDecision = (id: string): "carry" | "summarize" | "drop" =>
    id.endsWith(":recent") ? "carry" : id.endsWith(":mid") ? "summarize" : "drop"
  return blocks.map((block) => {
    const decision = block.verbatim ? ("carry" as const) : historyDecision(block.id)
    return {
      id: block.id,
      tokens: block.tokens,
      decision,
      jev: choice("Decide how this block crosses the rotation boundary.", ROTATION_CORE_CRITERIA),
    }
  })
}

export function planRotation(input: {
  readonly prefixTokens: number
  readonly coreTokens: number
  readonly historyTokens: number
  readonly summaryRatio?: number
}): RotationPlan {
  const { prefixTokens, coreTokens, historyTokens } = input
  const summaryTokens = Math.round(historyTokens * (input.summaryRatio ?? 0.12))

  // Chop: drop oldest 50% in place. Kept bytes shift → prefix hash changes →
  // 0% of the KEPT bytes hit; the whole request is re-billed as fresh input.
  const droppedTokens = Math.round(historyTokens / 2)
  const keptTokens = prefixTokens - droppedTokens
  const chop = {
    keptTokens,
    droppedTokens,
    projectedHitRate: 0,
    coldTokens: keptTokens,
  }

  // Rotation: new session, byte-identical core (contentCacheKey matches) +
  // JEV summary. First turn pays the core cold once if the provider cache
  // expired; every later turn reuses it.
  const rotation = {
    coreTokens,
    summaryTokens,
    coldFirstTurn: coreTokens + summaryTokens,
    projectedHitRate: 0.98,
  }

  return {
    measured: { prefixTokens, coreTokens, historyTokens },
    chop,
    rotation,
    verdicts: planBlocks(splitPrefix(coreTokens, historyTokens)),
  }
}

/** The rotation decision itself, as one JEV choice row. */
export function chooseStrategy(plan: RotationPlan): { choice: "chop" | "rotate"; jev: JevChoice; rationale: string } {
  const chopCost = plan.chop.coldTokens
  const rotateCost = plan.rotation.coldFirstTurn
  const better = rotateCost < chopCost ? "rotate" : "chop"
  return {
    choice: better,
    jev: choice("Choose how to cross the context cap.", CHOP_CRITERIA),
    rationale:
      better === "rotate"
        ? `rotate costs ${rotateCost} cold tokens once then ${Math.round(plan.rotation.projectedHitRate * 100)}% warm; chop re-bills ${chopCost} tokens at 0% hit`
        : `chop costs ${chopCost} cold tokens; rotate costs ${rotateCost}`,
  }
}

export function countDecisions(verdicts: readonly BlockVerdict[]) {
  return {
    carry: verdicts.filter((v) => v.decision === "carry").length,
    summarize: verdicts.filter((v) => v.decision === "summarize").length,
    drop: verdicts.filter((v) => v.decision === "drop").length,
    blocks: verdicts.length,
  }
}

if (import.meta.main) {
  // Measured live 2026-09-21 (see report): 114k session, 28-tool brain head.
  const plan = planRotation({ prefixTokens: 110912, coreTokens: 27648, historyTokens: 83264 })
  const strategy = chooseStrategy(plan)
  const counts = countDecisions(plan.verdicts)
  const line = JSON.stringify({
    ts: Date.now(),
    event: "rotation-proposal",
    mode: "dry-run",
    writes: 0,
    measured: plan.measured,
    chop: plan.chop,
    rotation: plan.rotation,
    strategy,
    counts,
    verdicts: plan.verdicts,
  })
  const { appendFile, mkdir } = await import("node:fs/promises")
  const { homedir } = await import("node:os")
  const dir = `${homedir()}/.local/share/opencode`
  await mkdir(dir, { recursive: true })
  await appendFile(`${dir}/rotation-plan.jsonl`, line + "\n")
  console.log(line)
}
