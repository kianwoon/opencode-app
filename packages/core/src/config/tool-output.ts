export * as ConfigToolOutput from "./tool-output"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.ToolOutput")({
  max_lines: PositiveInt.pipe(Schema.optional),
  max_bytes: PositiveInt.pipe(Schema.optional),
  evict_results_ms: NonNegativeInt.pipe(Schema.optional).annotate({
    description:
      "Lower completed local tool results older than this offset (relative to the newest message) to a compact placeholder when replaying history. 0 disables eviction",
  }),
  collapse_repeats: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Collapse long runs of identical lines in tool output before applying truncation limits",
  }),
}) {}
