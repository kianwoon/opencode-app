import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { MCP } from "../mcp"
import * as Tool from "./tool"
import { jevControlDetailed, jevKey, type ControllerOutcome, type JevAction, type NavMap } from "../jev/controller"
import { advanceMap, buildCandidates, decodeObservation, resolveTarget, screenSignature } from "./ui-eyes"
import type { Element } from "./ui-eyes"
import {
  actuationPlan,
  changeEvidence,
  clickAttempt,
  clickSignals,
  clickVerdict,
  foldFocusConsumer,
  foldFocusOutcome,
  frameEstablishingRead,
  isFocusTarget,
  keyPress,
  keySequence,
  observationArgs,
  pixelFrameRetry,
  type ActuationMode,
  type ActuationEvidence,
  type ActuationRung,
  type ClickAttemptEvidence,
  type ClickOutcome,
  type ClickSignals,
  type WindowRef,
} from "./ui-hands"
import {
  decodeBrowserBinding,
  foldSubstepEvidence,
  matchSkills,
  mineSequences,
  skillIndex,
  type BrowserBinding,
  type MinedSequence,
  type MiningStep,
  type SkillMatch,
  type SkillStep,
  type SkillSubstepEvidence,
} from "./ui-skills"

// EYES owns observation + world model; HANDS owns actuation. They are
// re-exported so the loop's public surface (and its tests) reach the organs
// through one entry point.
export {
  FRONTIER_HARD_MAX,
  advanceMap,
  buildCandidates,
  decodeObservation,
  resolveTarget,
  screenSignature,
} from "./ui-eyes"
export type { Element, Observation } from "./ui-eyes"

const DEFAULT_MAX_STEPS = 30
const HARD_MAX_STEPS = 100
/** Consecutive NON-PROGRESS iterations (a safe wait/scroll/observe, or an action
 * whose screen did not change) before the loop stops as stuck. */
const MAX_AMBIGUOUS = 3
/** Consecutive below-gate re-observations before the loop degrades to the strongest option it saw. */
export const MAX_BELOW_GATE = 2
/** Input verbs whose success depends on a preceding focus click on the SAME target. */
const FOCUS_CONSUMING = new Set<JevAction>(["type", "key"])
const DEFAULT_TIMEOUT = 30_000
const MAX_EXPECT = 8

/** jev's `goal_met` (or a `done` action) is ADVISORY, never a termination condition. */
export const isGoalMet = (outcome: ControllerOutcome): boolean =>
  outcome.verdict === "accepted" && (outcome.decision.goalMet === true || outcome.decision.action === "done")

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

/** Destructive verbs: a target label matching one stops the run for consent. */
const DESTRUCTIVE =
  /\b(save|submit|delete|remove|erase|confirm|apply|send|discard|reset|overwrite|uninstall|purchase|buy|pay|checkout)\b/i

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

/** The strongest below-gate option seen in the current spiral, for degradation. */
export interface BelowGateOption {
  readonly action: JevAction | null
  readonly target: string | null
  readonly strength: number
}

/**
 * GENERAL RULE: the loop re-observes and re-decides every iteration and stops
 * only on observed evidence. The open-loop batch is one INSTANCE of that rule's
 * failure — it decided once from a snapshot the UI had already invalidated, so
 * every later step acted on a stale candidate set. `decideStep` is the pure,
 * instance-independent core, so the rule holds for the reported case and for
 * unseen flows alike (e.g. a 40-step navigation interrupted by a mid-flow
 * dialog: each dialog re-observes, re-decides, and either acts or falls safe).
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

/** A chosen maneuver: the loop executes a skill's fixed sub-sequence as ONE step. */
export interface SkillDecision {
  readonly kind: "skill"
  readonly name: string
  readonly reason: string
}

