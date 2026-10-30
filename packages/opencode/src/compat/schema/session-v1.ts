// baseline-guard:allow new compat module; upstream removed WithParts which fork code still uses
import { SessionV1 } from "@opencode/schema/v1/session"
import { Schema } from "effect"

export const WithParts = Schema.Struct({
  info: SessionV1.Info,
  parts: Schema.Array(SessionV1.Part),
})

export type WithParts = {
  info: SessionV1.Info
  parts: SessionV1.Part[]
}
