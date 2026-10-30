import { Effect, Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { jevKey } from "../jev/controller"
import { jevLabel, type JevLabelResult } from "../jev/label"
import { buildSessionSnapshot } from "../jev/snapshot"

export const Parameters = Schema.Struct({
  snapshot: Schema.optional(Schema.String).annotate({
    description: "Compact session telemetry snapshot (tokens, cost, prompts, duration, activity pattern)",
  }),
  sessionID: Schema.optional(Schema.String).annotate({
    description: "Query this session from the local opencode DB and build the snapshot automatically (overrides snapshot)",
  }),
  objective: Schema.optional(Schema.String).annotate({
    description: "The session's stated objective, for drift judgments",
  }),
  threshold: Schema.optional(Schema.Number).annotate({
    description: "Minimum measured strength, i.e. probabilities[choice] (0..1), to trust the label (default 0.7)",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type LabelParams = Params & { readonly snapshot: string }

export function toLabelInput(params: LabelParams, key: string) {
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
    output: `label=${result.label}\nmeasured=${result.measured}\nstrength=${result.strength}\nprobabilities=${probabilities}`,
  }
}

export function formatUnavailable(): { title: string; output: string } {
  return {
    title: "jev: unavailable",
    output: JSON.stringify({ decision: null, reason: "unavailable" }),
  }
}

export const Plugin = {
  id: "opencode.tool.jev_label",
  effect: Effect.fn("JevLabelTool.Plugin")(function* (ctx: PluginContext) {
    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "jev_label",
        options: { codemode: false },
        description:
          "Session state labeling: classifies a telemetry snapshot as thrive|stall|bloat|drift via one JEV decide call (choice + probabilities). Advisory predictive features, never a gate; fails open unlabeled.",
        input: Parameters,
        execute: (params: Params) =>
          Effect.gen(function* () {
            const key = jevKey()
            if (!key) return { content: formatUnavailable().output, metadata: {} }
            const built =
              params.sessionID === undefined
                ? undefined
                : yield* Effect.promise(async () => {
                    const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db")
                    return await buildSessionSnapshot(dbPath, params.sessionID!)
                  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (params.sessionID !== undefined && !built) return { content: formatUnavailable().output, metadata: {} }
            const snapshot = built?.snapshot ?? params.snapshot
            if (snapshot === undefined) return { content: formatUnavailable().output, metadata: {} }
            const labelParams: LabelParams = {
              ...params,
              snapshot,
              objective: params.objective ?? built?.title,
            }
            const result = yield* Effect.promise(() => jevLabel(toLabelInput(labelParams, key))).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (!result) return { content: formatUnavailable().output, metadata: {} }
            const formatted = formatLabel(result)
            return { content: formatted.output, metadata: { title: formatted.title } }
          }),
      }),
    )
  }),
}