export interface StepInput {
  /** Controller verdict for THIS iteration (accepted | below_gate | unmeasured). */
  readonly outcome: ControllerOutcome
  /** Candidate index rebuilt from THIS iteration's fresh observation. */
  readonly candidates: {
    readonly labels: readonly string[]
    readonly byLabel: ReadonlyMap<string, Element>
    /** Full usable set for this observation; re-resolves a churned target by role+label. */
    readonly elements?: readonly Element[]
  }
  /** Advisory `goal_met` from jev (or a `done` action). Never authoritative. */
  readonly goalMet: boolean
  /** Observed proof the goal is met (`cua-driver_verify_state` satisfied). */
  readonly evidence: boolean
  /** Text to type when the decided action is `type`. */
  readonly text?: string
  /** Run-level goal; a `type` with no explicit text draws its value from here. */
  readonly goal?: string
  /** Zero-based iteration index and its budget. */
  readonly step: number
  readonly maxSteps: number
  /** Consecutive non-acting iterations and its bound. */
  readonly ambiguous: number
  readonly maxAmbiguous: number
  /** Consecutive below-gate iterations seen so far (including this one) and its bound. */
  readonly belowGate?: number
  readonly maxBelowGate?: number
  /** Strongest below-gate option seen in the current spiral, for graceful degradation. */
  readonly strongestBelowGate?: BelowGateOption
}

export const isDestructive = (label: string): boolean => DESTRUCTIVE.test(label)

/**
 * Resolve a decision target against THIS iteration's fresh candidates — a direct
 * label hit wins; on a miss it is re-resolved by role+label (see decideStep).
 */
const resolveElement = (target: string, input: StepInput): Element | undefined => {
  const fresh = input.candidates.elements ?? [...input.candidates.byLabel.values()]
  const element = input.candidates.byLabel.get(target) ?? resolveTarget(target, fresh)
  return element?.element_token ? element : undefined
}

/**
 * GENERAL RULE — graceful degradation takes the SAFEST STRONGEST action rather
 * than stalling: at the below-gate bound the strongest measured option is
 * executed in safe mode. It is REFUSED (falls to a safe wait) when it has no
 * resolvable target, is a destructive verb, or is a `type` with no value — an
 * uncertain verdict must never become an unsafe act. Unseen case it covers: a
 * below-gate spiral whose strongest option is a scroll, which cannot be
 * degraded to an act and therefore still falls safe.
 */
// hardcode-guard:allow the fallback reason token is the trace contract asserted by tests, not a case literal
function degradeToAct(option: BelowGateOption | undefined, input: StepInput): StepDecision | undefined {
  if (!option) return undefined
  if (option.action !== "click" && option.action !== "type") return undefined
  if (!option.target) return undefined
  const element = resolveElement(option.target, input)
  if (!element) return undefined
  if (isDestructive(option.target)) return undefined
  if (option.action === "type") {
    const text = input.text ?? (input.goal ? extractGoalValue(input.goal) : undefined)
    if (!text) return undefined
    return { kind: "act", action: "type", element, text, reason: "strongest-available-fallback" }
  }
  return { kind: "act", action: "click", element, reason: "strongest-available-fallback" }
}

/**
 * Pure per-iteration decision. Order is the contract: observed evidence wins
 * over every advisory signal; budget and the ambiguity bound are hard stops; a
 * below-gate, unmeasured or stale-target verdict falls to a SAFE action (never
 * an abort); a destructive target stops the run for consent BEFORE it acts.
 */
