import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Task } from "@opencode-ai/core/task"
import { Context, Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionPrompt } from "@/session/prompt"
import { DecodeError } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { TaskScheduler } from "@/task/scheduler"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageID, PartID } from "@/session/schema"

afterEach(async () => {
  await disposeAllInstances()
})

const directory = AbsolutePath.make("/tmp")

// Module-level mutable state shared between the prompt stub and the test
// assertion helpers. Reset per test via resetPromptState().
const promptState = {
  seen: [] as SessionPrompt.PromptInput[],
  failure: undefined as string | undefined,
  busy: new Set<string>(),
}

const resetPromptState = () => {
  promptState.seen = []
  promptState.failure = undefined
  promptState.busy.clear()
}

const reply = (input: SessionPrompt.PromptInput): SessionV1.WithParts => {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text: "done",
      },
    ],
  }
}

const promptStubLayer = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    cancel: () => Effect.void,
    prompt: (input) =>
      Effect.gen(function* () {
        if (promptState.busy.has(input.sessionID)) return yield* Effect.die(new Error("prompted a busy session"))
        promptState.seen.push(input)
        if (promptState.failure) {
          const message = promptState.failure
          promptState.failure = undefined
          return yield* Effect.fail(new DecodeError())
        }
        return reply(input)
      }),
    loop: () => Effect.die(new Error("not implemented in test")),
    shell: () => Effect.die(new Error("not implemented in test")),
    command: () => Effect.die(new Error("not implemented in test")),
    resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
  }),
)

const layerFor = () =>
  LayerNode.compile(
    LayerNode.group([Database.node, Task.node, Session.node, SessionStatus.node, InstanceStore.node, TaskScheduler.node]),
    [
      [SessionPrompt.node, promptStubLayer],
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  )

const it = testEffect(layerFor())

// The prompt fiber finishes asynchronously; poll until a run row settles.
const pollSettledRun = (taskID: Task.ID, expected: number) =>
  Effect.gen(function* () {
    const tasks = yield* Task.Service
    for (let i = 0; i < 150; i++) {
      const runs = yield* tasks.runs(taskID, 10)
      const settled = runs.filter((run) => run.status !== "running")
      if (settled.length >= expected) return runs
      yield* Effect.sleep("20 millis")
    }
    return yield* tasks.runs(taskID, 10)
  })

describe("task scheduler", () => {
  // it.live: fired prompts run in forked fibers and assertions poll with real
  // sleeps while run rows settle; TestClock would never advance those.
  it.live("tick claims due task, binds a lazily created session, and prompts it", () =>
    Effect.gen(function* () {
      resetPromptState()
      const tasks = yield* Task.Service
      const scheduler = yield* TaskScheduler.Service

      const task = yield* tasks.create({ title: "Sweep", prompt: { text: "say hi" }, cron: "minutely", directory })
      // Creation leaves the task unarmed; the first tick arms it.
      yield* scheduler.tick()
      const armed = yield* tasks.get(task.id)
      expect(armed?.next_run_at).toBeDefined()
      expect(armed?.sessionID).toBeUndefined()

      // Force the task due and fire it. The prompt runs in a forked fiber; wait
      // for the run row to settle before asserting on prompt state.
      yield* tasks.reschedule(task.id, Date.now() - 1, Date.now())
      yield* scheduler.tick()

      const runs = yield* pollSettledRun(task.id, 1)

      expect(promptState.seen.length).toBe(1)
      expect(promptState.seen[0]?.parts[0]).toEqual({ type: "text", text: "say hi" })

      const fired = yield* tasks.get(task.id)
      const boundSessionID = fired?.sessionID
      expect(boundSessionID).toBeDefined()
      expect(fired?.run_count).toBe(1)
      expect(fired?.next_run_at).toBeGreaterThan(Date.now())

      expect(runs[0]?.taskID).toBe(task.id)
      expect(String(runs[0]?.sessionID)).toBe(String(boundSessionID))
      expect(runs[0]?.status).toBe("completed")
    }),
  )

  it.live("reuses the bound session on the next fire", () =>
    Effect.gen(function* () {
      resetPromptState()
      const tasks = yield* Task.Service
      const scheduler = yield* TaskScheduler.Service

      const task = yield* tasks.create({ title: "Loop", prompt: { text: "again" }, cron: "minutely", directory })
      yield* scheduler.tick()
      yield* tasks.reschedule(task.id, Date.now() - 1, Date.now())
      yield* scheduler.tick()
      yield* pollSettledRun(task.id, 1)
      yield* tasks.reschedule(task.id, Date.now() - 1, Date.now())
      yield* scheduler.tick()
      yield* pollSettledRun(task.id, 2)

      expect(promptState.seen.length).toBe(2)
      expect(promptState.seen[0]?.sessionID).toBe(promptState.seen[1]?.sessionID)

      const runs = yield* pollSettledRun(task.id, 2)
      expect(runs.length).toBe(2)
    }),
  )

  it.live("skips busy sessions without consuming a run", () =>
    Effect.gen(function* () {
      resetPromptState()
      const tasks = yield* Task.Service
      const scheduler = yield* TaskScheduler.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const instances = yield* InstanceStore.Service

      const session = yield* instances.provide({ directory }, sessions.create({ title: "Bound" }))
      yield* instances.provide({ directory }, status.set(session.id, { type: "busy" }))
      const task = yield* tasks.create({
        title: "Busy",
        prompt: { text: "hi" },
        cron: "minutely",
        directory,
        sessionID: session.id,
      })

      yield* scheduler.tick()
      yield* tasks.reschedule(task.id, Date.now() - 1, Date.now())
      yield* scheduler.tick()

      expect(promptState.seen.length).toBe(0)

      const skipped = yield* tasks.get(task.id)
      expect(skipped?.missed_runs).toBe(1)
      expect(skipped?.run_count).toBe(0)
      expect(skipped?.next_run_at).toBeGreaterThan(Date.now())
      expect((yield* tasks.runs(task.id, 10)).length).toBe(0)
    }),
  )

  it.live("run failures are recorded on the run row and the task still re-arms", () =>
    Effect.gen(function* () {
      resetPromptState()
      const tasks = yield* Task.Service
      const scheduler = yield* TaskScheduler.Service

      const task = yield* tasks.create({ title: "Fails", prompt: { text: "boom" }, cron: "minutely", directory })
      yield* scheduler.tick()
      promptState.failure = "model exploded"
      yield* tasks.reschedule(task.id, Date.now() - 1, Date.now())
      yield* scheduler.tick()
      yield* pollSettledRun(task.id, 1)

      expect(promptState.seen.length).toBe(1)

      const runs = yield* pollSettledRun(task.id, 1)
      expect(runs[0]?.status).toBe("failed")
      expect(runs[0]?.error).toBeTruthy()

      const rearmed = yield* tasks.get(task.id)
      expect(rearmed?.next_run_at).toBeGreaterThan(Date.now())
    }),
  )
})
