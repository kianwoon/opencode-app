/**
 * jev-response-gate — JEV is an INPUT to generation, not a review of it.
 *
 * v1–v5 all acted on the FINISHED answer: grade it, then append an advisory for the
 * NEXT turn. That concept is retired. A judgement about a completed answer cannot
 * improve the answer being produced — it can only tell the model it did badly after
 * it has already committed. v6 inverted the causality: the readout fires at REQUEST
 * time, before the model has written a token, and shapes the answer while it is still
 * being formed. v6.1 fixes the two spec misses the JEV alignment study found in v6.
 *
 *   - `choice` DIRECTS: for the NEW request — and only the new request — one Choice
 *     question ranks three labeled WORK MODES, and the pick reaches the model as a
 *     transient tail part BEFORE generation starts.
 *   - `noul`  MEASURES: how well did the previous answer answer the previous question?
 *     Measurement only. The score is written to the jsonl row and nothing else — no
 *     advisory, no text, no tail part. `advised` is a shape-stable `false`.
 *
 * v7: the `noul` question gains an OBSERVED OUTPUT (O) section — the completed tool
 * parts of the graded answer — so the score measures claims-trace-to-observed-output
 * instead of sounds-grounded (the documented proxy ceiling). When O is present,
 * "grounded" means the claims in A trace to O; with no qualifying tool part the score
 * keeps its v6 meaning (sounds-grounded). O is measurement input only: it still never
 * reaches the model.
 *
 * v7.1: a THIRD question id, `premise`, rides the SAME one POST as a `noul` over the new
 * request — it asks whether the request's CENTRAL PREMISE is true as stated, so a false
 * premise is caught INPUT-side before the model builds an answer on it. Telemetry is
 * unconditional; the advisory fires only at a clearly-questionable noul ≤ 0.3, and a
 * `noul` emits no `criteria` (jev.md §2) — a third id beside `choice` in one record is
 * legal (§1/§3).
 *
 * v7.2: the O section aggregates completed tool outputs across the WHOLE turn's
 * assistant cluster, not just the graded answer message. A turn that dispatches a
 * hand writes its completed tool part on a SIBLING assistant message, and the final
 * text continuation is another — so -2-only extraction read the continuation, found
 * no completed tool part, and emitted "" over real evidence.
 *
 * v7.3: the O section harvests ERROR-state tool parts too — a ToolStateError carries
 * `error`, never `output`, so a completed-only O was BLIND to a permission denial and a
 * false "fix is live" answer scored 0.66. Each error part contributes a bounded
 * `[FAIL <tool>: <error>]` entry, the grading question names that convention, and a
 * questionable premise is now a TWO-TIER advisory: strong ≤ 0.3, soft ≤ 0.45.
 *
 * v6.1 CONTRACT:
 *   1. ONE POST per transform carries the WHOLE batch (jev.md §1): the mode `choice`
 *      and the `noul` grade are two question IDS in one record, not two sequential
 *      calls. Ids are the pairing contract, so a row is only ever read back under the
 *      id it was asked under.
 *   2. The advisory is GATED on a MEASURED `probabilities[choice]` at 0.7
 *      (jev.md §4.3/§4.4: max(stable threshold, confidenceFloor)). `confidence` is
 *      NEVER a gate — it is the model's faith in its own label, not evidence about
 *      the pick. Gating on any measured probability is the "flat verdict" failure: a
 *      0.34 pick and a 0.99 pick are both a "picks something", and the second one
 *      means nothing. An unmeasured row is an echo and gates to no advisory, never to
 *      a fabricated strength.
 *   3. The `jev.mode-readout` row is UNCONDITIONAL telemetry on a new request — the
 *      call was made, so the outcome is recorded even when it advises nothing.
 *   4. Exactly one advisory exists in this file and it comes from the mode readout on
 *      a request. NOTHING appendAdvisory from a judged FINAL answer.
 *   5. Answer grading is MEASUREMENT ONLY. The `noul` score never reaches the model.
 *   6. Nothing is asked when neither a new request nor a gradable exchange is at the
 *      tail — the hook costs zero requests on a bare tail.
 *   7. The assistant text is NEVER mutated. The only write is a transient advisory
 *      part appended to the request array.
 *   8. `output.system` is never touched — that array is the cached prefix head, so a
 *      per-turn byte change there re-bills the whole prompt. A trailing part only
 *      re-bills itself.
 *   9. `output.messages` is also a persistence source, so the advisory REPLACES the
 *      tail slot with a shallow clone (mirrors jev-reasoning's `appendAdvisory`): the
 *      part exists only in the transient request array and never in history.
 *  10. One-shot by construction: an advisory is a clone that leaves no state behind,
 *      so the next request re-derives it from whatever request is then at the tail.
 *
 * Fail-open throughout: a malformed tail, a missing key, a timeout, a non-numeric
 * answer, an unmeasured or unknown choice row, a request under the minimum length, or
 * a disabled config all yield NO advisory and no error. The advisory is advice —
 * nothing here routes, blocks, or enforces an action.
 *
 * Transport is inherited wholesale from jev-effort (same endpoints, same key lookup,
 * same model resolution) — plugin-lib stays zero-dependency and never imports the core
 * client (jev.md §7: raw fetch shapes only). A `noul` question carries NO `criteria`
 * (it emits no confidence/probabilities). The `choice` question DOES carry `criteria`,
 * and only its MEASURED `probabilities[choice]` is ever read (mirrors
 * `jevMeasuredChoice`). The key is never logged.
 */

