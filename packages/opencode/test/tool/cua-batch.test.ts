import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "path"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { CuaBatchTool, Parameters } from "@/tool/cua-batch"
import { MessageID, SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

// The test env configures no MCP servers, so the real MCP.Service has no
// cua-driver tools and the tool must degrade to the not-connected notice.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([MCP.node, Truncate.node, Agent.node, InstanceStore.node]),
    [
      [
        Config.node,
        TestConfig.layer({
          directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
        }),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
    ],
  ),
)

const toolContext = (): Tool.Context => ({
  sessionID: SessionID.create(),
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("cua_batch parameters", () => {
  test("decodes a mixed action script", () => {
    const decoded = Schema.decodeUnknownOption(Parameters)({
      actions: [
        { use: "click", pid: 4242, x: 10, y: 20, button: "left" },
        { use: "type_text", pid: 4242, text: "hello" },
        { use: "press_key", pid: 4242, key: "return" },
        { use: "wait", ms: 250 },
      ],
    })

    expect(decoded._tag).toBe("Some")
    if (decoded._tag !== "Some") return
    expect(decoded.value.actions.length).toBe(4)
    expect(decoded.value.actions[3]).toEqual({ use: "wait", ms: 250 })
  })

  test("rejects an unknown use value", () => {
    const decoded = Schema.decodeUnknownOption(Parameters)({
      actions: [{ use: "teleport", x: 1, y: 2 }],
    })

    expect(decoded._tag).toBe("None")
  })

  test("rejects a missing required actuator field", () => {
    const decoded = Schema.decodeUnknownOption(Parameters)({
      actions: [{ use: "press_key", pid: 1 }],
    })

    expect(decoded._tag).toBe("None")
  })
})

describe("cua_batch tool", () => {
  it.instance("reports a graceful not-connected result when cua-driver is absent", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* CuaBatchTool)
      expect(tool.id).toBe("cua_batch")

      const result = yield* tool.execute({ actions: [{ use: "wait", ms: 1 }] }, toolContext())

      expect(result.title).toBe("cua_batch (unavailable)")
      expect(result.output).toBe("cua-driver MCP server is not connected")
    }),
  )
})
