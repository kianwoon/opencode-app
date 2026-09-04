export * as ConfigBrain from "./brain"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

// Fill-absent-only synthesis of the brain agent hierarchy from the `brain` config
// block: user-defined agent entries always win, generated entries only fill gaps.
export function expand(config: ConfigV1.Info) {
  const brain = config.brain
  if (!brain) return

  const strict = brain.enforcement === "strict"
  const agent = (config.agent ??= {})

  if (!agent.brain) {
    agent.brain = {
      mode: "primary",
      ...(brain.model ? { model: brain.model } : {}),
      permission: strict
        ? {
            edit: "deny",
            bash: "deny",
            task: { "*": "deny", explorer: "allow", implementer: "allow", reviewer: "allow" },
          }
        : {},
    }
  }

  for (const [name, model] of [
    ["explorer", brain.hands_model],
    ["implementer", brain.hands_model],
    ["reviewer", brain.reviewer_model],
  ] as const) {
    if (agent[name]) continue
    agent[name] = {
      mode: "subagent",
      ...(model ? { model } : {}),
      permission: strict ? { task: "deny" } : {},
    }
  }
}