import type { Hooks } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEFAULT_JEV_EFFORT, jevKeyFor, jevTransport, resolveJevModel } from "./jev-effort.ts"

const CONFIG_FILE = join(homedir(), ".config", "opencode", "response-gate.json")
const REQUEST_TIMEOUT_MS = 3_000
export const QUESTION_EXCERPT_CHARS = 400
/**
 * Answers in this repo carry their gates/evidence sections at the TAIL, so a head-only
 * window truncates away exactly the grounding evidence the grader needs — jev.md §4.6:
 * head-only excerpts cause blindness. Input cost at $0.042/M is negligible.
 */
export const ANSWER_EXCERPT_CHARS = 4000
/** A candidate long enough to be a real candidate, short enough to rank. */
export const OPTION_EXCERPT_CHARS = 400
/** O section cap; input cost trivial at $0.042/M. */
export const OBSERVED_OUTPUT_EXCERPT_CHARS = 2500
/** Per-FAIL-entry cap on the error text; the entry is a marker, not a transcript. */
export const OBSERVED_ERROR_EXCERPT_CHARS = 140
/** Shorter answers are acknowledgements, not claims worth grading. */
export const MIN_GATE_CHARS = 240
/**
 * max(stable threshold, confidenceFloor) at the value jev.md §4.3/§4.4 settles on, and
 * compared against the MEASURED `probabilities[choice]` only — `confidence` is never a gate.
 */
export const MODE_GATE = 0.7

/**
 * The STRONG premise band: a clearly-QUESTIONABLE premise (measured noul ≤ this) is
 * called out as such. The soft band below carries a milder phrasing of the same caution.
 */
export const PREMISE_ADVISE_MAX = 0.3
/**
 * The SOFT premise band (v7.3): a noul above PREMISE_ADVISE_MAX and at or below this
 * still gets the one-line caution, because a barely-questionable premise is exactly
 * where a wrong build compounds. Above it, telemetry only.
 */
export const PREMISE_SOFT_MAX = 0.45

/**
 * The premise tier for a measured noul, or undefined when nothing should be said.
 * Two bands, one job: a question the grader rates ≤ 0.3 is called questionable, one
 * rated in (0.3, 0.45] gets the same caution more quietly, and a higher read is a flat
 * verdict this gate exists to reject. An unmeasured noul is never a tier.
 */
export const premiseTier = (noul: number | null): "strong" | "soft" | undefined =>
  noul === null ? undefined : noul <= PREMISE_ADVISE_MAX ? "strong" : noul <= PREMISE_SOFT_MAX ? "soft" : undefined

export type ResponseGateConfig = {
  enabled: boolean
}

export const DEFAULT_RESPONSE_GATE: ResponseGateConfig = {
  enabled: true,
}

/**
 * Coerce the raw `response-gate.json` block into a validated config (fail to defaults).
 * Only `enabled` is acted on. `adviseBelow` was dead since v6 and is REMOVED in v7.1;
 * unknown config keys (e.g. the v1 `annotateBelow`) are ignored, never reinterpreted.
 */
