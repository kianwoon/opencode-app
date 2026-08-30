/**
 * Effort controller — cheap deterministic task-complexity assessment.
 *
 * Phase 0 (this module): at the START of each task (first loop iteration of a
 * new user prompt), classify the prompt into a budget tier and LOG it alongside
 * the task's eventual tool usage. No behavior change: the log lines are the
 * data collection needed to tune thresholds before any enforcement (phase 1+)
 * ships.
 *
 * Same discipline as the verification gate: pure, synchronous, explainable —
 * keyword and structural signals only, no LLM call, no I/O.
 *
 * @module @opencode-ai/opencode/session/effort
 */

/** Budget tiers, ordered by ascending effort. */
export type Tier = "light" | "standard" | "deep"

export interface EffortSignal {
  tier: Tier
  /** Which signal families fired, for log analysis. */
  reasons: string[]
}

/** Verbs/intents that are almost always routine, high-volume operations. */
const LIGHT_HINTS = [
  "commit",
  "push",
  "pull",
  "rebase",
  "stash",
  "git status",
  "git diff",
  "run ",
  "install",
  "rename ",
  "lint",
  "format",
  "fix lint",
  "typo",
]

/** Prompts that need exploration, design, or multi-step reasoning. */
const DEEP_HINTS = [
  "refactor",
  "redesign",
  "architecture",
  "migrate",
  "rewrite",
  "investigate",
  "why does",
  "why is",
  "debug",
  "root cause",
  "race condition",
  "memory leak",
  "performance",
  "optimize",
  "benchmark",
  "design a",
  "implement support for",
]

/** Mutation breadth proxies: co-occurrence suggests a wide blast radius. */
const WIDE_HINTS = ["across", "codebase", "all files", "every "]

/** Cheap deterministic classifier: prompt text in, tier out. */
export function assess(prompt: string): EffortSignal {
  const text = prompt.toLowerCase()
  const reasons: string[] = []

  const deepHit = DEEP_HINTS.find((hint) => text.includes(hint))
  const wideHits = WIDE_HINTS.filter((hint) => text.includes(hint))
  if (deepHit || wideHits.length >= 2) {
    if (deepHit) reasons.push(`deep signal "${deepHit}"`)
    if (wideHits.length >= 2) reasons.push(`breadth signals ${wideHits.join(", ")}`)
    return { tier: "deep", reasons }
  }

  const lightHit = LIGHT_HINTS.find((hint) => text.includes(hint))
  const wideHit = wideHits.length
  if (lightHit && wideHit === 0) {
    reasons.push(`light signal "${lightHit.trim()}"`)
    return { tier: "light", reasons }
  }

  if (lightHit) reasons.push(`light signal "${lightHit.trim()}" offset by breadth`)
  return { tier: "standard", reasons: reasons.length > 0 ? reasons : ["no signals"] }
}

export * as Effort from "./effort"
