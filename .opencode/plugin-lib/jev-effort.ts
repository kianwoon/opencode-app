/**
 * jev-effort — cache-first Jev tier-classification for the task-effort-router.
 *
 * One detached choice question per user message: which reasoning-effort tier
 * does this request need? Fail-open: any error, timeout, or absent key returns
 * null, so a broken classifier never affects routing. Verdicts are memoized by
 * a key of (djb2 hash of the exact text + "|" + resolved model spec) so a memo
 * hit is byte-identical and sync — no per-message recompute, no cache churn.
 * The spec is part of the key: the SAME prompt classified under two different
 * models must never share a verdict.
 *
 * Config lives at `jev` in ~/.config/opencode/effort-router.json and is OFF by
 * default; nothing here runs unless the router opts in.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json")
const GLOBAL_CONFIG_FILE = join(homedir(), ".config", "opencode", "opencode.json")
export const MEMO_MAX = 200
const REQUEST_TIMEOUT_MS = 3_000
const EXCERPT_CHARS = 400

/**
 * Provider-aware transport, copied from packages/opencode/src/jev/client.ts:55-99
 * (plugin-lib must stay zero-dependency, so the pattern is mirrored not imported).
 * A `provider/model-id` spec resolves to its own endpoint: a `typesafe/*` spec
 * NEVER goes to openrouter.ai. Unknown providers return undefined so the caller
 * fails open instead of POSTing a decisions payload at a provider that cannot
 * answer it.
 */
const JEV_ENDPOINTS: Readonly<Record<string, string>> = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/alpha/decisions",
}

/** typesafe aliases normalized to a wire-accepted id; unknown ids → jev-latest. */
const JEV_TYPESAFE_MODELS: Readonly<Record<string, string>> = {
  "jev-latest": "jev-latest",
  "jev-1.13": "jev-latest",
  "jev-1.13.0": "jev-1.13.0",
}

const typesafeWireId = (id: string): string => JEV_TYPESAFE_MODELS[id] ?? "jev-latest"

/** Env var per provider namespace, tried after the matching auth.json entry. */
const JEV_KEY_ENV: Readonly<Record<string, string>> = { typesafe: "TYPESAFE_API_KEY", openrouter: "OPENROUTER_API_KEY" }

export type JevTransport = { provider: string; id: string; endpoint: string }

/**
 * Resolve a `provider/model-id` spec to a transport. typesafe ids are normalized
 * to a wire id; openrouter ids pass through verbatim. A missing provider/id or an
 * unknown provider prefix returns undefined (fail-open).
 */
export const jevTransport = (spec: string): JevTransport | undefined => {
  const raw = spec.trim()
  const slash = raw.indexOf("/")
  if (slash <= 0) return undefined
  const provider = raw.slice(0, slash)
  const rawId = raw.slice(slash + 1)
  if (!rawId) return undefined
  const endpoint = JEV_ENDPOINTS[provider]
  if (!endpoint) return undefined
  const id = provider === "typesafe" ? typesafeWireId(rawId) : rawId
  return { provider, id, endpoint }
}

/**
 * Read the key for a provider namespace from auth.json, then its env var. The
 * key is never logged. An unknown namespace has no env var and fails open.
 */
export const jevKeyFor = (provider: string): string | undefined => {
  try {
    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<string, { key?: string }>
    const k = auth[provider]?.key
    if (typeof k === "string" && k.length > 0) return k
  } catch {
    // fall through to env
  }
  const name = JEV_KEY_ENV[provider]
  const env = name ? process.env[name] : undefined
  return typeof env === "string" && env.length > 0 ? env : undefined
}

/**
 * Read the global `jevDefault.model` from ~/.config/opencode/opencode.json so an
 * effort-router.json that omits `model` inherits the user's default Jev provider
 * instead of the shipped constant. Fail-open undefined if unreadable.
 */
