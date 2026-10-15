/**
 * Jev controller prototype — "Jev-as-controller" gate.
 *
 * Given a compact UI state (goal + last action + the on-screen control labels)
 * ask the decision model, in ONE batch, to pick the next action and its target.
 * Fail-open: a missing key, timeout, transport error or sub-threshold verdict
 * returns `null` so a caller falls back to its own policy — a broken controller
 * must never emit a blind click.
 *
 * Batch shape (5 choice questions, one HTTP call):
 *   action          click | type | scroll | key | wait | done
 *   target          one label from the control token set
 *   success         yes | no   (did the last action succeed?)
 *   stuck           yes | no
 *   need_screenshot yes | no
 *
 * ENFORCED contract — the decider's OPTION SPACE equals the EYES' enumerated
 * world: a chooser cannot choose what it is not offered. buildControllerQuestions
 * offers the whole frontier the eyes enumerated, bounded only by the shared
 * content-adaptive hard max CHOICE_HARD_MAX (600, == ui-eyes FRONTIER_HARD_MAX),
 * never a fixed 60 prefix — a 159-label frontier is choosable in full, so a
 * target at position 150+ is not silently unchoosable. The STATE context string
 * is separately bounded (STATE_FRONTIER_MAX, sampled across the range, first and
 * last always kept) so its text stays under STATE_MAX; that bound never limits
 * the choice set. Per-label descriptions are shrunk to LABEL_MAX and the prose
 * to STATE_MAX.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  JEV_DEFAULT_CONFIDENCE_FLOOR,
  JEV_DEFAULT_THRESHOLD,
  JEV_DEFAULT_TIMEOUT_MS,
  jevFetchRetry,
  jevMeasuredChoice,
  jevTransport,
  type JevChoice,
} from "./client.ts"

export const STATE_MAX = 4_000
export const LABEL_MAX = 80
export const CONTROLS_MAX = 60

/**
 * GENERAL RULE — the decider's OPTION SPACE must equal the EYES' enumerated
 * world: a chooser cannot choose what it is not offered. The choice set is
 * bounded only by the SAME content-adaptive hard max the eyes enumerate to
 * (ui-eyes.ts FRONTIER_HARD_MAX), never a fixed 60 prefix — a 159-label frontier
 * is offered in full, so a target at position 150+ is choosable. A drift-guard
 * test asserts this equals the eyes' bound. Unseen case it covers: an 800-option
 * list whose goal target is the final option — sampled across the range, the
 * last option is still offered.
 */
export const CHOICE_HARD_MAX = 600

/**
 * The frontier a STATE string carries before the STATE_MAX guard bites. This
 * bounds the CONTEXT prose ONLY; it never bounds the choice set. Sampling spans
 * the whole range, so no region is hidden from the context either.
 */
export const STATE_FRONTIER_MAX = Math.max(1, Math.floor((STATE_MAX - 800) / (LABEL_MAX + 16)))

/**
 * GENERAL RULE — a cap must SAMPLE ACROSS the whole ordered range, never keep a
 * contiguous prefix. A prefix silently excludes every item past the cap, so a
 * goal target sitting in a later region (the detail pane behind a long sidebar)
 * can never be enumerated even though it is on screen. The selection spans the
 * range with the first and last items always included, so no region is hidden;
 * the COUNT is still capped at `max` (the state-size guard is unchanged).
 * Unseen case it covers: a 500-row list whose goal target is the final row.
 */
export function sampleWithinCap<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items]
  if (max <= 1) return items.slice(0, 1)
  const step = (items.length - 1) / (max - 1)
  const picked: T[] = []
  const seen = new Set<number>()
  for (let i = 0; i < max; i++) {
    const at = Math.round(i * step)
    if (seen.has(at)) continue
    seen.add(at)
    const item = items[at]
    if (item !== undefined) picked.push(item)
  }
  return picked
}

export type JevAction = "click" | "type" | "scroll" | "key" | "wait" | "done"

const ACTIONS: JevAction[] = ["click", "type", "scroll", "key", "wait", "done"]

const ACTION_CRITERIA: Record<string, string> = {
  click: "Activate a visible control by its label",
  type: "Enter text into an input that already has focus",
  scroll: "Reveal off-screen content",
  key: "Send a raw key (Enter, Escape, Tab, arrows)",
  wait: "No action yet; loading or the UI is mid-transition",
  done: "The goal is already satisfied; stop",
}

