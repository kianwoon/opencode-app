export * as ConfigClassifierV1 from "./classifier"

import { Schema } from "effect"

/**
 * Thresholds that turn calibrated classifier signals into a decision.
 * Mirrors plan §14; every field is optional so partial config merges cleanly.
 */
const Thresholds = Schema.Struct({
  retry_switch: Schema.optional(
    Schema.Struct({
      /** Accepting confidence for the retry→switch decision (e.g. 0.8). */
      accept: Schema.optional(Schema.Number),
    }),
  ),
  retry_act: Schema.optional(
    Schema.Struct({
      /** Accepting confidence for a STOP/ESCALATE verdict to actually halt retries (e.g. 0.8). */
      accept: Schema.optional(Schema.Number),
    }),
  ),
})

/**
 * Decision-seam (classifier) configuration. Phase 1 is infrastructure only:
 * `enabled` defaults to false and no loop reads these thresholds yet.
 */
export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the decision-classifier seam. Defaults to false (no behavioral change).",
  }),
  retry: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the retry/death-spiral classifier specifically.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: 'System One model id, e.g. "jev-latest".',
  }),
  max_attempts: Schema.optional(Schema.Number).annotate({
    description: "Attempts before the retry classifier is allowed to STOP or ESCALATE.",
  }),
  thresholds: Schema.optional(Thresholds).annotate({
    description: "Decision thresholds keyed by decision seam.",
  }),
  act: Schema.optional(Schema.Boolean).annotate({
    description: "Allow the classifier to ACT on STOP/ESCALATE verdicts, not just observe. Defaults to false.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