export function decideStep(input: StepInput): StepDecision {
  // Evidence is authoritative — the ONLY thing that stops the loop as verified.
  if (input.evidence) return { kind: "stop", reason: "evidence-satisfied" }
  if (input.step >= input.maxSteps) return { kind: "stop", reason: "budget-exhausted" }
  if (input.ambiguous >= input.maxAmbiguous) return { kind: "stop", reason: "ambiguous-limit" }

  // jev believing the goal is met is ADVISORY: with no observed evidence it must
  // NOT terminate — re-observe instead (continue-don't-abort, bounded above).
  if (input.goalMet) return { kind: "safe", action: "observe", reason: "goal-met-advisory-no-evidence" }

  // hardcode-guard:allow verdict tokens (below-gate/unmeasured) are the controller contract's own vocabulary
  if (input.outcome.verdict !== "accepted") {
    if (input.outcome.verdict !== "below_gate")
      return { kind: "safe", action: "wait", reason: "unmeasured" }
    // BELOW-GATE SPIRAL: re-observing forever stalls. Once the bound is reached,
    // degrade to the strongest option the loop actually saw, in SAFE mode — never
    // a destructive action below gate (isDestructive is refused in degradeToAct).
    if ((input.belowGate ?? 1) >= (input.maxBelowGate ?? MAX_BELOW_GATE)) {
      const strongest = input.strongestBelowGate ?? {
        action: input.outcome.action,
        target: input.outcome.target ?? null,
        strength: input.outcome.strength,
      }
      const degraded = degradeToAct(strongest, input)
      if (degraded) return degraded
    }
    return { kind: "safe", action: "wait", reason: "below-gate" }
  }

  const decision = input.outcome.decision
  if (decision.action !== "click" && decision.action !== "type")
    return {
      kind: "safe",
      action: decision.action === "scroll" ? "scroll" : "wait",
      reason: `action-${decision.action}`,
    }

  // Validate the target against THIS iteration's fresh candidate set — never a stale
  // map. EYES identity: a direct label hit wins; on a miss the target is re-resolved
  // by role+label, so an element whose token/snapshot churned is acted on rather than
  // dropped as "not-in-fresh-candidates".
  if (!decision.target) return { kind: "safe", action: "observe", reason: "target-not-in-fresh-candidates" }
  const element = resolveElement(decision.target, input)
  if (!element) return { kind: "safe", action: "observe", reason: "target-not-in-fresh-candidates" }
  if (isDestructive(decision.target)) return { kind: "checkpoint", target: decision.target, reason: "destructive-boundary" }
  if (decision.action === "type") {
    const text = input.text ?? (input.goal ? extractGoalValue(input.goal) : undefined)
    if (!text) return { kind: "safe", action: "observe", reason: "type-without-text" }
    return { kind: "act", action: "type", element, text, reason: "decided" }
  }
  return { kind: "act", action: "click", element, reason: "decided" }
}

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

