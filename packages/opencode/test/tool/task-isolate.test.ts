import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, isolatedEnabled, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

// These exercise the real Tool + real CrossSpawnSpawner — no mocks. The isolation
// flag is read from process.env at call time, so each test toggles it directly and
// restores it afterwards. The fallback is provoked for real by pointing the child
// binary at a path that does not exist, which makes the real spawner fail exactly
// the way a missing/stripped install would.

const ENV_FLAG = "OPENCODE_SUBAGENT_ISOLATE"
const ENV_BIN = "OPENCODE_BIN_PATH"

const saved = { flag: process.env[ENV_FLAG], bin: process.env[ENV_BIN] }

afterEach(async () => {
  if (saved.flag === undefined) delete process.env[ENV_FLAG]
  else process.env[ENV_FLAG] = saved.flag
  if (saved.bin === undefined) delete process.env[ENV_BIN]
  else process.env[ENV_BIN] = saved.bin
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

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
  )

const it = testEffect(layer())

const seed = Effect.fn("TaskIsolateTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        const id = MessageID.ascending()
        return {
          info: {
            id,
            role: "assistant" as const,
            parentID: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            mode: input.agent ?? "general",
            agent: input.agent ?? "general",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: input.model?.modelID ?? ref.modelID,
            providerID: input.model?.providerID ?? ref.providerID,
            time: { created: Date.now() },
            finish: "stop",
          },
          parts: [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "text" as const,
              text: opts?.text ?? "done",
            },
          ],
        }
      }),
  }
}

function ctx(chatID: SessionID, messageID: MessageID, promptOps: TaskPromptOps) {
  return {
    sessionID: chatID,
    messageID,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.task isolation flag", () => {
  // The binary is resolved independently of the flag: isolation needs a child
  // built from the same source. The test points OPENCODE_BIN_PATH at a real-ish
  // path so the flag branch is what decides, not the binary gate.
  test("isolatedEnabled defaults ON and only opts out on explicit falsy values", () => {
    process.env[ENV_BIN] = "/tmp/opencode-isolate-present"
    delete process.env[ENV_FLAG]
    expect(isolatedEnabled()).toBe(true)

    process.env[ENV_FLAG] = ""
    expect(isolatedEnabled()).toBe(true)

    process.env[ENV_FLAG] = "1"
    expect(isolatedEnabled()).toBe(true)

    process.env[ENV_FLAG] = "true"
    expect(isolatedEnabled()).toBe(true)

    for (const off of ["0", "false", "off", "FALSE", " 0 "]) {
      process.env[ENV_FLAG] = off
      expect(isolatedEnabled()).toBe(false)
    }
  })

  test("isolation is disabled when no same-build child binary resolves", () => {
    delete process.env[ENV_FLAG]
    delete process.env[ENV_BIN]
    // In a bun test runtime execPath is bun, not opencode: no safe child binary,
    // so isolation must disable itself instead of spawning a mismatched CLI.
    expect(isolatedEnabled()).toBe(false)
  })
})

describe("tool.task isolation path", () => {
  it.instance("flag off runs the in-fiber path", () =>
    Effect.gen(function* () {
      process.env[ENV_FLAG] = "0"
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
        ctx(chat.id, assistant.id, stubOps({ text: "in-fiber", onPrompt: (input) => (seen = input) })),
      )

      expect(seen?.sessionID).toBe(result.metadata.sessionId)
      expect(result.output).toContain("in-fiber")
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
  )

  it.instance("flag on with an unavailable child binary falls back without throwing", () =>
    Effect.gen(function* () {
      process.env[ENV_FLAG] = "1"
      process.env[ENV_BIN] = "/nonexistent/opencode-isolate-test-binary"
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
        ctx(chat.id, assistant.id, stubOps({ text: "fell-back", onPrompt: (input) => (seen = input) })),
      )

      expect(seen?.sessionID).toBe(result.metadata.sessionId)
      expect(result.output).toContain("fell-back")
    }),
  )

  it.instance("flag on still derives child session permissions before isolation", () =>
    Effect.gen(function* () {
      process.env[ENV_FLAG] = "1"
      process.env[ENV_BIN] = "/nonexistent/opencode-isolate-test-binary"
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "reviewer" },
        ctx(chat.id, assistant.id, stubOps()),
      )

      const child = yield* sessions.get(result.metadata.sessionId as SessionID)
      expect(child.parentID).toBe(chat.id)
      expect(child.agent).toBe("reviewer")
      expect(child.permission).toEqual([
        { permission: "todowrite", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "read", pattern: "*", action: "deny" },
      ])
    }),
    {
      config: {
        agent: {
          reviewer: { mode: "subagent", permission: { task: "allow" } },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )
})
