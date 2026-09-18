/**
 * Memory-hygiene classifier (#8 memory hygiene).
 *
 * The seam decides whether a lesson/event is worth storing, duplicates an
 * existing entry, is stale, and its scope — all in ONE batched request. The
 * `noul` questions are phrased so YES = the good/keep outcome (worth storing,
 * is a duplicate, is stale), plus a `choice` for scope.
 *
 * Nothing calls this yet; wiring it into the loop is a later piece.
 *
 * @module @opencode-ai/opencode/classifier/memory
 */
export * as ClassifierMemory from "./memory"

import { Effect } from "effect"

import { type Answer, type Question } from "./schema"
import { ClassifierClient } from "./client"

// --- Pure state --------------------------------------------------------------

/** Where a stored memory belongs; `none` means do not store. */
export const MEMORY_SCOPES = ["project", "global", "none"] as const

export const MEMORY_KEYS = {
  worthStoring: "worth_storing",
  duplicateOfExisting: "duplicate_of_existing",
  isStale: "is_stale",
  scope: "scope",
} as const

const EXCERPT_CHARS = 300

/** Bound the candidate/existing excerpts; never inline a huge payload. */
export const memoryExcerpt = (text: string): string =>
  text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS)}…`

/**
 * The batched question map for a candidate lesson against existing memories.
 * Every `noul` is phrased so YES is the good/keep outcome:
 * `worth_storing` yes = store it; `duplicate_of_existing` yes = it duplicates;
 * `is_stale` yes = it is stale and should not be re-added.
 */
export function buildMemoryQuestions(candidate: string, existing: readonly string[]): Record<string, Question> {
  const existingExcerpts = existing.map(memoryExcerpt).join(" | ")
  return {
    [MEMORY_KEYS.worthStoring]: {
      type: "noul",
      instructions: `Is this lesson worth storing as durable memory? Candidate: ${memoryExcerpt(candidate)}`,
      criteria: { true: "worth storing", false: "not worth storing" },
    },
    [MEMORY_KEYS.duplicateOfExisting]: {
      type: "noul",
      instructions: `Does this candidate duplicate an existing memory? Candidate: ${memoryExcerpt(candidate)}. Existing: ${existingExcerpts}`,
      criteria: { true: "duplicate", false: "novel" },
    },
    [MEMORY_KEYS.isStale]: {
      type: "noul",
      instructions: `Is this candidate stale or obsolete? Candidate: ${memoryExcerpt(candidate)}. Existing: ${existingExcerpts}`,
      criteria: { true: "stale", false: "current" },
    },
    [MEMORY_KEYS.scope]: {
      type: "choice",
      instructions: `What scope should this memory have? Candidate: ${memoryExcerpt(candidate)}`,
      criteria: Object.fromEntries(MEMORY_SCOPES.map((scope) => [scope, scope])),
    },
  }
}

/** Extract the `noul` probability (0..1); absent/unrecognised → `undefined`. */
export function memoryProbability(answer: Answer | undefined): number | undefined {
  if (!answer || answer.type !== "noul") return undefined
  return Number.isFinite(answer.noul) ? answer.noul : undefined
}

const YES = 0.5

/** `undefined` probability counts as "no signal"; a caller decides via default. */
const yes = (answer: Answer | undefined): boolean => {
  const p = memoryProbability(answer)
  return p !== undefined && p >= YES
}

export interface MemoryResult {
  store: boolean
  duplicate: boolean
  stale: boolean
  scope: string
}

/**
 * Fold answers into the memory verdict. Fail-open: an absent `worth_storing`
 * answer ⇒ `store: false` — we do NOT pollute durable memory on no signal; a
 * missing scope defaults to `"none"`. `duplicate`/`stale` default to the
 * no-signal-safe `false` (unknown duplication/staleness does not, by itself,
 * block storage — `worth_storing` alone gates `store`).
 */
export function evaluateMemory(input: { answers: Record<string, Answer> }): MemoryResult {
  const scopeAnswer = input.answers[MEMORY_KEYS.scope]
  const rawScope = scopeAnswer?.type === "choice" ? scopeAnswer.choice : undefined
  const scope = (MEMORY_SCOPES as readonly string[]).includes(rawScope ?? "") ? rawScope! : "none"
  return {
    store: yes(input.answers[MEMORY_KEYS.worthStoring]),
    duplicate: yes(input.answers[MEMORY_KEYS.duplicateOfExisting]),
    stale: yes(input.answers[MEMORY_KEYS.isStale]),
    scope,
  }
}

// --- Deterministic fallback --------------------------------------------------

/**
 * Network-free memory verdict: `store: false`. There is no offline signal that
 * can justify writing durable memory, so the conservative answer is "do not
 * store".
 */
export function ruleBasedMemory(): MemoryResult {
  return { store: false, duplicate: false, stale: false, scope: "none" }
}

// --- Effectful half (one Jev batch) ------------------------------------------

/**
 * Ask all memory questions in ONE `client.ask` call and fold the answers.
 * Deliberately not a loop: batching is the whole point of this seam.
 */
export const classifyMemory = (input: {
  client: ClassifierClient.Interface
  model: string
  state: string
  candidate: string
  existing: readonly string[]
}): Effect.Effect<MemoryResult, ClassifierClient.SystemOneError> =>
  Effect.gen(function* () {
    const questions = buildMemoryQuestions(input.candidate, input.existing)
    const response = yield* input.client.ask({
      model: input.model,
      state: input.state,
      questions,
    })
    return evaluateMemory({ answers: response.answers })
  })
