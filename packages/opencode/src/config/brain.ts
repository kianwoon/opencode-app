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
            task: { "*": "deny", explorer: "allow", implementer: "allow", reviewer: "allow", guru: "allow" },
          }
        : {},
    }
  } else {
    // agent/*.md entries exist without a model (single-source-truth change):
    // fill absent fields only, never overwrite user-set values.
    if (!agent.brain.model && brain.model) agent.brain.model = brain.model
    if (strict && (!agent.brain.permission || Object.keys(agent.brain.permission).length === 0)) {
      agent.brain.permission = {
        edit: "deny",
        bash: "deny",
        task: { "*": "deny", explorer: "allow", implementer: "allow", reviewer: "allow", guru: "allow" },
      }
    }
  }

  for (const [name, model] of [
    ["explorer", brain.hands_model],
    ["implementer", brain.hands_model],
    ["reviewer", brain.reviewer_model],
    ["guru", brain.guru_model],
  ] as const) {
    const entry = agent[name]
    if (!entry) {
      agent[name] = {
        mode: "subagent",
        ...(model ? { model } : {}),
        permission: strict ? { task: "deny" } : {},
      }
      continue
    }
    if (!entry.model && model) entry.model = model
    if (!strict) continue
    entry.permission ??= {}
    if (entry.permission.task === undefined) entry.permission.task = "deny"
  }
}