export const resolveResponseGateConfig = (raw: unknown): ResponseGateConfig => {
  if (!raw || typeof raw !== "object") return DEFAULT_RESPONSE_GATE
  const r = raw as Record<string, unknown>
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_RESPONSE_GATE.enabled,
  }
}

const GRADING_STATE =
  "You grade a coding agent's ANSWER (A) against the user's REQUEST (Q). " +
  "Grounded: claims in A trace to tool output or file content actually observed in this session. " +
  "On-task: A directly answers Q. " +
  " When an OBSERVED OUTPUT (O) section is provided, grounded means claims in A trace to O." +
  "0 means unfounded guesswork or off-topic prose, 1 means fully grounded and directly answering. " +
  "Return the numeric score only."

export const CHOICE_STATE =
  "You are selecting the response mode for a coding agent's request. " +
  "direct: the request has one clear good answer and enumeration would add noise. " +
  "enumerate-first: the request admits materially different approaches and weighing them changes the outcome. " +
  "investigate-first: the answer's claims must be checked against real tool or file output before they can be trusted. " +
  "Pick the mode the request actually needs — none is preferred by default."

export const excerpt = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max))

type WireMessage = { info?: { role?: unknown }; parts?: unknown }

const textOf = (message: WireMessage | undefined): string => {
  if (!Array.isArray(message?.parts)) return ""
  return message.parts
    .flatMap((part) => {
      const p = part as { type?: unknown; text?: unknown }
      return p?.type === "text" && typeof p.text === "string" ? [p.text] : []
    })
    .filter((text) => text.length > 0)
    .join("\n")
}

/**
 * The OBSERVED OUTPUT (O) for one message: every COMPLETED tool part's real output,
 * labelled by tool name so a claim can be traced to the call that produced it, plus
 * (v7.3) every ERROR tool part as a bounded `[FAIL <tool>: <error>]` entry — a
 * ToolStateError carries `error`, never `output`, so a completed-only O was BLIND to a
 * permission denial and a false "fix is live" answer scored 0.66. pending/running parts
 * contribute nothing. A message with no qualifying part yields "" — the grading question
 * then omits O and keeps its v6 sounds-grounded meaning.
 */
export const extractObservedOutputs = (message: WireMessage | undefined): string => {
  if (!Array.isArray(message?.parts)) return ""
  const blocks = message.parts.flatMap((part) => {
    const p = part as { type?: unknown; tool?: unknown; state?: { status?: unknown; output?: unknown; error?: unknown } }
    if (p?.type !== "tool" || typeof p.tool !== "string") return []
    const error = p.state?.status === "error" ? p.state.error : undefined
    if (typeof error === "string" && error.length > 0)
      return [`[FAIL ${p.tool}: ${excerpt(error.replace(/\s+/g, " ").trim(), OBSERVED_ERROR_EXCERPT_CHARS)}]`]
    const output = p.state?.status === "completed" ? p.state.output : undefined
    return typeof output === "string" && output.length > 0 ? [`[tool ${p.tool}]\n${output}`] : []
  })
  return blocks.length > 0 ? excerpt(blocks.join("\n\n"), OBSERVED_OUTPUT_EXCERPT_CHARS) : ""
}

const isUser = (message: WireMessage | undefined): boolean => message?.info?.role === "user"

/**
 * The O section for one TURN, not one message (v7.2). A turn that dispatches a hand
 * writes its completed tool part on a SIBLING assistant message and the final text
 * continuation is another, so reading only the answer message saw no completed part
 * and emitted "" over real evidence. The scan walks back to the user boundary — that
 * message ends the turn — and every non-empty per-message O block joins in order.
 */
export const extractTurnObservedOutputs = (messages: unknown, answerIndex: number): string => {
  if (!Array.isArray(messages)) return ""
  const uptoAnswer = (messages as WireMessage[]).slice(0, answerIndex + 1)
  const start = uptoAnswer.findLastIndex((message) => isUser(message as WireMessage)) + 1
  const blocks = uptoAnswer.slice(start).flatMap((message) => {
    const observed = extractObservedOutputs(message)
    return observed.length > 0 ? [observed] : []
  })
  return blocks.length > 0 ? excerpt(blocks.join("\n\n"), OBSERVED_OUTPUT_EXCERPT_CHARS) : ""
}

export type Exchange = { question: string; answer: string; observed: string }