export function traceStep(step: number, outcome: ControllerOutcome, verdict: StepDecision | SkillDecision): StepTrace {
  const accepted = "decision" in outcome ? outcome.decision : undefined
  const strength = "strength" in outcome ? outcome.strength : accepted?.strength
  return {
    step,
    verdict: outcome.verdict,
    action: accepted?.action ?? null,
    target: accepted?.target ?? null,
    ...(strength !== undefined ? { strength } : {}),
    decision: verdict.kind,
    reason: verdict.reason,
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

export const UiRunTool = Tool.define<typeof Parameters, Metadata, MCP.Service>(
  "ui_run",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    return {
      description:
        "Drive a window to a goal in ONE call with a CLOSED observe-decide-act-verify loop: every iteration re-observes the window afresh, re-decides with jev from that iteration's live controls, validates the target against them and acts, then verifies. It stops only on OBSERVED evidence (cua-driver_verify_state), an exhausted budget, N consecutive ambiguous decisions, a destructive-action boundary (Save/Submit/Delete/confirm — stops for consent), or a driver error. A missing/sub-threshold decision never aborts: it falls to a safe action (scroll/wait/re-observe) up to a small bound. An undecodable observation still stops (targets are never guessed from prose), and jev's `goal_met` is advisory only. Pass `expect` to verify the end state. Requires the cua-driver MCP server and a configured jev key; returns an unavailable notice otherwise.",
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
          let ambiguous = 0
          let status = "completed"
          let previous: string | undefined
          let evidence = false
          let truncated: string | undefined
          // The navigation map, re-derived from the observed UI EVERY iteration.
          let map: NavMap | undefined
          // Node signature at which the last action ran — a no-op (screen
          // unchanged) feeds the ambiguity bound instead of resetting it.
          let actedAt: string | undefined
          // The mode + target of the last action, so a content-unchanged focus click
          // followed by an input verb on the SAME target is a prerequisite, not a no-op.
          let actedMode: string | undefined
          let actedTarget: string | undefined
          // BELOW-GATE degradation: consecutive below-gate count and the strongest
          // option seen in the current spiral.
          let belowGate = 0
          let strongestBelowGate: BelowGateOption | undefined
          // HANDS: the mode + before-signature of the last action, folded with the
          // next observation into change evidence (never a bare success boolean).
          let lastActuation: { readonly mode: ActuationEvidence["mode"]; readonly before: string } | undefined
          // FUNCTIONAL DELIVERY: a FOCUS click in the main loop whose delivery is
          // deferred until its consumer sub-step (a later type/key on the SAME
          // target) lands — resolved against a later observation's target state.
          let pendingMainFocus:
            | { readonly traceIndex: number; readonly attempt: ClickAttemptEvidence; readonly target: Element }
            | undefined
          // Every iteration's decision, emitted so a caller can verify the chain.
          const trace: StepTrace[] = []

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
              let observationsUsed = 0
              let failure: string | undefined
              // BIND classification, carried to the branch step.
              let binding: BrowserBinding | undefined
              // A FOCUS click whose delivery is deferred to its consumer sub-step.
              let pendingFocus: { readonly index: number; readonly attempt: ClickAttemptEvidence } | undefined
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
                if (sub.kind === "prepare") {
                  // PREPARE the browser endpoint (`browser_prepare`) — attaches/owns
                  // the DevTools endpoint, the precondition for a bind to succeed on
                  // a Chromium window. Its failure is an honest skill failure.
                  const prepared = yield* callDriver(
                    tools,
                    "cua-driver_browser_prepare",
                    { pid: params.window.pid },
                    ctx.abort,
                  )
                  observationsUsed++
                  signatures.push(signatures.at(-1) ?? before)
                  modes.push({ label: sub.label, mode: "prepare" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  if (!prepared.ok) {
                    failure = prepared.error
                    break
                  }
                  continue
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
                  signatures.push(signatures.at(-1) ?? before)
                  modes.push({ label: sub.label, mode: "navigate" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlChanges.push(undefined)
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
                  const after = state?.ok ? decodeBrowserBinding(state.result.structuredContent) : undefined
                  urlChanges.push(after !== undefined && (after.url !== bound?.url || after.title !== bound?.title))
                  signatures.push(signatures.at(-1) ?? before)
                  modes.push({ label: sub.label, mode: "read" })
                  deliveries.push(undefined)
                  reads.push(undefined)
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
                  const plan = actuationPlan(match.element, params.window)
                  const fallback = signatures.at(-1) ?? before
                  const signalBefore = clickSignals(fallback, match.element, elements)
                  const run = yield* runClickRungs(
                    (name, args) => callDriver(tools, name, args, ctx.abort),
                    params.window,
                    match.element,
                    plan,
                    signalBefore,
                    fallback,
                  )
                  observationsUsed += run.observations
                  signatures.push(run.signature)
                  modes.push({ label: sub.label, mode: run.outcome.mode })
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  const first = run.attempts[0]
                  if (!run.outcome.worked && first !== undefined && isFocusTarget(match.element)) {
                    pendingFocus = { index: modes.length - 1, attempt: first }
                    deliveries.push(false)
                    continue
                  }
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
                  // value but never commits it (Chromium's address bar shows a
                  // type_text URL yet does NOT submit on Return) commits only on
                  // real key events. One press_key per code point, the foreground
                  // remedy for `same_pid_keyboard_ambiguity` applied exactly as for
                  // a single key, then ONE observation of the sub-step's effect.
                  for (const keyArgs of keySequence(sub.text, params.window, match.element)) {
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
                  signatures.push(keysObs ? screenSignature(keysObs.elements) : (signatures.at(-1) ?? before))
                  modes.push({ label: sub.label, mode: "key" })
                  deliveries.push(undefined)
                  reads.push(undefined)
                  urlChanges.push(undefined)
                  if (pendingFocus !== undefined && keysObs) {
                    const consumerSignals = clickSignals(signatures.at(-1) ?? before, match.element, keysObs.elements)
                    if (foldFocusConsumer(pendingFocus.attempt, consumerSignals, match.element).delivered) {
                      deliveries[pendingFocus.index] = true
                      pendingFocus = undefined
                    }
                  }
                  continue
                }
                const tool =
                  sub.kind === "key"
                    ? "cua-driver_press_key"
                    : sub.kind === "type"
                      ? "cua-driver_type_text"
                      : "cua-driver_scroll"
                const args =
                  sub.kind === "key"
                    ? keyPress(sub.key, params.window, sub.modifiers, match.element)
                    : sub.kind === "type"
                      ? {
                          element_token: match.element.element_token,
                          pid: params.window.pid,
                          window_id: params.window.window_id,
                          text: sub.text,
                        }
                      : {
                          pid: params.window.pid,
                          window_id: params.window.window_id,
                          direction: sub.direction,
                          by: sub.by ?? "page",
                          amount: sub.amount ?? 1,
                        }
                const mode: ActuationMode = sub.kind === "key" ? "key" : sub.kind === "type" ? "type" : "scroll"
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
                signatures.push(after ? screenSignature(after.elements) : (signatures.at(-1) ?? before))
                modes.push({ label: sub.label, mode })
                deliveries.push(undefined)
                reads.push(undefined)
                urlChanges.push(undefined)
                // FUNCTIONAL DELIVERY: a pending FOCUS click is delivered when a
                // consumer (type/key on the SAME target) lands in the target's state.
                if (pendingFocus !== undefined && (sub.kind === "type" || sub.kind === "key") && after) {
                  const consumerSignals = clickSignals(signatures.at(-1) ?? before, match.element, after.elements)
                  if (foldFocusConsumer(pendingFocus.attempt, consumerSignals, match.element).delivered) {
                    deliveries[pendingFocus.index] = true
                    pendingFocus = undefined
                  }
                }
              }
              const substeps = foldSubstepEvidence(modes, signatures, deliveries, reads, urlChanges)
              if (failure === undefined && pendingFocus !== undefined) failure = "focus click undelivered (no consumer landed)"
              const succeeded = failure === undefined && match.skill.succeeded(substeps)
              return { substeps, succeeded, observations: observationsUsed, failure }
            })

          for (let step = 0; step < maxSteps; step++) {
            // OBSERVE fresh EVERY iteration; a candidate map is never reused across steps.
            const observed = yield* callDriver(
              tools,
              "cua-driver_get_window_state",
              // The driver DEFAULTS tree_format to "markdown" (a `tree_markdown`
              // string, no `elements`); this loop parses the structured
              // `elements` array, so it must request the format it parses.
              // The loop's own observations stay cheap: no screenshot (economy).
              observationArgs(params.window),
              ctx.abort,
            )
            observations++
            if (!observed.ok) {
              status = "driver-error"
              lines.push(`[observe ${step + 1}] window state unreadable: ${observed.error}`)
              break
            }
            const observation = decodeObservation(observed.result.structuredContent)
            if (!observation) {
              status = "unparseable-observation"
              lines.push(
                `[observe ${step + 1}] no decodable structuredContent; the run stopped rather than guess targets from text`,
              )
              break
            }
            // FUNCTIONAL DELIVERY: a deferred FOCUS click is delivered once a later
            // observation shows its target's own state changed (the consumer landed).
            if (pendingMainFocus !== undefined) {
              const afterConsumer = clickSignals(
                screenSignature(observation.elements),
                pendingMainFocus.target,
                observation.elements,
              )
              if (foldFocusConsumer(pendingMainFocus.attempt, afterConsumer, pendingMainFocus.target).delivered) {
                const entry = trace[pendingMainFocus.traceIndex]
                if (entry?.click)
                  trace[pendingMainFocus.traceIndex] = {
                    ...entry,
                    click: foldFocusOutcome(entry.click, afterConsumer, pendingMainFocus.target),
                  }
                pendingMainFocus = undefined
              }
            }
            const candidates = buildCandidates(observation.elements)
            // Keep the newest snapshot's marker; it is the one that hid elements.
            if (candidates.truncated) truncated = candidates.truncated

            // SKILLS: a maneuver whose precondition holds (and whose goal value is
            // present) is offered to jev as ONE extra frontier option. The loop never
            // names a site; adding a skill is adding a registry entry.
            const skills = skillIndex(matchSkills(observation.elements, extractGoalValue(goal)))
            const frontier = [...candidates.labels, ...skills.keys()]

            // CODE owns the map: re-derive current + the enumerated frontier from
            // this freshness, carry `path` across iterations, then hand the whole
            // map to jev as `state` and let it CHOOSE among the frontier options.
            map = advanceMap(goal, map, observation.elements, frontier)

            // HANDS change evidence: the action ran at `lastActuation.before`; the
            // fresh signature is its `after`. State WHAT changed, and attach it to
            // the trace entry that took the action.
            if (lastActuation) {
              const evidenceOfChange = changeEvidence(lastActuation.mode, lastActuation.before, map.current)
              const prior = trace[trace.length - 1]
              if (prior) trace[trace.length - 1] = { ...prior, actuation: evidenceOfChange }
              lines.push(
                `[change ${step + 1}] ${evidenceOfChange.mode} changed=${evidenceOfChange.changed} (${evidenceOfChange.before}→${evidenceOfChange.after})`,
              )
              lastActuation = undefined
            }

            // hardcode-guard:allow loop wiring for the general prerequisite/degradation rules, no case literals
            const outcome = yield* Effect.promise(() =>
              jevControlDetailed({
                map,
                lastAction: `iteration ${step + 1}/${maxSteps}${previous ? ` | after: ${previous}` : ""}`,
                key,
                askGoalMet: true,
              }),
            )
            const goalMet = isGoalMet(outcome)

            // (b) Did the action executed last iteration actually change the screen?
            // The fresh signature answers it; an unchanged screen is a no-op, not
            // progress — UNLESS it FOCUSED the successor's own target (prerequisite:
            // click-field → type is one progress unit, see nextAmbiguity).
            const nextAction =
              outcome.verdict === "accepted"
                ? outcome.decision.action
                : outcome.verdict === "below_gate"
                  ? (outcome.action ?? undefined)
                  : undefined
            const nextTarget =
              outcome.verdict === "accepted"
                ? outcome.decision.target
                : outcome.verdict === "below_gate"
                  ? (outcome.target ?? null)
                  : undefined
            ambiguous = nextAmbiguity(ambiguous, actedAt, map.current, {
              actedMode,
              actedTarget,
              nextAction,
              nextTarget,
            })
            actedAt = undefined
            actedMode = undefined
            actedTarget = undefined

            // BELOW-GATE SPIRAL: count consecutive below-gate steps and remember the
            // strongest option seen, so decideStep can degrade at the bound instead
            // of spinning to the ambiguity limit.
            if (outcome.verdict === "below_gate") {
              belowGate++
              if (!strongestBelowGate || outcome.strength > strongestBelowGate.strength)
                strongestBelowGate = {
                  action: outcome.action,
                  target: outcome.target ?? null,
                  strength: outcome.strength,
                }
            } else {
              belowGate = 0
              strongestBelowGate = undefined
            }

            // SKILLS: when jev chooses a maneuver option, execute its FIXED sub-sequence
            // directly — no per-sub-step decisions — and fold it into ONE trace step.
            // hardcode-guard:allow generic skill interception over the registry contract, no case literals
            // hardcode-guard:allow generic skill interception, action-verb gate over the registry contract
            const chosenTarget =
              outcome.verdict === "accepted"
                ? outcome.decision.target
                : outcome.verdict === "below_gate"
                  ? (outcome.target ?? null)
                  : null
            const chosenAction =
              outcome.verdict === "accepted"
                ? outcome.decision.action
                : outcome.verdict === "below_gate"
                  ? outcome.action
                  : null
            // A maneuver is an ACTION: only a click/type choice of the option executes it,
            // never a `done`/`wait` that merely named it.
            const chosen =
              chosenTarget && (chosenAction === "click" || chosenAction === "type")
                ? skills.get(chosenTarget)
                : undefined
            if (chosen) {
              const skillVerdict: SkillDecision = { kind: "skill", name: chosen.skill.name, reason: "skill-chosen" }
              const execution = yield* executeSkill(chosen, map.current, observation.elements)
              observations += execution.observations
              const skillTrace = {
                name: chosen.skill.name,
                succeeded: execution.succeeded,
                substeps: execution.substeps,
              }
              trace.push({ ...traceStep(step + 1, outcome, skillVerdict), skill: skillTrace })
              previous = `[skill ${step + 1}] ${chosen.skill.name} (${execution.substeps.length} substeps, succeeded=${execution.succeeded})`
              lines.push(previous)
              for (const sub of execution.substeps)
                lines.push(
                  `[skill ${step + 1}]   ${sub.label}: ${sub.mode} changed=${sub.changed} (${sub.before}→${sub.after})`,
                )
              if (execution.failure !== undefined) {
                status = "failed"
                lines.push(`[skill ${step + 1}] ${chosen.skill.name} failed at a sub-step: ${execution.failure}`)
                break
              }
              executed += execution.substeps.length
              // The maneuver ran at this node; the next observation reveals the change.
              actedAt = map.current
              actedMode = "skill"
              actedTarget = chosen.element.label ?? chosen.element.element_token
              belowGate = 0
              strongestBelowGate = undefined
              continue
            }

            const verdict = decideStep({
              outcome,
              candidates,
              goalMet,
              evidence,
              ...(params.value !== undefined ? { text: params.value } : {}),
              goal,
              step,
              maxSteps,
              ambiguous,
              maxAmbiguous: MAX_AMBIGUOUS,
              belowGate,
              maxBelowGate: MAX_BELOW_GATE,
              ...(strongestBelowGate !== undefined ? { strongestBelowGate } : {}),
            })
            if (verdict.kind === "act") {
              belowGate = 0
              strongestBelowGate = undefined
            }
            // (c) Record this iteration's jev decision and the loop's resolved action
            // as a general, per-step trace so a caller can verify the chain.
            trace.push(traceStep(step + 1, outcome, verdict))

            if (verdict.kind === "stop") {
              status = verdict.reason === "evidence-satisfied" ? "verified" : verdict.reason
              lines.push(`[stop ${step + 1}] ${verdict.reason}`)
              break
            }
            if (verdict.kind === "checkpoint") {
              status = "needs-consent"
              lines.push(`[checkpoint ${step + 1}] destructive action requires consent before acting: ${verdict.target}`)
              break
            }
            if (verdict.kind === "safe") {
              ambiguous++
              previous = `safe ${verdict.action} (${verdict.reason})`
              lines.push(`[safe ${step + 1}] ${previous}`)
              if (verdict.action === "scroll")
                yield* callDriver(
                  tools,
                  "cua-driver_scroll",
                  { pid: params.window.pid, window_id: params.window.window_id, direction: "down", by: "page", amount: 1 },
                  ctx.abort,
                )
              else if (verdict.action === "wait") yield* Effect.sleep("300 millis")
              // `observe` needs no driver call: the next iteration re-observes by design.
              continue
            }

            // hardcode-guard:allow the actuation rungs are the organ's general contract
            // (declared action first, pixel frame fallback second), not a case literal.
            // HANDS actuation. A type is one rung (with the driver's foreground
            // remedy for same-pid keyboard ambiguity); a click is MULTI-MODAL: the
            // element's declared action first, then a foreground pixel click at its
            // frame. A rung is tried only when its predecessor fails.
            let actLabel: string
            let actResult: DriverOutcome
            // hardcode-guard:allow a per-step state slot, not a case literal
            let clickOutcome: ClickOutcome | undefined
            if (verdict.action === "type") {
              const actArgs = {
                element_token: verdict.element.element_token,
                pid: params.window.pid,
                window_id: params.window.window_id,
                text: verdict.text,
              }
              const attempt = yield* callDriver(tools, "cua-driver_type_text", actArgs, ctx.abort)
              const retried = !attempt.ok && needsForegroundDelivery(attempt.error)
              actResult = retried
                ? yield* callDriver(tools, "cua-driver_type_text", { ...actArgs, delivery_mode: "foreground" }, ctx.abort)
                : attempt
              actLabel = `type_text "${verdict.text}"${retried ? " (foreground retry)" : ""}`
            } else {
              // AFFIRMATIVE CLICK: rung 1 (declared action), rung 2 (pixel frame
              // centre), run through the shared on-demand-sensor runner (see
              // runClickRungs): the sensor-dependent pixel rung establishes a
              // screenshot frame when missing and retries once. Delivery is judged
              // on WORLD STATE after each rung; absent evidence escalates. Two
              // silent rungs → worked:false with both rungs' evidence.
              const plan = actuationPlan(verdict.element, params.window)
              actLabel = plan[0]?.label ?? "click"
              const run = yield* runClickRungs(
                (name, args) => callDriver(tools, name, args, ctx.abort),
                params.window,
                verdict.element,
                plan,
                clickSignals(map.current, verdict.element, observation.elements),
                map.current,
              )
              observations += run.observations
              actResult = run.result
              clickOutcome = run.outcome
              const prior = trace[trace.length - 1]
              if (prior) trace[trace.length - 1] = { ...prior, click: clickOutcome }
              if (!clickOutcome.worked) {
                const first = clickOutcome.attempts[0]
                if (first !== undefined && isFocusTarget(verdict.element)) {
                  // FUNCTIONAL DELIVERY: a focus click is NOT failed here — its
                  // delivery is deferred until its consumer (a later type/key on
                  // this SAME target) lands, resolved against a later observation.
                  pendingMainFocus = { traceIndex: trace.length - 1, attempt: first, target: verdict.element }
                } else {
                  status = "failed"
                  previous = `[fail ${step + 1}] click undelivered → ${verdict.element.label ?? verdict.element.element_token}`
                  lines.push(previous)
                  for (const attempt of clickOutcome.attempts)
                    lines.push(
                      `[fail ${step + 1}]   ${attempt.mode} ${attempt.label} delivered=${attempt.delivered} reasons=[${attempt.reasons.join(",")}] (${attempt.before.screen}→${attempt.after.screen})`,
                    )
                  // AFFIRMATIVE FAILURE FEEDS THE BOUND: the click ran at this node
                  // and changed nothing observable, so the next iteration's unchanged
                  // screen advances the ambiguity count — it is never retried forever.
                  actedAt = map.current
                  continue
                }
              }
            }
            const target = verdict.element.label ?? verdict.element.element_token
            if (verdict.action === "type" && !actResult.ok) {
              status = "failed"
              previous = `[fail ${step + 1}] ${actLabel} → ${target}`
              lines.push(`${previous}: ${actResult.error}`)
              break
            }
            executed++
            if (verdict.action === "click") {
              // A delivered click is progress on ANY signal (screen, target state
              // or focus), so it resets the count rather than feeding it.
              ambiguous = 0
              actedAt = undefined
            } else {
              // The action ran at this node; the next observation reveals whether it
              // changed the screen (see nextAmbiguity) and folds the change evidence.
              actedAt = map.current
            }
            // Remember the target + mode so a focus click on the successor's target
            // reads as a prerequisite rather than a no-op next iteration.
            actedMode = clickOutcome ? clickOutcome.mode : "type"
            actedTarget = target
            lastActuation = {
              mode: clickOutcome ? clickOutcome.mode : "type",
              before: map.current,
            }
            previous = `[ok ${step + 1}] ${actLabel} → ${target}`
            lines.push(`${previous}`)

            if (params.expect !== undefined) {
              const verified = yield* callDriver(
                tools,
                "cua-driver_verify_state",
                { pid: params.window.pid, window_id: params.window.window_id, expect: normalizeExpect(params.expect) },
                ctx.abort,
              )
              if (!verified.ok) {
                status = "failed"
                lines.push(`[verify ${step + 1}] driver could not verify: ${verified.error}`)
                break
              }
              const verdictText = textOf(verified.result.content).trim()
              const satisfied = /satisfied|passed|true/i.test(verdictText)
              lines.push(`[verify ${step + 1}] ${verdictText || "driver returned no verdict"}`)
              // OBSERVED evidence agrees — this is the only authoritative stop.
              if (satisfied) {
                evidence = true
                status = "verified"
                break
              }
            }
          }

          // SKILL MINING: repeated progressed sub-sequences become promotion
          // CANDIDATES in metadata; the loop never adds a registry entry.
          const promotionCandidates = mineTrace(trace)

          // (c) The run's return carries the map (start/current/frontier/path),
          // every step's decision, and any promotion candidates, in metadata and as
          // a JSON trailer on the output, so an external checker can verify the chain.
          const navMap = map
            ? { start: map.start, current: map.current, frontier: map.frontier, path: map.path }
            : undefined
          const summary = {
            status,
            steps: trace,
            promotionCandidates,
            ...(navMap ? { map: navMap } : {}),
          }
          return {
            title: `ui_run (${executed} actions, ${observations} observations, ${status})`,
            metadata: { ...summary, goal, executed, observations },
            output: [...lines, ...(truncated ? [truncated] : []), JSON.stringify(summary)].join("\n"),
          }
        }),
    }
  }),
)