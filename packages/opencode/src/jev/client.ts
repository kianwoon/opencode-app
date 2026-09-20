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
 * the unknown-tool sentinel, and the computer-aid observation AND actuator
 * primitives. Dropping these silently breaks delegation, the json_schema finish
 * path, or strips a GUI hand of the look-before-you-act / act calls it needs.
 *
 * Actuators are exempt on the same footing as the observers: the routing
 * decision is computed ONCE per user turn and reused across every LLM step, so a
 * single wrong drop removes the only way the hand can perform input for the rest
 * of the turn — there is no re-decision and no recovery path.
 *
 * Session-lifecycle tools are exempt for the same single-shot reason: a fresh
 * hand can inherit a dead transport session (the driver rejects every action
 * with "session has ended"), and `start_session` is the ONLY revive path.
 *
 * Namespaced MCP tools use the `server_tool` key from McpCatalog.toolName, so
 * the `cua-driver` server surfaces as `cua-driver_<tool>`.
 */
export const JEV_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "task",
  "StructuredOutput",
  "invalid",
  "cua-driver_get_window_state",
  "cua-driver_get_accessibility_tree",
  "cua-driver_get_desktop_state",
  "cua-driver_list_windows",
  "cua-driver_verify_state",
  "cua-driver_zoom",
  // Actuators — every cua-driver act-tool that routes input to the desktop.
  // Verified against `cua-driver list-tools` (v0.28.2); keeping them never
  // over-keeps, it only narrows less.
  "cua-driver_click",
  "cua-driver_bring_to_front",
  "cua-driver_hotkey",
  "cua-driver_press_key",
  "cua-driver_clipboard_write",
  "cua-driver_type_text",
  "cua-driver_scroll",
  "cua-driver_drag",
  "cua-driver_set_value",
  // Session lifecycle — `start_session` is the ONLY revive path when a fresh
  // hand inherits a transport session that already ended ("session has ended"
  // rejects every action). Routing it away leaves the hand with no recovery at
  // all, since the decision is made once per turn. `end_session` is deliberately
  // NOT exempt: a hand does not need it to act, and keeping it routable only
  // narrows less on the one tool that can kill a sibling hand's session.
  "cua-driver_start_session",
  "cua-driver_get_session",
  "cua-driver_list_sessions",
])

export interface JevVerdict {
  readonly use: boolean
  readonly strength: number
  /**
   * True when the row carried no usable `probabilities[choice]`: `strength`
   * below is then a stand-in (1 for `use`, 0 for `skip`), NOT a measured
   * score. Callers must fail open on it instead of gating a silent 1/0 through
   * the threshold — a degraded echo would otherwise keep/drop on a fabricated
   * number with nothing in the logs to show it.
   */
  readonly assumed?: true
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
  const measured = typeof probUse === "number" && Number.isFinite(probUse) ? probUse : undefined
  const use = choice === "use"
  const strength = measured ?? (use ? 1 : 0)
  return measured === undefined ? { use, strength, assumed: true } : { use, strength }
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
 * Fold result: the kept set plus counters for rows that were DISCARDED instead
 * of scored. Both causes fail open (the tool stays in the list):
 *  - `unknownId`: the response echoed an id this request never asked about, so
 *    the row belongs to no tool — pairing it by position would attribute one
 *    tool's verdict to another tool.
 *  - `unmeasured`: `choice` arrived without `probabilities[choice]`, so there
 *    is no score to gate on.
 * Counters are aggregate, never per-name, to keep caller logs bounded.
 */
export interface JevFold {
  readonly keep: Set<string>
  readonly dropped: { readonly unknownId: number; readonly unmeasured: number }
}

/**
 * Narrow a tool list from a raw decisions payload. Returns:
 *  - `undefined` → parse miss / no answers → caller fails open to the full list.
 *  - `JevFold` → a real decision; an empty `keep` means "kept nothing", which is
 *    a real outcome distinct from a parse miss.
 */
export function jevFoldTools(payload: unknown, names: string[], threshold: number): JevFold | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const root = payload as Record<string, unknown>
  const raw = root["decisions"] ?? root["results"] ?? root["choices"]
  // The pairing contract is the question ID: this client sends `questions`
  // keyed by tool name, so answers come back under the same names (jev.md §2).
  // An id we never asked about CANNOT be resolved to a tool: positional
  // fallback would hand tool N the verdict of whatever row landed at index N,
  // which is a silent misattribution (wrong verdict, right-looking keep-set).
  // Such rows are counted and dropped from the fold; the caller logs the count.
  const answers = root["answers"]
  const nameSet = new Set(names)
  const rowPairs: [string, unknown][] =
    typeof answers === "object" && answers !== null
      ? Object.entries(answers as Record<string, unknown>).filter(([id]) => nameSet.has(id))
      : []
  const unknownId =
    typeof answers === "object" && answers !== null
      ? Object.keys(answers as Record<string, unknown>).filter((id) => !nameSet.has(id)).length
      : 0
  const entries: [string, unknown][] =
    rowPairs.length > 0
      ? rowPairs
      : Array.isArray(raw)
        ? raw.flatMap((item) => {
            if (typeof item !== "object" || item === null) return []
            const r = item as Record<string, unknown>
            const name = r["tool"] ?? r["name"] ?? r["question"]
            return typeof name === "string" && nameSet.has(name) ? ([[name, item]] as [string, unknown][]) : []
          })
        : typeof raw === "object" && raw !== null
          ? Object.entries(raw as Record<string, unknown>).filter(([name]) => nameSet.has(name))
          : []
  if (entries.length === 0 && unknownId === 0) return undefined
  const keep = new Set<string>()
  // Seed with every name and prune only on an explicit, ATTRIBUTED drop verdict.
  // The gate for removing a tool is deliberately one-sided (`use` + score), so
  // starting from "keep nothing" made every un-echoed, non-categorical, or
  // un-measured row a silent removal — which is how a partial response stripped
  // a turn's tools. Everything except a confident `use` fails open.
  for (const name of names) keep.add(name)
  let unmeasured = 0
  for (const [name, value] of entries) {
    // Exempt tools are never pruned, whatever the response says: a unanimous
    // `skip` on `task`/`StructuredOutput`/the cua primitives must still keep
    // them, and a partial echo that omits their question cannot drop them
    // either, since they are already seeded above.
    if (JEV_EXEMPT_TOOLS.has(name)) continue
    const verdict = jevVerdict(value)
    // Not a drop verdict: keep, and note why when the row simply had no score
    // to gate on (the fabricated 1/0 no longer passes through the threshold).
    if (!verdict) continue
    if (verdict.assumed) {
      unmeasured++
      continue
    }
    if (!verdict.use || verdict.strength < threshold) keep.delete(name)
  }
  return { keep, dropped: { unknownId, unmeasured } }
}