/**
 * The graded PAIR at the tail: a user request, the assistant answer that followed it,
 * and the request that answer answered. Every mismatch is null — a partial exchange
 * grades nothing, because half an exchange is what produced the v2 false negatives.
 */
export const pickExchange = (messages: unknown): Exchange | null => {
  if (!Array.isArray(messages) || messages.length < 3) return null
  const wire = messages as WireMessage[]
  if (!isUser(wire.at(-1))) return null
  const answer = textOf(wire.at(-2))
  if (answer.length < MIN_GATE_CHARS) return null
  const question = textOf(wire.slice(0, -2).findLast(isUser))
  return question.length > 0 ? { question, answer, observed: extractTurnObservedOutputs(wire, wire.length - 2) } : null
}

/** Below this the tail is a chat line ("ok thanks"), not a request worth directing. */
const MIN_REQUEST_CHARS = 80

/**
 * The tail user message when it is a NEW request. v4.1 dropped v4's "the message before
 * it is not a ≥240-char assistant answer" exclusion: in a working session the previous
 * answer almost always clears that bar, so the readout never rode at all. The mode
 * readout rides EVERY new user request, which is the only point where it can still
 * change the outcome.
 */
export const newRequestTail = (messages: unknown): string | null => {
  if (!Array.isArray(messages) || messages.length === 0) return null
  const wire = messages as WireMessage[]
  if (!isUser(wire.at(-1))) return null
  const text = textOf(wire.at(-1))
  return text.length > 0 ? text : null
}

/**
 * The three labeled WORK MODES the readout ranks. The Choice wire shape keys its
 * `criteria` on the candidate TEXT, so the descriptions are the options and the labels
 * are what the model is told; `parseBatchAnswers` maps between them. Each description is
 * the mode spelled out as an instruction, so a pick is directly actionable rather than a
 * label the model has to interpret.
 */
export const MODE_OPTIONS: Record<string, string> = {
  direct: "Answer the request directly with the best single approach; no enumeration needed.",
  "enumerate-first":
    'Before committing, sketch 2-3 materially different approaches as "Option A:", "Option B:", "Option C:" — one line each, including at least one you would not normally pick — then commit with the trade-off stated.',
  "investigate-first": "Verify claims against real tool and file output BEFORE answering; read the code/files first, then answer with evidence.",
}

const MODE_LABELS = Object.keys(MODE_OPTIONS)

/** The single advisory line, shown to the model only, naming the mode and its strength. */
export const modeAdvisory = (mode: string, probability: number, confidence: number | null): string =>
  `[system-1 read] mode: ${mode} (p=${probability.toFixed(2)}; confidence=${confidence === null ? "n/a" : confidence.toFixed(2)}). Shape this answer accordingly.`

/**
 * The whole batch as ONE questions record keyed by id (jev.md §1): `approach` asks which
 * mode fits the NEW request, `premise` asks whether that request's central premise is
 * true as stated, and `grounding` scores the COMPLETED exchange. A null request asks
 * neither request-side question and a null exchange asks no grading question, so the
 * record degrades to whichever ids are actually warranted rather than asking an empty
 * one. The `noul` ids carry NO `criteria` — they emit no probabilities.
 */
export type BatchQuestions = {
  approach?: { type: "choice"; instructions: string; criteria: Record<string, string> }
  premise?: { type: "noul"; instructions: string }
  grounding?: { type: "noul"; instructions: string }
}

export const buildBatchQuestions = (request: string | null, exchange: Exchange | null): BatchQuestions => ({
  ...(request === null
    ? {}
    : {
        approach: {
          type: "choice" as const,
          instructions: `REQUEST (Q): "${excerpt(request, QUESTION_EXCERPT_CHARS)}"\nWhich of these approaches best answers Q?`,
          criteria: Object.fromEntries(
            MODE_LABELS.map((label) => [MODE_OPTIONS[label], excerpt(MODE_OPTIONS[label], OPTION_EXCERPT_CHARS)]),
          ),
        },
        premise: {
          type: "noul" as const,
          instructions: `REQUEST (Q): "${excerpt(request, QUESTION_EXCERPT_CHARS)}"\nIs the central premise of Q factually true as stated? 0 = the premise is false or contains a false assumption, 1 = the premise is true.`,
        },
      }),
  ...(exchange === null
    ? {}
    : {
        grounding: {
          type: "noul" as const,
          instructions: `REQUEST (Q): "${excerpt(exchange.question, QUESTION_EXCERPT_CHARS)}"\nANSWER (A): "${excerpt(exchange.answer, ANSWER_EXCERPT_CHARS)}"${exchange.observed.length > 0 ? `\nOBSERVED OUTPUT (O): "${excerpt(exchange.observed, OBSERVED_OUTPUT_EXCERPT_CHARS)}"` : ""}\nIf O contains entries marked [FAIL, an answer that does not acknowledge those failures scores low.\nHow well does A answer Q? 0 = unfounded or off-topic, 1 = fully grounded and directly answering.`,
        },
      }),
})

