export * as Orchestration from "./orchestration.js"

import { Schema } from "effect"

/**
 * Resolved effort-router configuration. Mirrors the coercion the router plugin
 * applies to `effort-router.json` (booleans default false, bands clamp to 0..1,
 * absent models fall back). Deliberately contains no key material.
 */
export const EffortRouterConfig = Schema.Struct({
  jev: Schema.Struct({
    enabled: Schema.Boolean,
    model: Schema.String,
    threshold: Schema.Number,
  }),
  guardrail: Schema.Struct({
    enabled: Schema.Boolean,
    model: Schema.String,
    denyBelow: Schema.Number,
    abstainBelow: Schema.Number,
  }),
  riskyTools: Schema.Array(Schema.String),
}).annotate({ identifier: "Orchestration.EffortRouterConfig" })
export type EffortRouterConfig = typeof EffortRouterConfig.Type

export const JevVerdictsQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100)),
  ),
}).annotate({ identifier: "Orchestration.JevVerdictsQuery" })
export type JevVerdictsQuery = typeof JevVerdictsQuery.Type

/**
 * Resolved context-gate configuration as the plugin would coerce it from
 * `context-gate.json`. Read-only fields mirror the toggle state; only
 * `triageEnabled` is writable here (the others live elsewhere / in the file).
 * Contains no key material.
 */
export const GateConfig = Schema.Struct({
  scopingEnabled: Schema.Boolean,
  summarizeEnabled: Schema.Boolean,
  triageEnabled: Schema.Boolean,
}).annotate({ identifier: "Orchestration.GateConfig" })
export type GateConfig = typeof GateConfig.Type

export const GateConfigUpdateInput = Schema.Struct({
  triageEnabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Orchestration.GateConfigUpdateInput" })
export type GateConfigUpdateInput = typeof GateConfigUpdateInput.Type
