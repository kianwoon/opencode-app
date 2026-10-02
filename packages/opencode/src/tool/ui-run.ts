import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { MCP } from "../mcp"
import * as Tool from "./tool"
import { CONTROLS_MAX, LABEL_MAX, jevControl, jevKey } from "../jev/controller"

const MAX_STEPS = 12
const DEFAULT_TIMEOUT = 30_000
const MAX_EXPECT = 8

/** AXStaticText/AXImage carry no actions, so offering them as click targets emits blind clicks. */
const NON_INTERACTIVE = new Set(["AXStaticText", "AXImage"])

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max))

export const Element = Schema.Struct({
  element_index: Schema.optional(Schema.Int),
  element_token: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
})
export type Element = Schema.Schema.Type<typeof Element>

const Observation = Schema.Struct({
  snapshot_id: Schema.String,
  elements: Schema.Array(Element),
})
export type Observation = Schema.Schema.Type<typeof Observation>

/**
 * Decode a `cua-driver_get_window_state` `structuredContent`. A missing or
 * undecodable payload is never guessed from the text channel: it returns `null`
 * and the run stops, because a target invented from prose would be a blind click.
 */
export function decodeObservation(input: unknown): Observation | null {
  const decoded = Schema.decodeUnknownOption(Observation)(input)
  return Option.isSome(decoded) ? decoded.value : null
}

/**
 * Turn observed elements into the capped label set the controller chooses from.
 * Labels are the round-trip handle: `foldController` returns exactly the clipped
 * string it was offered, so `byLabel` maps a decision back to a live element_token.
 */
export function buildCandidates(elements: readonly Element[]): {
  labels: string[]
  byLabel: Map<string, Element>
  truncated: string | undefined
} {
  const usable = elements.filter(
    (element) =>
      element.element_token !== undefined &&
      element.role !== undefined &&
      !NON_INTERACTIVE.has(element.role) &&
      element.enabled !== false,
  )
  const entries = usable
    .slice(0, CONTROLS_MAX)
    .map((element, i) => ({
      element,
      label: clip(`c${i + 1} ${element.role} ${element.label ?? ""}`.trim(), LABEL_MAX),
    }))
  return {
    labels: entries.map((entry) => entry.label),
    byLabel: new Map(entries.map((entry) => [entry.label, entry.element])),
    truncated:
      usable.length > CONTROLS_MAX
        ? `controls truncated from ${usable.length} to ${CONTROLS_MAX}; tail elements are invisible to the decision model`
        : undefined,
  }
}

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

