import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { MCP } from "../mcp"
import * as Tool from "./tool"
import { jevControlDetailed, jevKey, type ControllerOutcome, type JevAction } from "../jev/controller"
import { JEV_DEFAULT_THRESHOLD } from "../jev/client"
import { decodeObservation, resolveTarget, screenSignature } from "./ui-eyes"
import type { Element } from "./ui-eyes"
import {
  CLIPBOARD_REPLACED_NOTE,
  actuationPlan,
  browserNeedsSetup,
  clickAttempt,
  clickSignals,
  clickVerdict,
  fieldValue,
  foldFocusConsumer,
  frameEstablishingRead,
  hotkeyArgs,
  initialTextDelivery,
  isFocusTarget,
  keyPress,
  keySequence,
  observationArgs,
  pixelFrameRetry,
  refindElement,
  remainingSuffix,
  textDeliveryStep,
  valueMatches,
  type ActuationMode,
  type ActuationEvidence,
  type ActuationRung,
  type ClickAttemptEvidence,
  type ClickOutcome,
  type ClickSignals,
  type TextDelivery,
  type WindowRef,
} from "./ui-hands"
import {
  arrival,
  decodeBrowserBinding,
  foldSubstepEvidence,
  matchSkills,
  mineSequences,
  type BrowserBinding,
  type MinedSequence,
  type MiningStep,
  type SkillMatch,
  type SkillStep,
  type SkillSubstepEvidence,
  type UrlRecord,
} from "./ui-skills"
import { buildScene, type Scene } from "./ui-scene"
import { deriveManeuvers, type ManeuverOption } from "./ui-maneuvers"
import {
  plan as derivePlan,
  readOnlyGoal,
  replan as revisePlan,
  type Plan,
  type PlanCandidate,
  type PlanSubgoal,
  type StepRecord,
} from "./ui-plan"
import { progress as measureProgress, sameScene, type Progress } from "./ui-progress"

// EYES owns observation + world model; HANDS owns actuation. They are
// re-exported so the loop's public surface (and its tests) reach the organs
// through one entry point.
export {
  FRONTIER_HARD_MAX,
  advanceMap,
  decodeObservation,
  resolveTarget,
  screenSignature,
} from "./ui-eyes"
export type { Element, Observation } from "./ui-eyes"

const DEFAULT_MAX_STEPS = 30
const HARD_MAX_STEPS = 100
/**
 * Identical re-issues of the SAME maneuver (skill name + goal value) the loop
 * tolerates before it stops. A maneuver may run `MAX_MANEUVER_REPEATS + 1` times;
 * the next identical re-issue stops with `maneuver-repeat-limit`.
 */
export const MAX_MANEUVER_REPEATS = 2
/** Maneuver-repeat accounting state: the current maneuver key and its run count. */
export interface ManeuverRepeatState {
  readonly key?: string
  readonly runs: number
}
export const initialManeuverRepeat = (): ManeuverRepeatState => ({ runs: 0 })

/**
 * MANEUVER REPEAT BOUND.
 * INVARIANT OWNED: a repeated DELIBERATE maneuver is not progress even when the
 * screen changes. Re-issuing the SAME maneuver (skill name + goal value) counts
 * toward a stop bound INDEPENDENT of the screen-change/ambiguity bound — which a
 * redirect can keep resetting (each redirect changes the screen, so the no-op
 * bound never fires). `exceeded` is true once the SAME maneuver has already run
 * `MAX_MANEUVER_REPEATS + 1` times; the caller stops with `maneuver-repeat-limit`
 * and records the attempt chain rather than issuing one more.
 * hardcode-guard:allow the named live repeat is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: `go_to_url` was re-issued 3-4 times in a row
 * because a same-host redirect kept changing the screen, so the no-op bound reset
 * every iteration; the maneuver bound stops the identical re-issue.
 * UNSEEN CASE COVERED: any other deliberate maneuver (dismiss/scroll/search) that
 * keeps "succeeding" without resolving takes the SAME bound, no loop change.
 */
export function maneuverRepeatStep(
  state: ManeuverRepeatState,
  key: string,
): { readonly next: ManeuverRepeatState; readonly runs: number; readonly exceeded: boolean } {
  if (state.key !== key) return { next: { key, runs: 1 }, runs: 1, exceeded: false }
  const runs = state.runs + 1
  return { next: { key, runs }, runs, exceeded: state.runs >= MAX_MANEUVER_REPEATS + 1 }
}
/** Input verbs whose success depends on a preceding focus click on the SAME target. */
const FOCUS_CONSUMING = new Set<JevAction>(["type", "key"])
/**
 * FOCUS-CONSUMER CLASSES — every sub-step kind whose SUCCESS consumes a preceding
 * focus click on the SAME target: a typed entry (`type`/`keys`), the atomic paste
 * and the clipboard write that carries it (`paste`/`clipboard`), and a key/hotkey
 * press (`key`). This is the ONE vocabulary the focus-click delivery resolution
 * tracks, so a route's consumer can never be missed and a new class is added here.
 * hardcode-guard:allow the sub-step verb vocabulary is the registry's own contract, not a case literal
 */
export const FOCUS_CONSUMER_KINDS: ReadonlySet<SkillStep["kind"]> = new Set<SkillStep["kind"]>([
  "type",
  "keys",
  "key",
  "paste",
  "clipboard",
])

/**
 * Whether a click is a FOCUS click by its ROUTE: a consumer that can follow it on
 * the SAME target is still ahead. A click's delivery is then deferred to that
 * consumer instead of judged on the click alone.
 */
export function focusConsumerAhead(steps: readonly SkillStep[]): boolean {
  return steps.some((step) => FOCUS_CONSUMER_KINDS.has(step.kind))
}
const DEFAULT_TIMEOUT = 30_000
const MAX_EXPECT = 8

/**
 * The cua-driver refuses process-scoped key events when one pid owns several
 * eligible top-level windows (process-scoped input cannot be proven to reach the
 * intended one). It names that refusal `same_pid_keyboard_ambiguity` and offers
 * `delivery_mode:"foreground"` as the remedy.
 */
export function needsForegroundDelivery(errorText: string): boolean {
  return errorText.includes("same_pid_keyboard_ambiguity")
}

const EXPECT_BOOLEAN_KEYS = ["exists", "enabled", "selected"]

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizePredicate = (predicate: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(predicate).map(([key, value]) => [
      key,
      isPlainObject(value)
        ? normalizePredicate(value)
        : EXPECT_BOOLEAN_KEYS.includes(key) && (value === "true" || value === "false")
          ? value === "true"
          : value,
    ]),
  )

/**
 * `verify_state` types `exists`/`enabled`/`selected` as booleans, but models emit
 * the string form of those tokens (the documented prose-token failure mode) and
 * its strict `Schema.Boolean` rejects a string, failing every verify. The read
 * site therefore coerces exactly those tokens, exact lowercase match only, and
 * passes every other key and value through verbatim.
 */
export function normalizeExpect(expect: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return expect.map(normalizePredicate)
}

/**
 * GENERAL RULE — VALUES come from the GOAL, not the option space. jev is a chooser
 * over the ENUMERATED controls: it can pick an action and a target, but arbitrary
 * text (a URL, a search phrase, a username) is not in the option space and cannot
 * be chosen from it — hence the live "type-without-text" dead-end. The minimal
 * general mechanism: when the goal literally carries the value (a quoted token or
 * a bare URL), the loop supplies it as the `type` value. Unseen case it covers: a
 * goal whose value is a bare URL with no surrounding quotes — the URL fallback
 * still extracts it.
 */
