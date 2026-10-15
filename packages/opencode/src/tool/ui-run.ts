import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { MCP } from "../mcp"
import * as Tool from "./tool"
import { jevControlDetailed, jevKey, type ControllerOutcome, type JevAction, type NavMap } from "../jev/controller"
import { advanceMap, buildCandidates, decodeObservation, resolveTarget, screenSignature } from "./ui-eyes"
import type { Element } from "./ui-eyes"
import { actuationPlan, changeEvidence, type ActuationEvidence, type ActuationRung } from "./ui-hands"

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
  /** Zero-based iteration index and its budget. */
  readonly step: number
  readonly maxSteps: number
  /** Consecutive non-acting iterations and its bound. */
  readonly ambiguous: number
  readonly maxAmbiguous: number
}

export const isDestructive = (label: string): boolean => DESTRUCTIVE.test(label)

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

  if (input.outcome.verdict !== "accepted")
    return {
      kind: "safe",
      action: "wait",
      reason: input.outcome.verdict === "below_gate" ? "below-gate" : "unmeasured",
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
  const fresh = input.candidates.elements ?? [...input.candidates.byLabel.values()]
  const element = input.candidates.byLabel.get(decision.target) ?? resolveTarget(decision.target, fresh)
  if (!element?.element_token) return { kind: "safe", action: "observe", reason: "target-not-in-fresh-candidates" }
  if (isDestructive(decision.target)) return { kind: "checkpoint", target: decision.target, reason: "destructive-boundary" }
  if (decision.action === "type") {
    if (!input.text) return { kind: "safe", action: "observe", reason: "type-without-text" }
    return { kind: "act", action: "type", element, text: input.text, reason: "decided" }
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
 */
export function nextAmbiguity(ambiguous: number, actedAt: string | undefined, current: string): number {
  if (actedAt === undefined) return ambiguous
  return actedAt === current ? ambiguous + 1 : 0
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
  readonly decision: StepDecision["kind"]
  readonly reason: string
  /** HANDS change evidence for the action this step took, once the next screen is observed. */
  readonly actuation?: ActuationEvidence
}

export function traceStep(step: number, outcome: ControllerOutcome, verdict: StepDecision): StepTrace {
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

type DriverOutcome = { ok: true; result: DriverResult } | { ok: false; error: string }

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
          // HANDS: the mode + before-signature of the last action, folded with the
          // next observation into change evidence (never a bare success boolean).
          let lastActuation: { readonly mode: ActuationEvidence["mode"]; readonly before: string } | undefined
          // Every iteration's decision, emitted so a caller can verify the chain.
          const trace: StepTrace[] = []

          for (let step = 0; step < maxSteps; step++) {
            // OBSERVE fresh EVERY iteration; a candidate map is never reused across steps.
            const observed = yield* callDriver(
              tools,
              "cua-driver_get_window_state",
              {
                pid: params.window.pid,
                window_id: params.window.window_id,
                include_screenshot: false,
                // The driver DEFAULTS tree_format to "markdown" (a `tree_markdown`
                // string, no `elements`); this loop parses the structured
                // `elements` array, so it must request the format it parses.
                tree_format: "elements",
              },
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
            const candidates = buildCandidates(observation.elements)
            // Keep the newest snapshot's marker; it is the one that hid elements.
            if (candidates.truncated) truncated = candidates.truncated

            // CODE owns the map: re-derive current + the enumerated frontier from
            // this freshness, carry `path` across iterations, then hand the whole
            // map to jev as `state` and let it CHOOSE among the frontier options.
            map = advanceMap(goal, map, observation.elements, candidates.labels)

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

            // (b) Did the action executed last iteration actually change the screen?
            // The fresh signature answers it; an unchanged screen is a no-op, not
            // progress, so it advances the ambiguity count toward the bound.
            ambiguous = nextAmbiguity(ambiguous, actedAt, map.current)
            actedAt = undefined

            const outcome = yield* Effect.promise(() =>
              jevControlDetailed({
                map,
                lastAction: `iteration ${step + 1}/${maxSteps}${previous ? ` | after: ${previous}` : ""}`,
                key,
                askGoalMet: true,
              }),
            )
            const goalMet = isGoalMet(outcome)

            const verdict = decideStep({
              outcome,
              candidates,
              goalMet,
              evidence,
              ...(params.value !== undefined ? { text: params.value } : {}),
              step,
              maxSteps,
              ambiguous,
              maxAmbiguous: MAX_AMBIGUOUS,
            })
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
            let clickRung: ActuationRung | undefined
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
              const plan = actuationPlan(verdict.element, params.window)
              actLabel = plan[0]?.label ?? "click"
              actResult = { ok: false, error: "no actuation rung" }
              for (const candidate of plan) {
                actResult = yield* callDriver(tools, "cua-driver_click", candidate.args, ctx.abort)
                actLabel = candidate.label
                if (actResult.ok) {
                  clickRung = candidate
                  break
                }
              }
            }
            const target = verdict.element.label ?? verdict.element.element_token
            if (!actResult.ok) {
              status = "failed"
              previous = `[fail ${step + 1}] ${actLabel} → ${target}`
              lines.push(`${previous}: ${actResult.error}`)
              break
            }
            executed++
            // The action ran at this node; the next observation reveals whether it
            // changed the screen (see nextAmbiguity) and folds the change evidence.
            actedAt = map.current
            lastActuation = {
              mode: clickRung ? clickRung.mode : "type",
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

          // (c) The run's return carries the map (start/current/frontier/path) and
          // every step's decision, in metadata and as a JSON trailer on the output,
          // so an external checker can verify the chain.
          const navMap = map
            ? { start: map.start, current: map.current, frontier: map.frontier, path: map.path }
            : undefined
          const summary = { status, steps: trace, ...(navMap ? { map: navMap } : {}) }
          return {
            title: `ui_run (${executed} actions, ${observations} observations, ${status})`,
            metadata: { ...summary, goal, executed, observations },
            output: [...lines, ...(truncated ? [truncated] : []), JSON.stringify(summary)].join("\n"),
          }
        }),
    }
  }),
)