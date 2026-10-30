import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode/schema/v1/session"
import { WithParts } from "@/compat/schema/session-v1"
import { Database } from "@opencode/core/database/database"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { SessionProjector } from "@opencode/core/session/projector"
import { Deferred, Duration, Effect, Fiber } from "effect"
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
import { pollWithTimeout, testEffect } from "../lib/effect"
import { Provider } from "@opencode/core/provider"
import { Model } from "@opencode/core/model"

// Two task calls in ONE assistant message run concurrently against the same
// parent's children list, so a just-created sibling is adoptable. The subagent
// is a real promptOps seam (the seam every task test drives), held in flight
// with a real delay so the overlap is genuine rather than scheduled.
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

const seed = Effect.fn("TaskFanoutTest.seed")(function* (title = "Fanout") {
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

// The stub echoes the prompt marker it was handed and, for child sessions only,
// stays busy for `delayMs` so a concurrent call really finds a live subagent.
function stubOps(input: { log: SessionPrompt.PromptInput[]; parent: SessionID; delayMs: number }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (req) =>
      Effect.gen(function* () {
        input.log.push(req)
        const marker = req.parts.find((part) => part.type === "text")?.text ?? ""
        if (req.sessionID !== input.parent) yield* Effect.sleep(Duration.millis(input.delayMs))
        const id = MessageID.ascending()
        return {
          info: {
            id,
            role: "assistant",
            parentID: req.messageID ?? MessageID.ascending(),
            sessionID: req.sessionID,
            mode: req.agent ?? "general",
            agent: req.agent ?? "general",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: req.model?.modelID ?? ref.modelID,
            providerID: req.model?.providerID ?? ref.providerID,
            time: { created: Date.now() },
            finish: "stop",
          },
          parts: [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: req.sessionID,
              type: "text",
              text: `RESULT:${marker}`,
            },
          ],
        } satisfies WithParts
      }),
  }
}

const ctxFor = (
  chat: { id: SessionID },
  assistant: { id: MessageID },
  promptOps: TaskPromptOps,
  metadata?: () => Effect.Effect<void>,
) => ({
  sessionID: chat.id,
  messageID: assistant.id,
  agent: "build",
  abort: new AbortController().signal,
  extra: { promptOps },
  messages: [],
  metadata: metadata ?? (() => Effect.void),
  ask: () => Effect.void,
})

const taskID = (output: string) => /<task id="([^"]+)"/.exec(output)?.[1]

const injectedText = (req: SessionPrompt.PromptInput) =>
  req.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")

describe("tool.task parallel fan-out", () => {
  it.instance("two concurrent same-agent tasks never share a child session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const gate = yield* Deferred.make<void>()
      const created = yield* Deferred.make<void>()
      const log: SessionPrompt.PromptInput[] = []
      const ops = stubOps({ log, parent: chat.id, delayMs: 200 })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      // ctx.metadata fires AFTER the child is created and BEFORE the job is
      // registered — parking there reproduces the exact window in which the
      // sibling's reuse scan cannot see the first call's live child.
      const first = yield* Effect.forkScoped(
        def.execute(
          { description: "fan out one", prompt: "MARKER-ONE", subagent_type: "general" },
          ctxFor(chat, assistant, ops, () => Deferred.succeed(created, void 0).pipe(Effect.andThen(Deferred.await(gate)))),
        ),
      )
      yield* Deferred.await(created)

      const second = yield* Effect.forkScoped(
        def.execute({ description: "fan out two", prompt: "MARKER-TWO", subagent_type: "general" }, ctxFor(chat, assistant, ops)),
      )
      // The sibling's whole scan+dispatch must complete while the first call is
      // still parked, so the gate opens only afterwards.
      const two = yield* Fiber.join(second)
      yield* Deferred.succeed(gate, void 0)
      const one = yield* Fiber.join(first)

      expect(one.metadata.sessionId).not.toBe(two.metadata.sessionId)
      expect(taskID(one.output)).toBe(one.metadata.sessionId)
      expect(taskID(two.output)).toBe(two.metadata.sessionId)
      expect(one.output).toContain("RESULT:MARKER-ONE")
      expect(one.output).not.toContain("RESULT:MARKER-TWO")
      expect(two.output).toContain("RESULT:MARKER-TWO")
      expect(two.output).not.toContain("RESULT:MARKER-ONE")
      expect(one.output).not.toContain("still working in the background")
      expect(two.output).not.toContain("still working in the background")
      expect(yield* sessions.children(chat.id)).toHaveLength(2)
    }),
  )

  it.instance("the extend stub keeps its promise: the queued result is injected", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const log: SessionPrompt.PromptInput[] = []
      const ops = stubOps({ log, parent: chat.id, delayMs: 200 })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const first = yield* Effect.forkScoped(
        def.execute({ description: "queued one", prompt: "MARKER-ONE", subagent_type: "general" }, ctxFor(chat, assistant, ops)),
      )
      const child = yield* pollWithTimeout(
        Effect.sync(() => log.find((req) => req.sessionID !== chat.id)?.sessionID),
        "the first subagent never started",
      )

      const queued = yield* def.execute(
        { description: "queued two", prompt: "MARKER-TWO", subagent_type: "general", task_id: child },
        ctxFor(chat, assistant, ops),
      )
      expect(queued.output).toContain("still working in the background")

      // The stub promises delivery; only the LAST settled run's output may ride
      // the notification, i.e. the queued one, never the first run's.
      const injected = yield* pollWithTimeout(
        Effect.sync(() => log.filter((req) => req.sessionID === chat.id).at(-1)),
        "the queued task result was never injected into the parent session",
      )
      const text = injectedText(injected)
      expect(text).toContain("RESULT:MARKER-TWO")
      expect(text).not.toContain("RESULT:MARKER-ONE")
      yield* Fiber.join(first)
    }),
  )
})
