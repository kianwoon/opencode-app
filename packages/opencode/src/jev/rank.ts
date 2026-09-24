/**
 * Read pre-ranking — "which of these candidates should I read first?" as an
 * advisory Score ordering (jev.md §3: score for ordering, never for gating).
 * Score rows are normalized by their own legend (client parseJevAnswer:
 * normalizedScore = score / legend.maximum) so a 3/4 on a 4-level scale and a
 * 1/1 on a 1-level scale mean the same 1.0. Fold semantics mirror
 * session/arbitrate.ts: below-threshold = unranked tail, never dropped; ties
 * keep input order; unmeasured rows fail open; <2 candidates is unranked.
 */
import { JEV_DEFAULT_TIMEOUT_MS, jevFetchRetry, jevTransport, parseJevAnswer, type JevTransport } from "./client"

export const RANK_THRESHOLD_DEFAULT = 0.5
export const RANK_QUESTION_MAX = 2_000
export const RANK_CANDIDATE_MAX = 200

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max))

const RANK_CRITERIA = [
  "irrelevant to the question",
  "tangentially related",
  "relevant context",
  "must read to answer the question",
]

export interface JevRankInput {
  readonly key: string
  /** The question the candidates are ranked against. */
  readonly question: string
  /** Candidate identifiers (file paths, labels) in the caller's preferred order. */
  readonly candidates: readonly string[]
  /** Minimum normalized score (0..1) to trust for ranking; below = unranked tail. */
  readonly threshold?: number
  readonly timeoutMs?: number
  /** `provider/model-id` spec; defaults to `typesafe/jev-latest` (SystemOne). */
  readonly model?: string
  /** Endpoint seam for tests; overrides the transport lookup when set. */
  readonly transport?: Pick<JevTransport, "endpoint" | "id">
}

export interface JevRankResult {
  /** False when nothing measurable came back (fail open, input order). */
  readonly ranked: boolean
  /** Candidates: ranked first (desc normalized score), unranked tail in input order. */
  readonly order: readonly string[]
  readonly ranks: readonly { readonly candidate: string; readonly rank: number; readonly score: number }[]
}

const unranked = (candidates: readonly string[]): JevRankResult => ({
  ranked: false,
  order: [...candidates],
  ranks: [],
})

/**
 * Pure fold (mirrors session/arbitrate.ts). A parsed score at or above the
 * threshold ranks its candidate; every other row — unmeasured, malformed, or
 * below the cut — keeps its candidate in the unranked tail, never dropped.
 */
export function foldJevRank(
  answers: Record<string, unknown>,
  candidates: readonly string[],
  threshold: number,
): JevRankResult {
  const order = [...candidates]
  if (candidates.length < 2) return unranked(candidates)
  const scored: { candidate: string; score: number; index: number }[] = []
  for (let i = 0; i < candidates.length; i++) {
    const parsed = parseJevAnswer(answers[`cand:${i}`])
    if (parsed.type === "score" && parsed.normalizedScore >= threshold)
      scored.push({ candidate: candidates[i]!, score: parsed.normalizedScore, index: i })
  }
  if (scored.length === 0) return unranked(candidates)
  const ranked = scored.toSorted((a, b) => b.score - a.score || a.index - b.index)
  const rankedIDs = new Set(ranked.map((row) => row.candidate))
  const tail = candidates.filter((candidate) => !rankedIDs.has(candidate))
  return {
    ranked: true,
    order: [...ranked.map((row) => row.candidate), ...tail],
    ranks: ranked.map((row, i) => ({ candidate: row.candidate, rank: i + 1, score: row.score })),
  }
}

export async function jevRank(input: JevRankInput): Promise<JevRankResult> {
  const transport = input.transport ?? jevTransport(input.model)
  if (!transport) return unranked(input.candidates)
  const threshold = input.threshold ?? RANK_THRESHOLD_DEFAULT
  const timeoutMs = input.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS
  const state = JSON.stringify({
    question: clip(input.question, RANK_QUESTION_MAX),
    candidates: input.candidates.map((candidate) => clip(candidate, RANK_CANDIDATE_MAX)),
  })
  const questions: Record<string, unknown> = {}
  for (let i = 0; i < input.candidates.length; i++) {
    questions[`cand:${i}`] = {
      type: "score",
      instructions: `How relevant is \`candidates[${i}]\` to answering \`question\`?`,
      criteria: RANK_CRITERIA,
    }
  }
  const res = await jevFetchRetry(transport.endpoint, timeoutMs, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://opencode.ai/",
      "X-Title": "opencode",
    },
    body: JSON.stringify({ model: transport.id, state, questions }),
  })
  if (!res?.ok) return unranked(input.candidates)
  const payload = await res.json().catch((): undefined => undefined)
  if (typeof payload !== "object" || payload === null) return unranked(input.candidates)
  const root = payload as Record<string, unknown>
  const answers = root["answers"] ?? root["decisions"] ?? root["results"]
  return typeof answers === "object" && answers !== null
    ? foldJevRank(answers as Record<string, unknown>, input.candidates, threshold)
    : unranked(input.candidates)
}
