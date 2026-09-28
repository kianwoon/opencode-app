/**
 * Session state labeling — advisory classification for predictive features, never
 * a gate. The measured noul is a numeric prefilter; the constrained choice and
 * its probability are the verdict. Unmeasured labels fail open unlabeled.
 */
import { JEV_DEFAULT_TIMEOUT_MS, jevFetchRetry, jevTransport, parseJevAnswer, type JevTransport } from "./client.ts"

export const LABEL_OPTIONS = ["thrive", "stall", "bloat", "drift"] as const
export const LABEL_THRESHOLD_DEFAULT = 0.7
export const LABEL_SNAPSHOT_MAX = 4_000

const LABEL_CRITERIA = {
  thrive: "productive momentum, progress per cost healthy",
  stall: "stuck or idle, repeated similar prompts without new progress",
  bloat: "context or cost growing faster than progress",
  drift: "active but moving off the stated objective",
} as const

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max))

export interface JevLabelInput {
  readonly key: string
  readonly snapshot: string
  readonly objective?: string
  /** Minimum measured noul (0..1) to trust the label (default 0.7). */
  readonly threshold?: number
  readonly timeoutMs?: number
  /** `provider/model-id` spec; defaults to `typesafe/jev-latest` (SystemOne). */
  readonly model?: string
  /** Endpoint seam for tests; overrides the transport lookup when set. */
  readonly transport?: Pick<JevTransport, "endpoint" | "id">
}

export interface JevLabelResult {
  readonly labeled: boolean
  readonly label: string | null
  readonly measured: boolean
  readonly noul: number | null
  readonly strength: number | null
  readonly probabilities: Readonly<Record<string, number>>
  readonly options: readonly string[]
}

const unlabeled = (options: readonly string[]): JevLabelResult => ({
  labeled: false,
  label: null,
  measured: false,
  noul: null,
  strength: null,
  probabilities: {},
  options,
})

const probability = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null

export function foldJevLabel(answer: unknown, options: readonly string[], threshold: number): JevLabelResult {
  const root = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {}
  const choiceAnswer = Object.hasOwn(root, "label") ? root["label"] : root
  const noulAnswer = Object.hasOwn(root, "noul")
    ? typeof root["noul"] === "object"
      ? root["noul"]
      : { noul: root["noul"] }
    : root
  const parsed = parseJevAnswer(choiceAnswer)
  const noulDecision = parseJevAnswer(noulAnswer)
  const noul = noulDecision.type === "noul" ? noulDecision.noul : null
  if (noul === null || parsed.type !== "choice") return unlabeled(options)
  const choice = parsed.choice
  const probabilities = parsed.probabilities
  if (!options.includes(choice)) {
    return { labeled: false, label: null, measured: true, noul, strength: null, probabilities: {}, options }
  }
  const strength = probability(probabilities[choice])
  if (strength === null) return unlabeled(options)
  return {
    labeled: noul >= threshold,
    label: choice,
    measured: true,
    noul,
    strength,
    probabilities,
    options,
  }
}

export async function jevLabel(input: JevLabelInput): Promise<JevLabelResult> {
  const transport = input.transport ?? jevTransport(input.model)
  if (!transport) return unlabeled(LABEL_OPTIONS)
  const threshold = input.threshold ?? LABEL_THRESHOLD_DEFAULT
  const timeoutMs = input.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS
  const state = JSON.stringify({
    snapshot: clip(input.snapshot, LABEL_SNAPSHOT_MAX),
    ...(input.objective !== undefined ? { objective: input.objective } : {}),
  })
  const res = await jevFetchRetry(transport.endpoint, timeoutMs, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://opencode.ai/",
      "X-Title": "opencode",
    },
    body: JSON.stringify({
      model: transport.id,
      state,
      questions: {
        label: {
          type: "choice",
          instructions: "Which state is this session in? Choose exactly one.",
          criteria: LABEL_CRITERIA,
        },
        noul: {
          type: "noul",
          instructions: "Is the session state classification reliable? 1 = fully reliable, 0 = not at all.",
        },
      },
    }),
  })
  if (!res?.ok) return unlabeled(LABEL_OPTIONS)
  const payload = await res.json().catch((): undefined => undefined)
  if (typeof payload !== "object" || payload === null) return unlabeled(LABEL_OPTIONS)
  const root = payload as Record<string, unknown>
  const answers = root["answers"] ?? root["decisions"] ?? root["results"]
  return typeof answers === "object" && answers !== null
    ? foldJevLabel(answers as Record<string, unknown>, LABEL_OPTIONS, threshold)
    : unlabeled(LABEL_OPTIONS)
}