const YES_NO: Record<string, string> = { yes: "Yes", no: "No" }

/**
 * NAVIGATION MAP — the loop's input model, owned by CODE. `current` is the node
 * the agent is on; `frontier` is the code-enumerated next-level option set at
 * that node; `path` is the node ids visited in order; `start` is where the run
 * began. jev is a decider: it is handed this map and chooses ONE frontier option.
 */
export interface NavMap {
  readonly goal: string
  readonly start: string
  readonly current: string
  readonly frontier: readonly string[]
  readonly path: readonly string[]
}

export interface ControllerState {
  /** NAVIGATION MAP — the loop's input model; preferred over the flat list. */
  readonly map?: NavMap
  /** Goal text: carried inside `map`; standalone only for the legacy flat list. */
  readonly goal?: string
  /** Human-readable last action taken (empty on the first step). */
  readonly lastAction?: string
  /** Legacy flat on-screen control labels (the `jev_decide` tool's input). */
  readonly controls?: readonly string[]
}

export interface ControllerInput extends ControllerState {
  readonly key: string
  readonly model?: string
  readonly timeoutMs?: number
  readonly threshold?: number
  /** Minimum action strength to trust; below it the decision fails open (null). */
  readonly confidenceFloor?: number
  /** Memo namespace, tied to the batch identity. */
  readonly id?: string
  /**
   * Ask the model for the advisory `goal_met` question. Opt-in so the existing
   * batch (five questions) is unchanged for every other caller.
   */
  readonly askGoalMet?: boolean
}

export interface ControllerDecision {
  readonly action: JevAction
  readonly target: string | null
  readonly success: boolean
  readonly stuck: boolean
  readonly needScreenshot: boolean
  /** Strength (`probabilities[choice]`) of the action verdict. */
  readonly strength: number
  /**
   * ADVISORY only: the model's belief that the goal is already met. It is
   * deliberately NOT a termination condition — the loop stops on observed
   * evidence, never on this. Only present when the caller asked for it.
   */
  readonly goalMet?: boolean
}

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max))

/**
 * Assemble the `state` text. The goal/action prose is clipped to STATE_MAX.
 * The frontier/path here carry a SAMPLED view bounded by STATE_FRONTIER_MAX so
 * the text stays valid under STATE_MAX; the FULL list is supplied separately as
 * the target criteria (buildControllerQuestions), which is the choice set — this
 * bound never limits what jev can choose.
 */
export function buildState(input: ControllerState): string {
  const lastAction = clip(input.lastAction ?? "(none — first step)", 400)
  // Map branch: the state IS the navigation map (goal + start + current +
  // frontier + path), so jev sees where it is, the enumerated options at that
  // node, and how it got there — not just a flat one-screen control list.
  if (input.map) {
    const map = input.map
    return clip(
      JSON.stringify({
        goal: clip(map.goal, 2_000),
        start: clip(map.start, LABEL_MAX),
        current: clip(map.current, LABEL_MAX),
        frontier: sampleWithinCap(map.frontier, STATE_FRONTIER_MAX).map((label) => clip(label, LABEL_MAX)),
        path: sampleWithinCap(map.path, STATE_FRONTIER_MAX).map((node) => clip(node, LABEL_MAX)),
        lastAction,
      }),
      STATE_MAX,
    )
  }
  const goal = clip(input.goal ?? "", 2_000)
  const controls = sampleWithinCap(input.controls ?? [], STATE_FRONTIER_MAX).map((label) => clip(label, LABEL_MAX))
  return clip(JSON.stringify({ goal, lastAction, controls }), STATE_MAX)
}

const authFile = join(homedir(), ".local", "share", "opencode", "auth.json")

/** Env var per provider namespace, tried after the matching auth.json entry. */
const JEV_KEY_ENV: Readonly<Record<string, string>> = { typesafe: "TYPESAFE_API_KEY", openrouter: "OPENROUTER_API_KEY" }

/**
 * Read the key for a provider namespace from auth.json, then its env var.
 * The key is never logged. An unknown namespace has no env var and fails open.
 */
