import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { ORPHAN_ERROR, SessionProjector } from "@opencode/core/session/projector"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionV1 } from "@opencode/schema/v1/session"
import { eq } from "drizzle-orm"
import { Effect, Layer, Logger } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { StaleSubagentTask } from "@/session/stale-task"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Config } from "@/config/config"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode/core/database/database"
import { Provider } from "@opencode/core/provider"
import { Model } from "@opencode/core/model"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      StaleSubagentTask.node,
      Session.node,
      SessionRunState.node,
      SessionStatus.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Config.node,
      BackgroundJob.node,
      RuntimeFlags.node,
      Database.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const MINUTE = 60_000
const TIMEOUT = 15 * MINUTE

const seed = (input: {
  now: number
  start: number
  childUpdated: number
  /** `null` seeds a metadata-less part (no child pointer at all). */
  metadata?: Record<string, unknown> | null
  /** `"child"` seeds input.task_id with the real child id; any other string is used verbatim. */
  taskID?: string
}) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const parent = yield* sessions.create({ agent: "build", model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") } })
    const child = yield* sessions.create({ parentID: parent.id, agent: "build" })
    const message: SessionV1.User = {
      id: MessageID.ascending(),
      sessionID: parent.id,
      role: "user",
      time: { created: input.now },
      agent: "build",
      model: { providerID: Provider.ID.make("test"), modelID: Model.ID.make("test-model") },
    }
    yield* sessions.updateMessage(message)
    const partID = PartID.ascending()
    yield* sessions.updatePart({
      id: partID,
      messageID: message.id,
      sessionID: parent.id,
      type: "tool",
      callID: "call_stale_task",
      tool: "task",
      state: {
        status: "running",
        input: {
          prompt: "do the thing",
          description: "investigate the flake",
          subagent_type: "general",
          ...(input.taskID === undefined ? {} : { task_id: input.taskID === "child" ? child.id : input.taskID }),
        },
        title: "investigate the flake",
        ...(input.metadata === null
          ? {}
          : {
              metadata: input.metadata ?? {
                childSessionId: child.id,
                sessionId: child.id,
                model: { providerID: "test", modelID: "test-model" },
              },
            }),
        time: { start: input.start },
      },
    } satisfies SessionV1.ToolPart)
    yield* db
      .update(SessionTable)
      .set({ time_updated: input.childUpdated })
      .where(eq(SessionTable.id, child.id))
      .run()
      .pipe(Effect.orDie)
    return { sessions, parent, child, message, partID }
  })

const staleTextCount = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const messages = yield* sessions.messages({ sessionID })
    return messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text" && part.text.includes("Subagent task \"")).length
  })

