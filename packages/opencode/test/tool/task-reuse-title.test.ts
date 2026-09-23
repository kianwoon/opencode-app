import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Duration, Effect, Exit, Fiber } from "effect"
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

  it.instance("rejects a task_id outside the current parent lineage", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const outsideParent = yield* sessions.create({ title: "outside parent" })
      const outside = yield* sessions.create({
        parentID: outsideParent.id,
        title: "outside task",
        agent: "explore",
      })
      const prompts: SessionPrompt.PromptInput[] = []
      const baseOps = stubOps()
      const promptOps: TaskPromptOps = {
        ...baseOps,
        prompt: (input) => {
          prompts.push(input)
          return baseOps.prompt(input)
        },
      }
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* Effect.exit(
        def.execute(
          { description: "outside", prompt: "must not run", subagent_type: "explore", task_id: outside.id },
          ctxWith(chat, assistant, promptOps, []),
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.prettyErrors(exit.cause).map(String).join("\n")).toContain("not a descendant")
      }
      expect(prompts).toHaveLength(0)
      expect((yield* sessions.get(outside.id)).title).toBe("outside task")
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("reuses a valid descendant task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const first = yield* def.execute(
        { description: "first", prompt: "first prompt", subagent_type: "explore" },
        ctxWith(chat, assistant, stubOps("first"), []),
      )
      const childID = SessionID.make(first.metadata.sessionId)
      const child = yield* sessions.get(childID)
      expect(child.parentID).toBe(chat.id)

      const second = yield* def.execute(
        { description: "continue", prompt: "continue prompt", subagent_type: "explore", task_id: childID },
        ctxWith(chat, assistant, stubOps("continued"), []),
      )

      expect(second.metadata.sessionId).toBe(first.metadata.sessionId)
      expect(second.output).toContain("continued")
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
  )

  it.instance("keeps the adopted lease while isolated fallback starts", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = yield* def.execute(
        { description: "isolation seed", prompt: "seed prompt", subagent_type: "explore" },
        ctxWith(chat, assistant, stubOps(), []),
      )
      const childID = SessionID.make(first.metadata.sessionId)
      const previousIsolate = process.env["OPENCODE_SUBAGENT_ISOLATE"]
      const previousBinary = process.env["OPENCODE_BIN_PATH"]
      process.env["OPENCODE_SUBAGENT_ISOLATE"] = "1"
      process.env["OPENCODE_BIN_PATH"] = "/usr/bin/false"

      yield* Effect.gen(function* () {
        const baseOps = stubOps()
        let fallbackStarted = false
        let concurrentStarted = false
        let allowFallback = false
        const fallbackOps: TaskPromptOps = {
          ...baseOps,
          prompt: (input) =>
            Effect.gen(function* () {
              fallbackStarted = true
              while (!allowFallback) yield* Effect.sleep(Duration.millis(1))
              return yield* baseOps.prompt(input)
            }),
        }
        const concurrentOps: TaskPromptOps = {
          ...baseOps,
          prompt: (input) =>
            Effect.gen(function* () {
              concurrentStarted = true
              return yield* baseOps.prompt(input)
            }),
        }

        const fallback = yield* Effect.forkScoped(
          def.execute(
            { description: "fallback", prompt: "fallback prompt", subagent_type: "explore" },
            ctxWith(chat, assistant, fallbackOps, []),
          ),
        )
        while (!fallbackStarted) yield* Effect.sleep(Duration.millis(1))
        const concurrentFiber = yield* Effect.forkScoped(
          def.execute(
            { description: "concurrent", prompt: "concurrent prompt", subagent_type: "explore" },
            ctxWith(chat, assistant, concurrentOps, []),
          ),
        )
        while (!concurrentStarted) yield* Effect.sleep(Duration.millis(1))
        allowFallback = true
        const [reused, concurrent] = yield* Effect.all(
          [Fiber.join(fallback), Fiber.join(concurrentFiber)],
          { concurrency: 2 },
        )

        expect(reused.metadata.sessionId).toBe(childID)
        expect(concurrent.metadata.sessionId).not.toBe(childID)
        expect(yield* sessions.children(chat.id)).toHaveLength(2)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousIsolate === undefined) delete process.env["OPENCODE_SUBAGENT_ISOLATE"]
            else process.env["OPENCODE_SUBAGENT_ISOLATE"] = previousIsolate
            if (previousBinary === undefined) delete process.env["OPENCODE_BIN_PATH"]
            else process.env["OPENCODE_BIN_PATH"] = previousBinary
          }),
        ),
      )
    }),
  )

  it.instance("releases the adopted lease when promptOps is missing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const first = yield* def.execute(
        { description: "lease one", prompt: "lease prompt", subagent_type: "explore" },
        ctxWith(chat, assistant, stubOps(), []),
      )
      const noPromptContext = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        messages: [{ info: assistant, parts: [] }],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const exit = yield* Effect.exit(
        def.execute(
          { description: "lease two", prompt: "must not prompt", subagent_type: "explore" },
          noPromptContext,
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.prettyErrors(exit.cause).map(String).join("\n")).toContain("promptOps")
      }

      const second = yield* def.execute(
        { description: "lease three", prompt: "reuse prompt", subagent_type: "explore" },
        ctxWith(chat, assistant, stubOps(), []),
      )
      expect(second.metadata.sessionId).toBe(first.metadata.sessionId)
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
  )
})