export function jevKey(provider = "typesafe"): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, { key?: string }>
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
 * Build the one-batch question record. THE CHOICE SET: target options come from
 * the FULL frontier the eyes enumerated (order preserved), bounded only by
 * CHOICE_HARD_MAX — never a 60 prefix, so every label the eyes can see is one
 * jev can choose. Each label description is clipped to LABEL_MAX. Returns
 * `undefined` when there is no usable action to gate on.
 */
export function buildControllerQuestions(
  controls: readonly string[],
  opts?: { readonly goalMet?: boolean },
): Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> | undefined {
  const visible = sampleWithinCap(controls, CHOICE_HARD_MAX)
  const allActions = ACTIONS.reduce<Record<string, string>>((acc, action) => {
    acc[action] = ACTION_CRITERIA[action] ?? action
    return acc
  }, {})
  const targetCriteria = visible.reduce<Record<string, string>>((acc, label, i) => {
    const key = `${i}:${clip(label, LABEL_MAX)}`
    acc[key] = clip(label, LABEL_MAX)
    return acc
  }, {})
  return {
    action: {
      type: "choice",
      instructions: "Given `goal` and `lastAction`, what is the single next step?",
      criteria: allActions,
    },
    target: {
      type: "choice",
      instructions:
        "Which on-screen control is the target of the next step? Pick exactly one `controls[i]` label, or the control labeled none.",
      criteria: { ...targetCriteria, none: "No visible control applies" },
    },
    success: {
      type: "choice",
      instructions: "Did the last action achieve its intended effect?",
      criteria: YES_NO,
    },
    stuck: {
      type: "choice",
      instructions: "Is the agent stuck (repeating the same failed step)?",
      criteria: YES_NO,
    },
    need_screenshot: {
      type: "choice",
      instructions: "Is a fresh screenshot needed before acting?",
      criteria: YES_NO,
    },
    // Additive and opt-in: existing folds ignore this row, so `jev_decide` and
    // every other caller see the same five-question batch as before.
    ...(opts?.goalMet
      ? {
          goal_met: {
            type: "choice" as const,
            instructions: "Is the stated goal already satisfied, as far as you can tell from the control set alone?",
            criteria: YES_NO,
          },
        }
      : {}),
  }
}

const isAction = (v: string): v is JevAction => (ACTIONS as string[]).includes(v)

/**
 * Fold one controller response body into a three-outcome verdict. `below_gate` is
 * distinct from `unmeasured`: a measured-but-weak action is a real "uncertain"
 * verdict that must surface its choice and strength, while `unmeasured` (no body,
 * no answers, no measured action row) is a true fail-open.
 */
export type ControllerOutcome =
  | { readonly verdict: "accepted"; readonly decision: ControllerDecision }
  | {
      readonly verdict: "below_gate"
      readonly choice: string
      readonly action: JevAction | null
      readonly strength: number
    }
  | { readonly verdict: "unmeasured" }

export const foldController = (
  body: unknown,
  threshold: number,
  floor = JEV_DEFAULT_CONFIDENCE_FLOOR,
): ControllerOutcome => {
  if (typeof body !== "object" || body === null) return { verdict: "unmeasured" }
  const answers = (body as Record<string, unknown>).answers
  if (typeof answers !== "object" || answers === null) return { verdict: "unmeasured" }
  const rows = answers as Record<string, unknown>
  // Measured only — fabricated strength=1 would emit a blind click. An unmeasured
  // or unknown action row fails open as unmeasured, never as a below-gate verdict.
  const actionRow = jevMeasuredChoice(rows["action"])
  if (!actionRow || !isAction(actionRow.choice)) return { verdict: "unmeasured" }
  if (actionRow.strength < floor || actionRow.strength < threshold)
    return { verdict: "below_gate", choice: actionRow.choice, action: actionRow.choice, strength: actionRow.strength }
  const targetRow = jevMeasuredChoice(rows["target"])
  // Deliberate step-0 asymmetry: a target row is gated by the threshold ONLY,
  // never by the action confidence floor — a floor-gated target would drop a
  // low-strength target even when the action itself is well-measured.
  const target =
    targetRow && targetRow.strength >= threshold && targetRow.choice !== "none"
      ? targetRow.choice.replace(/^\d+:/, "")
      : null
  return {
    verdict: "accepted",
    decision: {
      action: actionRow.choice,
      target,
      success: jevMeasuredChoice(rows["success"])?.choice === "yes",
      stuck: jevMeasuredChoice(rows["stuck"])?.choice === "yes",
      needScreenshot: jevMeasuredChoice(rows["need_screenshot"])?.choice === "yes",
      strength: actionRow.strength,
      goalMet: jevMeasuredChoice(rows["goal_met"])?.choice === "yes",
    },
  }
}

