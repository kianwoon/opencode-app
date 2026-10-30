import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode/schema/v1/session"
import { WithParts } from "@/compat/schema/session-v1"
import { Database } from "@opencode/core/database/database"
import { LayerNode } from "@opencode/core/effect/layer-node"
import { SessionProjector } from "@opencode/core/session/projector"
import { Cause, Effect, Exit } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { Ripgrep } from "@opencode/core/ripgrep"
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
import { Provider } from "@opencode/core/provider"
import { Model } from "@opencode/core/model"

process.env.OPENCODE_SUBAGENT_ISOLATE = "0"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: Provider.ID.make("test"),
  modelID: Model.ID.make("test-model"),
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

const seed = Effect.fn("TaskLatchPersistedTest.seed")(function* (title = "PersistedLatch") {
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
  // A SECOND assistant message stands in for the later turn that re-fires the
  // task. The earlier parts must hang off `assistant`, never off
  // `ctx.messageID`, or the per-turn parallel cap (which reads the live parts of
  // the CURRENT message) would refuse for the wrong reason and mask the guard
  // under test.
  const later: SessionV1.Assistant = { ...assistant, id: MessageID.ascending(), time: { created: Date.now() + 1 } }
  yield* session.updateMessage(later)
  return { chat, assistant, later }
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
        } satisfies WithParts
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
  callID: "persisted1",
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
  callID: "persisted-err",
  type: "tool" as const,
  tool: "task",
  state: {
    status: "error" as const,
    input: { description: args.description, prompt: args.prompt, subagent_type: args.subagent_type },
    error: "boom",
    time: { start: Date.now() - 1000, end: Date.now() },
  },
})

// The identical-task guards must read the DURABLE part rows, not the per-step
// ctx.messages view: that array is snapshotted before the current assistant
// message exists and is the object plugins mutate, so a completed part earlier
// in the same session is invisible to it and the re-fire slips into the reuse
// path instead of being refused.
describe("tool.task latch backed by persisted parts", () => {
  it.instance("refuses an identical completed task that is absent from ctx.messages", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant, later } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      // Real persistence: a part row must exist for the guard to find.
      const persisted = completedPart(chat.id, assistant.id)
      yield* sessions.updatePart(persisted)
      expect(
        yield* sessions.getPart({ sessionID: chat.id, messageID: assistant.id, partID: persisted.id }),
      ).toBeDefined()

      const exit = yield* Effect.exit(
        def.execute(args, ctxWith(chat, later, stubOps(), [])),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(message).toContain("already completed")
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("counts persisted failed attempts toward the retry storm bound", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant, later } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      for (let i = 0; i < 5; i++) {
        const part = errorPart(chat.id, assistant.id)
        yield* sessions.updatePart({ ...part, id: PartID.ascending(), callID: `persisted-err-${i}` })
      }

      const exit = yield* Effect.exit(def.execute(args, ctxWith(chat, later, stubOps(), [])))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("Terminal")
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("force:true still bypasses the persisted latch", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant, later } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      yield* sessions.updatePart(completedPart(chat.id, assistant.id))

      const result = yield* def.execute({ ...args, force: true }, ctxWith(chat, later, stubOps(), []))
      expect(result.metadata.sessionId).toBeDefined()
    }),
  )

  it.instance("task_id resume still bypasses the persisted latch", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant, later } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const resumed = yield* sessions.create({ parentID: chat.id, title: "resumed" })

      yield* sessions.updatePart(completedPart(chat.id, assistant.id))

      const result = yield* def.execute(
        { ...args, task_id: resumed.id },
        ctxWith(chat, later, stubOps(), []),
      )
      expect(result.metadata.sessionId).toBeDefined()
    }),
  )

  it.instance("a different prompt against persisted history proceeds", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant, later } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const other = completedPart(chat.id, assistant.id)
      yield* sessions.updatePart({ ...other, state: { ...other.state, input: { ...other.state.input, prompt: "other" } } })

      const result = yield* def.execute(args, ctxWith(chat, later, stubOps(), []))
      expect(result.metadata.sessionId).toBeDefined()
    }),
  )
})
