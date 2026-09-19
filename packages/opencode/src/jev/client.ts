/**
 * Jev shared client — zero-dependency transport + verdict algebra for the
 * TypeSafe System One decision endpoint.
 *
 * This module is deliberately free of Effect/Auth/`@/` imports so it can be
 * copied verbatim into a plugin (`.opencode/plugin-lib`) that cannot pull the
 * runtime. It is pure `fetch` + JSON shaping; the only Node-ish global used is
 * `fetch` / `AbortSignal.timeout`, both present in the DOM lib.
 *
 * Gate rule (source of truth): Jev is categorical. `confidence` is confidence
 * in the *label chosen*, so a confident `skip` clears any `>=0.7` test while a
 * low-confidence `use` gets dropped. Always gate on `choice` and score strength
 * with `probabilities[choice]` — never `confidence`.
 */

export const JEV_MODEL = "typesafe/jev-1.13"
export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
export const JEV_DEFAULT_TIMEOUT_MS = 3_000
export const JEV_DEFAULT_THRESHOLD = 0.7

/**
 * Tools that must never be routed away: subagent delegation, structured output,
 * and the unknown-tool sentinel. Dropping these silently breaks delegation or
 * the json_schema finish path, so they are always kept.
 */
export const JEV_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["task", "StructuredOutput", "invalid"])

export interface JevVerdict {
  readonly use: boolean
  readonly strength: number
}

/** A single choice answer (categorical + per-label probabilities). */
export interface JevChoice {
  readonly choice: string
  readonly strength: number
}

export function jevVerdict(value: unknown): JevVerdict | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const r = value as Record<string, unknown>
  const choice = r["choice"] ?? r["decision"] ?? r["label"]
  if (choice !== "use" && choice !== "skip") return undefined
  const probabilities = r["probabilities"]
  const probUse =
    typeof probabilities === "object" && probabilities !== null
      ? (probabilities as Record<string, unknown>)["use"]
      : undefined
  const strength = typeof probUse === "number" && Number.isFinite(probUse) ? probUse : choice === "use" ? 1 : 0
  return { use: choice === "use", strength }
}

/**
 * Fold a categorical answer into `{ choice, strength }` for an arbitrary label
 * set (not just use/skip). `strength` is `probabilities[choice]`, falling back
 * to 1 when the probability map is absent (the endpoint always emits it for
 * choice rows, but a degraded echo must not zero out a real choice).
 */
export function jevChoice(value: unknown): JevChoice | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const r = value as Record<string, unknown>
  const choice = r["choice"] ?? r["answer"] ?? r["value"] ?? r["label"]
  if (typeof choice !== "string") return undefined
  const probabilities = r["probabilities"]
  const raw =
    typeof probabilities === "object" && probabilities !== null
      ? (probabilities as Record<string, unknown>)[choice]
      : undefined
  const strength = typeof raw === "number" && Number.isFinite(raw) ? raw : 1
  return { choice, strength }
}

/**
 * Narrow a tool list from a raw decisions payload. Returns:
 *  - `undefined` → parse miss / no answers → caller fails open to the full list.
 *  - `Set` (possibly empty) → a real decision; empty means "kept nothing".
 */