/**
 * One detached controller call, full three-outcome result: the accepted decision,
 * a measured `below_gate` verdict, or `null` when the call itself was unmeasured
 * (error/timeout/no key). The key is never logged.
 *
 * A module-level memo (TTL 60s, max 200 FIFO) short-circuits an identical
 * request — same id, threshold and state — returning the byte-identical cached
 * decision. Only the accepted path is memoized: below-gate and miss/timeout/error
 * paths bypass the memo entirely and are not cached, so a transient failure or a
 * weak verdict never sticks.
 */
export async function jevControlDetailed(input: ControllerInput): Promise<ControllerOutcome> {
  // The controller's target options are the CODE-ENUMERATED frontier at the
  // current node (map input model), or the legacy flat list — never its own guess.
  const questions = buildControllerQuestions(input.map ? input.map.frontier : (input.controls ?? []), {
    goalMet: input.askGoalMet,
  })
  if (!questions) return { verdict: "unmeasured" }
  const transport = jevTransport(input.model)
  if (!transport) return { verdict: "unmeasured" }
  const threshold = input.threshold ?? JEV_DEFAULT_THRESHOLD
  const floor = input.confidenceFloor ?? JEV_DEFAULT_CONFIDENCE_FLOOR
  const timeoutMs = input.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS
  const state = buildState(input)
  const key = controllerMemoKey(
    input.id,
    transport.id,
    threshold,
    floor,
    timeoutMs,
    controllerHash(state),
    input.askGoalMet,
  )
  const hit = controllerMemo.get(key)
  if (hit && hit.expires > Date.now()) return { verdict: "accepted", decision: hit.decision }
  try {
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
    if (!res) return { verdict: "unmeasured" }
    if (!res.ok) return { verdict: "unmeasured" }
    const outcome = foldController(await res.json(), threshold, floor)
    if (outcome.verdict === "accepted") controllerRemember(key, outcome.decision)
    return outcome
  } catch {
    return { verdict: "unmeasured" }
  }
}

/**
 * Actionable-decision view over jevControlDetailed. Keeps the historical
 * `ControllerDecision | null` contract: a below-gate verdict is uncertain, not
 * actionable, so callers that drive the UI still fail open to null. Callers that
 * must SEE the uncertain verdict use jevControlDetailed.
 */
export async function jevControl(input: ControllerInput): Promise<ControllerDecision | null> {
  const outcome = await jevControlDetailed(input)
  return outcome.verdict === "accepted" ? outcome.decision : null
}

const CONTROLLER_MEMO_MAX = 200
const CONTROLLER_MEMO_TTL_MS = 60_000
const controllerMemo = new Map<string, { decision: ControllerDecision; expires: number }>()

/**
 * Memo identity for one controller batch. Covers every input that can change the
 * decision: the namespace id, the RESOLVED transport model, the threshold, the
 * confidence floor, the timeout and the state hash. Without transportId a model
 * swap replays a stale memoized decision inside the 60s TTL.
 */
export const controllerMemoKey = (
  id: string | undefined,
  transportId: string,
  threshold: number,
  floor: number,
  timeoutMs: number,
  stateHash: string,
  goalMet = false,
): string =>
  `${id ?? "ctl"}:${transportId}:${threshold}:${floor}:${timeoutMs}:${goalMet ? "gm" : "n"}:${stateHash}`

/** Inline djb2 string hash — no imports, matching the client's memo keying. */
const controllerHash = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const controllerRemember = (key: string, decision: ControllerDecision): void => {
  if (controllerMemo.size >= CONTROLLER_MEMO_MAX) {
    const oldest = controllerMemo.keys().next().value
    if (oldest !== undefined) controllerMemo.delete(oldest)
  }
  controllerMemo.set(key, { decision, expires: Date.now() + CONTROLLER_MEMO_TTL_MS })
}
