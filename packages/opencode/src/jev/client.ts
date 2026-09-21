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

/**
 * Default decision model. `provider/model-id`: the prefix selects the transport
 * (typesafe → SystemOne, openrouter → OpenRouter decisions), the suffix is the
 * model id sent on the wire. Only those two providers speak the decisions
 * protocol; anything else fails open (see `jevTransport`).
 */
export const JEV_DEFAULT_MODEL = "typesafe/jev-latest"
/** @deprecated use JEV_DEFAULT_MODEL — kept so older imports stay valid. */
export const JEV_MODEL = JEV_DEFAULT_MODEL
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
export const JEV_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
/**
 * OpenRouter-transport form of the default spec. The OpenRouter decisions
 * endpoint proxies the SystemOne model, so the wire model id keeps its
 * `typesafe/` prefix and only the transport provider changes. Used as the
 * fallback when a default/typesafe spec has no typesafe key but an OpenRouter
 * credential is present (see `resolveJevModel`).
 */
export const JEV_OPENROUTER_MODEL = "openrouter/typesafe/jev-latest"
export const JEV_DEFAULT_TIMEOUT_MS = 3_000
export const JEV_DEFAULT_THRESHOLD = 0.7

/** Provider prefix → decisions endpoint. Only these two speak the protocol. */
const JEV_ENDPOINTS: Readonly<Record<string, string>> = {
  typesafe: JEV_ENDPOINT,
  openrouter: JEV_OPENROUTER_ENDPOINT,
}

/**
 * SystemOne wire-id allowlist. The provider config exposes friendly aliases
 * (`jev-latest`, `jev-1.13`) that resolve to a canonical release id, but only
 * the canonical/`-latest` forms are accepted on the wire — POSTing the bare
 * alias `jev-1.13` is rejected with HTTP 400, which the routing/booster paths
 * fold as a fail-open `no-decision:http`. Normalize the typesafe id part here
 * so a configured alias never reaches the endpoint verbatim. Unknown typesafe
 * ids fall back to `jev-latest` (never denied — the user gets a working
 * default rather than a silent 400). The OpenRouter path is untouched: it
 * proxies the same model under its own naming.
 */
const JEV_TYPESAFE_MODELS: Readonly<Record<string, string>> = {
  "jev-latest": "jev-latest",
  "jev-1.13": "jev-latest",
  "jev-1.13.0": "jev-1.13.0",
}

/** Canonical wire id for a typesafe spec; unknown ids degrade to `jev-latest`. */
function typesafeWireId(id: string): string {
  return JEV_TYPESAFE_MODELS[id] ?? "jev-latest"
}

export interface JevTransport {
  readonly provider: string
  readonly id: string
  readonly endpoint: string
}

/**
 * Resolve a `provider/model-id` spec to a transport. Empty/absent ⇒ the default
 * `typesafe/jev-latest` ⇒ SystemOne. An unknown provider prefix, or a missing
 * model id, returns `undefined` so the caller fails open rather than POSTing a
 * decisions payload at a provider that cannot answer it.
 */
export function jevTransport(spec?: string): JevTransport | undefined {
  const raw = typeof spec === "string" && spec.trim().length > 0 ? spec.trim() : JEV_DEFAULT_MODEL
  const [provider, ...rest] = raw.split("/")
  const rawId = rest.join("/")
  if (!provider || !rawId) return undefined
  const endpoint = JEV_ENDPOINTS[provider]
  if (!endpoint) return undefined
  // typesafe aliases are normalized to a wire-accepted id; every other
  // (openrouter) id is passed through verbatim.
  const id = provider === "typesafe" ? typesafeWireId(rawId) : rawId
  return { provider, id, endpoint }
}

