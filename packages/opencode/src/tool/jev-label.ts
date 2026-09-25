import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { jevKey } from "../jev/controller"
import { jevLabel, type JevLabelResult } from "../jev/label"

export const Parameters = Schema.Struct({
  snapshot: Schema.String.annotate({
    description: "Compact session telemetry snapshot (tokens, cost, prompts, duration, activity pattern)",
  }),
  objective: Schema.optional(Schema.String).annotate({
    description: "The session's stated objective, for drift judgments",
  }),
  threshold: Schema.optional(Schema.Number).annotate({
    description: "Minimum noul (0..1) to trust the label (default 0.7)",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Metadata = {}

export function toLabelInput(params: Params, key: string) {
  return {
    key,
    snapshot: params.snapshot,
    objective: params.objective,
    ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
  }
}

export function formatLabel(result: JevLabelResult): { title: string; output: string } {
  const probabilities = Object.entries(result.probabilities)
    .map(([label, value]) => `${label}:${value}`)
    .join(" ")
  return {
    title: result.labeled ? "jev: label" : "jev: unlabeled",
    output: `label=${result.label}\nmeasured=${result.measured}\nnoul=${result.noul}\nstrength=${result.strength}\nprobabilities=${probabilities}`,
  }
}

export function formatUnavailable(): { title: string; output: string } {
  return {
    title: "jev: unavailable",
    output: JSON.stringify({ decision: null, reason: "unavailable" }),
  }
}

export const JevLabelTool = Tool.define<typeof Parameters, Metadata, never>(
  "jev_label",
  Effect.gen(function* () {
    return {
      description:
        "Session state labeling: classifies a telemetry snapshot as thrive|stall|bloat|drift via one JEV decide call (choice + probabilities + noul). Advisory predictive features, never a gate; fails open unlabeled.",
      parameters: Parameters,
      execute: (params: Params) =>
        Effect.gen(function* () {
          const key = jevKey()
          if (!key) return { ...formatUnavailable(), metadata: {} }
          const result = yield* Effect.promise(() => jevLabel(toLabelInput(params, key))).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (!result) return { ...formatUnavailable(), metadata: {} }
          return { ...formatLabel(result), metadata: {} }
        }),
    }
  }),
)
