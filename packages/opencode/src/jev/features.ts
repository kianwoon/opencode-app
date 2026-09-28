/**
 * Discriminative session features for jev_label snapshots — wall-clock duration
 * alone cannot distinguish thriving from stalled sessions; these expose idle
 * inflation, prompt looping, and todo churn (2026-09-25 probe evidence).
 */

const MS_PER_HOUR = 3_600_000

export interface PromptRow {
  readonly time: number
  readonly text: string
}

export interface TemporalFeatures {
  readonly wall_hours: number
  readonly active_span_hours: number
  readonly max_idle_hours: number
  readonly idle_ratio: number
  readonly prompt_count: number
}

export interface RecencyFeatures {
  readonly trailing_idle_hours: number
  readonly recent_prompts: number
  readonly recent_repetition_score: number
}

export function extractTemporalFeatures(
  sessionStart: number,
  sessionEnd: number,
  times: readonly number[],
): TemporalFeatures {
  // A non-numeric sqlite `time` would poison every gap below with NaN.
  const finite = times.filter((time) => Number.isFinite(time))
  if (finite.length === 0)
    return { wall_hours: 0, active_span_hours: 0, max_idle_hours: 0, idle_ratio: 0, prompt_count: 0 }
  const gaps = finite.slice(1).map((time, index) => time - finite[index]!)
  const wallMs = Math.max(sessionEnd - sessionStart, 0)
  const maxIdleMs = gaps.length === 0 ? 0 : Math.max(...gaps)
  return {
    wall_hours: wallMs / MS_PER_HOUR,
    active_span_hours: (finite[finite.length - 1]! - finite[0]!) / MS_PER_HOUR,
    max_idle_hours: maxIdleMs / MS_PER_HOUR,
    idle_ratio: wallMs > 0 ? maxIdleMs / wallMs : 0,
    prompt_count: times.length,
  }
}

export function extractRecencyFeatures(
  sessionEnd: number,
  prompts: readonly PromptRow[],
  windowMinutes = 60,
): RecencyFeatures {
  const timed = prompts.filter((prompt) => Number.isFinite(prompt.time))
  if (timed.length === 0)
    return { trailing_idle_hours: 0, recent_prompts: 0, recent_repetition_score: 0 }
  const lastPrompt = timed[timed.length - 1]!
  const windowStart = sessionEnd - windowMinutes * 60_000
  const recent = prompts.filter((prompt) => prompt.time >= windowStart && prompt.time <= sessionEnd)
  return {
    trailing_idle_hours: Math.max(sessionEnd - lastPrompt.time, 0) / MS_PER_HOUR,
    recent_prompts: recent.length,
    recent_repetition_score: computeRepetitionScore(recent.map((prompt) => prompt.text)),
  }
}

const tokens = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((token) => token.length >= 3),
  )

const jaccard = (left: Set<string>, right: Set<string>): number => {
  const intersection = [...left].filter((token) => right.has(token)).length
  const union = new Set([...left, ...right]).size
  return union === 0 ? 0 : intersection / union
}

export function computeRepetitionScore(texts: readonly string[]): number {
  if (texts.length < 2) return 0
  const scores = texts.slice(1).map((text, index) => jaccard(tokens(texts[index]!), tokens(text)))
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length
  return Math.min(1, Math.max(0, average))
}

export function computeTodoChurn(toolCounts: Record<string, number>, promptCount: number): number {
  if (promptCount <= 0) return 0
  return (toolCounts["todowrite"] ?? 0) / promptCount
}
