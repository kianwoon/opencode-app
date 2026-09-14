export * as ConfigBrain from "./brain"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

// Explicit brain models take precedence over agent entry models: a non-empty
// brain model string overwrites `agent.<name>.model`; empty/absent leaves the
// agent entry as-is (cleared = no opinion). Permission fill stays fill-absent-only.
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
            task: {
              "*": "deny",
              explorer: "allow",
              implementer: "allow",
              reviewer: "allow",
              guru: "allow",
              "computer-aid": "allow",
            },
          }
        : {},
    }
  } else {
    // brain.model overrides agent/*.md entry models when set.
    if (brain.model) agent.brain.model = brain.model
    if (strict && (!agent.brain.permission || Object.keys(agent.brain.permission).length === 0)) {
      agent.brain.permission = {
        edit: "deny",
        bash: "deny",
        task: {
          "*": "deny",
          explorer: "allow",
          implementer: "allow",
          reviewer: "allow",
          guru: "allow",
          "computer-aid": "allow",
        },
      }
    }
  }

  for (const [name, model] of [
    ["explorer", brain.hands_model],
    ["implementer", brain.hands_model],
    ["reviewer", brain.reviewer_model],
    ["guru", brain.guru_model],
    ["computer-aid", brain.computer_aid_model],
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
    // Non-empty brain model wins; empty/absent leaves the entry untouched.
    if (model) entry.model = model
    if (!strict) continue
    entry.permission ??= {}
    if (entry.permission.task === undefined) entry.permission.task = "deny"
  }
}
