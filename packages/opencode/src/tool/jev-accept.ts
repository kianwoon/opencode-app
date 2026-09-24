import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { jevKey } from "../jev/controller"
import { jevAccept, type JevAcceptDecision } from "../jev/accept"

export const Parameters = Schema.Struct({
  gate: Schema.String.annotate({ description: "The handoff's acceptance gate: what 'done' means for the task" }),
  result: Schema.String.annotate({ description: "The hand's returned report to measure against the gate" }),
  threshold: Schema.optional(Schema.Number).annotate({
    description: "Minimum measured strength to accept (default 0.7)",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Metadata = {}

export function toAcceptInput(params: Params, key: string) {
  return {
    key,
    gate: params.gate,
    result: params.result,
    ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
  }
}

export function formatAccept(decision: JevAcceptDecision): { title: string; output: string } {
  const verdict = decision.accept ? "accept" : decision.measured ? "refire" : "unmeasured"
  return {
    title: `jev: ${verdict}`,
    output: `verdict=${verdict} noul=${decision.noul ?? "n/a"} strength=${decision.strength ?? "n/a"}\n${JSON.stringify(decision)}`,
  }
}

export function formatUnavailable(): { title: string; output: string } {
  return {
    title: "jev: unavailable",
    output: JSON.stringify({ decision: null, reason: "unavailable" }),
  }
}

export const JevAcceptTool = Tool.define<typeof Parameters, Metadata, never>(
  "jev_accept",
  Effect.gen(function* () {
    return {
      description:
        "Measured acceptance gate for a returned handoff: scores `result` against `gate` with a noul 0-1 prefilter plus an accept/refire choice verdict. Fail-open — an unmeasured result means 'fall back to the prompt-level two-strike rule', never auto-accept.",
      parameters: Parameters,
      execute: (params: Params) =>
        Effect.gen(function* () {
          const key = jevKey()
          if (!key) return { ...formatUnavailable(), metadata: {} }
          const decision = yield* Effect.promise(() => jevAccept(toAcceptInput(params, key))).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (!decision) return { ...formatUnavailable(), metadata: {} }
          return { ...formatAccept(decision), metadata: {} }
        }),
    }
  }),
)
