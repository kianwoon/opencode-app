import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
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
import {
  HAND_REUSE_MAX_TOKENS,
  HAND_REUSE_TTL_MS,
  TaskTool,
  type TaskPromptOps,
} from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

// In-fiber task lifecycle (stub prompt ops), not the child-process isolation
// path, which is default-ON. Opt out so foreground tasks stay in-fiber.
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

const seed = Effect.fn("TaskReuseTest.seed")(function* (title = "Pinned") {
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

const touchRow = (id: SessionID, values: Partial<typeof SessionTable.$inferInsert>) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set(values).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)
  })

const args = {
  description: "inspect bug",
  prompt: "look into the cache key path",
  subagent_type: "general",
}

const ctxFor = (
  chat: { id: SessionID },
  assistant: { id: MessageID },
  promptOps: TaskPromptOps,
  extra?: Record<string, unknown>,
) => ({
  sessionID: chat.id,
  messageID: assistant.id,
  agent: "build",
  abort: new AbortController().signal,
  extra: { promptOps, ...extra },
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("tool.task auto-resume", () => {
  it.instance("reuses the newest qualifying same-agent child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const older = yield* sessions.create({ parentID: chat.id, title: "older", agent: "general" })
      const newer = yield* sessions.create({ parentID: chat.id, title: "newer", agent: "general" })
      yield* touchRow(newer.id, { time_updated: Date.now() + 1000 })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const result = yield* def.execute(args, ctxFor(chat, assistant, stubOps({ onPrompt: (input) => (seen = input) })))

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(2)
      expect(result.metadata.sessionId).toBe(newer.id)
      expect(seen?.sessionID).toBe(newer.id)
    }),
  )

  it.instance("skips sessions stale beyond TTL", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const stale = yield* sessions.create({ parentID: chat.id, title: "stale", agent: "general" })
      yield* touchRow(stale.id, { time_updated: Date.now() - HAND_REUSE_TTL_MS - 1000 })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(args, ctxFor(chat, assistant, stubOps()))

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(2)
      expect(result.metadata.sessionId).not.toBe(stale.id)
    }),
  )

  it.instance("explicit task_id behaves exactly as before", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const pinned = yield* sessions.create({ parentID: chat.id, title: "pinned", agent: "general" })
      yield* touchRow(pinned.id, {
        time_updated: Date.now() - HAND_REUSE_TTL_MS - 1000,
        tokens_input: HAND_REUSE_MAX_TOKENS + 1,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const result = yield* def.execute(
        { ...args, task_id: pinned.id },
        ctxFor(chat, assistant, stubOps({ onPrompt: (input) => (seen = input) })),
      )

      expect(yield* sessions.children(chat.id)).toHaveLength(1)
      expect(result.metadata.sessionId).toBe(pinned.id)
      expect(seen?.sessionID).toBe(pinned.id)
    }),
  )

  it.instance("skips when live context exceeds the cap", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const heavy = yield* sessions.create({ parentID: chat.id, title: "heavy", agent: "general" })
      const hUser = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: heavy.id,
        agent: "general",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: hUser.id,
        sessionID: heavy.id,
        mode: "general",
        agent: "general",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: HAND_REUSE_MAX_TOKENS + 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        variant: "xhigh",
        time: { created: Date.now() },
      } satisfies SessionV1.Assistant)
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(args, ctxFor(chat, assistant, stubOps()))

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(2)
      expect(result.metadata.sessionId).not.toBe(heavy.id)
    }),
  )

  it.instance("reuses child with no assistant message", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const empty = yield* sessions.create({ parentID: chat.id, title: "empty", agent: "general" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const result = yield* def.execute(args, ctxFor(chat, assistant, stubOps({ onPrompt: (input) => (seen = input) })))

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(result.metadata.sessionId).toBe(empty.id)
      expect(seen?.sessionID).toBe(empty.id)
    }),
  )

  it.instance("never considers sessions from a different parent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const other = yield* sessions.create({ title: "other parent" })
      const foreign = yield* sessions.create({ parentID: other.id, title: "foreign", agent: "general" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(args, ctxFor(chat, assistant, stubOps()))

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(result.metadata.sessionId).not.toBe(foreign.id)
      expect(result.metadata.sessionId).toBe(kids[0]?.id)
    }),
  )
})
