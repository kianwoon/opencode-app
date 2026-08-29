export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  trigger: Schema.Number.check(Schema.isBetween({ minimum: 0.05, maximum: 0.95 }))
    .pipe(Schema.optional)
    .annotate({
      description:
        "Compact proactively once estimated context reaches this fraction of the model window (0.05-0.95), instead of waiting until the window is nearly full",
    }),
}) {}
