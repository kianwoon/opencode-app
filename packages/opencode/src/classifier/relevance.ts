/**
 * Context-relevance classifier.
 *
 * The seam asks ONE batched question per context section ("is this section
 * relevant to the current task?"), so N sections cost one request, exactly like
 * the retry batch. The decisive logic is PURE and fail-open: an absent or
 * undecodable answer NEVER prunes — it keeps the section.
 *
 * Nothing calls this yet; wiring it into the loop is a later piece.
 *
 * @module @opencode-ai/opencode/classifier/relevance
 */
export * as ClassifierRelevance from "./relevance"

import { Effect } from "effect"

import {
  type Answer,
  type ClassifierDecision,
  type ReasonCode,
  type RelevanceDecision,
} from "./schema"
import { ClassifierClient } from "./client"

// --- Pure state --------------------------------------------------------------

/** One addressable slice of the context sent to the model. */
export interface ContextSection {
  readonly id: string
  readonly text: string
  readonly label?: string
}

/** How much of a section's text may travel inside the question instruction. */
const SECTION_EXCERPT_CHARS = 200

/**
 * A section can be huge, so the question carries a bounded EXCERPT rather than
 * the whole text: `state` is already TEXT ONLY and holds the same material, so
 * inlining it again would double the request for no extra signal. The excerpt
 * gives the model an anchor to the right section without the token cost.
 */
export const sectionExcerpt = (text: string): string =>
  text.length <= SECTION_EXCERPT_CHARS ? text : `${text.slice(0, SECTION_EXCERPT_CHARS)}…`

/**
 * One `noul` question per section, keyed by section id. Pure: the ONLY input is
 * the section list, so batching costs are visible and testable at the call site.
 */
export function buildSectionQuestions(
  task: string,
  sections: readonly ContextSection[],
  extras?: readonly GatingExtra[],
): Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> {
  // The task travels ONCE, out of band in `state` (see `classifyRelevance`);
  // Jev ingests `state`, so re-interpolating it into every instruction would
  // transmit it 1 + N times and blow the 64k per-request budget on big sessions.
  void task
  return Object.fromEntries(
    sections.flatMap((section) => {
      const base = [
        section.id,
        {
          type: "noul" as const,
          instructions: `Is section "${section.label ?? section.id}" relevant to the current task? Section excerpt: ${sectionExcerpt(section.text)}`,
          criteria: { true: "relevant", false: "irrelevant" },
        },
      ] as const
      // No extras requested → byte-identical to the legacy single-question shape.
      if (!extras || extras.length === 0) return [base]
      const extraEntries = extras.map(
        (extra) =>
          [
            extraQuestionKey(section.id, extra),
            {
              type: "noul" as const,
              instructions: `${GATING_EXTRAS[extra].question} Section "${section.label ?? section.id}". Section excerpt: ${sectionExcerpt(section.text)}`,
              criteria: GATING_EXTRAS[extra].criteria,
            },
          ] as const,
      )
      return [base, ...extraEntries]
    }),
  )
}

/**
 * Cap on sections classified in ONE request. The vendor budget is 64k tokens
 * for `state` + ALL questions combined; `state` is the task (unbounded, but in
 * practice a few hundred tokens) and each question is a short instruction plus
 * a ≤200-char excerpt (~60–80 tokens worst case). 64k / ~100 ≈ 640, so 400
 * leaves a large margin for a long task and generous tokenizer variance.
 *
 * Honesty: when there are more sections than this, the OLDEST are skipped and
 * are NEVER classified — so they can never be pruned. That is a real coverage
 * limitation, not a free win. We take the tail because the most recent sections
 * are the ones most likely to be relevant to the current task.
 */
export const MAX_SECTIONS_PER_REQUEST = 400

/** The tail (most recent) `MAX_SECTIONS_PER_REQUEST` sections, plus skip stats. */
export function capSections(sections: readonly ContextSection[]): {
  considered: number
  requested: number
  skipped: number
  sections: readonly ContextSection[]
} {
  const requested = Math.min(sections.length, MAX_SECTIONS_PER_REQUEST)
  return {
    considered: sections.length,
    requested,
    skipped: sections.length - requested,
    sections: requested === sections.length ? sections : sections.slice(sections.length - requested),
  }
}

// --- Extra context-gating questions (Task #7) --------------------------------

