/**
 * compaction-triage — one JEV choice per oversize section: keep / summarize / drop.
 *
 * Asked BEFORE a section is summarized, so a section the agent must follow
 * verbatim can ride through byte-identical instead of being compressed.
 * Decisive only at strength >= DECISIVE_STRENGTH; every other outcome — a weak
 * row, an absent row, a missing key, an unknown provider, a timeout — resolves
 * to "summarize", which is exactly what the gate did before triage existed. So
 * enabling triage can never make the gate MORE destructive than its default.
 *
 * Transport is inherited wholesale from jev-effort (same endpoints, same key
 * lookup, same model resolution) — plugin-lib stays zero-dependency. The key is
 * never logged; only the verdict and its strength leave this module.
 */

import { DEFAULT_JEV_EFFORT, jevKeyFor, jevTransport, resolveJevModel } from "./jev-effort.ts"

export type TriageDecision = "keep" | "summarize" | "drop"

/** `strength` is null when no measured row existed (transport failure, no key). */
export type TriageVerdict = { decision: TriageDecision; strength: number | null }

/** Below this the row is not trusted and the caller summarizes (fail-safe). */
const DECISIVE_STRENGTH = 0.5
const REQUEST_TIMEOUT_MS = 3_000
const EXCERPT_CHARS = 400

const STATE =
  "Decide how one oversize instruction section should enter a coding agent's system prompt. " +
  "keep: the agent must follow it verbatim for the work at hand. " +
  "summarize: relevant context that survives compression. " +
  "drop: irrelevant to the work at hand."

const CRITERIA: Record<string, string | null> = {
  keep: "rules the agent must follow verbatim right now",
  summarize: "relevant context, compressible without losing imperatives",
  drop: "irrelevant to the current work",
}

const DECISIONS: TriageDecision[] = ["keep", "summarize", "drop"]

const isDecision = (v: unknown): v is TriageDecision => typeof v === "string" && (DECISIONS as string[]).includes(v)

/** Reuse jev-effort's resolution: global jevDefault.model > shipped default. */
const resolveSpec = (): string => resolveJevModel(DEFAULT_JEV_EFFORT)

const excerpt = (text: string): string => (text.length <= EXCERPT_CHARS ? text : text.slice(0, EXCERPT_CHARS))

const buildQuestions = (path: string, text: string) => ({
  compaction: {
    type: "choice" as const,
    instructions: `How should this instruction section (${path}) enter the system prompt? Section: "${excerpt(text)}"`,
    criteria: CRITERIA,
  },
})

/**
 * Pull the chosen label + its MEASURED strength. `strength` is
 * `probabilities[choice]`, never `confidence` — confidence is faith in the
 * LABEL, so a confident "drop" would otherwise clear the bar. An absent numeric
 * row returns null and the caller summarizes.
 */
export function foldTriageAnswer(body: unknown): TriageVerdict | null {
  if (!body || typeof body !== "object") return null
  const answers = (body as { answers?: unknown }).answers
  if (!answers || typeof answers !== "object") return null
  const answer = (answers as Record<string, unknown>).compaction
  if (!answer || typeof answer !== "object") return null
  const a = answer as Record<string, unknown>
  const choice = a.choice ?? a.answer ?? a.value
  if (!isDecision(choice)) return null
  const probabilities = a.probabilities
  const raw =
    probabilities && typeof probabilities === "object"
      ? (probabilities as Record<string, unknown>)[choice]
      : undefined
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  return { decision: choice, strength: raw }
}

/**
 * One choice question. Returns null on ANY problem — transport error, timeout,
 * missing key, absent/weak row — so the caller's default ("summarize") applies.
 * The bar is enforced here, not at the call site, so no caller can forget it.
 */
export async function classifyCompaction(path: string, text: string): Promise<TriageVerdict | null> {
  const transport = jevTransport(resolveSpec())
  const key = transport && jevKeyFor(transport.provider)
  if (!transport || !key) return null
  try {
    const res = await fetch(transport.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: transport.id, state: STATE, questions: buildQuestions(path, text) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const verdict = foldTriageAnswer(await res.json())
    if (!verdict || verdict.strength === null || verdict.strength < DECISIVE_STRENGTH) return null
    return verdict
  } catch {
    return null
  }
}
