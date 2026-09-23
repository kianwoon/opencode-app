import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Duration, Effect } from "effect"
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

const seed = Effect.fn("TaskReuseTitleTest.seed")(function* (title = "ReuseTitle") {
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

// delayMs keeps the stubbed run alive across the await point so two concurrent
// tasks overlap the way a real (long-lived) LLM turn does.
function stubOps(text = "done", delayMs = 0): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        if (delayMs > 0) yield* Effect.sleep(Duration.millis(delayMs))
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
              text,
            },
          ],
        } satisfies SessionV1.WithParts
      }),
  }
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

describe("tool.task reuse title and claim", () => {
  it.instance("adoption re-titles the reused session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const first = yield* def.execute(
        { description: "explore one", prompt: "prompt one", subagent_type: "explore" },
        ctxWith(chat, assistant, stubOps(), []),
      )
      const second = yield* def.execute(
        { description: "explore two", prompt: "prompt two", subagent_type: "explore" },
        ctxWith(chat, assistant, stubOps(), []),
      )

      expect(second.metadata.sessionId).toBe(first.metadata.sessionId)
      const adopted = yield* sessions.get(SessionID.make(second.metadata.sessionId))
      expect(adopted.title).toBe("explore two (@explore subagent)")
    }),
  )

  it.instance("concurrent same-agent tasks never share a session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const seeded = yield* def.execute(
        { description: "seed general", prompt: "seed prompt", subagent_type: "general" },
        ctxWith(chat, assistant, stubOps(), []),
      )

      const [a, b] = yield* Effect.all(
        [
          def.execute(
            { description: "general a", prompt: "prompt a", subagent_type: "general" },
            ctxWith(chat, assistant, stubOps("done", 50), []),
          ),
          def.execute(
            { description: "general b", prompt: "prompt b", subagent_type: "general" },
            ctxWith(chat, assistant, stubOps("done", 50), []),
          ),
        ],
        { concurrency: 2 },
      )

      expect(a.metadata.sessionId).not.toBe(b.metadata.sessionId)
      // Exactly one adopted the seeded child (no new session); the other created a fresh one.
      expect([a.metadata.sessionId, b.metadata.sessionId]).toContain(seeded.metadata.sessionId)
      expect(yield* sessions.children(chat.id)).toHaveLength(2)
    }),
  )
})