/** The fuller gating questions #7 asks beyond the single relevance one. */
export type GatingExtra = "include_in_context" | "still_relevant" | "duplicate" | "superseded" | "needs_full_read"

/** Per-extra question text + true/false criteria. Pure data, keyed by name. */
export const GATING_EXTRAS: Record<GatingExtra, { question: string; criteria: { true: string; false: string } }> = {
  include_in_context: {
    question: "Should this section be included in the model context?",
    criteria: { true: "include", false: "exclude" },
  },
  still_relevant: {
    question: "Is this section still relevant, or has it been made obsolete?",
    criteria: { true: "still relevant", false: "obsolete" },
  },
  duplicate: {
    question: "Does this section duplicate information already present elsewhere?",
    criteria: { true: "duplicate", false: "distinct" },
  },
  superseded: {
    question: "Has this section been superseded by a newer message or decision?",
    criteria: { true: "superseded", false: "current" },
  },
  needs_full_read: {
    question: "Does the task require reading this section in full rather than an excerpt?",
    criteria: { true: "needs full read", false: "excerpt sufficient" },
  },
}

/** Key a per-section extra answer so it cannot collide with a section id. */
export const extraQuestionKey = (sectionID: string, extra: GatingExtra): string => `${sectionID}:${extra}`

/** Extract the `noul` probability (0..1); absent/unrecognised answers → `undefined`. */
export function relevanceProbability(answer: Answer | undefined): number | undefined {
  if (!answer || answer.type !== "noul") return undefined
  return Number.isFinite(answer.noul) ? answer.noul : undefined
}

export interface SectionVerdict {
  id: string
  noul: number
  keep: boolean
}

/**
 * Fold answers into per-section verdicts. Fail-open: an answer that is missing,
 * malformed or non-finite keeps its section and is reported with `noul: 1`.
 * Unknown section ids in `answers` are ignored (we only report requested ones).
 */
export function evaluateRelevance(input: {
  answers: Record<string, Answer>
  sections: readonly ContextSection[]
  threshold: number
}): SectionVerdict[] {
  return input.sections.map((section) => {
    const noul = relevanceProbability(input.answers[section.id])
    if (noul === undefined) return { id: section.id, noul: 1, keep: true }
    return { id: section.id, noul, keep: noul >= input.threshold }
  })
}

/** Per-section gating verdict folded from the extra #7 questions. */
export interface GatingVerdict {
  id: string
  include: boolean
  stillRelevant: boolean
  duplicate: boolean
  superseded: boolean
  needsFullRead: boolean
}

/**
 * Fold the extra gating answers into a per-section verdict. FAIL-OPEN: an absent
 * or undecodable answer NEVER drops context — `include` defaults true and the
 * "bad" flags (`duplicate`, `superseded`) default false, while `stillRelevant`
 * and `needsFullRead` default true. Only a FINITE answer can flip a flag.
 */
export function evaluateGating(input: {
  answers: Record<string, Answer>
  sections: readonly ContextSection[]
  extras?: readonly GatingExtra[]
}): GatingVerdict[] {
  const flag = (sectionID: string, extra: GatingExtra): boolean | undefined => {
    const noul = relevanceProbability(input.answers[extraQuestionKey(sectionID, extra)])
    return noul === undefined ? undefined : noul >= 0.5
  }
  return input.sections.map((section) => {
    const deprecated = flag(section.id, "still_relevant")
    return {
      id: section.id,
      include: flag(section.id, "include_in_context") ?? true,
      stillRelevant: deprecated ?? true,
      duplicate: flag(section.id, "duplicate") ?? false,
      superseded: flag(section.id, "superseded") ?? false,
      needsFullRead: flag(section.id, "needs_full_read") ?? true,
    }
  })
}

/** Which sections the batch would prune; `[]` when every verdict fails open. */
export const prunableSections = (verdicts: readonly SectionVerdict[]): SectionVerdict[] =>
  verdicts.filter((verdict) => !verdict.keep)

/** Every section kept, at certainty 1 — the deterministic offline stance. */
export const keepAllVerdicts = (sections: readonly ContextSection[]): SectionVerdict[] =>
  sections.map((section) => ({ id: section.id, noul: 1, keep: true }))

/**
 * Collapse verdicts into the single seam decision. Prunable sections exist only
 * when a REAL answer crossed the threshold, so `PRUNE` is never reached from
 * absent data; an empty batch is `UNSURE`, not a vacuous `KEEP`.
 */