export function extractGoalValue(goal: string): string | undefined {
  const quoted = goal.match(/["'`]([^"'`]+)["'`]/)
  if (quoted?.[1]?.trim()) return quoted[1].trim()
  return goal.match(/https?:\/\/\S+/)?.[0]
}

/**
 * The decision shape a trace step records — the trace's own vocabulary. It is
 * the union of every termination/act outcome an iteration can emit.
 */
export type StepDecision =
  | {
      readonly kind: "act"
      readonly action: "click" | "type"
      readonly element: Element
      readonly text?: string
      readonly reason: string
    }
  | { readonly kind: "safe"; readonly action: "scroll" | "wait" | "observe"; readonly reason: string }
  | { readonly kind: "stop"; readonly reason: string }
  | { readonly kind: "checkpoint"; readonly target: string; readonly reason: string }

/**
 * GENERAL RULE — a step makes PROGRESS only when the screen its action ran on
 * actually CHANGED. Node identity is the stable `screenSignature` of the
 * observed screen, so `actedAt` (the node an action ran at) can be compared to
 * the successor node `current`: equal signatures mean the action changed
 * nothing, so the count advances toward the ambiguity bound; a differing
 * signature is the only thing that resets it. `undefined` means no action ran
 * last iteration, leaving the count untouched.
 *
 * PREREQUISITE FOCUS is not a no-op: a content-unchanged CLICK that focused the
 * SAME target for an immediately-following input verb (type/key) is one progress
 * unit — click-field → type — so it does not feed the ambiguity bound. Unseen
 * case it covers: a click that focuses a field followed by a raw Enter (key) on
 * that same field to submit, which likewise must not read as a stuck no-op.
 */
export interface AmbiguityContext {
  /** Mode of the action that ran last iteration ("type" is not a click). */
  readonly actedMode?: string
  /** Target the last action ran on. */
  readonly actedTarget?: string
  /** This iteration's decided action + target (the successor). */
  readonly nextAction?: JevAction
  readonly nextTarget?: string | null
}

export function nextAmbiguity(
  ambiguous: number,
  actedAt: string | undefined,
  current: string,
  ctx?: AmbiguityContext,
): number {
  if (actedAt === undefined) return ambiguous
  if (actedAt !== current) return 0
  const prerequisite =
    ctx?.actedMode !== undefined &&
    ctx.actedMode !== "type" &&
    ctx.nextAction !== undefined &&
    FOCUS_CONSUMING.has(ctx.nextAction) &&
    ctx.actedTarget !== undefined &&
    ctx.actedTarget === ctx.nextTarget
  return prerequisite ? ambiguous : ambiguous + 1
}

/**
 * One iteration's externally-checkable trace: what jev returned (verdict,
 * action, target, strength) and what the loop did with it (`decision`,
 * `reason`). A below_gate/unmeasured step carries its verdict and no action; an
 * accepted step carries the decided action + target + strength. Emitted for
 * every iteration so a caller can verify the chain.
 */
export interface StepTrace {
  readonly step: number
  readonly verdict: ControllerOutcome["verdict"]
  readonly action: JevAction | null
  readonly target: string | null
  readonly strength?: number
  readonly decision: StepDecision["kind"] | "skill"
  readonly reason: string
  /** HANDS change evidence for the action this step took, once the next screen is observed. */
  readonly actuation?: ActuationEvidence
  /** AFFIRMATIVE click delivery evidence: rung attempts + verdict over the multi-signal world state. */
  readonly click?: ClickOutcome
  /** A chosen skill's folded sub-step telemetry: ONE trace step over N hand actions. */
  readonly skill?: {
    readonly name: string
    readonly succeeded: boolean
    readonly substeps: readonly SkillSubstepEvidence[]
  }
}

/**
 * SKILL MINING over the run's trace: map each act/skill step to `{ action, target,
 * progressed }` (progressed = click delivered / screen changed / skill succeeded)
 * and return the repeated progressed sub-sequences as promotion CANDIDATES. This
 * only FLAGS — it never mutates the registry; promotion is a human/brain decision.
 * hardcode-guard:allow the decision-tag vocabulary is the trace's own contract, not a case literal
 */
export function mineTrace(trace: readonly StepTrace[]): MinedSequence[] {
  const steps: MiningStep[] = trace.flatMap((entry) => {
    const progressed = entry.click?.worked ?? entry.actuation?.changed ?? entry.skill?.succeeded ?? false
    const action = entry.decision === "skill" ? "skill" : entry.decision === "act" ? entry.action : null
    return action === null ? [] : [{ action, target: entry.target, progressed }]
  })
  return mineSequences(steps)
}

export const Parameters = Schema.Struct({
  goal: Schema.String.annotate({
    description: "Run-level goal the closed loop drives to; re-observed and re-decided every iteration",
  }),
  window: Schema.Struct({ pid: Schema.Int, window_id: Schema.Int }).annotate({
    description: "Target window, as reported by cua-driver_list_windows",
  }),
  steps: Schema.optional(
    Schema.Array(
      Schema.Struct({
        intent: Schema.String.annotate({ description: "Subgoal for this one step, handed to the decision model" }),
        value: Schema.optional(Schema.String).annotate({
          description: "Text to type into the chosen control; when present the step types instead of clicking",
        }),
      }),
    ),
  ).annotate({
    description:
      "DEPRECATED alias for caller-authored fixed steps. The loop is goal-driven now and treats these only as an advisory hint; prefer `goal` + `value`.",
  }),
  value: Schema.optional(Schema.String).annotate({
    description: "Text to type when the decided action is `type`",
  }),
  expect: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))).annotate({
    description: "Verify predicates passed straight through to cua-driver_verify_state",
  }),
  maxSteps: Schema.optional(Schema.Int).annotate({
    description: `Max observe→decide→act→verify iterations (default ${DEFAULT_MAX_STEPS}, hard cap ${HARD_MAX_STEPS})`,
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Metadata = Record<string, unknown>
type ContentItem = { type: string; text?: string }

/** The two CallToolResult fields this loop reads; the SDK type resolves to `never` here. */
type DriverResult = { content: readonly ContentItem[]; structuredContent?: unknown }

export type DriverOutcome = { ok: true; result: DriverResult } | { ok: false; error: string }

/** One driver call, collapsed to ok/error so the loop never inspects an Exit. */
function callDriver(
  tools: Record<string, MCP.McpTool | undefined>,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Effect.Effect<DriverOutcome> {
  const tool = tools[name]
  if (!tool) return Effect.succeed({ ok: false, error: `${name} not found on cua-driver server` })
  return Effect.exit(
    Effect.tryPromise(() =>
      tool.client.callTool({ name: tool.def.name, arguments: args }, CallToolResultSchema, {
        resetTimeoutOnProgress: true,
        signal,
        timeout: tool.timeout ?? DEFAULT_TIMEOUT,
        onprogress: () => {},
      }),
    ),
  ).pipe(
    Effect.map((exit): DriverOutcome =>
      Exit.isFailure(exit)
        ? { ok: false, error: Cause.prettyErrors(exit.cause).map(String).join("\n\n") }
        : exit.value.isError
          ? { ok: false, error: textOf(exit.value.content) || `${name} returned an error` }
          : { ok: true, result: exit.value },
    ),
  )
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .flatMap((item) => (item.type === "text" && item.text ? [item.text] : []))
    .filter((text) => text.trim())
    .join("\n\n")
}

export interface ClickRuns {
  readonly attempts: readonly ClickAttemptEvidence[]
  readonly outcome: ClickOutcome
  /** The last driver click result — diagnostics only, never the verdict. */
  readonly result: DriverOutcome
  /** Screen signature after the last attempt's observation (falls back when unreadable). */
  readonly signature: string
  readonly observations: number
}

/** One driver call, injected so the click runner is exercisable without a live MCP client. */
export type DriverCall = (name: string, args: Record<string, unknown>) => Effect.Effect<DriverOutcome>

/**
 * CLICK RUNGS — the ONE implementation both call sites (the main loop and
 * executeSkill's click sub-step) share, so an on-demand sensor rule can never be
 * fixed at one site and left latent at another.
 *
 * INVARIANT (stated once here): a SENSOR-DEPENDENT actuator establishes the
 * sensor state it needs ON DEMAND, while an OBSERVER optimizes its own payload
 * independently. The pixel rung clicks only when a screenshot frame exists; the
 * loop's own observations carry no screenshot (economy), so a pixel click that
 * reports the driver's no-frame refusal triggers ONE include_screenshot:true read
 * — which is also that failed attempt's after-capture, folding the focus signal
 * the economy probe omits — then a single retry of the same pixel rung. Delivery
 * is judged throughout on the multi-signal world state, never the driver's code.
 * hardcode-guard:allow the named live refusal is one instance cited to ground the invariant
 */
export const runClickRungs = (
  call: DriverCall,
  window: WindowRef,
  target: Element,
  plan: readonly ActuationRung[],
  signalBefore: ClickSignals,
  fallbackSignature: string,
): Effect.Effect<ClickRuns> =>
  Effect.gen(function* () {
    const attempts: ClickAttemptEvidence[] = []
    let result: DriverOutcome = { ok: false, error: "no actuation rung" }
    let signature = fallbackSignature
    let observations = 0
    let frameEstablished = false
    for (const rung of plan) {
      result = yield* call("cua-driver_click", rung.args)
      if (pixelFrameRetry(rung, result.ok ? undefined : result.error, frameEstablished)) {
        const frame = yield* call("cua-driver_get_window_state", frameEstablishingRead(window))
        observations++
        frameEstablished = true
        const frameObs = frame.ok ? decodeObservation(frame.result.structuredContent) : null
        if (frameObs) signature = screenSignature(frameObs.elements)
        const signalAfter = frameObs ? clickSignals(signature, target, frameObs.elements) : signalBefore
        const failed = clickAttempt(rung, signalBefore, signalAfter, target, result.ok ? undefined : result.error)
        attempts.push(failed)
        if (failed.delivered) break
        result = yield* call("cua-driver_click", rung.args)
      }
      const probe = yield* call("cua-driver_get_window_state", observationArgs(window))
      observations++
      const probed = probe.ok ? decodeObservation(probe.result.structuredContent) : null
      if (probed) signature = screenSignature(probed.elements)
      const signalAfter = probed ? clickSignals(signature, target, probed.elements) : signalBefore
      const attempt = clickAttempt(rung, signalBefore, signalAfter, target, result.ok ? undefined : result.error)
      attempts.push(attempt)
      if (attempt.delivered) break
    }
    return { attempts, outcome: clickVerdict(attempts), result, signature, observations }
  })

export interface TypeDeliveryRuns {
  readonly rounds: number
  readonly delivered: number
  /** The full string landed (partial reports were resumed to completion). */
  readonly completed: boolean
  readonly failure?: string
  /** The last driver result — diagnostics only, never the verdict. */
  readonly result: DriverOutcome
}

/**
 * RESUMABLE TEXT DELIVERY — the ONE implementation both call sites (the main loop
 * and executeSkill's type sub-step) share, so a partial-delivery fix can never land
 * at one site and stay latent at the other. Foreground `type_text` sends REAL
 * keystrokes but may land only a PREFIX and report it; this drives the string to
 * completion, retrying ONLY the remaining suffix, bounded by TYPE_ROUND_MAX, and
 * records the rounds and final confirmed count. A partial report is never a
 * failure; an unparsable error or exhausted rounds is.
 */
export const runTypeDelivery = (
  call: DriverCall,
  window: WindowRef,
  element: Element,
  text: string,
): Effect.Effect<TypeDeliveryRuns> =>
  Effect.gen(function* () {
    let delivery: TextDelivery = initialTextDelivery()
    let result: DriverOutcome = { ok: false, error: "no type attempt" }
    while (delivery.failure === undefined && delivery.confirmed < text.length) {
      const args = {
        ...(element.element_token !== undefined ? { element_token: element.element_token } : {}),
        pid: window.pid,
        window_id: window.window_id,
        text: remainingSuffix(text, delivery),
        delivery_mode: "foreground",
      }
      result = yield* call("cua-driver_type_text", args)
      delivery = textDeliveryStep(text, delivery, result.ok ? { ok: true } : { ok: false, error: result.error })
    }
    return {
      rounds: delivery.rounds,
      delivered: delivery.confirmed,
      completed: delivery.failure === undefined && delivery.confirmed >= text.length,
      ...(delivery.failure !== undefined ? { failure: delivery.failure } : {}),
      result,
    }
  })

export interface UrlEntryRuns {
  readonly mode: "paste" | "type"
  /** The full string landed (a paste is atomic; a type fallback was resumed to completion). */
  readonly completed: boolean
  readonly delivered: number
  readonly rounds: number
  readonly failure?: string
  /** The last driver result — diagnostics only, never the verdict. */
  readonly result: DriverOutcome
}

/**
 * ATOMIC URL ENTRY — INVARIANT: prefer ONE atomic input event over N synthesized
 * events when the surface accepts it. A clipboard paste (a clipboard already
 * written, then one `cmd+v` hotkey) is a SINGLE input event that Chromium accepts
 * and submits on Return; N synthesized per-character presses are the live
 * partial-delivery instance, so they are the BOUNDED fallback taken only when the
 * clipboard write did not land. The same runner is shared so a fix cannot land at
 * one sub-step and stay latent at another.
 * hardcode-guard:allow the named live partial-delivery report + driver tool names are the wiring contract under test
 * LIVE FAILURE AS ONE INSTANCE: foreground `type_text` delivered 6 of 24 characters
 * of a URL and the tab navigated to the 6-character prefix.
 * UNSEEN CASE COVERED: any second surface that accepts a single paste but drops
 * synthesized keystrokes (an Electron/WebGL field) takes the SAME atomic paste,
 * with the bounded type fallback unchanged.
 */
export const runUrlEntry = (
  call: DriverCall,
  window: WindowRef,
  element: Element,
  text: string,
  clipboardOk: boolean,
): Effect.Effect<UrlEntryRuns> =>
  Effect.gen(function* () {
    if (clipboardOk) {
      const pasted = yield* call("cua-driver_hotkey", hotkeyArgs(window, ["cmd", "v"]))
      if (pasted.ok) return { mode: "paste", completed: true, delivered: text.length, rounds: 0, result: pasted }
    }
    // clipboard unavailable or the paste chord failed → the bounded resumable type path
    const run = yield* runTypeDelivery(call, window, element, text)
    return {
      mode: "type",
      completed: run.completed,
      delivered: run.delivered,
      rounds: run.rounds,
      ...(run.failure !== undefined ? { failure: run.failure } : {}),
      result: run.result,
    }
  })

// ---------------------------------------------------------------------------
// PLAN LOOP — goal-conditioned maneuvers over one verified executor
//
// hardcode-guard:allow the named live failures are instances cited to ground the plan-loop invariants, not case literals
// INVARIANT OWNED: ui_run commits a PLAN, each iteration takes the next subgoal,
// derives its (bounded) maneuver option space, lets jev choose ONE maneuver, and
// EXECUTES it through the one executor. Termination is a predicate PROVED OVER THE
// SCENE (ui-progress), never jev's say-so. A read-only goal never executes a
// state-changing maneuver; a state-changing maneuver needs measured gate strength;
// a credential wall stops the run and types nothing.
// LIVE INSTANCES: a loop that clicked a message list's selection checkboxes and a
// flat aimless frontier becomes one option space of navigational maneuvers.
// UNSEEN CASE: any other scene whose goal-relevant region differs from chrome takes
// the same region-scoped predicates, no change.
// ---------------------------------------------------------------------------

/**
 * Minimum gate strength a STATE-CHANGING action must carry before it executes.
 * Derived from the shared jev controller threshold (`JEV_DEFAULT_THRESHOLD`) so a
 * drift in the controller's rule propagates to the loop's gate instead of being
 * mirrored by a second literal.
 */
export const GATE_FLOOR = JEV_DEFAULT_THRESHOLD

const STATUS_READ_ONLY = "read-only-blocked"
const STATUS_BELOW_GATE = "below-gate"
const STATUS_NO_MANEUVER = "no-maneuver"
const STATUS_LOGIN_WALL = "login-wall"
/**
 * The scene kept arriving past the settle budget, so the loop withheld judgement
 * rather than deciding on a moving page. A DISTINCT status, never `completed` or
 * `no-maneuver` — a partial render must not satisfy a read or end the run.
 */
export const STATUS_UNSETTLED = "scene-unsettled"
/** Bounded number of observations one settle may take before it is declared unsettled. */
export const SETTLE_BUDGET = 8
/**
 * A page can present a momentarily-stable LOADING state (a skeleton, a spinner)
 * that two back-to-back observations would agree on. Settling therefore WAITS
 * between observations and requires the scene to stay unchanged for a minimum
 * duration before it counts as settled, so a page that is still arriving is never
 * judged. Both are wired by the tool; the loop's defaults are zero so tests run
 * without wall-clock delay.
 */
export const SETTLE_INTERVAL_MS = 800
export const SETTLE_MIN_STABLE_MS = 1_500
/** A destructive maneuver stops here for consent — distinct from the gate stops. */
export const STATUS_DESTRUCTIVE = "destructive-consent-required"
/** Every predicate is satisfied but no satisfied subgoal cites observable content. */
export const STATUS_UNEVIDENCED = "completion-without-evidence"
/** The loop's existing maneuver-repeat bound status, mirrored into the plan loop. */
const REASON_MANEUVER_REPEAT = "maneuver-repeat-limit"

export interface ManeuverExecution {
  readonly deliveryModes: readonly ActuationMode[]
  readonly paste?: { readonly mode: string; readonly completed: boolean }
  readonly navigate?: { readonly requested?: string; readonly landed?: string }
  readonly failure?: string
}

export interface ManeuverChoice {
  readonly label?: string
  readonly strength?: number
}

/**
 * The outcome of SETTLING perception: the last observed Scene, how many
 * observations the settle took, and whether consecutive observations converged
 * (`settled`) or the bounded budget expired first (`false`).
 */
export interface SettleOutcome {
  readonly scene: Scene
  readonly observations: number
  readonly settled: boolean
}

/** The destructive maneuver the loop blocked on, and the strength it carried. */
export interface DestructiveConsent {
  readonly option: string
  /** The irreversible affordance label the maneuver would have activated. */
  readonly target?: string
  readonly strength?: number
}

export interface PlanLoopTelemetry {
  readonly planId: string
  readonly subgoalIndex: number
  readonly maneuver: string
  readonly label: string
  readonly strength?: number
  readonly deliveryModes: readonly ActuationMode[]
  readonly paste?: { readonly mode: string; readonly completed: boolean }
  readonly navigate?: { readonly requested?: string; readonly landed?: string }
  /** Progress measured over the Scene AFTER the step. */
  readonly progress: { readonly done: number; readonly total: number; readonly reasons: readonly string[] }
  /** How many observations the post-action settle took, and whether it converged. */
  readonly settle?: { readonly observations: number; readonly settled: boolean }
  readonly reason: string
}

export interface PlanLoopDeps {
  readonly goal: string
  readonly observe: () => Effect.Effect<Scene | undefined>
  readonly choosePlan: (candidates: readonly PlanCandidate[], scene: Scene) => Effect.Effect<string | undefined>
  readonly chooseManeuver: (
    subgoal: PlanSubgoal,
    options: readonly ManeuverOption[],
    scene: Scene,
  ) => Effect.Effect<ManeuverChoice>
  readonly execute: (option: ManeuverOption, subgoal: PlanSubgoal, scene: Scene) => Effect.Effect<ManeuverExecution>
  readonly stateChanging: (option: ManeuverOption, scene: Scene) => boolean
  readonly readOnly: boolean
  readonly maxSteps: number
  readonly gateFloor?: number
  /** Bounded observations one settle may take before it is declared unsettled (default SETTLE_BUDGET). */
  readonly settleBudget?: number
  /** Bounded wait between settle observations (default 0; the tool wires SETTLE_INTERVAL_MS). */
  readonly settleDelayMs?: number
  /** How long the scene must stay unchanged before it counts as settled (default 0). */
  readonly settleMinStableMs?: number
}

export interface PlanLoopResult {
  readonly status: string
  readonly reason: string
  readonly planId?: string
  readonly telemetry: readonly PlanLoopTelemetry[]
  readonly progress: Progress | undefined
  readonly frontier: readonly string[]
  /** Present iff a destructive maneuver stopped the loop for consent. */
  readonly consent?: DestructiveConsent
  /** The concrete observed content behind a `completed` report (evidence-bound success). */
  readonly evidence?: readonly string[]
}

// hardcode-guard:allow the mining vocabulary (action/target/progressed) is the plan telemetry's own contract, not case literals
/**
 * SKILL MINING over the PLAN telemetry: fold each executed maneuver to one
 * mining step (`action` = the maneuver name, `target` = its option label,
 * `progressed` = the maneuver ran and was DELIVERED rather than failed) and
 * return the repeated progressed sub-sequences as promotion CANDIDATES. This
 * only FLAGS — it never mutates the registry; promotion is a human/brain decision.
 */
export function minePlan(telemetry: readonly PlanLoopTelemetry[]): MinedSequence[] {
  return mineSequences(
    telemetry.map((entry) => ({
      action: entry.maneuver,
      target: entry.label,
      progressed: entry.reason === "executed" && entry.deliveryModes.length > 0,
    })),
  )
}

export interface RunSummary {
  readonly status: string
  readonly planId?: string
  readonly telemetry: readonly PlanLoopTelemetry[]
  readonly promotionCandidates: readonly MinedSequence[]
  /** Present iff the run stopped on a destructive maneuver awaiting consent. */
  readonly consent?: DestructiveConsent
  /** Present iff the run reported completion backed by cited content. */
  readonly evidence?: readonly string[]
}

/**
 * EVIDENCE-BOUND COMPLETION — the citable content behind a COMPLETED report.
 * Returns the concrete content (labels/texts/urls) every satisfied subgoal cites,
 * or `undefined` when any satisfied subgoal cannot cite observable content — a run
 * may not claim success without evidence. An `unknown`/unsatisfied subgoal is not
 * part of completion (an unsatisfied predicate means the run is not complete).
 */
export function completionEvidence(progress: Progress): readonly string[] | undefined {
  const satisfied = progress.perSubgoal.filter((entry) => entry.success)
  if (satisfied.length === 0) return undefined
  if (satisfied.some((entry) => entry.cited.every((c) => c.trim().length === 0))) return undefined
  return [...new Set(satisfied.flatMap((entry) => entry.cited).filter((c) => c.trim().length > 0))]
}

/**
 * The run's returned SUMMARY/METADATA: the plan id, the FULL per-step plan
 * telemetry (subgoal index, maneuver, strength, delivery evidence, measured
 * progress) and the mining candidates, so the returned metadata alone carries
 * every decision and its evidence.
 */
export function planSummary(planResult: PlanLoopResult): RunSummary {
  return {
    status: planResult.status,
    ...(planResult.planId !== undefined ? { planId: planResult.planId } : {}),
    telemetry: planResult.telemetry,
    promotionCandidates: minePlan(planResult.telemetry),
    ...(planResult.consent !== undefined ? { consent: planResult.consent } : {}),
    ...(planResult.evidence !== undefined ? { evidence: planResult.evidence } : {}),
  }
}

const CREDENTIAL_TEXT = /\b(sign in to continue|log ?in to continue|enter (?:your )?password|create a password)\b/i

/**
 * LOGIN / CREDENTIAL WALL — a Scene whose next step would be entering credentials.
 * A secure text field (or a "sign in to continue" style prompt) is the marker; the
 * loop STOPS with a distinct reason and types nothing. Detection is role/text
 * derived from the Scene, never a site name.
 */
export function loginWall(scene: Scene): string | undefined {
  const secure =
    scene.items.some((item) => item.role === "AXSecureTextField") ||
    scene.texts.some((text) => text.role === "AXSecureTextField")
  if (secure) return "credential-wall: a secure text field is present; the run types nothing"
  const prompt = scene.texts.map((text) => text.text).find((text) => CREDENTIAL_TEXT.test(text))
  return prompt !== undefined ? `credential-wall: "${prompt}"; the run types nothing` : undefined
}

/** A plan is read-only when its goal names no state-mutating verb. */
export function readOnlyPlan(plan: Plan): boolean {
  return readOnlyGoal(plan.goal)
}

/** Whether acting on a maneuver mutates state (checkbox/radio/toggle/selectable row). */
export function stateChangingManeuver(option: ManeuverOption, scene: Scene): boolean {
  const ids = new Set(option.targets.map((target) => target.id))
  return scene.items.some((item) => ids.has(item.id) && item.stateChanging)
}

// hardcode-guard:allow the destructive verb set and the activating-maneuver names are the boundary's own general vocabulary (a governor input), not case/site literals
/**
 * DESTRUCTIVE-CONSENT BOUNDARY.
 * INVARIANT OWNED: an IRREVERSIBLE write affordance is never auto-executed at ANY
 * confidence — a maneuver that would ACTIVATE a target whose Scene semantics mark
 * it irreversible stops the loop for consent even ABOVE the gate. Classification is
 * derived from the Scene's role/label semantics (never a site, app or address name).
 * LIVE INSTANCE IT RESTORES: the flat decider returned a `checkpoint` (consent stop)
 * for any chosen target whose label carried a destructive verb; the plan rewrite
 * dropped that stop while the tool description kept promising it.
 * LIVE INSTANCE — UNINTENDED STATE CHANGE: the wallpaper/checkbox class, where a
 * click mutates state the goal never asked for; the same boundary keeps an
 * irreversible control from being auto-pressed.
 * UNSEEN CASE COVERED: any other irreversible affordance — a "Unsubscribe" list
 * row, a "Send"/"Purchase" control — on any screen takes the same stop, no change.
 */
const DESTRUCTIVE =
  /\b(save|submit|delete|remove|erase|confirm|apply|send|discard|reset|overwrite|uninstall|purchase|buy|pay|checkout|revoke|unsubscribe|deactivate)\b/i

export const isDestructive = (label: string): boolean => DESTRUCTIVE.test(label)

/**
 * Maneuvers that ACTIVATE a bound control (press/click/select) — the only ones that
 * can commit an irreversible write. Reading, scrolling, navigation and typing never
 * activate a labelled control, so a destructive label under them stays inert.
 */
const ACTIVATING_MANEUVERS = new Set(["open_item", "activate", "dismiss_dialog"])

/** Whether executing a maneuver would activate an irreversible affordance. */
export function destructiveManeuver(option: ManeuverOption, scene: Scene): boolean {
  return destructiveTarget(option, scene) !== undefined
}

/** The irreversible affordance a maneuver would activate, if any. */
export function destructiveTarget(option: ManeuverOption, scene: Scene): string | undefined {
  if (!ACTIVATING_MANEUVERS.has(option.name)) return undefined
  const ids = new Set(option.targets.map((target) => target.id))
  return scene.items.find((item) => ids.has(item.id) && isDestructive(item.label))?.label
}

/**
 * The plan-driven core: commit a plan, measure progress over the Scene, take the
 * next subgoal, derive maneuvers, choose ONE, execute it, repeat — terminating only
 * on a predicate proved over the Scene. `observe`/`choosePlan`/`chooseManeuver`/
 * `execute` are injected so the loop is exercisable over fixtures without a driver.
 */
export function planLoop(deps: PlanLoopDeps): Effect.Effect<PlanLoopResult> {
  return Effect.gen(function* () {
    const gateFloor = deps.gateFloor ?? GATE_FLOOR
    const settleBudget = Math.max(2, deps.settleBudget ?? SETTLE_BUDGET)
    const settleDelayMs = Math.max(0, deps.settleDelayMs ?? 0)
    const settleMinStableMs = Math.max(0, deps.settleMinStableMs ?? 0)
    const telemetry: PlanLoopTelemetry[] = []
    const history: StepRecord[] = []
    let maneuverRepeat: ManeuverRepeatState = initialManeuverRepeat()
    let plan: Plan | undefined
    let planId: string | undefined
    let lastProgress: Progress | undefined
    let frontier: readonly string[] = []
    const result = (
      status: string,
      reason: string,
      consent?: DestructiveConsent,
      evidence?: readonly string[],
    ): PlanLoopResult => ({
      status,
      reason,
      ...(planId !== undefined ? { planId } : {}),
      telemetry,
      progress: lastProgress,
      frontier,
      ...(consent !== undefined ? { consent } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
    })

    // SETTLE: perception must CONVERGE before it is judged. Poll the one
    // non-state-changing action (the observation itself, so nothing mutates),
    // waiting between observations, until two consecutive observations show the
    // SAME scene identity AND the same item/text content signature AND the scene
    // has stayed unchanged for the minimum stable duration — or the bounded settle
    // budget expires. The duration floor rejects a momentarily-stable loading state
    // (a skeleton/spinner) that two back-to-back observations would agree on.
    const settle = (): Effect.Effect<SettleOutcome | undefined> =>
      Effect.gen(function* () {
        let previous = yield* deps.observe()
        if (previous === undefined) return undefined
        let observations = 1
        let stableSince = Date.now()
        while (observations < settleBudget) {
          if (settleDelayMs > 0) yield* Effect.sleep(settleDelayMs)
          const next = yield* deps.observe()
          if (next === undefined) return undefined
          observations++
          if (sameScene(previous, next)) {
            if (Date.now() - stableSince >= settleMinStableMs) return { scene: next, observations, settled: true }
          } else {
            stableSince = Date.now()
          }
          previous = next
        }
        return { scene: previous, observations, settled: false }
      })

    // EVIDENCE-BOUND COMPLETION: completion is only reported when every satisfied
    // subgoal cites the observed content behind it. A completion that cannot cite
    // evidence is refused with a distinct status rather than reported as success.
    const complete = (current: Progress): PlanLoopResult => {
      const evidence = completionEvidence(current)
      return evidence === undefined
        ? result(
            STATUS_UNEVIDENCED,
            "every predicate is satisfied but no satisfied subgoal cites observable content; refusing to report success",
          )
        : result("completed", "predicate-satisfied", undefined, evidence)
    }

    for (let iteration = 0; iteration < deps.maxSteps; iteration++) {
      const seen = yield* settle()
      if (seen === undefined) return result("unparseable-observation", "observation could not be decoded into a Scene")
      const scene = seen.scene
      // NO JUDGEMENT ON A MOVING SCENE: a page still arriving is never judged —
      // no plan is derived from it, no predicate read (so a partial list can never
      // satisfy a read) and no completion. The loop stops with a DISTINCT status
      // rather than a false decision.
      if (!seen.settled)
        return result(
          STATUS_UNSETTLED,
          `scene did not settle within ${settleBudget} observations (${seen.observations} observed); judgement withheld`,
        )
      const wall = loginWall(scene)
      if (wall !== undefined) return result(STATUS_LOGIN_WALL, wall)
      if (plan === undefined) {
        const decision = derivePlan(deps.goal, scene)
        if (decision.candidates.length > 1) {
          const chosenId = yield* deps.choosePlan(decision.candidates, scene)
          const candidate = decision.candidates.find((entry) => entry.id === chosenId)
          plan = candidate?.plan ?? decision.commit
          planId = candidate?.id ?? decision.commitId
        } else {
          plan = decision.commit
          planId = decision.commitId
        }
      }
      const current = measureProgress(plan, scene, history)
      lastProgress = current
      if (current.nextSubgoal === undefined) return complete(current)
      if (current.exhausted) return result("budget-exhausted", current.reason ?? "budget-exhausted")
      if (current.shouldReplan) {
        const revised = revisePlan(plan, scene, history)
        if (revised === plan) return result(current.reason ?? "replan-exhausted", current.reason ?? "replan-exhausted")
        plan = revised
        continue
      }
      const subgoal = plan.subgoals[current.nextSubgoal]
      if (subgoal === undefined) return complete(current)
      const set = deriveManeuvers(subgoal.params, scene)
      if (set.options.length === 0) return result(STATUS_NO_MANEUVER, set.reason ?? STATUS_NO_MANEUVER)
      const eligible = deps.readOnly ? set.options.filter((option) => !deps.stateChanging(option, scene)) : set.options
      frontier = eligible.map((option) => option.label)
      if (eligible.length === 0)
        return result(STATUS_READ_ONLY, "read-only goal: every derived maneuver mutates state")
      const choice = yield* deps.chooseManeuver(subgoal, eligible, scene)
      const option = eligible.find((entry) => entry.label === choice.label)
      if (option === undefined) return result("no-choice", "jev chose no maneuver among the offered options")
      // DESTRUCTIVE-CONSENT BOUNDARY: an irreversible maneuver stops for consent
      // BEFORE the gate — even a strong verdict never auto-executes it. The
      // blocking option, its irreversible target and its measured strength are
      // reported so the brain/user can consent.
      const blocking = destructiveTarget(option, scene)
      if (blocking !== undefined)
        return result(
          STATUS_DESTRUCTIVE,
          `destructive maneuver "${option.label}" targets "${blocking}" and requires consent (${choice.strength ?? "unmeasured"}); nothing executed`,
          {
            option: option.label,
            target: blocking,
            ...(choice.strength !== undefined ? { strength: choice.strength } : {}),
          },
        )
      if (deps.stateChanging(option, scene)) {
        if (choice.strength === undefined)
          return result(STATUS_BELOW_GATE, "state-changing maneuver with no measured gate strength; nothing executed")
        if (choice.strength < gateFloor)
          return result(
            STATUS_BELOW_GATE,
            `state-changing maneuver below the gate floor (${choice.strength} < ${gateFloor}); nothing executed`,
          )
      }
      // MANEUVER REPEAT BOUND: an identical deliberate maneuver re-issued past the
      // bound stops the run rather than hammering (counted independently of any
      // screen change a redirect keeps producing).
      const key = `${option.name}\u0000${subgoal.params.value ?? subgoal.params.matching ?? ""}`
      const repeat = maneuverRepeatStep(maneuverRepeat, key)
      if (repeat.exceeded) return result(REASON_MANEUVER_REPEAT, `maneuver ${option.name} re-issued ${maneuverRepeat.runs}× unresolved`)
      maneuverRepeat = repeat.next
      const execution = yield* deps.execute(option, subgoal, scene)
      // SETTLE AFTER ACTION: the maneuver may have changed the page; wait for the
      // result to arrive (bounded) before judging it. The settle's observation
      // count and convergence are recorded in this step's telemetry.
      const post = yield* settle()
      const afterScene = post?.scene ?? scene
      history.push({
        maneuver: key,
        scene: afterScene,
        subgoalIndex: current.nextSubgoal,
      })
      const after = measureProgress(plan, afterScene, history, post?.settled ?? false)
      lastProgress = after
      telemetry.push({
        planId: planId ?? "plan",
        subgoalIndex: current.nextSubgoal,
        maneuver: option.name,
        label: option.label,
        ...(choice.strength !== undefined ? { strength: choice.strength } : {}),
        deliveryModes: execution.deliveryModes,
        ...(execution.paste !== undefined ? { paste: execution.paste } : {}),
        ...(execution.navigate !== undefined ? { navigate: execution.navigate } : {}),
        ...(post !== undefined ? { settle: { observations: post.observations, settled: post.settled } } : {}),
        progress: {
          done: after.done,
          total: after.total,
          reasons: after.reason !== undefined ? [after.reason] : [],
        },
        reason: execution.failure !== undefined ? `failed: ${execution.failure}` : "executed",
      })
      if (execution.failure !== undefined) return result("failed", execution.failure)
      if (post !== undefined && !post.settled)
        return result(
          STATUS_UNSETTLED,
          `scene did not settle after ${option.name} within ${settleBudget} observations (${post.observations} observed); judgement withheld`,
        )
    }
    return result("budget-exhausted", `no predicate proved within ${deps.maxSteps} steps`)
  })
}

export const UiRunTool = Tool.define<typeof Parameters, Metadata, MCP.Service>(
  "ui_run",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    return {
      description:
        "Drive a window to a goal in ONE call with a CLOSED observe-decide-act-verify loop: every iteration re-observes the window afresh, re-decides with jev from that iteration's live controls, validates the target against them and acts, then verifies. It stops only on OBSERVED evidence (cua-driver_verify_state), an exhausted budget, N consecutive ambiguous decisions, a destructive-action (irreversible write) boundary — a Delete/Remove/Submit/Send/Confirm/Purchase/Save-type affordance stops the run for consent with status `destructive-consent-required`, even above the gate — or a driver error. A missing/sub-threshold decision never aborts: it falls to a safe action (scroll/wait/re-observe) up to a small bound. An undecodable observation still stops (targets are never guessed from prose), and jev's `goal_met` is advisory only. Pass `expect` to verify the end state. A `completed` report is EVIDENCE-BOUND: every satisfied predicate must cite the observed content behind it, and a completion that cannot cite evidence stops with status `completion-without-evidence` instead of reporting success. Requires the cua-driver MCP server and a configured jev key; returns an unavailable notice otherwise.",
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const tools = yield* mcp.tools()
          if (!Object.keys(tools).some((key) => key.startsWith("cua-driver_"))) {
            return {
              title: "ui_run (unavailable)",
              metadata: {},
              output: "cua-driver MCP server is not connected",
            }
          }
          if (params.steps !== undefined && params.steps.length > HARD_MAX_STEPS) {
            return {
              title: "ui_run (rejected)",
              metadata: {},
              output: `ui_run accepts at most ${HARD_MAX_STEPS} deprecated steps per call; received ${params.steps.length}.`,
            }
          }
          if (params.expect !== undefined && (params.expect.length === 0 || params.expect.length > MAX_EXPECT)) {
            return {
              title: "ui_run (rejected)",
              metadata: {},
              output: `ui_run expects between 1 and ${MAX_EXPECT} verify predicates; received ${params.expect.length}.`,
            }
          }
          const key = jevKey()
          if (!key) {
            return {
              title: "ui_run (unavailable)",
              metadata: {},
              output: "jev decision key not configured",
            }
          }

          const maxSteps = Math.min(Math.max(params.maxSteps ?? DEFAULT_MAX_STEPS, 1), HARD_MAX_STEPS)
          const goal = params.steps?.length
            ? `${params.goal} (deprecated steps hint: ${params.steps.map((s) => s.intent).join(" > ")})`
            : params.goal

          const lines: string[] = []
          let executed = 0
          let observations = 0

          // SKILLS execution: run a chosen maneuver's FIXED sub-sequence directly
          // (no per-sub-step jev decisions), re-observing after each sub-step so the
          // folded evidence carries a real before/after signature per step. Returns
          // the folded sub-steps + whether the skill's success predicate held.
          // hardcode-guard:allow generic skill-runner wiring over the registry contract, no case literals
          const executeSkill = (match: SkillMatch, before: string, elements: readonly Element[]) =>
            Effect.gen(function* () {
              const signatures: string[] = [before]
              const modes: { label: string; mode: ActuationMode }[] = []
              const deliveries: (boolean | undefined)[] = []
              // Read sub-step results (labels matching the step's token), folded into the trace.
              const reads: (readonly string[] | undefined)[] = []
              // Verify sub-step results (the page URL/title actually changed).
              const urlChanges: (boolean | undefined)[] = []
              // Value-gate sub-step results (the target's value matched the goal), by trace index.
              const valueByIndex = new Map<number, boolean>()
              // Per-sub-step privacy/actuation notes (e.g. the clipboard was replaced), by trace index.
              const noteByIndex = new Map<number, string>()
              // Per-sub-step URL records (requested + arrival), by trace index.
              const urlByIndex = new Map<number, UrlRecord>()
              let observationsUsed = 0
              let failure: string | undefined
              // Whether the clipboard write landed — the paste sub-step's fallback gate.
              let clipboardOk = false
              // BIND classification, carried to the branch step.
              let binding: BrowserBinding | undefined
              // A FOCUS click whose delivery is deferred to its consumer sub-step.
              let pendingFocus: { readonly index: number; readonly attempt: ClickAttemptEvidence } | undefined
              // Text sub-step delivery accounting (rounds + final delivered count), by trace index.
              const textByIndex = new Map<number, { readonly rounds: number; readonly delivered: number }>()
              // TOKEN FRESHNESS: the skill's target, the newest observed element set,
              // and whether a snapshot-minting driver call has run since that set was
              // read (bind/prepare/navigate/act mint new snapshots and stale tokens).
              let target = match.element
              let newest: readonly Element[] = elements
              let staleSnapshot = false
              // Re-resolve the target from a NEWEST observation before any driver call
              // that uses its element_token. Observes only when a snapshot-minting
              // call ran since the last observation, then always re-resolves the
              // handle against the newest element set, so a token never outlives its
              // snapshot (the stale-token live failure).
              const freshTarget = Effect.gen(function* () {
                if (staleSnapshot) {
                  const fresh = yield* callDriver(
                    tools,
                    "cua-driver_get_window_state",
                    observationArgs(params.window),
                    ctx.abort,
                  )
                  observationsUsed++
                  staleSnapshot = false
                  const obs = fresh.ok ? decodeObservation(fresh.result.structuredContent) : null
                  if (obs) newest = obs.elements
                }
                target = refindElement(target, newest) ?? target
                return target
              })
              // FUNCTIONAL DELIVERY — ONE site resolves a pending FOCUS click's
              // delivery from ANY consumer that followed it on the SAME target, so
              // every consumer class (type/key/keys/paste/clipboard/hotkey) is
              // covered and no class can be left latent. `landed` is the consumer's
              // OWN success signal (a verified value / a completed paste); a
              // consumer that neither lands nor moves a signal leaves it pending.
              const settleFocus = (consumerElements: readonly Element[] | undefined, landed: boolean): void => {
                if (pendingFocus === undefined || consumerElements === undefined) return
                const consumerSignals = clickSignals(signatures.at(-1) ?? before, target, consumerElements)
                if (foldFocusConsumer(pendingFocus.attempt, consumerSignals, target, landed).delivered) {
                  deliveries[pendingFocus.index] = true
                  pendingFocus = undefined
                }
              }
              const queue: SkillStep[] = [...match.skill.steps(match)]
              while (queue.length > 0) {
                const sub = queue.shift()
                if (sub === undefined) break
                // DECLARATIVE BRANCH: the bind classification picks the arm.
                if (sub.kind === "branch") {
                  queue.unshift(...(binding?.browser ? sub.browser : sub.fallback))
                  continue
                }
                // hardcode-guard:allow the browser tool/verb vocabulary is the registry's own contract, not a case literal
                // hardcode-guard:allow the policy-answer token is the driver's own refusal vocabulary, not a case literal
                if (sub.kind === "prepare") {
                  // PREPARE the browser endpoint (`browser_prepare`) — attaches/owns
                  // the DevTools endpoint, the precondition for a bind to succeed on
                  // a Chromium window. `browser_requires_setup` (a live browser with
                  // no owned endpoint) is a POLICY ANSWER, not a transient error:
                  // do NOT retry — treat the window as not-a-browser and let the
                  // route short-circuit to the address-bar sequence.
                  const prepared = yield* callDriver(
                    tools,
                    "cua-driver_browser_prepare",
                    { pid: params.window.pid },
                    ctx.abort,
                  )
                  observationsUsed++
                  staleSnapshot = true
                  signatures.push(signatures.at(-1) ?? before)
                  modes.push({ label: sub.label, mode: "prepare" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  if (prepared.ok) continue
                  if (browserNeedsSetup(prepared.error)) {
                    binding = { browser: false }
                    continue
                  }
                  failure = prepared.error
                  break
                }
                // hardcode-guard:allow the browser tool/branch vocabulary is the registry's own contract, not a case literal
                if (sub.kind === "bind") {
                  // SANCTIONED BIND (mode 1): pid+window_id classifies the window.
                  const bound = yield* callDriver(
                    tools,
                    "cua-driver_get_browser_state",
                    { pid: params.window.pid, window_id: params.window.window_id },
                    ctx.abort,
                  )
                  observationsUsed++
                  binding = bound.ok ? decodeBrowserBinding(bound.result.structuredContent) : { browser: false }
                  // a bind mints a new snapshot: any token read before it is stale
                  staleSnapshot = true
                  signatures.push(signatures.at(-1) ?? before)
                  modes.push({ label: sub.label, mode: "bind" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  continue
                }
                if (sub.kind === "navigate") {
                  if (binding?.browser !== true || binding.target_id === undefined || binding.tab_id === undefined) {
                    failure = "browser_navigate without a usable browser binding"
                    break
                  }
                  const nav = yield* callDriver(
                    tools,
                    "cua-driver_browser_navigate",
                    { target_id: binding.target_id, tab_id: binding.tab_id, url: sub.url },
                    ctx.abort,
                  )
                  observationsUsed++
                  staleSnapshot = true
                  signatures.push(signatures.at(-1) ?? before)
                  modes.push({ label: sub.label, mode: "navigate" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  urlByIndex.set(modes.length - 1, { requested: sub.url })
                  if (!nav.ok) {
                    failure = nav.error
                    break
                  }
                  continue
                }
                if (sub.kind === "verifyUrl") {
                  const bound = binding
                  const state =
                    bound?.target_id !== undefined && bound.tab_id !== undefined
                      ? yield* callDriver(
                          tools,
                          "cua-driver_get_browser_state",
                          { target_id: bound.target_id, tab_id: bound.tab_id, snapshot_format: "semantic_v2" },
                          ctx.abort,
                        )
                      : undefined
                  if (state !== undefined) observationsUsed++
                  staleSnapshot = true
                  const after = state?.ok ? decodeBrowserBinding(state.result.structuredContent) : undefined
                  // hardcode-guard:allow the arrival predicate is the loop's own contract, not a case literal
                  // ARRIVAL BY DESTINATION IDENTITY: the landed URL's host vs the
                  // goal's host — a same-host redirect is arrival, not failure.
                  const landing = arrival(sub.url, after?.url)
                  urlChanges.push(landing.status === "arrived" || landing.status === "arrived-via-redirect")
                  signatures.push(signatures.at(-1) ?? before)
                  modes.push({ label: sub.label, mode: "read" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlByIndex.set(modes.length - 1, { requested: sub.url, arrival: landing })
                  continue
                }
                if (sub.kind === "verifyScreen") {
                  const observedVerify = yield* callDriver(
                    tools,
                    "cua-driver_get_window_state",
                    observationArgs(params.window),
                    ctx.abort,
                  )
                  observationsUsed++
                  const vObs = observedVerify.ok ? decodeObservation(observedVerify.result.structuredContent) : null
                  // a fresh observation is the NEWEST element set; nothing is stale now
                  if (vObs) newest = vObs.elements
                  staleSnapshot = false
                  const priorSignature = signatures.at(-1) ?? before
                  const verifiedSignature = vObs ? screenSignature(vObs.elements) : priorSignature
                  urlChanges.push(verifiedSignature !== priorSignature)
                  signatures.push(verifiedSignature)
                  modes.push({ label: sub.label, mode: "read" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  continue
                }
                // hardcode-guard:allow the refusal token is the loop's internal vocabulary, not a case literal
                if (sub.kind === "click") {
                  // AFFIRMATIVE click sub-step: escalate declared→pixel on ABSENT
                  // delivery through the shared rung runner (which also establishes
                  // a screenshot frame on demand for the sensor-dependent pixel
                  // rung). A FOCUS click is NOT aborted on absent delivery: its
                  // delivery is deferred to its consumer sub-step.
                  // TOKEN FRESHNESS: re-resolve the target from the newest
                  // observation before the click commits its handle.
                  // hardcode-guard:allow the freshness rule is the hand contract, not a case literal
                  target = yield* freshTarget
                  const plan = actuationPlan(target, params.window)
                  const fallback = signatures.at(-1) ?? before
                  const signalBefore = clickSignals(fallback, target, newest)
                  const run = yield* runClickRungs(
                    (name, args) => callDriver(tools, name, args, ctx.abort),
                    params.window,
                    target,
                    plan,
                    signalBefore,
                    fallback,
                  )
                  observationsUsed += run.observations
                  staleSnapshot = true
                  signatures.push(run.signature)
                  const first = run.attempts[0]
                  // A FOCUS click defers its delivery to its consumer: either the
                  // element DECLARES a press (isFocusTarget), or a focus-consuming
                  // sub-step (type/key/paste/clipboard/hotkey) still follows on the
                  // SAME target. The final honesty check rejects the deferral when
                  // no consumer ever lands.
                  if (!run.outcome.worked && first !== undefined && (isFocusTarget(target) || focusConsumerAhead(queue))) {
                    // The FIRST (declared) rung is the one a focus click's consumer
                    // proves, so a deferring click records that rung's mode — never
                    // the last-tried pixel rung, which is only the undelivered tail.
                    modes.push({ label: sub.label, mode: first.mode })
                    reads.push(undefined)
                    urlChanges.push(undefined)
                    pendingFocus = { index: modes.length - 1, attempt: first }
                    deliveries.push(false)
                    continue
                  }
                  modes.push({ label: sub.label, mode: run.outcome.mode })
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  deliveries.push(run.outcome.worked)
                  if (!run.outcome.worked) {
                    failure = "click undelivered on every rung"
                    break
                  }
                  continue
                }
                // hardcode-guard:allow the sub-step verb vocabulary is the skills' own contract, not a case literal
                if (sub.kind === "read") {
                  // READ: no actuation — the fresh observation IS the result. Fold
                  // the labels matching the step's token into the trace.
                  const observedRead = yield* callDriver(
                    tools,
                    "cua-driver_get_window_state",
                    observationArgs(params.window),
                    ctx.abort,
                  )
                  observationsUsed++
                  const readObs = observedRead.ok ? decodeObservation(observedRead.result.structuredContent) : null
                  if (readObs) newest = readObs.elements
                  staleSnapshot = false
                  signatures.push(readObs ? screenSignature(readObs.elements) : (signatures.at(-1) ?? before))
                  modes.push({ label: sub.label, mode: "read" })
                  deliveries.push(undefined)
                  reads.push(
                    readObs
                      ? readObs.elements.flatMap((element) =>
                          element.label && element.label.includes(sub.match) ? [element.label] : [],
                        )
                      : undefined,
                  )
                  urlChanges.push(undefined)
                  continue
                }
                // hardcode-guard:allow the keystroke verb + driver tool name are the registry/hand contract, not a case literal
                if (sub.kind === "keys") {
                  // KEYSTROKE ROUTE — real per-character key events, never
                  // accessibility insertion: a surface that accepts an inserted
                  // value but never commits it commits only on real key events. One
                  // press_key per code point, the foreground remedy for
                  // `same_pid_keyboard_ambiguity` applied exactly as for a single
                  // key, then ONE observation of the sub-step's effect. TOKEN
                  // FRESHNESS: re-resolve the target before the sequence commits.
                  // hardcode-guard:allow the freshness rule is the hand contract, not a case literal
                  target = yield* freshTarget
                  for (const keyArgs of keySequence(sub.text, params.window, target)) {
                    const pressed = yield* callDriver(tools, "cua-driver_press_key", keyArgs, ctx.abort)
                    observationsUsed++
                    const result =
                      !pressed.ok && needsForegroundDelivery(pressed.error)
                        ? yield* callDriver(
                            tools,
                            "cua-driver_press_key",
                            { ...keyArgs, delivery_mode: "foreground" },
                            ctx.abort,
                          )
                        : pressed
                    if (!result.ok) {
                      failure = result.error
                      break
                    }
                  }
                  if (failure !== undefined) break
                  const keysAfter = yield* callDriver(
                    tools,
                    "cua-driver_get_window_state",
                    observationArgs(params.window),
                    ctx.abort,
                  )
                  observationsUsed++
                  const keysObs = keysAfter.ok ? decodeObservation(keysAfter.result.structuredContent) : null
                  if (keysObs) newest = keysObs.elements
                  staleSnapshot = false
                  signatures.push(keysObs ? screenSignature(keysObs.elements) : (signatures.at(-1) ?? before))
                  modes.push({ label: sub.label, mode: "key" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  // keystroke consumer (e.g. select-all): a screen/state move proves
                  // the click's focus; the keys themselves carry no landed signal.
                  settleFocus(keysObs?.elements, false)
                  continue
                }
                // hardcode-guard:allow the clipboard verb + driver tool name are the registry/hand contract, not a case literal
                if (sub.kind === "clipboard") {
                  // CLIPBOARD WRITE — replace the clipboard with the goal value as ONE
                  // atomic payload, the precondition for a single-event paste. The route
                  // NEVER reads the clipboard back (privacy); the overwrite is disclosed
                  // in the evidence. A failed write is NOT fatal: it sets the paste
                  // sub-step's fallback gate rather than aborting the maneuver.
                  target = yield* freshTarget
                  const clip = yield* callDriver(tools, "cua-driver_clipboard_write", { text: sub.text }, ctx.abort)
                  observationsUsed++
                  staleSnapshot = false
                  clipboardOk = clip.ok
                  signatures.push(signatures.at(-1) ?? before)
                  modes.push({ label: sub.label, mode: "clipboard" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  noteByIndex.set(modes.length - 1, CLIPBOARD_REPLACED_NOTE)
                  continue
                }
                // hardcode-guard:allow the paste verb + driver tool name are the registry/hand contract, not a case literal
                if (sub.kind === "paste") {
                  // ATOMIC PASTE — one `cmd+v` input event when the clipboard write
                  // landed; else the BOUNDED resumable type path. TOKEN FRESHNESS:
                  // re-resolve the target before the entry commits. One observation of
                  // the sub-step's effect; the value gate (below) confirms before Return.
                  target = yield* freshTarget
                  const run = yield* runUrlEntry(
                    (name, a) => callDriver(tools, name, a, ctx.abort),
                    params.window,
                    target,
                    sub.text,
                    clipboardOk,
                  )
                  observationsUsed += run.rounds + (run.mode === "paste" ? 1 : 0)
                  const observed = yield* callDriver(
                    tools,
                    "cua-driver_get_window_state",
                    observationArgs(params.window),
                    ctx.abort,
                  )
                  observationsUsed++
                  const after = observed.ok ? decodeObservation(observed.result.structuredContent) : null
                  if (after) newest = after.elements
                  staleSnapshot = false
                  signatures.push(after ? screenSignature(after.elements) : (signatures.at(-1) ?? before))
                  modes.push({ label: sub.label, mode: run.mode })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  // hardcode-guard:allow the paste/type mode vocabulary is the runner's own contract, not a case literal
                  if (run.mode === "paste") noteByIndex.set(modes.length - 1, CLIPBOARD_REPLACED_NOTE)
                  if (run.mode === "type") textByIndex.set(modes.length - 1, { rounds: run.rounds, delivered: run.delivered })
                  // EVIDENCE (requested + landed URL): always record the REQUESTED
                  // destination; best-effort read where the tab LANDED so a paste a
                  // site redirects still reports the landing (arrival by host).
                  // hardcode-guard:allow the browser-state driver tool name is the loop's own contract, not a case literal
                  const landedRead = yield* callDriver(
                    tools,
                    "cua-driver_get_browser_state",
                    { pid: params.window.pid, window_id: params.window.window_id },
                    ctx.abort,
                  )
                  observationsUsed++
                  const landedUrl = landedRead.ok ? decodeBrowserBinding(landedRead.result.structuredContent).url : undefined
                  urlByIndex.set(modes.length - 1, {
                    requested: sub.text,
                    ...(landedUrl !== undefined ? { arrival: arrival(sub.text, landedUrl) } : {}),
                  })
                  if (run.failure !== undefined) {
                    failure = run.failure
                    break
                  }
                  // atomic-paste consumer: the runner landing (clipboard written,
                  // paste chord delivered) is the consumer's own success signal.
                  settleFocus(after?.elements, run.completed)
                  continue
                }
                // hardcode-guard:allow the value-gate verb is the registry's own contract, not a case literal
                if (sub.kind === "verifyValue") {
                  // VALUE GATE — read the target's value back and confirm it matches the
                  // goal's value BEFORE any later Return. A mismatch aborts the maneuver
                  // rather than submitting a malformed destination.
                  const observedValue = yield* callDriver(
                    tools,
                    "cua-driver_get_window_state",
                    observationArgs(params.window),
                    ctx.abort,
                  )
                  observationsUsed++
                  const gateObs = observedValue.ok ? decodeObservation(observedValue.result.structuredContent) : null
                  if (gateObs) newest = gateObs.elements
                  staleSnapshot = false
                  const matched = gateObs !== null && valueMatches(fieldValue(target, gateObs.elements), sub.text)
                  signatures.push(gateObs ? screenSignature(gateObs.elements) : (signatures.at(-1) ?? before))
                  modes.push({ label: sub.label, mode: "read" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  valueByIndex.set(modes.length - 1, matched)
                  if (!matched) {
                    failure = "address bar value did not match the goal before Return"
                    break
                  }
                  continue
                }
                // hardcode-guard:allow the freshness rule is the hand contract, not a case literal
                if (sub.kind === "type") {
                  // RESUMABLE TEXT DELIVERY: drive the string to completion — a partial
                  // report (a prefix landed) is resumed, never treated as failure and
                  // never submitted half-typed. With `verify`, read the field's value
                  // back and, on a mismatch (a truncated entry), re-do select-all + the
                  // entry ONCE, so the destination is confirmed before any later
                  // Return. The delivered rounds/count fold into the evidence.
                  target = yield* freshTarget
                  let run = yield* runTypeDelivery(
                    (name, a) => callDriver(tools, name, a, ctx.abort),
                    params.window,
                    target,
                    sub.text,
                  )
                  observationsUsed += run.rounds
                  const observed = yield* callDriver(
                    tools,
                    "cua-driver_get_window_state",
                    observationArgs(params.window),
                    ctx.abort,
                  )
                  observationsUsed++
                  let after = observed.ok ? decodeObservation(observed.result.structuredContent) : null
                  if (after) newest = after.elements
                  staleSnapshot = false
                  let delivered = run.delivered
                  let rounds = run.rounds
                  if (run.failure === undefined && sub.verify === true && after !== null) {
                    if (!valueMatches(fieldValue(target, after.elements), sub.text)) {
                      // the entry did not land intact: re-do select-all + the entry once
                      target = refindElement(target, after.elements) ?? target
                      yield* callDriver(
                        tools,
                        "cua-driver_press_key",
                        keyPress("a", params.window, ["cmd"], target),
                        ctx.abort,
                      )
                      observationsUsed++
                      // the select-all mints a new snapshot: re-resolve before the repair entry
                      // hardcode-guard:allow the freshness rule is the hand contract, not a case literal
                      staleSnapshot = true
                      target = yield* freshTarget
                      const repair = yield* runTypeDelivery(
                        (name, a) => callDriver(tools, name, a, ctx.abort),
                        params.window,
                        target,
                        sub.text,
                      )
                      observationsUsed += repair.rounds
                      rounds += repair.rounds
                      delivered = repair.delivered
                      const recheck = yield* callDriver(
                        tools,
                        "cua-driver_get_window_state",
                        observationArgs(params.window),
                        ctx.abort,
                      )
                      observationsUsed++
                      after = recheck.ok ? decodeObservation(recheck.result.structuredContent) : after
                      if (after) newest = after.elements
                      run = repair
                    }
                  }
                  signatures.push(after ? screenSignature(after.elements) : (signatures.at(-1) ?? before))
                  modes.push({ label: sub.label, mode: "type" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  textByIndex.set(modes.length - 1, { rounds, delivered })
                  if (run.failure !== undefined) {
                    failure = run.failure
                    break
                  }
                  if (sub.verify === true && after !== null && !valueMatches(fieldValue(target, after.elements), sub.text)) {
                    failure = "typed value did not match the goal after one repair"
                    break
                  }
                  // typed-entry consumer: when the route VERIFIES the value, a match
                  // is the consumer's own success signal; else its value move alone
                  // proves the focus (a route with no check never claims one).
                  settleFocus(
                    after?.elements,
                    sub.verify === true && after !== null && valueMatches(fieldValue(target, after.elements), sub.text),
                  )
                  continue
                }
                if (sub.kind === "key") target = yield* freshTarget
                const args =
                  sub.kind === "key"
                    ? keyPress(sub.key, params.window, sub.modifiers, target)
                    : {
                        pid: params.window.pid,
                        window_id: params.window.window_id,
                        direction: sub.direction,
                        by: sub.by ?? "page",
                        amount: sub.amount ?? 1,
                      }
                const mode: ActuationMode = sub.kind === "key" ? "key" : "scroll"
                const tool = sub.kind === "key" ? "cua-driver_press_key" : "cua-driver_scroll"
                const attempt = yield* callDriver(tools, tool, args, ctx.abort)
                const result =
                  !attempt.ok && needsForegroundDelivery(attempt.error)
                    ? yield* callDriver(tools, tool, { ...args, delivery_mode: "foreground" }, ctx.abort)
                    : attempt
                if (!result.ok) {
                  failure = result.error
                  break
                }
                const observedAfter = yield* callDriver(
                  tools,
                  "cua-driver_get_window_state",
                  observationArgs(params.window),
                  ctx.abort,
                )
                observationsUsed++
                const after = observedAfter.ok ? decodeObservation(observedAfter.result.structuredContent) : null
                if (after) newest = after.elements
                staleSnapshot = false
                signatures.push(after ? screenSignature(after.elements) : (signatures.at(-1) ?? before))
                modes.push({ label: sub.label, mode })
                deliveries.push(undefined)
                reads.push(undefined)
                urlChanges.push(undefined)
                // FUNCTIONAL DELIVERY: a pending FOCUS click is delivered when a
                // key/hotkey consumer on the SAME target lands (a state move here).
                if (sub.kind === "key") settleFocus(after?.elements, false)
              }
              const substeps = foldSubstepEvidence(
                modes,
                signatures,
                deliveries,
                reads,
                urlChanges,
                modes.map((_, i) => textByIndex.get(i)),
                modes.map((_, i) => valueByIndex.get(i)),
                modes.map((_, i) => noteByIndex.get(i)),
                modes.map((_, i) => urlByIndex.get(i)),
              )
              if (failure === undefined && pendingFocus !== undefined) failure = "focus click undelivered (no consumer landed)"
              const succeeded = failure === undefined && match.skill.succeeded(substeps)
              return { substeps, succeeded, observations: observationsUsed, failure }
            })

          // PLAN-DRIVEN CORE: observe → commit a plan (jev chooses when more than
          // one candidate exists) → measure progress (ui-progress) → take the next
          // subgoal → derive maneuvers (ui-maneuvers) → jev chooses ONE maneuver →
          // execute it through the one executor. Termination is always a predicate
          // PROVED OVER THE SCENE; jev's `done` is advisory and never stops the run.
          // hardcode-guard:allow the plan-driver wiring is the plan-loop contract, not a case literal
          let lastElements: readonly Element[] = []
          let lastSignature = ""
          let lastScene: Scene | undefined

          const observeScene = (): Effect.Effect<Scene | undefined> =>
            Effect.gen(function* () {
              const observed = yield* callDriver(
                tools,
                "cua-driver_get_window_state",
                observationArgs(params.window),
                ctx.abort,
              )
              observations++
              if (!observed.ok) return undefined
              const observation = decodeObservation(observed.result.structuredContent)
              if (!observation) return undefined
              lastElements = observation.elements
              lastSignature = screenSignature(observation.elements)
              lastScene = buildScene({ snapshot_id: observation.snapshot_id, elements: observation.elements })
              return lastScene
            })

          const jevChoose = (frontier: readonly string[], lastAction: string) =>
            Effect.promise(() =>
              jevControlDetailed({
                map: { goal, start: lastSignature, current: lastSignature, frontier, path: [] },
                lastAction,
                key,
                askGoalMet: false,
              }),
            )

          const chosenLabel = (outcome: ControllerOutcome): ManeuverChoice => {
            if (outcome.verdict === "accepted")
              return {
                ...(outcome.decision.target !== null ? { label: outcome.decision.target } : {}),
                strength: outcome.decision.strength,
              }
            if (outcome.verdict === "below_gate")
              return { ...(outcome.target ? { label: outcome.target } : {}), strength: outcome.strength }
            return {}
          }

          const resolveTargetElement = (id: string): Element | undefined => {
            const direct = lastElements.find((element) => element.element_token === id)
            if (direct !== undefined) return direct
            const scene = lastScene
            if (scene === undefined) return undefined
            const item = scene.items.find((entry) => entry.id === id)
            if (item !== undefined) return refindElement(item.element, lastElements) ?? item.element
            const text = scene.texts.find((entry) => entry.id === id)
            if (text !== undefined) return refindElement(text.element, lastElements) ?? text.element
            return undefined
          }

          // The ONE executor path: a registered-skill maneuver runs its fixed
          // sub-sequence via executeSkill; the kinds with no skill yet
          // (open_item / activate / read_items / back) run as step sequences over
          // the SAME helpers (runClickRungs / keyPress / the observation).
          const executeManeuver = (option: ManeuverOption, subgoal: PlanSubgoal): Effect.Effect<ManeuverExecution> =>
            Effect.gen(function* () {
              // The maneuver was DERIVED from the subgoal's own value; the skill
              // must be matched with that SAME value, never a re-extraction that
              // can disagree (the goal-value extraction is scheme-limited, so a
              // `file://` destination matched no `go_to_url` skill and fell to a
              // bare address-bar CLICK with no consumer to defer to).
              const matches = matchSkills(lastElements, subgoal.params.value ?? extractGoalValue(goal))
              const skillMatch = matches.find((match) => match.skill.name === option.name)
              if (skillMatch !== undefined) {
                const execution = yield* executeSkill(skillMatch, lastSignature, lastElements)
                observations += execution.observations
                executed += execution.substeps.length
                const navigateStep = execution.substeps.find((sub) => sub.arrival !== undefined)
                return {
                  deliveryModes: execution.substeps.map((sub) => sub.mode),
                  ...(navigateStep?.arrival !== undefined && subgoal.params.value !== undefined
                    ? {
                        navigate: {
                          requested: subgoal.params.value,
                          ...(navigateStep.arrival.landedUrl !== undefined
                            ? { landed: navigateStep.arrival.landedUrl }
                            : {}),
                        },
                      }
                    : {}),
                  ...(execution.failure !== undefined ? { failure: execution.failure } : {}),
                }
              }
              // READ_ITEMS: no actuation — the observation IS the result.
              if (option.name === "read_items") return { deliveryModes: ["read"] }
              // BACK: the navigation-chrome affordance — one Escape key event.
              if (option.name === "back") {
                const args = keyPress("escape", params.window, [])
                const pressed = yield* callDriver(tools, "cua-driver_press_key", args, ctx.abort)
                observations++
                if (!pressed.ok && needsForegroundDelivery(pressed.error)) {
                  const retry = yield* callDriver(
                    tools,
                    "cua-driver_press_key",
                    { ...args, delivery_mode: "foreground" },
                    ctx.abort,
                  )
                  observations++
                  if (!retry.ok) return { deliveryModes: ["key"], failure: retry.error }
                  return { deliveryModes: ["key"] }
                }
                if (!pressed.ok) return { deliveryModes: ["key"], failure: pressed.error }
                return { deliveryModes: ["key"] }
              }
              // OPEN_ITEM / ACTIVATE: a click through the SHARED rung runner.
              const target = option.targets
                .map((entry) => resolveTargetElement(entry.id))
                .find((element) => element !== undefined)
              if (target === undefined) return { deliveryModes: [], failure: "no resolvable maneuver target" }
              const plan = actuationPlan(target, params.window)
              const fallback = lastSignature
              const run = yield* runClickRungs(
                (name, args) => callDriver(tools, name, args, ctx.abort),
                params.window,
                target,
                plan,
                clickSignals(fallback, target, lastElements),
                fallback,
              )
              observations += run.observations
              executed++
              return {
                deliveryModes: [run.outcome.mode],
                ...(run.outcome.worked ? {} : { failure: "click undelivered on every rung" }),
              }
            })

          const planResult = yield* planLoop({
            goal,
            observe: observeScene,
            choosePlan: (candidates) =>
              Effect.gen(function* () {
                const outcome = yield* jevChoose(
                  candidates.map((candidate) => candidate.id),
                  "choose the plan",
                )
                const choice = chosenLabel(outcome)
                return choice.label !== undefined && candidates.some((candidate) => candidate.id === choice.label)
                  ? choice.label
                  : candidates[0]?.id
              }),
            chooseManeuver: (_subgoal, options) =>
              Effect.gen(function* () {
                const outcome = yield* jevChoose(
                  options.map((option) => option.label),
                  "choose the maneuver",
                )
                return chosenLabel(outcome)
              }),
            execute: (option, subgoal) => executeManeuver(option, subgoal),
            stateChanging: stateChangingManeuver,
            readOnly: readOnlyGoal(goal),
            maxSteps,
            settleDelayMs: SETTLE_INTERVAL_MS,
            settleMinStableMs: SETTLE_MIN_STABLE_MS,
          })

          lines.push(`[plan ${planResult.planId ?? "?"}] ${planResult.status}: ${planResult.reason}`)
          for (const entry of planResult.telemetry)
            lines.push(
              `[plan step] subgoal ${entry.subgoalIndex} ${entry.maneuver} (${entry.label}) strength=${entry.strength ?? "n/a"} modes=[${entry.deliveryModes.join(",")}] ${entry.reason} → ${entry.progress.done}/${entry.progress.total}`,
            )

          // The run's return carries the plan telemetry (plan id, subgoal index,
          // maneuver, strength, delivery evidence, measured progress) and the mined
          // promotion CANDIDATES in metadata and as a JSON trailer on the output, so
          // an external checker can verify every decision and its evidence.
          const summary = planSummary(planResult)
          return {
            title: `ui_run (${executed} actions, ${observations} observations, ${summary.status})`,
            metadata: { ...summary, goal, executed, observations },
            output: [...lines, JSON.stringify(summary)].join("\n"),
          }
        }),
    }
  }),
)