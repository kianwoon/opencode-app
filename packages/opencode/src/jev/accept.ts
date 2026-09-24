/**
 * Handoff acceptance gate — "did the returned result satisfy the acceptance
 * gate?" as a measured verdict, powering the two-strike subagent budget
 * mechanically instead of by prompt discipline. Doctrine (jev.md §3/§4):
 * noul is a fail-closed PREFILTER, choice is the verdict, gate on choice +
 * `probabilities[choice]`, never `confidence`. Fail-open: an unmeasured
 * decision returns `measured:false` so the caller falls back to the
 * prompt-level rule — a broken gate must never reject a good result.
 */
import {
  JEV_DEFAULT_THRESHOLD,
  JEV_DEFAULT_TIMEOUT_MS,
  jevFetchRetry,
  jevMeasuredChoice,
  jevTransport,
  type JevTransport,
} from "./client"

const GATE_MAX = 2_000
const RESULT_MAX = 6_000

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max))

export interface JevAcceptInput {
  readonly key: string
  /** The handoff's acceptance-gate text (what "done" means for the task). */
  readonly gate: string
  /** The hand's returned report to measure against the gate. */
  readonly result: string
  /** Minimum measured strength to accept (default 0.7). */
  readonly threshold?: number
  readonly timeoutMs?: number
  /** `provider/model-id` spec; defaults to `typesafe/jev-latest` (SystemOne). */
  readonly model?: string
  /** Endpoint seam for tests; overrides the transport lookup when set. */
  readonly transport?: Pick<JevTransport, "endpoint" | "id">
}

export interface JevAcceptDecision {
  /** True only on a MEASURED pass; never true on a fail-open path. */
  readonly accept: boolean
  /** False when nothing was measurable — caller falls back to the prompt-level two-strike rule. */
  readonly measured: boolean
  readonly noul: number | undefined
  readonly choice: string | undefined
  readonly strength: number | undefined
}

const unmeasured = (): JevAcceptDecision => ({
  accept: false,
  measured: false,
  noul: undefined,
  choice: undefined,
  strength: undefined,
})

/** Numeric `noul` from a bare number or a row carrying it; else undefined. */
const noulOf = (value: unknown): number | undefined => {
  const noul =
    typeof value === "number"
      ? value
      : typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)["noul"]
        : undefined
  return typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : undefined
}

/**
 * Pure fold. Measured noul below the threshold rejects immediately; otherwise
 * a MEASURED choice verdict decides; a measured noul pass with no choice row
 * accepts; anything unmeasured fails open to `measured:false`.
 */
export function foldJevAccept(answers: Record<string, unknown>, threshold: number): JevAcceptDecision {
  const noul = noulOf(answers["gate_ok"])
  const row = jevMeasuredChoice(answers["verdict"])
  if (noul !== undefined && noul < threshold) {
    return { accept: false, measured: true, noul, choice: row?.choice, strength: row?.strength }
  }
  if (row) {
    return {
      accept: row.choice === "accept" && row.strength >= threshold,
      measured: true,
      noul,
      choice: row.choice,
      strength: row.strength,
    }
  }
  if (noul !== undefined) return { accept: true, measured: true, noul, choice: undefined, strength: undefined }
  return unmeasured()
}

export async function jevAccept(input: JevAcceptInput): Promise<JevAcceptDecision> {
  const transport = input.transport ?? jevTransport(input.model)
  if (!transport) return unmeasured()
  const threshold = input.threshold ?? JEV_DEFAULT_THRESHOLD
  const timeoutMs = input.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS
  const state = JSON.stringify({ gate: clip(input.gate, GATE_MAX), result: clip(input.result, RESULT_MAX) })
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
        gate_ok: {
          type: "noul",
          instructions: "Does `result` fully satisfy the acceptance gate `gate`? 1 = fully satisfied, 0 = not at all.",
        },
        verdict: {
          type: "choice",
          instructions: "Given `gate` and `result`, what is the verdict?",
          criteria: {
            accept: "`result` satisfies the acceptance gate `gate`.",
            refire: "`result` misses the gate; one re-scoped re-fire is warranted.",
          },
        },
      },
    }),
  })
  if (!res?.ok) return unmeasured()
  const payload = await res.json().catch((): undefined => undefined)
  if (typeof payload !== "object" || payload === null) return unmeasured()
  const root = payload as Record<string, unknown>
  const answers = root["answers"] ?? root["decisions"] ?? root["results"]
  return typeof answers === "object" && answers !== null
    ? foldJevAccept(answers as Record<string, unknown>, threshold)
    : unmeasured()
}