export function toRelevanceResult(
  verdicts: readonly SectionVerdict[],
): { decision: RelevanceDecision; reasonCode: ReasonCode; confidence: number } {
  if (verdicts.length === 0) return { decision: "UNSURE", reasonCode: "CONTEXT_UNKNOWN", confidence: 0 }
  const prunable = prunableSections(verdicts)
  if (prunable.length > 0) {
    const weakest = Math.min(...prunable.map((verdict) => verdict.noul))
    return { decision: "PRUNE", reasonCode: "CONTEXT_IRRELEVANT", confidence: 1 - weakest }
  }
  const strongestKept = Math.max(...verdicts.filter((verdict) => verdict.noul < 1).map((verdict) => verdict.noul))
  // Every section failed open (no real answer): that is uncertainty, not evidence.
  if (!Number.isFinite(strongestKept)) {
    return { decision: "UNSURE", reasonCode: "CONTEXT_UNKNOWN", confidence: 0 }
  }
  return { decision: "KEEP", reasonCode: "CONTEXT_RELEVANT", confidence: strongestKept }
}

// --- Deterministic fallback classifier ---------------------------------------

/**
 * Network-free relevance verdict: keep everything. There is no offline signal
 * that can justify dropping context, so the safe deterministic answer is `KEEP`.
 */
export function ruleBasedRelevance(
  verdicts: readonly SectionVerdict[],
): { decision: RelevanceDecision; reasonCode: ReasonCode; confidence: number } {
  const kept = verdicts.filter((verdict) => verdict.keep)
  return {
    decision: "KEEP",
    reasonCode: "CONTEXT_RELEVANT",
    confidence: verdicts.length === 0 ? 0 : kept.length / verdicts.length,
  }
}

/** Pure guards consulted before a PRUNE verdict may be acted on. */
export const shouldActOnRelevance = (input: {
  decision: RelevanceDecision
  confidence: number
  threshold: number
  fallbackUsed?: boolean
}): boolean => {
  if (input.decision !== "PRUNE") return false
  if (input.fallbackUsed === true) return false
  if (!Number.isFinite(input.confidence)) return false
  return input.confidence >= input.threshold
}

/**
 * Wrap a pure verdict in the domain envelope. `latencyMs`/`fallbackUsed` come
 * from the caller so this stays pure and testable.
 */
export function toDecision(
  classifier: string,
  result: { decision: RelevanceDecision; reasonCode: ReasonCode; confidence: number },
  meta: { latencyMs: number; fallbackUsed: boolean },
): ClassifierDecision<RelevanceDecision> {
  return {
    decision: result.decision,
    confidence: result.confidence,
    reasonCode: result.reasonCode,
    classifier,
    latencyMs: meta.latencyMs,
    fallbackUsed: meta.fallbackUsed,
  }
}

// --- Effectful half (one Jev batch) ------------------------------------------

export interface RelevanceInput {
  readonly task: string
  readonly sections: readonly ContextSection[]
  /** Overrides the configured `thresholds.relevance.accept`. */
  readonly threshold?: number
}

/**
 * Ask about EVERY section in ONE `client.ask` call and fold the answers.
 * Deliberately not a loop: batching is the whole point of this seam.
 */
export const classifyRelevance = (input: {
  client: ClassifierClient.Interface
  model: string
  task: string
  sections: readonly ContextSection[]
  threshold: number
  /** Optional extra #7 gating questions; absent ⇒ legacy single-question batch. */
  extras?: readonly GatingExtra[]
}): Effect.Effect<
  {
    decision: RelevanceDecision
    reasonCode: ReasonCode
    confidence: number
    verdicts: SectionVerdict[]
    gating: GatingVerdict[]
  },
  ClassifierClient.SystemOneError
> =>
  Effect.gen(function* () {
    const capped = capSections(input.sections)
    const questions = buildSectionQuestions(input.task, capped.sections, input.extras)
    const response = yield* input.client.ask({
      model: input.model,
      state: input.task,
      questions,
    })
    const verdicts = evaluateRelevance({
      answers: response.answers,
      sections: capped.sections,
      threshold: input.threshold,
    })
    const gating = evaluateGating({
      answers: response.answers,
      sections: capped.sections,
      extras: input.extras,
    })
    return { ...toRelevanceResult(verdicts), verdicts, gating }
  })