export const readGlobalJevDefaultModel = (): string | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(GLOBAL_CONFIG_FILE, "utf8")) as { jevDefault?: { model?: unknown } }
    const m = parsed.jevDefault?.model
    return typeof m === "string" && m.length > 0 ? m : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the effective model spec: explicit config wins, then the global
 * `jevDefault.model`, then the shipped default. Single source of truth for both
 * the network call and the memo key, so a spec change invalidates the memo.
 */
export const resolveJevModel = (cfg: JevEffortConfig = DEFAULT_JEV_EFFORT): string =>
  cfg.model || readGlobalJevDefaultModel() || DEFAULT_JEV_EFFORT.model

export type EffortTier = "minimal" | "low" | "medium" | "high"

export type JevEffortConfig = {
  enabled: boolean
  model: string
  threshold: number
}

export const DEFAULT_JEV_EFFORT: JevEffortConfig = {
  enabled: false,
  model: "typesafe/jev-1.13",
  threshold: 0.5,
}

/** Coerce the raw `jev` JSON block into a validated config (fail to defaults). */
export const resolveJevEffortConfig = (raw: unknown): JevEffortConfig => {
  if (!raw || typeof raw !== "object") return DEFAULT_JEV_EFFORT
  const r = raw as Record<string, unknown>
  return {
    enabled: r.enabled === true,
    model: typeof r.model === "string" && r.model.length > 0 ? r.model : DEFAULT_JEV_EFFORT.model,
    threshold:
      typeof r.threshold === "number" && Number.isFinite(r.threshold) && r.threshold >= 0 && r.threshold <= 1
        ? r.threshold
        : DEFAULT_JEV_EFFORT.threshold,
  }
}
/** One `noul` question (jev.md §2: numeric 0..1, never boolean). Fail-open null. */
export const classifyNoul = async (state: string, model: string): Promise<number | null> => {
  const t = jevTransport(model)
  const key = t && jevKeyFor(t.provider)
  if (!t || !key) return null
  // A `noul` question carries NO `criteria` (jev.md §2/§3: it emits no
  // confidence/probabilities, so there are no labels to describe); sending one 422s.
  const questions = { guardrail: { type: "noul", instructions: "Is this proposed action permitted given the goal and policy state?" } }
  try {
    const res = await fetch(t.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: t.id, state, questions }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) return null
    const noul = ((await res.json()) as { answers?: { guardrail?: { noul?: unknown } } }).answers?.guardrail?.noul
    return typeof noul === "number" && Number.isFinite(noul) ? noul : null
  } catch { return null }
}

/**
 * A categorical tier verdict. `strength` is the MEASURED score for the chosen
 * label (`probabilities[choice]`), never `confidence` — confidence is the
 * model's confidence in its own LABEL, so a confident SKIP would otherwise
 * clear a threshold (see the routing lesson). An unmeasured row yields no
 * TierResult at all (fail-open no-op), so gating can never run on a fabricated
 * number.
 */
export type TierResult = { tier: EffortTier; strength: number }

const STATE =
  "Route each developer request to the reasoning effort tier it needs to complete correctly. " +
  "Tiers: minimal (trivial acknowledgements), low (simple mechanical changes), " +
  "medium (standard feature work with some design), high (deep debugging, concurrency, " +
  "distributed systems, architecture)."

const CRITERIA: Record<string, string | null> = {
  minimal: "trivial acknowledgement",
  low: "simple mechanical change",
  medium: "standard feature work with some design",
  high: "deep debugging, concurrency, distributed systems, architecture",
}

const TIERS: EffortTier[] = ["minimal", "low", "medium", "high"]

const isTier = (v: unknown): v is EffortTier => typeof v === "string" && (TIERS as string[]).includes(v)

