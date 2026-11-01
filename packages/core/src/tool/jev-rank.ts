export * as JevRankTool from "./jev-rank.js"

import { Effect, Schema } from "effect"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { jevKey } from "../jev/controller"
import { jevRank, type JevRankResult } from "../jev/rank"

export const Parameters = Schema.Struct({
  question: Schema.String.annotate({ description: "What you are trying to answer or read for" }),
  candidates: Schema.Array(Schema.String).annotate({
    description: "Candidate identifiers (file paths or labels) to rank, best-guess order first",
  }),
  threshold: Schema.optional(Schema.Number).annotate({
    description: "Minimum normalized score (0..1) to trust for ranking (default 0.5)",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

export function toRankInput(params: Params, key: string) {
  return {
    key,
    question: params.question,
    candidates: params.candidates,
    ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
  }
}

export function formatRank(result: JevRankResult): { title: string; output: string } {
  const lines = result.ranks.map((row) => `${row.rank}. ${row.candidate} (${row.score.toFixed(2)})`)
  return {
    title: result.ranked ? "jev: rank" : "jev: unranked",
    output: `ranked=${result.ranks.length} of ${result.order.length}\n${lines.join("\n")}\norder=${result.order.join(" | ")}`,
  }
}

export function formatUnavailable(): { title: string; output: string } {
  return {
    title: "jev: unavailable",
    output: JSON.stringify({ decision: null, reason: "unavailable" }),
  }
}

export const Plugin = {
  id: "opencode.tool.jev_rank",
  effect: Effect.fn("opencode.tool.jev_rank.Plugin")(function* (ctx: PluginContext) {
    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "jev_rank",
        options: { codemode: false },
        description:
          "Advisory read pre-ranking: scores candidate files/labels against `question` with JEV Score (legend-normalized) and returns a read order — ranked first, unmeasured tail last. Ordering only, never a gate; fails open to input order.",
        input: Parameters,
        execute: (params: Params) =>
          Effect.gen(function* () {
            const key = jevKey()
            if (!key) return { content: formatUnavailable().output, metadata: {} }
            const result = yield* Effect.promise(() => jevRank(toRankInput(params, key))).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (!result) return { content: formatUnavailable().output, metadata: {} }
            const formatted = formatRank(result)
            return { content: formatted.output, metadata: { title: formatted.title } }
          }),
      }),
    )
  }),
}
