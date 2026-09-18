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
  relevance: Schema.optional(
    Schema.Struct({
      /** Accepting irrelevance probability for a context section to be prunable (e.g. 0.5). */
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
  relevance: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the context-relevance classifier specifically.",
  }),
  scoring: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the ordered-scoring classifier specifically.",
  }),
  state_extraction: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the state-extraction classifier specifically.",
  }),
  batch: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the batch/map-reduce classifier specifically.",
  }),
  verification: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the verification classifier specifically.",
  }),
  guardrails: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the guardrails classifier specifically.",
  }),
  matching: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the matching classifier specifically.",
  }),
  screening: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the screening classifier specifically.",
  }),
  memory: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the memory classifier specifically.",
  }),
  anomaly: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the anomaly classifier specifically.",
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
    description:
      "Allow the classifier to ACT on STOP/ESCALATE verdicts, not just observe. Defaults to false. MASTER switch: when a per-seam `act_*` field is absent it supplies that seam's default.",
  }),
  act_relevance: Schema.optional(Schema.Boolean).annotate({
    description: "Allow the classifier to ACT on relevance decisions (prune context). Falls back to `act`.",
  }),
  act_retry: Schema.optional(Schema.Boolean).annotate({
    description: "Allow the classifier to ACT on retry decisions (halt retries). Falls back to `act`.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
