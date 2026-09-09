import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { MessageID, PartID } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
const sessionID = SessionV2.ID.make("ses_orphan_sweep_test")

const runningState = { status: "running", input: {}, time: { start: 1 } }
const completedState = { status: "completed", input: {}, output: "ok", title: "t", metadata: {}, time: { start: 1, end: 2 } }

const toolPart = (state: Record<string, unknown>) => ({ type: "tool", callID: "call-1", tool: "bash", state })

describe("sweepOrphanedParts", () => {
  it.effect("marks running parts failed, leaves completed parts, idempotent on rerun", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, slug: "t", directory: "/project", title: "t", version: "t" })
        .run()
      const messageID = MessageID.make("msg_orphan_sweep")
      yield* db.insert(MessageTable).values({ id: messageID, session_id: sessionID, data: {} as never }).run()
      const runningID = PartID.make("prt_orphan_running")
      const doneID = PartID.make("prt_orphan_done")
      yield* db
        .insert(PartTable)
        .values([
          { id: runningID, message_id: messageID, session_id: sessionID, data: toolPart(runningState) as never },
          { id: doneID, message_id: messageID, session_id: sessionID, data: toolPart(completedState) as never },
        ])
        .run()

      expect(yield* SessionProjector.sweepOrphanedParts(db)).toEqual(1)

      const running = yield* db.select().from(PartTable).where(eq(PartTable.id, runningID)).get().pipe(Effect.orDie)
      expect((running!.data as any).state.status).toEqual("error")
      expect((running!.data as any).state.error).toContain("Orphaned by restart")
      expect(typeof (running!.data as any).state.time.end).toEqual("number")

      const done = yield* db.select().from(PartTable).where(eq(PartTable.id, doneID)).get().pipe(Effect.orDie)
      expect((done!.data as any).state).toEqual(completedState)

      expect(yield* SessionProjector.sweepOrphanedParts(db)).toEqual(0)
    }),
  )
})
