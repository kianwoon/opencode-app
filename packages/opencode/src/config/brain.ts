export * as ConfigBrain from "./brain"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

// Default-deny: MCP tools are named `<server>_<tool>` and `disabled()`
// (permission/index.ts:219) hides a tool only when its NAME matches a rule, so a
// `bash: "deny"` rule never applies to e.g. `context-mode_execute`. Default-deny is
// therefore required so every current and future MCP server is denied to this
// planner-only agent unless explicitly allow-listed below. Key order matters:
// `Ruleset.findLast` (permission/index.ts:225) makes the LAST matching rule win, so
// `"*": "deny"` must remain the FIRST key.
//
// The allow-list is COMPLETE: read-only, planning, delegation, effort-escalation
// and research tools are explicitly allowed; every execution tool stays denied by
// the `"*"` catch-all (bash/shell, edit, write, apply_patch, patch, execute,
// compress, context-mode_execute, context-mode_batch_execute, open-computer-use_*,
// webmcp-today_*). Prefix allows (`web-reader_*`, `web-search-prime_*`,
// `zai-mcp-server_*`) cover whole read-only MCP servers. `context-mode_*` is NOT
// prefix-allowed because that server is mixed — it also exposes
// context-mode_execute/context-mode_batch_execute which must stay denied.
const BRAIN_PERMISSION_STRICT = () => ({
  "*": "deny",
  read: "allow",
  grep: "allow",
  glob: "allow",
  list: "allow",
  todowrite: "allow",
  session_rename: "allow",
  skill: "allow",
  question: "allow",
  invalid: "allow",
  request_effort: "allow",
  workflow: "allow",
  tool_search: "allow",
  find_tools: "allow",
  webfetch: "allow",
  websearch: "allow",
  "context-mode_search": "allow",
  "context-mode_get_chunk": "allow",
  "context-mode_fetch_and_index": "allow",
  "web-reader_*": "allow",
  "web-search-prime_*": "allow",
  "zai-mcp-server_*": "allow",
  bash: {
    "*": "deny",
    "echo *": "allow",
    // "*>*" catches all redirection variants; last matching rule wins (permission/index.ts findLast)
    "*>*": "deny",
  },
  task: {
    "*": "deny",
    explorer: "allow",
    implementer: "allow",
    reviewer: "allow",
    guru: "allow",
    "computer-aid": "allow",
  },
}) as const

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
      permission: strict ? BRAIN_PERMISSION_STRICT() : {},
    }
  } else {
    // brain.model overrides agent/*.md entry models when set.
    if (brain.model) agent.brain.model = brain.model
    if (strict && (!agent.brain.permission || Object.keys(agent.brain.permission).length === 0)) {
      agent.brain.permission = BRAIN_PERMISSION_STRICT()
    }
  }

  for (const [name, model] of [
    ["explorer", brain.hands_model],
    ["implementer", brain.hands_model],
    ["reviewer", brain.reviewer_model],
    ["guru", brain.guru_model],
    ["computer-aid", brain.computer_aid_model],
  ] as const) {
    if (!model) continue
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