/** One `state` for the whole record: the clause for each id actually asked. */
const buildBatchState = (request: string | null, exchange: Exchange | null): string =>
  [request === null ? null : CHOICE_STATE, exchange === null ? null : GRADING_STATE]
    .filter((clause): clause is string => clause !== null)
    .join(" ")

export type ModeRow = { choice: string; probability: number | null; confidence: number | null }
export type BatchResult = { score: number | null; mode: ModeRow | null; premise: number | null }

const NO_ROWS: BatchResult = { score: null, mode: null, premise: null }

/**
 * Read both rows back under the ids they were asked under. A non-numeric or absent
 * `noul` is a null score, never a fabricated 0. A `choice` naming a label outside
 * `MODE_OPTIONS` is not one of ours and fails open to a null mode; a KNOWN label with no
 * finite `probabilities[choice]` is an unmeasured echo and keeps its mode with a null
 * probability, so the row records the pick while the advisory gate refuses it.
 */
export const parseBatchAnswers = (payload: unknown): BatchResult => {
  const answers = (payload as { answers?: Record<string, unknown> } | null | undefined)?.answers
  const grounding = answers?.grounding as { noul?: unknown } | undefined
  const noul = grounding?.noul
  const premiseNoul = (answers?.premise as { noul?: unknown } | undefined)?.noul
  const row = answers?.approach as { choice?: unknown; probabilities?: unknown; confidence?: unknown } | undefined
  const choice = row?.choice
  const label = typeof choice === "string" ? MODE_LABELS.find((candidate) => MODE_OPTIONS[candidate] === choice) : undefined
  const measured = (row?.probabilities as Record<string, unknown> | undefined)?.[choice as string]
  const confidence = row?.confidence
  return {
    score: typeof noul === "number" && Number.isFinite(noul) ? noul : null,
    premise: typeof premiseNoul === "number" && Number.isFinite(premiseNoul) ? premiseNoul : null,
    mode: label === undefined
      ? null
      : {
          choice: label,
          probability: typeof measured === "number" && Number.isFinite(measured) ? measured : null,
          confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : null,
        },
  }
}

/**
 * ONE POST for the whole batch (jev.md §1) — the v6 two-call version asked `noul` and
 * `choice` sequentially, which spends two round trips and can observe two different
 * states of the world. Fail-open like every call in plugin-lib: a missing key, a
 * non-2xx, a timeout or an unparseable body is two null rows and no advisory.
 */
