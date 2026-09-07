import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"
import PROMPT_META from "./prompt/meta.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("muse")) {
    const name = model.api.id.includes("muse-glimmer") ? "Muse Glimmer" : "Muse Spark"
    return [PROMPT_META.replaceAll("{{MODEL_NAME}}", name)]
  }
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (
    model.api.id.toLowerCase().includes("kimi") ||
    ["kimi-for-coding", "moonshotai", "moonshotai-cn"].includes(model.providerID)
  )
    return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly environmentDate: () => Effect.Effect<string>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
  readonly workflow: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly rules: (paths: string[]) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap.Service
    const flags = yield* RuntimeFlags.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `</env>`,
            // Early salience pointer: the skills list sits far below after all
            // instruction files; this stable one-liner keeps it discoverable
            // without moving the list itself (which would hurt prompt cache).
            `Note: available skills are listed near the end of this system prompt; load one with the skill tool when a task matches.`,
          ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
        ].filter((part): part is string => part !== undefined)
      }),

      // Volatile date anchor, rendered as the LAST system entry so a midnight
      // rollover only re-misses the short trailing tail instead of the entire
      // stable prompt prefix (which must stay byte-identical across turns for
      // implicit provider prefix caching to hit).
      environmentDate: Effect.fn("SystemPrompt.environmentDate")(function* () {
        return `Today's date: ${new Date().toDateString()}`
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
          "Before starting a multi-step task, scan the skills above: if a task matches a skill description, load it with the skill tool before improvising.",
        ].join("\n")
      }),

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "<mcp_instructions>",
          ...instructions.flatMap((item) => [
            `  <server name="${item.name}">`,
            ...item.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]),
          "</mcp_instructions>",
        ].join("\n")
      }),

      workflow: Effect.fn("SystemPrompt.workflow")(function* (agent: Agent.Info) {
        if (!flags.experimentalWorkflows) return
        if (Permission.disabled(["workflow"], agent.permission).has("workflow")) return
        return [
          "## Workflow guidance",
          "Assess EVERY user request before acting: does it decompose into multiple",
          "distinct phases, dependencies, or steps that could run in parallel?",
          "If YES — plan first, then orchestrate:",
          "1. PLAN: identify the distinct steps, their agent types, and their",
          "   dependency edges. For multi-file or multi-phase work, briefly lay out",
          "   the plan (steps + dependencies) before executing anything.",
          "2. ORCHESTRATE: declare the plan as one workflow tool call. Each step is",
          "   a subagent task with its dependsOn; the engine runs independent steps",
          "   concurrently, skips dependents of failed steps, and reports per-step",
          "   statuses (with failure reasons) back to you in the summary.",
          "3. REACT: read the workflow summary. If steps failed, decide whether to",
          "   re-plan a corrective workflow or handle the fallout yourself.",
          "You decide the steps and their dependencies yourself — the user should not",
          "need to specify a pipeline. Recognize pipeline-shaped goals automatically:",
          "build-then-test-then-deploy, lint+test in parallel before release, data",
          "pipeline stages, multi-repo changes, etc.",
          "If NO — the request is simple, single-step, or sequential by nature: do not",
          "use the workflow tool, use regular tools or the task tool directly.",
        ].join("\n")
      }),

      // Strict rule-enforcement anchor, rendered as the LAST system entry every
      // step. Rules listed only at the top of a long system prompt lose
      // attention over a session; the recency position keeps them binding.
      // Content is stable across steps (only the file list), preserving
      // provider prompt-cache hits on the rest of the prefix.
      rules: Effect.fn("SystemPrompt.rules")(function* (paths: string[]) {
        if (paths.length === 0) return
        return [
          "<rule_enforcement>",
          "The instruction files listed in this system prompt are BINDING RULES that apply to every action you take in this session.",
          "Obey every rule they contain, with NO exceptions, regardless of task complexity, time pressure, or model capability.",
          "Every project inherits the global rules, and global rules ALWAYS outrank project-level rules on conflict; project rules add constraints on top and may only be stricter, never more permissive.",
          "Rules you must not skip: read the relevant AGENTS.md guidance before working in an unfamiliar area; follow stated style, naming, testing, and verification requirements; honor permission, safety, and scope constraints.",
          "Before you finish a turn, check your work against these rules. If you cannot satisfy a rule, say so explicitly instead of silently deviating.",
          `Rule files in effect (${paths.length}):`,
          ...paths.map((p) => `  - ${p}`),
          "</rule_enforcement>",
        ].join("\n")
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Skill.node, MCP.node, locationServiceMapNode, RuntimeFlags.node],
})

export * as SystemPrompt from "./system"