/**
 * Thin accessor for callers that only need the kept set (controller, tests).
 * The counters are folded inside `jevFoldTools`; routing calls that one.
 */
export function jevKeepTools(payload: unknown, names: string[], threshold: number): Set<string> | undefined {
  return jevFoldTools(payload, names, threshold)?.keep
}

export interface JevDecision {
  readonly keep?: Set<string>
  // Present only when the endpoint rejected the request, so the fallback log
  // can distinguish an HTTP rejection (e.g. unknown model alias) from a
  // response-parse miss. No secrets.
  readonly status?: number
  /**
   * Why there is no `keep` set; surfaced in the caller's fallback log so a
   * silent fail-open is diagnosable. `http` pairs with `status`, `parse` means
   * a 2xx body that carried no usable answer, `transport` a timeout/network
   * failure (the abort in the memoized call).
   */
  readonly failure?: "http" | "parse" | "transport"
  /** Rows discarded by the fold instead of scored (see `JevFold`). */
  readonly dropped?: JevFold["dropped"]
}

// ---------------------------------------------------------------------------
// Memo: id + content-hash keyed, bounded FIFO. A hit is byte-identical to the
// original decision and skips the network entirely. The THRESHOLD is part of the
// key: a keep-set folded at 0.7 is not the same decision as one folded at 0.01,
// so a config change must re-evaluate rather than replay the stale set.
// ---------------------------------------------------------------------------
const MEMO_MAX = 500
const memo = new Map<string, JevDecision>()

const djb2 = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const memoKey = (id: string, state: string, names: readonly string[], threshold: number): string =>
  `${id}:${djb2(state)}\u0000${djb2(names.join("\u0001"))}\u0000${threshold}`

export const memoizedDecision = (
  id: string,
  state: string,
  names: readonly string[],
  threshold: number,
): JevDecision | undefined => memo.get(memoKey(id, state, names, threshold))

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
 * tool name (use/skip) and folds the response with `jevFoldTools`. Fail-open:
 * any error/timeout/missing answer resolves a decision WITHOUT `keep` (plus a
 * `failure` tag for the caller's log), never throws.
 */
export function jevDecide(input: JevDecideInput): Promise<JevDecision> {
  const id = input.id ?? "tools"
  const cached = memoizedDecision(id, input.state, input.names, input.threshold)
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
      if (!res.ok) return Promise.resolve({ status: res.status, failure: "http" })
      return res.json().then((payload): JevDecision => {
        const folded = jevFoldTools(payload, input.names, input.threshold)
        if (!folded) return { failure: "parse" }
        return { keep: folded.keep, dropped: folded.dropped }
      })
    })
    .then((decision) => {
      remember(memoKey(id, input.state, input.names, input.threshold), decision)
      return decision
    })
    .catch(() => ({ failure: "transport" }) satisfies JevDecision)
}