describe("stale subagent sweep", () => {
  it.instance("finalizes a quiet running task part and queues the parent escalation", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const seeded = yield* seed({ now, start: now - 20 * MINUTE, childUpdated: now - 16 * MINUTE })
      const sweep = yield* StaleSubagentTask.Service

      const result = yield* sweep.sweep({ now, timeoutMs: TIMEOUT })

      expect(result.finalized).toBe(1)
      expect(result.escalated).toBe(1)
      const part = yield* seeded.sessions.getPart({
        sessionID: seeded.parent.id,
        messageID: seeded.message.id,
        partID: seeded.partID,
      })
      expect(part?.type).toBe("tool")
      if (part?.type !== "tool") throw new Error("expected tool part")
      expect(part.state.status).toBe("error")
      if (part.state.status !== "error") throw new Error("expected error state")
      expect(part.state.error).toContain("subagent stale: no activity for 960s")
      expect(part.state.metadata?.staleEscalated).toBe(true)
      expect(yield* staleTextCount(seeded.parent.id)).toBe(1)
    }),
  )

  it.instance("leaves a task part untouched while its child session shows recent activity", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const seeded = yield* seed({ now, start: now - 20 * MINUTE, childUpdated: now - MINUTE })
      const sweep = yield* StaleSubagentTask.Service

      const result = yield* sweep.sweep({ now, timeoutMs: TIMEOUT })

      expect(result.finalized).toBe(0)
      expect(result.escalated).toBe(0)
      const part = yield* seeded.sessions.getPart({
        sessionID: seeded.parent.id,
        messageID: seeded.message.id,
        partID: seeded.partID,
      })
      expect(part?.type).toBe("tool")
      if (part?.type !== "tool") throw new Error("expected tool part")
      expect(part.state.status).toBe("running")
      expect(yield* staleTextCount(seeded.parent.id)).toBe(0)
    }),
  )

  it.instance("boot reconciliation escalates a V1 task part orphaned by a previous process exactly once", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const sweep = yield* StaleSubagentTask.Service
      const now = Date.now()
      const parent = yield* sessions.create({ agent: "build", model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") } })
      const message: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID: parent.id,
        role: "user",
        time: { created: now },
        agent: "build",
        model: { providerID: Provider.ID.make("test"), modelID: Model.ID.make("test-model") },
      }
      yield* sessions.updateMessage(message)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: parent.id,
        type: "tool",
        callID: "call_orphan_task",
        tool: "task",
        state: {
          status: "error",
          input: { prompt: "do the thing", description: "orphaned hand", subagent_type: "general" },
          error: ORPHAN_ERROR,
          metadata: { model: { providerID: "test", modelID: "test-model" } },
          time: { start: now - 30 * MINUTE, end: now - 30 * MINUTE },
        },
      } satisfies SessionV1.ToolPart)

      const first = yield* sweep.reconcile({ now, boot: true })
      expect(first.finalized).toBe(1)
      expect(first.escalated).toBe(1)
      expect(yield* staleTextCount(parent.id)).toBe(1)

      // A second boot pass in the same process must not duplicate the message.
      const second = yield* sweep.reconcile({ now, boot: true })
      expect(second.finalized).toBe(0)
      expect(second.escalated).toBe(0)
      expect(yield* staleTextCount(parent.id)).toBe(1)
    }),
  )

  it.instance("root-only quiet parts that are not task tools are ignored", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const sweep = yield* StaleSubagentTask.Service
      const now = Date.now()
      const parent = yield* sessions.create({})
      const message: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID: parent.id,
        role: "user",
        time: { created: now },
        agent: "build",
        model: { providerID: Provider.ID.make("test"), modelID: Model.ID.make("test-model") },
      }
      yield* sessions.updateMessage(message)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: parent.id,
        type: "tool",
        callID: "call_other_tool",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "sleep 3600" },
          time: { start: now - 60 * MINUTE },
        },
      } satisfies SessionV1.ToolPart)

      const result = yield* sweep.sweep({ now, timeoutMs: TIMEOUT })
      expect(result.scanned).toBe(0)
      expect(result.finalized).toBe(0)
    }),
  )

  it.instance("fails open on a metadata-less part older than the timeout instead of finalizing it", () =>
    Effect.gen(function* () {
      const now = Date.now()
      // The 2026-10-25 18:33Z false positive: a healthy child was streaming,
      // but the part carried no child pointer. Created age alone must never
      // be read as silence.
      const seeded = yield* seed({ now, start: now - 20 * MINUTE, childUpdated: now - MINUTE, metadata: null })
      const sweep = yield* StaleSubagentTask.Service
      const logs: unknown[] = []

      const result = yield* sweep.sweep({ now, timeoutMs: TIMEOUT }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>((options) => {
              logs.push(options.message)
            }),
          ]),
        ),
      )

      expect(result.finalized).toBe(0)
      expect(result.escalated).toBe(0)
      const part = yield* seeded.sessions.getPart({
        sessionID: seeded.parent.id,
        messageID: seeded.message.id,
        partID: seeded.partID,
      })
      expect(part?.type).toBe("tool")
      if (part?.type !== "tool") throw new Error("expected tool part")
      expect(part.state.status).toBe("running")
      expect(logs).toContainEqual([
        "stale subagent sweep skipped part without a linked child session",
        expect.objectContaining({ partID: seeded.partID }),
      ])
    }),
  )

  it.instance("resolves the child from input.task_id when the metadata carries no pointer", () =>
    Effect.gen(function* () {
      const now = Date.now()
      // The live 2026-10-28 incident: the task part lost the metadata write to
      // an abort, so it carried no childSessionId — only input.task_id.
      const seeded = yield* seed({ now, start: now - 20 * MINUTE, childUpdated: now - 16 * MINUTE, metadata: null, taskID: "child" })
      const sweep = yield* StaleSubagentTask.Service

      const result = yield* sweep.sweep({ now, timeoutMs: TIMEOUT })

      expect(result.finalized).toBe(1)
      expect(result.escalated).toBe(1)
      const part = yield* seeded.sessions.getPart({
        sessionID: seeded.parent.id,
        messageID: seeded.message.id,
        partID: seeded.partID,
      })
      expect(part?.type).toBe("tool")
      if (part?.type !== "tool") throw new Error("expected tool part")
      expect(part.state.status).toBe("error")
      if (part.state.status !== "error") throw new Error("expected error state")
      expect(part.state.error).toContain("subagent stale")
      expect(part.state.metadata?.staleEscalated).toBe(true)
      expect(yield* staleTextCount(seeded.parent.id)).toBe(1)
    }),
  )

  it.instance("resolves the child from input.task_id when metadata exists but has no child pointer", () =>
    Effect.gen(function* () {
      const now = Date.now()
      // Same part shape the processor's abort handler leaves behind: metadata
      // present ({ interrupted: true }) but no durable child pointer.
      const seeded = yield* seed({
        now,
        start: now - 20 * MINUTE,
        childUpdated: now - 16 * MINUTE,
        metadata: { interrupted: true },
        taskID: "child",
      })
      const sweep = yield* StaleSubagentTask.Service

      const result = yield* sweep.sweep({ now, timeoutMs: TIMEOUT })

      expect(result.finalized).toBe(1)
      expect(result.escalated).toBe(1)
      expect(yield* staleTextCount(seeded.parent.id)).toBe(1)
    }),
  )

  it.instance("ignores an input.task_id that is not session-id shaped", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const seeded = yield* seed({ now, start: now - 20 * MINUTE, childUpdated: now - 16 * MINUTE, metadata: null, taskID: "not-a-session" })
      const sweep = yield* StaleSubagentTask.Service
      const logs: unknown[] = []

      const result = yield* sweep.sweep({ now, timeoutMs: TIMEOUT }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>((options) => {
              logs.push(options.message)
            }),
          ]),
        ),
      )

      expect(result.finalized).toBe(0)
      expect(result.escalated).toBe(0)
      const part = yield* seeded.sessions.getPart({
        sessionID: seeded.parent.id,
        messageID: seeded.message.id,
        partID: seeded.partID,
      })
      expect(part?.type).toBe("tool")
      if (part?.type !== "tool") throw new Error("expected tool part")
      expect(part.state.status).toBe("running")
      expect(logs).toContainEqual([
        "stale subagent sweep skipped part without a linked child session",
        expect.objectContaining({ partID: seeded.partID }),
      ])
    }),
  )

  it.instance("aborts the child session when a genuinely stale linked part is finalized", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const seeded = yield* seed({ now, start: now - 20 * MINUTE, childUpdated: now - 16 * MINUTE })
      const sweep = yield* StaleSubagentTask.Service
      const runState = yield* SessionRunState.Service

      expect(yield* runState.lastCancelledAt(seeded.child.id)).toBe(0)
      const result = yield* sweep.sweep({ now, timeoutMs: TIMEOUT })

      expect(result.finalized).toBe(1)
      // Finalizing the part must stop the orphan, not leave it streaming.
      expect(yield* runState.lastCancelledAt(seeded.child.id)).toBeGreaterThan(0)
    }),
  )
})