/**
 * Pick the wire model spec to actually call, resolving the default-provider
 * gotcha: the client defaults to a `typesafe/*` spec (SystemOne), but an
 * existing user may hold only an OpenRouter key. Rather than silently disabling
 * routing (`no-key` skip), fall the transport back to the OpenRouter decisions
 * endpoint — which proxies the same model — WHEN the configured spec is
 * `typesafe*` and has no typesafe key yet an OpenRouter key exists.
 *
 * Semantics are deliberately narrow:
 *  - an explicitly configured non-typesafe spec is untouched (no cross-provider
 *    redirect of a user's deliberate choice);
 *  - when a typesafe key IS present the configured spec stands verbatim;
 *  - unset-everything (no typesafe, no openrouter key) stays fail-open off —
 *    the returned spec resolves to a transport the caller still cannot key.
 *
 * `keyFor(provider)` is injected by the caller so this stays zero-dependency
 * (`@/jev/controller` owns auth.json/env access, and importing it here would
 * pull the runtime this module is copyable without).
 */
export function resolveJevModel(
  configured: string | undefined,
  keyFor: (provider: string) => string | undefined,
): { readonly spec: string; readonly fallback: boolean } {
  const spec = typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : JEV_DEFAULT_MODEL
  const provider = spec.split("/")[0]
  if (provider !== "typesafe" || keyFor("typesafe")) return { spec, fallback: false }
  return keyFor("openrouter") ? { spec: JEV_OPENROUTER_MODEL, fallback: true } : { spec, fallback: false }
}

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
 * Measured-only categorical fold: like `jevChoice` but returns `undefined`
 * instead of fabricating `strength` when `probabilities[choice]` is absent or
 * non-finite. Advisory consumers that emit on a HIGH score must gate on this,
 * not `jevChoice` — a degraded echo (label without a probability map) would
 * otherwise clear the threshold on a fabricated 1 and emit an unmeasured
 * advisory (mirrors `jevGaugeKeep`, which keeps on an unmeasured drop row).
 */
export function jevMeasuredChoice(value: unknown): JevChoice | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const r = value as Record<string, unknown>
  const choice = r["choice"] ?? r["answer"] ?? r["value"] ?? r["label"]
  if (typeof choice !== "string") return undefined
  const probabilities = r["probabilities"]
  const raw =
    typeof probabilities === "object" && probabilities !== null
      ? (probabilities as Record<string, unknown>)[choice]
      : undefined
  return typeof raw === "number" && Number.isFinite(raw) ? { choice, strength: raw } : undefined
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

/**
 * Generic decisions call for the governor / brain booster. Sends one batch of
 * named choice questions and returns the raw `answers` record, or `undefined`
 * on any fail-open path (unknown provider prefix, HTTP rejection, transport
 * error, or a response with no answers envelope). Callers fold with `jevChoice`
 * and MUST gate on `choice` + `probabilities[choice]`, never `confidence`.
 */
export function jevAsk(input: JevAskInput): Promise<Record<string, unknown> | undefined> {
  const transport = jevTransport(input.model)
  if (!transport) return Promise.resolve(undefined)
  return fetch(transport.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://opencode.ai/",
      "X-Title": "opencode",
    },
    body: JSON.stringify({ model: transport.id, state: input.state, questions: input.questions }),
    signal: AbortSignal.timeout(input.timeoutMs),
  })
    .then((res) => (res.ok ? res.json() : undefined))
    .then((payload): Record<string, unknown> | undefined => {
      if (typeof payload !== "object" || payload === null) return undefined
      const root = payload as Record<string, unknown>
      const answers = root["answers"] ?? root["decisions"] ?? root["results"]
      return typeof answers === "object" && answers !== null ? (answers as Record<string, unknown>) : undefined
    })
    .catch(() => undefined)
}

export interface JevAskInput {
  readonly key: string
  readonly state: string
  readonly questions: Record<string, unknown>
  readonly timeoutMs: number
  /** `provider/model-id` spec; defaults to `typesafe/jev-latest` (SystemOne). */
  readonly model?: string
}

/**
 * Drop-only fold for one batch of keep/drop rows. Returns the ids to KEEP, or
 * `undefined` when the payload carried nothing usable (fail open = keep every
 * section). An id is dropped ONLY on an explicit, measured `drop` that clears
 * the threshold; a missing row, an unknown choice, or a row without
 * `probabilities[choice]` all keep (the routing lesson: gate on choice +
 * probabilities[choice], never `confidence`).
 */
