import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import {
  CONTROLS_MAX,
  LABEL_MAX,
  STATE_MAX,
  jevControlDetailed,
  jevKey,
  type ControllerDecision,
  type ControllerInput,
} from "../jev/controller"

export const JevControlSchema = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  label: Schema.String,
  value: Schema.optional(Schema.String),
})

export const Parameters = Schema.Struct({
  goal: Schema.String.annotate({ description: "What the agent is trying to accomplish" }),
  controls: Schema.Array(JevControlSchema).annotate({
    description: "Indexed control table: visible interactive controls in order",
  }),
  state: Schema.optional(Schema.String).annotate({
    description: "Brief page/window context (url, title, anchor)",
  }),
  recent: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Recent action summaries, most recent last",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Control = Params["controls"][number]

type Metadata = {}

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max))

export function toControlLabels(controls: readonly Control[]): string[] {
  return controls
    .slice(0, CONTROLS_MAX)
    .map((c) => clip(`${c.id} ${c.action} ${c.label}${c.value ? ` ${c.value}` : ""}`.trim(), LABEL_MAX))
}

export function toLastAction(state?: string, recent?: readonly string[]): string | undefined {
  const tail = (recent ?? []).slice(-10)
  const parts = [...(state ? [clip(state, STATE_MAX)] : []), ...tail]
  if (parts.length === 0) return undefined
  return parts.join(" | ")
}

/**
 * Marker for a control table that hit the CONTROLS_MAX cap at this tool boundary.
 * The controller can only see the first CONTROLS_MAX labels, so a hidden tail
 * target must be stated outright — never left to look like an absent control.
 */
export function truncationMarker(controls: readonly Control[]): string | undefined {
  return controls.length > CONTROLS_MAX
    ? `controls truncated from ${controls.length} to ${CONTROLS_MAX}; tail labels are invisible to the decision model`
    : undefined
}

export function toControllerInput(params: Params, key: string): ControllerInput {
  const marker = truncationMarker(params.controls)
  const lastAction = [toLastAction(params.state, params.recent), marker].filter(Boolean).join(" | ") || undefined
  return {
    goal: params.goal,
    controls: toControlLabels(params.controls),
    ...(lastAction ? { lastAction } : {}),
    key,
  }
}

export function formatDecision(decision: ControllerDecision, marker?: string): { title: string; output: string } {
  const target = decision.target ? ` [${decision.target}]` : ""
  return {
    title: `jev: ${decision.action}${target}`,
    output: `${marker ? marker + "\n" : ""}operation=${decision.action} target=${decision.target ?? "none"} strength=${decision.strength}\n${JSON.stringify(decision)}`,
  }
}

export function formatUnavailable(): { title: string; output: string } {
  return {
    title: "jev: unavailable",
    output: JSON.stringify({ decision: null, reason: "unavailable" }),
  }
}

/**
 * A measured-but-below-gate verdict is an "uncertain" outcome, not unavailable:
 * it carries the choice and its strength so the caller can see the model weighed
 * a real action and declined to trust it.
 */
export function formatBelowGate(
  outcome: { choice: string; strength: number },
  marker?: string,
): { title: string; output: string } {
  return {
    title: "jev: below_gate",
    output: `${marker ? marker + "\n" : ""}${JSON.stringify({ decision: null, reason: "below_gate", choice: outcome.choice, strength: outcome.strength })}`,
  }
}

export const JevDecideTool = Tool.define<typeof Parameters, Metadata, never>(
  "jev_decide",
  Effect.gen(function* () {
    return {
      description:
        "Categorical UI-steering decision via the jev SystemOne endpoint over an indexed control table; fail-open by design.",
      parameters: Parameters,
      execute: (params: Params) =>
        Effect.gen(function* () {
          const key = jevKey()
          if (!key) return { ...formatUnavailable(), metadata: {} }
          const outcome = yield* Effect.promise(() => jevControlDetailed(toControllerInput(params, key))).pipe(
            Effect.catch(() => Effect.succeed({ verdict: "unmeasured" } as const)),
          )
          if (outcome.verdict === "below_gate")
            return { ...formatBelowGate(outcome, truncationMarker(params.controls)), metadata: {} }
          if (outcome.verdict !== "accepted") return { ...formatUnavailable(), metadata: {} }
          return { ...formatDecision(outcome.decision, truncationMarker(params.controls)), metadata: {} }
        }),
    }
  }),
)
