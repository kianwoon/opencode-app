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
 * Order-bias guard: the control set is NEVER truncated to fit the state budget
 * — every label stays a choice option at every size. Only the per-label
 * description is shrunk (LABEL_MAX) and the surrounding prose is clipped
 * (STATE_MAX). Dropping tail labels would silently remove valid targets and
 * bias the model toward whichever labels happened to survive.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  JEV_DEFAULT_CONFIDENCE_FLOOR,
  JEV_DEFAULT_THRESHOLD,
  JEV_DEFAULT_TIMEOUT_MS,
  jevMeasuredChoice,
  jevTransport,
  type JevChoice,
} from "./client"

export const STATE_MAX = 4_000
export const LABEL_MAX = 80
export const CONTROLS_MAX = 60

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

export interface ControllerState {
  /** What the agent is trying to accomplish. */
  readonly goal: string
  /** Human-readable last action taken (empty on the first step). */
  readonly lastAction?: string
  /** On-screen control labels (fixed order; sliced to CONTROLS_MAX). */
  readonly controls: readonly string[]
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
}

export interface ControllerDecision {
  readonly action: JevAction
  readonly target: string | null
  readonly success: boolean
  readonly stuck: boolean
  readonly needScreenshot: boolean
  /** Strength (`probabilities[choice]`) of the action verdict. */
  readonly strength: number
}

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max))

/**
 * Assemble the `state` text. The goal/action prose is clipped to STATE_MAX;
 * control labels are clipped individually to LABEL_MAX but the control COUNT is
 * never reduced here (the same full list is supplied separately as criteria).
 */
export function buildState(input: ControllerState): string {
  const goal = clip(input.goal ?? "", 2_000)
  const lastAction = clip(input.lastAction ?? "(none — first step)", 400)
  const controls = input.controls.slice(0, CONTROLS_MAX).map((label) => clip(label, LABEL_MAX))
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
 * Build the one-batch question record. Target options come from the FULL control
 * set (order preserved, count intact); each label description is clipped to
 * LABEL_MAX. Returns `undefined` when there is no usable action to gate on.
 */
export function buildControllerQuestions(
  controls: readonly string[],
): Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> | undefined {
  const visible = controls.slice(0, CONTROLS_MAX)
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
  }
}

const isAction = (v: string): v is JevAction => (ACTIONS as string[]).includes(v)

export const foldController = (
  body: unknown,
  threshold: number,
  floor = JEV_DEFAULT_CONFIDENCE_FLOOR,
): ControllerDecision | null => {
  if (typeof body !== "object" || body === null) return null
  const answers = (body as Record<string, unknown>).answers
  if (typeof answers !== "object" || answers === null) return null
  const rows = answers as Record<string, unknown>
  // Measured only — fabricated strength=1 would emit a blind click. A row below
  // the confidence floor is treated as unmeasured and fails open (null).
  const actionRow = jevMeasuredChoice(rows["action"])
  if (!actionRow || !isAction(actionRow.choice) || actionRow.strength < floor || actionRow.strength < threshold)
    return null
  const targetRow = jevMeasuredChoice(rows["target"])
  const target =
    targetRow && targetRow.strength >= threshold && targetRow.choice !== "none"
      ? targetRow.choice.replace(/^\d+:/, "")
      : null
  return {
    action: actionRow.choice,
    target,
    success: jevMeasuredChoice(rows["success"])?.choice === "yes",
    stuck: jevMeasuredChoice(rows["stuck"])?.choice === "yes",
    needScreenshot: jevMeasuredChoice(rows["need_screenshot"])?.choice === "yes",
    strength: actionRow.strength,
  }
}

/**
 * One detached controller call. Returns the gated action+target, or `null`
 * fail-open on any error/timeout/sub-threshold action. The key is never logged.
 *
 * A module-level memo (TTL 60s, max 200 FIFO) short-circuits an identical
 * request — same id, threshold and state — returning the byte-identical cached
 * decision. Only the success path is memoized: miss/timeout/error paths bypass
 * the memo entirely and are not cached, so a transient failure never sticks.
 */
export async function jevControl(input: ControllerInput): Promise<ControllerDecision | null> {
  const questions = buildControllerQuestions(input.controls)
  if (!questions) return null
  const transport = jevTransport(input.model)
  if (!transport) return null
  const threshold = input.threshold ?? JEV_DEFAULT_THRESHOLD
  const floor = input.confidenceFloor ?? JEV_DEFAULT_CONFIDENCE_FLOOR
  const timeoutMs = input.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS
  const state = buildState(input)
  const key = `${input.id ?? "ctl"}:${threshold}:${controllerHash(state)}`
  const hit = controllerMemo.get(key)
  if (hit && hit.expires > Date.now()) return hit.decision
  try {
    const res = await fetch(transport.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://opencode.ai/",
        "X-Title": "opencode",
      },
      body: JSON.stringify({ model: transport.id, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const decision = foldController(await res.json(), threshold, floor)
    if (decision) controllerRemember(key, decision)
    return decision
  } catch {
    return null
  }
}

const CONTROLLER_MEMO_MAX = 200
const CONTROLLER_MEMO_TTL_MS = 60_000
const controllerMemo = new Map<string, { decision: ControllerDecision; expires: number }>()

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
