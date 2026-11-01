export * as Agent from "./agent.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"
import { Model } from "./model.js"
import { Permission } from "./permission.js"
import { Provider } from "./provider.js"
import { PositiveInt, statics } from "./schema.js"

const Updated = ephemeral({ type: "agent.updated", schema: {} })

export const ID = Schema.String.pipe(Schema.brand("Agent.ID"), Schema.annotate({ identifier: "Agent.ID" }))
export type ID = typeof ID.Type

export const Name = Schema.String.pipe(Schema.brand("Agent.Name"))
export type Name = typeof Name.Type

export const Color = Schema.String.annotate({ identifier: "Agent.Color" })
export type Color = typeof Color.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Name,
  model: Model.Ref.pipe(optional),
  effort: Schema.String.pipe(optional).annotate({
    description:
      "Reasoning effort for this agent's runs, independent of its model. A subagent applies it instead of inheriting the parent session's effort. A value matching one of the model's variants selects that variant; any other value becomes a reasoningEffort model setting.",
  }),
  request: Provider.Request,
  system: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  hidden: Schema.Boolean,
  color: Color.pipe(optional),
  steps: PositiveInt.pipe(optional),
  permissions: Permission.Ruleset,
  tools: Schema.Record(Schema.String, Schema.Boolean).pipe(optional),
  budget: PositiveInt.pipe(optional).annotate({
    description:
      "Target context budget in tokens for this agent. Compaction keeps estimated context at or below this window instead of the full model context",
  }),
})
  .annotate({ identifier: "Agent.Info" })
  .pipe(
    statics(() => ({
      default: (id: ID) =>
        ({
          id,
          name: Name.make(id),
          request: { settings: {}, headers: {}, body: {} },
          mode: "primary",
          hidden: false,
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            { action: "read", resource: "*.env", effect: "ask" },
            { action: "read", resource: "*.env.*", effect: "ask" },
            { action: "read", resource: "*.env.example", effect: "allow" },
          ],
        }) satisfies Info,
    })),
  )

export const Event = {
  Updated,
  Definitions: inventory(Updated),
}
