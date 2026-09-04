export * as ConfigBrainV1 from "./brain"

import { Schema } from "effect"

export const Info = Schema.Struct({
  model: Schema.optional(Schema.String).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  hands_model: Schema.optional(Schema.String).annotate({
    description: "Model to use for hands in the format of provider/model",
  }),
  reviewer_model: Schema.optional(Schema.String).annotate({
    description: "Model to use for review in the format of provider/model",
  }),
  guru_model: Schema.optional(Schema.String).annotate({
    description: "Smartest model for guru advisor in provider/model format (cost opt-in, one-shot guidance only)",
  }),
  enforcement: Schema.optional(Schema.Literals(["strict", "advisory"])).annotate({
    description:
      "Control brain enforcement behavior: 'strict' blocks on failed checks, 'advisory' only warns without blocking. Strict enforcement permissions take precedence over global `permission` for the generated agents.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
