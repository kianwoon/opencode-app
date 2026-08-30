import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Effect, Exit } from "effect"
import { testEffect } from "../lib/effect"
import { WorkflowTool } from "../../src/tool/workflow"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Database } from "@opencode-ai/core/database/database"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const noWorkflows = testEffect(layer({ experimentalWorkflows: false }))

const ref = { providerID: "test", modelID: "test-model" } as const

describe("workflow tool", () => {
  it.instance(
    "execute emits a WorkflowPart with steps via promptOps",
    () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const chat = yield* session.create({ title: "wf-test" })

        const tool = yield* WorkflowTool
        const def = yield* tool.init()

        let emitted: { parts?: SessionV1.Part[] } | undefined
        const promptOps = {
          prompt: (input: { parts: SessionV1.Part[] }) => {
            emitted = input
            return Effect.succeed({} as SessionV1.WithParts)
          },
        }

        const result = yield* def.execute(
          {
            title: "release",
            steps: [
              { id: "build", prompt: "build it", description: "build", agent: "build", dependsOn: undefined },
              { id: "test", prompt: "test it", description: "test", agent: "build", dependsOn: ["build"] },
            ],
          },
          {
            sessionID: chat.id,
            messageID: MessageID.ascending(),
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.output).toContain('Workflow "release" started')
        const workflowPart = emitted?.parts?.find((p) => p.type === "workflow") as
          | SessionV1.WorkflowPartInput
          | undefined
        expect(workflowPart).toBeDefined()
        expect(workflowPart?.title).toBe("release")
        expect(workflowPart?.steps).toHaveLength(2)
        expect(workflowPart?.steps[0]?.id).toBe("build")
        expect(workflowPart?.steps[1]?.id).toBe("test")
        expect(workflowPart?.steps[1]?.dependsOn).toEqual(["build"])
      }),
    {
      config: {
        agent: {
          build: { mode: "primary" },
        },
      },
    },
  )

  it.instance(
    "workflow tool is registered by default",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const tools = yield* registry.tools({
          providerID: "test" as any,
          modelID: "test-model" as any,
          agent: build,
        })
        expect(tools.some((tool) => tool.id === "workflow")).toBe(true)
      }),
    {
      config: { agent: { build: { mode: "primary" } } },
    },
  )

  noWorkflows.instance(
    "workflow tool is not registered when explicitly disabled",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const tools = yield* registry.tools({
          providerID: "test" as any,
          modelID: "test-model" as any,
          agent: build,
        })
        expect(tools.some((tool) => tool.id === "workflow")).toBe(false)
      }),
    {
      config: { agent: { build: { mode: "primary" } } },
    },
  )

  it.instance(
    "execute rejects workflows exceeding the step cap with a correctable error",
    () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const chat = yield* session.create({ title: "wf-cap" })

        const tool = yield* WorkflowTool
        const def = yield* tool.init()

        const steps = Array.from({ length: 65 }, (_, i) => ({
          id: `s${i}`,
          prompt: "do it",
          description: "step",
          agent: "build",
          dependsOn: undefined,
        }))

        const exit = yield* def
          .execute(
            { title: "too-big", steps },
            {
              sessionID: chat.id,
              messageID: MessageID.ascending(),
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: { prompt: () => Effect.succeed({} as SessionV1.WithParts) } },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        // The tool fails with the shared admission error (Effect.orDie wraps
        // it as a defect) instead of admitting an oversized workflow.
        expect(Exit.isSuccess(exit)).toBe(false)
        if (Exit.isFailure(exit)) {
          const defect = Cause.squash(exit.cause)
          expect(defect instanceof Error ? defect.message : String(defect)).toContain("has 65 steps; the maximum is 64")
        }
      }),
    {
      config: {
        agent: {
          build: { mode: "primary" },
        },
      },
    },
  )

  it.instance(
    "execute rejects an unknown step agent with a correctable error",
    () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const chat = yield* session.create({ title: "wf-agent" })

        const tool = yield* WorkflowTool
        const def = yield* tool.init()

        let admitted = false
        const exit = yield* def
          .execute(
            {
              title: "typo",
              steps: [{ id: "build", prompt: "build it", description: "build", agent: "biuld" }],
            },
            {
              sessionID: chat.id,
              messageID: MessageID.ascending(),
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: {
                  prompt: () => {
                    admitted = true
                    return Effect.succeed({} as SessionV1.WithParts)
                  },
                },
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isSuccess(exit)).toBe(false)
        if (Exit.isFailure(exit)) {
          const defect = Cause.squash(exit.cause)
          expect(defect instanceof Error ? defect.message : String(defect)).toContain(
            'step "build" references unknown agent "biuld"',
          )
        }
        // Nothing was admitted — the model can correct the agent name and retry.
        expect(admitted).toBe(false)
      }),
    {
      config: {
        agent: {
          build: { mode: "primary" },
        },
      },
    },
  )
})