// ---------------------------------------------------------------------------
// Memo: tier keyed by (djb2(exact text) + "|" + model spec), bounded to
// MEMO_MAX entries (FIFO). The spec is part of the key so the same prompt under
// a different model spec cannot share a verdict. Entries live for the task and
// carry NO time-based expiry. Deliberately NOT cleared at the task boundary
// (chat.message): a verdict is a pure function of (text, spec), so keeping it
// across tasks can only turn a later identical request into a zero-I/O hit —
// clearing would discard valid identical verdicts for no benefit. A config
// change is handled by the spec being part of the key, not by a reset.
// ---------------------------------------------------------------------------
const memo = new Map<string, TierResult>()

const djb2 = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** Resolve the effective model spec, then memo key = text hash + "|" + spec. */
const memoKey = (text: string, spec: string): string => `${djb2(text)}|${spec}`

export const memoResult = (text: string, spec: string): TierResult | undefined => memo.get(memoKey(text, spec))

const remember = (text: string, spec: string, result: TierResult): void => {
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next().value
    if (oldest !== undefined) memo.delete(oldest)
  }
  memo.set(memoKey(text, spec), result)
}

export const clearEffortMemo = (): void => memo.clear()

/** Test-only seam to seed the memo without a network call. */
export const __testRemember = remember

// ---------------------------------------------------------------------------
// Effectful: one detached decisions call. NEVER awaited on the critical path.
// ---------------------------------------------------------------------------
const excerpt = (text: string): string => (text.length <= EXCERPT_CHARS ? text : text.slice(0, EXCERPT_CHARS))

const buildQuestions = (text: string): Record<string, { type: "choice"; instructions: string; criteria: Record<string, string | null> }> => ({
  effort: {
    type: "choice",
    instructions: `What reasoning effort does this developer request need? Request: "${excerpt(text)}"`,
    criteria: CRITERIA,
  },
})

/**
 * Pull the chosen tier + its MEASURED strength out of the answers record for
 * "effort". Mirrors `jevMeasuredChoice` in packages/opencode/src/jev/client.ts
 * (plugin-lib stays zero-dependency, so the check is copied, not imported).
 * Requires an explicit numeric `probabilities[choice]`; a row carrying only
 * `confidence` (confidence in the LABEL) is unmeasured and returns null so the
 * caller fails open instead of gating on it.
 */
export const foldEffortAnswer = (body: unknown): TierResult | null => {
  if (!body || typeof body !== "object") return null
  const answers = (body as { answers?: unknown }).answers
  if (!answers || typeof answers !== "object") return null
  const answer = (answers as Record<string, unknown>).effort
  if (!answer || typeof answer !== "object") return null
  const a = answer as Record<string, unknown>
  const choice = a.choice ?? a.answer ?? a.value
  if (!isTier(choice)) return null
  const probabilities = a.probabilities
  const raw =
    probabilities && typeof probabilities === "object"
      ? (probabilities as Record<string, unknown>)[choice]
      : undefined
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  return { tier: choice, strength: raw }
}

/**
 * Classify a request into an effort tier. One choice question. Fail-open null on
 * any error/timeout (3s)/missing key. The key is never printed.
 */
export const classifyTier = async (text: string, cfg: JevEffortConfig = DEFAULT_JEV_EFFORT): Promise<TierResult | null> => {
  if (!cfg.enabled) return null
  const spec = resolveJevModel(cfg)
  const cached = memoResult(text, spec)
  if (cached) return cached
  const transport = jevTransport(spec)
  if (!transport) return null
  const key = jevKeyFor(transport.provider)
  if (!key) return null
  try {
    const res = await fetch(transport.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: transport.id, state: STATE, questions: buildQuestions(text) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (process.env.OPENCODE_JEV_DEBUG) {
      // Server-side only: endpoint HOST + model id, never the key.
      console.debug(`jev-effort: ${transport.provider}/${transport.id} -> ${new URL(transport.endpoint).host} ok=${res.ok}`)
    }
    if (!res.ok) return null
    const result = foldEffortAnswer(await res.json())
    if (result) remember(text, spec, result)
    return result
  } catch {
    return null
  }
}
