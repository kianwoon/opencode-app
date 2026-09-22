import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { CONTROLS_MAX, LABEL_MAX, STATE_MAX, jevControl, jevKey, type ControllerDecision, type ControllerInput } from "../jev/controller"

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

export function toControllerInput(params: Params, key: string): ControllerInput {
  return {
    goal: params.goal,
    controls: toControlLabels(params.controls),
    ...(toLastAction(params.state, params.recent) ? { lastAction: toLastAction(params.state, params.recent)! } : {}),
    key,
  }
}

export function formatDecision(decision: ControllerDecision): { title: string; output: string } {
  const target = decision.target ? ` [${decision.target}]` : ""
  return {
    title: `jev: ${decision.action}${target}`,
    output: `operation=${decision.action} target=${decision.target ?? "none"} confidence=${decision.strength}\n${JSON.stringify(decision)}`,
  }
}

export function formatUnavailable(): { title: string; output: string } {
  return {
    title: "jev: unavailable",
    output: JSON.stringify({ decision: null, reason: "unavailable" }),
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
          const decision = yield* Effect.promise(() => jevControl(toControllerInput(params, key))).pipe(
            Effect.catch(() => Effect.succeed(null)),
          )
          if (!decision) return { ...formatUnavailable(), metadata: {} }
          return { ...formatDecision(decision), metadata: {} }
        }),
    }
  }),
)