export const Parameters = Schema.Struct({
  goal: Schema.String.annotate({ description: "Run-level goal, kept as context for every step" }),
  window: Schema.Struct({ pid: Schema.Int, window_id: Schema.Int }).annotate({
    description: "Target window, as reported by cua-driver_list_windows",
  }),
  steps: Schema.Array(
    Schema.Struct({
      intent: Schema.String.annotate({ description: "Subgoal for this one step, handed to the decision model" }),
      value: Schema.optional(Schema.String).annotate({
        description: "Text to type into the chosen control; when present the step types instead of clicking",
      }),
    }),
  ).annotate({ description: "Ordered step subgoals, executed in order" }),
  expect: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))).annotate({
    description: "Verify predicates passed straight through to cua-driver_verify_state",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Metadata = {}
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
        "Run a bounded observe-decide-act-verify loop on one window in ONE call: the window is observed once, then each step's subgoal is decided by jev and executed with no model turn between steps. Fails open at every stage — a missing decision key, an undecodable observation, a sub-threshold decision or a driver error stops the loop and reports back instead of guessing. Actuator effects are unverifiable per step, so pass `expect` to verify the end state with cua-driver_verify_state. Requires the cua-driver MCP server and a configured jev key; returns an unavailable notice otherwise.",
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
          if (params.steps.length > MAX_STEPS) {
            return {
              title: "ui_run (rejected)",
              metadata: {},
              output: `ui_run accepts at most ${MAX_STEPS} steps per call; received ${params.steps.length}. Split the run across calls.`,
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

          const observed = yield* callDriver(
            tools,
            "cua-driver_get_window_state",
            { pid: params.window.pid, window_id: params.window.window_id, include_screenshot: false },
            ctx.abort,
          )
          if (!observed.ok) {
            return {
              title: "ui_run (unparseable observation)",
              metadata: {},
              output: `window state unreadable: ${observed.error}`,
            }
          }
          const observation = decodeObservation(observed.result.structuredContent)
          if (!observation) {
            return {
              title: "ui_run (unparseable observation)",
              metadata: {},
              output: "window state carried no decodable structuredContent; the run stopped rather than guess targets from text",
            }
          }

          const candidates = buildCandidates(observation.elements)
          const lines: string[] = []
          let executed = 0
          let status = "completed"
          let previous: string | undefined

          for (const [i, step] of params.steps.entries()) {
            const decision = yield* Effect.promise(() =>
              jevControl({
                goal: step.intent,
                lastAction: `${params.goal} (step ${i + 1}/${params.steps.length})${
                  previous ? ` | after: ${previous}` : ""
                }`,
                controls: candidates.labels,
                key,
              }),
            )
            if (!decision) {
              status = "escalate"
              lines.push(`[escalate ${i + 1}/${params.steps.length}] jev returned no usable decision`)
              break
            }
            const element = decision.target ? candidates.byLabel.get(decision.target) : undefined
            if (!decision.target || !element?.element_token) {
              status = "escalate"
              lines.push(`[escalate ${i + 1}/${params.steps.length}] jev target is not an offered control`)
              break
            }
            const actArgs = {
              element_token: element.element_token,
              pid: params.window.pid,
              window_id: params.window.window_id,
              ...(step.value !== undefined ? { text: step.value } : {}),
            }
            const attempt = yield* callDriver(
              tools,
              step.value !== undefined ? "cua-driver_type_text" : "cua-driver_click",
              actArgs,
              ctx.abort,
            )
            // Exactly one rung: the driver refuses process-scoped key events when one pid
            // owns several eligible windows, and offers foreground delivery as the remedy.
            // click is NEVER escalated — pointer/AXPress is already window-targeted, so the
            // refusal class is keyboard-delivery-specific only.
            const retried = !attempt.ok && step.value !== undefined && needsForegroundDelivery(attempt.error)
            const outcome = retried
              ? yield* callDriver(
                  tools,
                  "cua-driver_type_text",
                  { ...actArgs, delivery_mode: "foreground" },
                  ctx.abort,
                )
              : attempt
            if (!outcome.ok) {
              status = "failed"
              previous = `[fail ${i + 1}/${params.steps.length}] ${step.value !== undefined ? "type_text" : "click"} → ${decision.target}`
              lines.push(`${previous}: ${outcome.error}`)
              break
            }
            executed++
            previous =
              step.value !== undefined
                ? `[ok ${i + 1}/${params.steps.length}] type_text "${step.value}" → ${decision.target}`
                : `[ok ${i + 1}/${params.steps.length}] click → ${decision.target}`
            lines.push(`${previous} (jev ${decision.strength}${retried ? ", foreground retry" : ""})`)
          }

          if (status === "completed" && params.expect !== undefined) {
            const verified = yield* callDriver(
              tools,
              "cua-driver_verify_state",
              { pid: params.window.pid, window_id: params.window.window_id, expect: normalizeExpect(params.expect) },
              ctx.abort,
            )
            if (!verified.ok) {
              status = "failed"
              lines.push(`[verify] driver could not verify: ${verified.error}`)
            } else {
              const verdict = textOf(verified.result.content).trim()
              const satisfied = /satisfied|passed|true/i.test(verdict)
              status = satisfied ? "verified" : "unsatisfied"
              lines.push(`[verify] ${verdict || "driver returned no verdict"}`)
            }
          }

          return {
            title: `ui_run (${executed}/${params.steps.length} steps, ${status})`,
            metadata: {},
            output: [
              ...lines,
              `observations: 1 snapshot for ${executed} steps`,
              ...(candidates.truncated ? [candidates.truncated] : []),
            ].join("\n"),
          }
        }),
    }
  }),
)