export async function askModeAndGrounding(request: string | null, exchange: Exchange | null): Promise<BatchResult> {
  const transport = jevTransport(resolveJevModel(DEFAULT_JEV_EFFORT))
  const key = transport && jevKeyFor(transport.provider)
  if (!transport || !key) return NO_ROWS
  try {
    const res = await fetch(transport.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: transport.id,
        state: buildBatchState(request, exchange),
        questions: buildBatchQuestions(request, exchange),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return NO_ROWS
    return parseBatchAnswers(await res.json())
  } catch {
    return NO_ROWS
  }
}

/** The measured strength that clears the gate, else null — never a fallback value. */
export const advisableProbability = (probability: number | null): number | null =>
  probability !== null && probability >= MODE_GATE ? probability : null

/**
 * The advisory must ride the conversation TAIL, never `output.system`: the provider
 * caches a byte prefix of the request and the system array comes first, so a system
 * entry that changes per turn re-bills the whole conversation.
 *
 * CRITICAL: `output.messages` holds the PERSISTED message objects, so never push onto
 * an existing message's `parts` — REPLACE the array slot with a NEW object so the added
 * part exists only in this transient request array. Mirrors jev-reasoning.
 */
const appendAdvisory = (messages: unknown, text: string): string => {
  if (!Array.isArray(messages) || messages.length === 0) return "no-messages"
  const index = messages.length - 1
  const last = messages[index] as { parts?: unknown; content?: unknown } | undefined
  if (!last) return "no-last"
  if (Array.isArray(last.parts)) {
    messages[index] = { ...last, parts: [...last.parts, { type: "text", text, synthetic: true }] }
    return "parts-clone"
  }
  if (Array.isArray(last.content)) {
    messages[index] = { ...last, content: [...last.content, { type: "text", text }] }
    return "content-array-clone"
  }
  if (typeof last.content === "string") {
    messages[index] = { ...last, content: `${last.content}\n\n${text}` }
    return "content-string-clone"
  }
  return `unknown:${Object.keys(last).join(",")}`
}

const dataRoot = () => process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`

function log(event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: Date.now(), event, ...fields }) + "\n"
  void (async () => {
    try {
      const { appendFile, mkdir } = await import("node:fs/promises")
      const dir = `${dataRoot()}/opencode`
      await mkdir(dir, { recursive: true })
      await appendFile(`${dir}/jev-response-gate.jsonl`, line)
    } catch {
      // Observability is best-effort by design.
    }
  })()
}

export const JevResponseGatePlugin = async (): Promise<Hooks> => ({
  // `input` is always `{}` on this hook (no sessionID, no model), so the session comes
  // from the tail message. One batched call, two readouts with two different jobs: the
  // mode row acts on the answer being produced, the noul row is measurement only.
  "experimental.chat.messages.transform": async (input, output) => {
    // Advisory-only hook: a throw here would surface as a model error, so swallow.
    try {
    const sessionID = (output.messages.at(-1) as { info?: { sessionID?: string } } | undefined)?.info?.sessionID
    if (!sessionID) return
    const cfg = resolveResponseGateConfig(readConfig())
    if (!cfg.enabled) return
    const tail = newRequestTail(output.messages)
    const request = tail !== null && tail.length >= MIN_REQUEST_CHARS ? tail : null
    const exchange = pickExchange(output.messages)
    if (request === null && exchange === null) return
    const batch = await askModeAndGrounding(request, exchange)
    // (1) INPUT. Telemetry is unconditional — the call was made, so the pick is
    // recorded even when it is too weak or unmeasured to advise.
    if (request !== null) {
      log("jev.mode-readout", {
        sessionID,
        mode: batch.mode?.choice ?? null,
        probability: batch.mode?.probability ?? null,
        confidence: batch.mode?.confidence ?? null,
      })
      const strong = batch.mode === null ? null : advisableProbability(batch.mode.probability)
      if (batch.mode !== null && strong !== null) {
        appendAdvisory(output.messages, modeAdvisory(batch.mode.choice, strong, batch.mode.confidence))
      }
      // (1b) INPUT, premise side. Telemetry is unconditional on a MEASURED noul; the
      // advisory is two-tiered so a barely-questionable premise (0.3, 0.45] still gets
      // the caution, while a mid read above 0.45 stays a record and never reaches the model.
      if (batch.premise !== null) {
        const tier = premiseTier(batch.premise)
        log("jev.premise-readout", { sessionID, noul: batch.premise, advised: tier !== undefined, ...(tier ? { tier } : {}) })
        if (tier !== undefined) {
          appendAdvisory(
            output.messages,
            tier === "strong"
              ? `[system-1 read] premise questionable (noul=${batch.premise.toFixed(2)}) — verify the premise before building on it.`
              : `[system-1 read] premise questionable — verify the premise before building on it.`,
          )
        }
      }
    }
    // (2) MEASUREMENT. Logged only when a score was actually measured. NEVER an
    // advisory: a score on a final answer cannot change that answer.
    if (exchange !== null && batch.score !== null) {
      log("jev.response-gate", { sessionID, score: batch.score, advised: false, observedChars: exchange.observed.length })
    }
    } catch {
      return
    }
  },
})

/** Missing or unreadable file yields undefined, which coerces to defaults. */
function readConfig(): unknown {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as unknown
  } catch {
    return undefined
  }
}

// Default-export the PluginModule shape (server()) so the loader takes the v1
// path. Without it the legacy fallback treats every exported function in this
// module (pickExchange, parseBatchAnswers, ...) as a plugin instance and crashes.
export default {
  id: "jev-response-gate",
  server: JevResponseGatePlugin,
}
