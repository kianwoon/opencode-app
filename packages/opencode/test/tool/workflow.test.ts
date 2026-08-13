import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
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

const layer = () =>
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
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  )

const it = testEffect(layer())

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
})
