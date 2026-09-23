import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit } from "effect"
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
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

process.env.OPENCODE_SUBAGENT_ISOLATE = "0"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

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

const seed = Effect.fn("TaskLatchTest.seed")(function* (title = "Latch") {
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
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
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
            role: "assistant",
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
              type: "text",
              text: opts?.text ?? "done",
            },
          ],
        } satisfies SessionV1.WithParts
      }),
  }
}

const args = {
  description: "inspect bug",
  prompt: "look into the cache key path",
  subagent_type: "general",
}

const ctxWith = (
  chat: { id: SessionID },
  assistant: SessionV1.Assistant,
  promptOps: TaskPromptOps,
  parts: Array<SessionV1.ToolPart>,
) => ({
  sessionID: chat.id,
  messageID: assistant.id,
  agent: "build",
  abort: new AbortController().signal,
  extra: { promptOps },
  messages: [{ info: assistant, parts }],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const completedPart = (sessionID: SessionID, messageID: MessageID) => ({
  id: PartID.ascending(),
  sessionID,
  messageID,
  callID: "prev1",
  type: "tool" as const,
  tool: "task",
  state: {
    status: "completed" as const,
    input: { description: args.description, prompt: args.prompt, subagent_type: args.subagent_type },
    output: "green result text",
    title: args.description,
    metadata: {},
    time: { start: Date.now() - 1000, end: Date.now() },
  },
})

const errorPart = (sessionID: SessionID, messageID: MessageID) => ({
  id: PartID.ascending(),
  sessionID,
  messageID,
  callID: "prev-err",
  type: "tool" as const,
  tool: "task",
  state: {
    status: "error" as const,
    input: { description: args.description, prompt: args.prompt, subagent_type: args.subagent_type },
    error: "boom",
    time: { start: Date.now() - 1000, end: Date.now() },
  },
})

describe("tool.task success latch", () => {
  it.instance("refuses an identical completed task", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* Effect.exit(def.execute(args, ctxWith(chat, assistant, stubOps(), [completedPart(chat.id, assistant.id)])))
      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(message).toContain("already completed")
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("force bypasses the latch", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { ...args, force: true },
        ctxWith(chat, assistant, stubOps(), [completedPart(chat.id, assistant.id)]),
      )

      expect(result.metadata.sessionId).toBeDefined()
    }),
  )

  it.instance("task_id resume bypasses the latch", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { ...args, task_id: "ses_latch_resume" },
        ctxWith(chat, assistant, stubOps(), [completedPart(chat.id, assistant.id)]),
      )

      expect(result.metadata.sessionId).toBeDefined()
    }),
  )

  it.instance("a failed identical task does not trigger the latch", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(args, ctxWith(chat, assistant, stubOps(), [errorPart(chat.id, assistant.id)]))

      expect(result.metadata.sessionId).toBeDefined()
    }),
  )

  it.instance("a different prompt proceeds", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const other = completedPart(chat.id, assistant.id)
      const varied = { ...other, state: { ...other.state, input: { ...other.state.input, prompt: "other" } } }
      const result = yield* def.execute(args, ctxWith(chat, assistant, stubOps(), [varied]))

      expect(result.metadata.sessionId).toBeDefined()
    }),
  )
})