export function jevKeepTools(payload: unknown, names: string[], threshold: number): Set<string> | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const root = payload as Record<string, unknown>
  const raw = root["decisions"] ?? root["results"] ?? root["choices"]
  // Live Jev echoes question ids: answers is keyed by the same ids the
  // questions used (tool name when available), so prefer a name match and
  // fall back to positional pairing.
  const answers = root["answers"]
  const nameSet = new Set(names)
  const entries: [string, unknown][] =
    typeof answers === "object" && answers !== null
      ? Object.entries(answers as Record<string, unknown>).map(
          // Prefer the echoed id when it matches a known tool name; otherwise
          // assume answers preserve question order and pair positionally
          // (names count may differ from answers count and is left as-is).
          ([id, item], i) => [nameSet.has(id) ? id : (names[i] ?? id), item] as [string, unknown],
        )
      : Array.isArray(raw)
        ? raw.map((item, i) => {
            if (typeof item === "object" && item !== null) {
              const r = item as Record<string, unknown>
              const name = r["tool"] ?? r["name"] ?? r["question"]
              if (typeof name === "string") return [name, item] as [string, unknown]
            }
            return [names[i] ?? "", item] as [string, unknown]
          })
        : typeof raw === "object" && raw !== null
          ? Object.entries(raw as Record<string, unknown>)
          : []
  if (entries.length === 0) return undefined
  const keep = new Set<string>()
  // Exempt tools are seeded unconditionally, independent of what the response
  // echoed: a partial response that omits an exempt question must never drop
  // `task`/`StructuredOutput`/`invalid` from the narrowed set.
  for (const name of names) if (JEV_EXEMPT_TOOLS.has(name)) keep.add(name)
  for (const [name, value] of entries) {
    if (JEV_EXEMPT_TOOLS.has(name)) {
      keep.add(name)
      continue
    }
    const verdict = jevVerdict(value)
    if (verdict?.use && verdict.strength >= threshold) keep.add(name)
  }
  // Return the parsed set even when empty: 'the decision kept nothing' is a
  // real outcome the caller reports as empty-narrowing, distinct from a
  // parse failure (undefined), which fails open to the full tool list.
  return keep
}

export interface JevDecision {
  readonly keep?: Set<string>
  // Present only when the endpoint rejected the request, so the fallback log
  // can distinguish an HTTP rejection (e.g. unknown model alias) from a
  // response-parse miss. No secrets.
  readonly status?: number
}

// ---------------------------------------------------------------------------
// Memo: id + content-hash keyed, bounded FIFO. A hit is byte-identical to the
// original decision and skips the network entirely.
// ---------------------------------------------------------------------------
const MEMO_MAX = 500
const memo = new Map<string, JevDecision>()

const djb2 = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const memoKey = (id: string, state: string, names: readonly string[]): string =>
  `${id}:${djb2(state)}\u0000${djb2(names.join("\u0001"))}`

export const memoizedDecision = (id: string, state: string, names: readonly string[]): JevDecision | undefined =>
  memo.get(memoKey(id, state, names))

export const clearJevMemo = (): void => memo.clear()

const remember = (key: string, result: JevDecision): void => {
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next().value
    if (oldest !== undefined) memo.delete(oldest)
  }
  memo.set(key, result)
}

export interface JevDecideInput {
  readonly key: string
  readonly state: string
  readonly names: string[]
  readonly threshold: number
  readonly timeoutMs: number
  /** Memo namespace; callers that share a state shape should pass a stable id. */
  readonly id?: string
}

/**
 * One detached decisions call for tool routing. Builds a `choice` question per
 * tool name (use/skip) and folds the response with `jevKeepTools`. Fail-open:
 * any error/timeout/missing answer resolves `{}` (no `keep`), never throws.
 */
export function jevDecide(input: JevDecideInput): Promise<JevDecision> {
  const id = input.id ?? "tools"
  const cached = memoizedDecision(id, input.state, input.names)
  if (cached) return Promise.resolve(cached)
  const questions: Record<string, unknown> = {}
  for (const name of input.names) {
    questions[name] = {
      type: "choice",
      instructions: `Should ${name} be used?`,
      criteria: { use: "Tool is needed for this request", skip: "Tool is not needed" },
    }
  }
  return fetch(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://opencode.ai/",
      "X-Title": "opencode",
    },
    body: JSON.stringify({ model: JEV_MODEL, state: input.state, questions }),
    signal: AbortSignal.timeout(input.timeoutMs),
  })
    .then((res): Promise<JevDecision> => {
      if (!res.ok) return Promise.resolve({ status: res.status })
      return res
        .json()
        .then((payload) => ({ keep: jevKeepTools(payload, input.names, input.threshold) }))
    })
    .then((decision) => {
      remember(memoKey(id, input.state, input.names), decision)
      return decision
    })
    .catch(() => ({}))
}