export function jevGaugeKeep(payload: unknown, ids: readonly string[], threshold: number): Set<string> | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const rows = payload as Record<string, unknown>
  if (Object.keys(rows).length === 0) return undefined
  const idSet = new Set(ids)
  const keep = new Set<string>(ids)
  for (const [id, value] of Object.entries(rows)) {
    if (!idSet.has(id)) continue
    // require an INVERSE measure: only a `drop` with an explicit finite
    // probabilities[drop] clears the gate. `jevChoice` falls back strength=1
    // when the map is absent, which for a drop-only gate would turn a degraded
    // echo (label without score) into a silent removal — exactly the failure
    // the routing lesson warns about, so it must keep instead.
    const raw =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)["probabilities"]
        : undefined
    const prob =
      typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["drop"] : undefined
    if (typeof prob !== "number" || !Number.isFinite(prob) || prob < threshold) continue
    const choice = jevChoice(value)?.choice
    if (choice !== "drop") continue
    keep.delete(id)
  }
  return keep
}

/**
 * Floor guard for tool routing: must a folded keep-set be applied, or should the
 * caller fail open to the un-narrowed list?
 *
 * The fold is one-sided by design (only a confident `use` + score keeps), so a
 * response that confidently skips almost everything can fold a 35-tool turn down
 * to 2. That is a REAL decision, not a parse miss — but applying it leaves the
 * turn unable to act, and the decision is CACHED for the whole turn, so no later
 * step recovers (observed: `ses_f4545cf6` folded 35 → 2 at `threshold=0.7`).
 * Below `floor` the caller keeps the full list instead.
 *
 * `kept === 0` is deliberately NOT this guard's business: an empty fold already
 * reaches the caller's own keep-all fallback and is reported as `tools_after: 0`,
 * so flagging it here would only hide that distinct signal.
 */
export const jevBelowFloor = (kept: number, floor: number): boolean => kept > 0 && kept < floor

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

const memoKey = (id: string, state: string, names: readonly string[], threshold: number, model: string): string =>
  `${id}:${model}:${djb2(state)}\u0000${djb2(names.join("\u0001"))}\u0000${threshold}`

export const memoizedDecision = (key: string): JevDecision | undefined => memo.get(key)

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
  /** `provider/model-id` spec; defaults to `typesafe/jev-latest` (SystemOne). */
  readonly model?: string
  /** Memo namespace; callers that share a state shape should pass a stable id. */
  readonly id?: string
}

/**
 * One detached decisions call for tool routing. Builds a `choice` question per
 * tool name (use/skip) and folds the response with `jevFoldTools`. Fail-open:
 * any error/timeout/missing answer resolves a decision WITHOUT `keep` (plus a
 * `failure` tag for the caller's log), never throws. An unknown provider prefix
 * (no endpoint to POST to) is a `parse` failure — fail-open, no request made.
 */
export function jevDecide(input: JevDecideInput): Promise<JevDecision> {
  const id = input.id ?? "tools"
  const transport = jevTransport(input.model)
  if (!transport) return Promise.resolve({ failure: "parse" })
  const memo = memoKey(id, input.state, input.names, input.threshold, `${transport.provider}/${transport.id}`)
  const cached = memoizedDecision(memo)
  if (cached) return Promise.resolve(cached)
  const questions: Record<string, unknown> = {}
  for (const name of input.names) {
    questions[name] = {
      type: "choice",
      instructions: `Should ${name} be used?`,
      criteria: { use: "Tool is needed for this request", skip: "Tool is not needed" },
    }
  }
  return fetch(transport.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://opencode.ai/",
      "X-Title": "opencode",
    },
    body: JSON.stringify({ model: transport.id, state: input.state, questions }),
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
      remember(memo, decision)
      return decision
    })
    .catch(() => ({ failure: "transport" }) satisfies JevDecision)
}
