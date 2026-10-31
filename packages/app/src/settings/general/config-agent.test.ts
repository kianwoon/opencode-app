import { describe, expect, test } from "bun:test"
import { agentPatch, parseModel, readAgents, resolveDisplayModel } from "./config-agent"

// The exact shapes GET /api/config serves for the user's live config: model is a
// decoded ConfigModel.Selection, permissions an ordered Permission.Ruleset, and
// every unknown legacy key (owned_tools, skills, capabilities, temperature) is
// funnelled into request.body by the v1 normalizer.
const config = {
  agents: {
    implementer: {
      model: { providerID: "command-code", model: "deepseek/deepseek-v4.1-flash" },
    },
    explorer: {
      model: { providerID: "command-code", model: "deepseek/deepseek-v4.1-flash", variant: "low" },
      color: "#aabbcc",
      description: "Fast repository exploration and codebase analysis",
      mode: "subagent",
      hidden: false,
      steps: 12,
      request: {
        body: {
          temperature: 0.7,
          owned_tools: ["read", "bash"],
          skills: ["internet-research"],
          capabilities: ["exploring codebase"],
        },
      },
      permissions: [
        { action: "shell", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "read", resource: "src/*", effect: "allow" },
        { action: "read", resource: "*", effect: "deny" },
      ],
    },
    build: { disabled: true, mode: "primary" },
  },
}

describe("readAgents", () => {
  test("resolves the served model selection to the legacy string, including a model id with a slash", () => {
    const model = readAgents(config).implementer.model
    expect(model).toBe("command-code/deepseek/deepseek-v4.1-flash")
    expect(parseModel(model)).toEqual({ providerID: "command-code", modelID: "deepseek/deepseek-v4.1-flash" })
  })

  test("maps the ruleset onto the legacy per-tool permission map, renaming folded actions back", () => {
    expect(readAgents(config).explorer.permission).toEqual({
      bash: "allow",
      edit: "deny",
      task: "deny",
      read: { "src/*": "allow", "*": "deny" },
    })
  })

  test("reads the fields the normalizer keeps outside the legacy block", () => {
    expect(readAgents(config).explorer).toMatchObject({
      description: "Fast repository exploration and codebase analysis",
      mode: "subagent",
      hidden: false,
      steps: 12,
      variant: "low",
      color: "#aabbcc",
      temperature: 0.7,
      owned_tools: ["read", "bash"],
      skills: ["internet-research"],
      capabilities: ["exploring codebase"],
    })
  })

  test("maps `disabled` to the legacy tombstone key", () => {
    expect(readAgents(config).build).toEqual({ mode: "primary", disable: true })
  })

  test("a missing or malformed agents block reads as an empty map", () => {
    expect(readAgents({})).toEqual({})
    expect(readAgents(undefined)).toEqual({})
    expect(readAgents({ agents: null })).toEqual({})
    expect(readAgents({ agents: { broken: "nope" } })).toEqual({ broken: {} })
  })
})

// The write contract: the legacy `agent` key, one agent, and ONLY the keys the
// control changed. The read side cannot reconstruct prompt/variant/color, so a
// commit that restated the whole block would make the server erase them.
describe("agentPatch", () => {
  test("carries only the changed key under the legacy agent key", () => {
    const block = readAgents(config).explorer
    expect(block.model).toBe("command-code/deepseek/deepseek-v4.1-flash")
    expect(agentPatch("explorer", { steps: 99 })).toEqual({ agent: { explorer: { steps: 99 } } })
  })

  test("keeps the model as the legacy providerID/modelID string", () => {
    expect(agentPatch("implementer", { model: "command-code/deepseek/deepseek-v4.1-flash" })).toEqual({
      agent: { implementer: { model: "command-code/deepseek/deepseek-v4.1-flash" } },
    })
  })

  test("carries a permission edit as one field, leaving the rest of the block to the server merge", () => {
    const patch = agentPatch("explorer", { permission: { bash: "deny" } })
    expect(patch).toEqual({ agent: { explorer: { permission: { bash: "deny" } } } })
    expect(Object.keys(patch.agent.explorer)).toEqual(["permission"])
  })

  // The rename copies the RESOLVED block onto the new key (subagent.tsx), so the
  // read must expose every field the normalized info still carries.
  test("a rename carries description, mode, model variant, and color", () => {
    const from = readAgents(config).explorer
    const moved = { ...from, prompt: "Review the handoff." }
    const block = agentPatch("explorer-2", moved).agent["explorer-2"]
    expect(block).toMatchObject({
      description: "Fast repository exploration and codebase analysis",
      mode: "subagent",
      model: "command-code/deepseek/deepseek-v4.1-flash",
      variant: "low",
      color: "#aabbcc",
      prompt: "Review the handoff.",
    })
    // The variant travels as its own legacy key: a "#variant" suffix in `model` is
    // dropped by the v1 normalizer, which would erase the model entirely.
    expect(block.model).not.toContain("#")
    expect(parseModel(block.model)!.modelID).toBe("deepseek/deepseek-v4.1-flash")
  })

  // The Model row displays what `/api/agent` resolved; `normalizeAgentList` maps
  // the server's `{providerID, id}` onto this `{providerID, modelID}` shape.
  test("the display model comes from the runtime entry, not the config snapshot", () => {
    const runtime = {
      name: "implementer",
      mode: "subagent" as const,
      model: { providerID: "command-code", modelID: "deepseek/deepseek-v4.1-flash" },
    }

    expect(resolveDisplayModel(runtime.model, undefined)).toEqual({
      providerID: "command-code",
      modelID: "deepseek/deepseek-v4.1-flash",
    })
  })

  // An agent whose model lives only in `.md` frontmatter has no config block and
  // no snapshot model; the resolved runtime model still has to display.
  test("an md-frontmatter model displays even though the config snapshot lacks it", () => {
    const config = { agents: { implementer: { mode: "subagent" } } }
    expect(readAgents(config).implementer.model).toBeUndefined()
    expect(
      resolveDisplayModel(
        { providerID: "command-code", modelID: "deepseek/deepseek-v4.1-flash" },
        readAgents(config).implementer.model,
      ),
    ).toEqual({ providerID: "command-code", modelID: "deepseek/deepseek-v4.1-flash" })
  })

  test("falls back to the config model when the runtime entry has no model", () => {
    expect(resolveDisplayModel(undefined, "anthropic/claude-sonnet-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    // No runtime model and no config model is the "Default" state.
    expect(resolveDisplayModel(undefined, undefined)).toBeUndefined()
  })
})
