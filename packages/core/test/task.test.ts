import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Task } from "@opencode-ai/core/task"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@opencode-ai/schema/session-id"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Task.node])))

const directory = AbsolutePath.make("/tmp/task-test")

const createInput = {
  title: "Nightly sync",
  prompt: { text: "Summarize the repo state" },
  cron: "0 3 * * *",
  directory,
}

describe("Task", () => {
  it.effect("creates, reads, updates, and removes tasks", () =>
    Effect.gen(function* () {
      const tasks = yield* Task.Service

      const created = yield* tasks.create(createInput)
      expect(created.title).toBe("Nightly sync")
      expect(created.cron).toBe("0 3 * * *")
      expect(created.enabled).toBe(true)
      expect(created.missed_runs).toBe(0)
      expect(created.run_count).toBe(0)
      expect(created.sessionID).toBeUndefined()
      expect(created.next_run_at).toBeUndefined()

      expect(yield* tasks.get(created.id)).toEqual(created)
      expect(yield* tasks.all()).toEqual([created])

      const updated = yield* tasks.update(created.id, { title: "Renamed", enabled: false })
      expect(updated?.title).toBe("Renamed")
      expect(updated?.enabled).toBe(false)
      expect(updated?.cron).toBe("0 3 * * *")

      yield* tasks.remove(created.id)
      expect(yield* tasks.get(created.id)).toBeUndefined()
      expect(yield* tasks.all()).toEqual([])
    }),
  )

  it.effect("create with sessionID binds the task to an existing session", () =>
    Effect.gen(function* () {
      const tasks = yield* Task.Service
      const { db } = yield* Database.Service

      const projectID = ProjectV2.ID.make("task_test_project")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: directory, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      const sessionID = SessionID.make("ses_test123")
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "task-test",
          directory: "/tmp/task-test",
          title: "Task test",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const created = yield* tasks.create({ ...createInput, sessionID })
      expect(created.sessionID).toBe(sessionID)

      expect((yield* tasks.all())[0]?.sessionID).toBe(sessionID)

      // Removing the session detaches the binding instead of deleting the task.
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      const detached = yield* tasks.get(created.id)
      expect(detached?.sessionID).toBeUndefined()
    }),
  )

  it.effect("update of missing task returns undefined", () =>
    Effect.gen(function* () {
      const tasks = yield* Task.Service
      const missing = Task.ID.make("task_missing")
      expect(yield* tasks.update(missing, { title: "nope" })).toBeUndefined()
    }),
  )

  it.effect("remove of missing task is a no-op", () =>
    Effect.gen(function* () {
      const tasks = yield* Task.Service
      yield* tasks.remove(Task.ID.make("task_missing"))
      expect(yield* tasks.all()).toEqual([])
    }),
  )

  it.effect("claimDue claims only enabled due tasks once", () =>
    Effect.gen(function* () {
      const tasks = yield* Task.Service
      const now = Date.now()

      const due = yield* tasks.create(createInput)
      const future = yield* tasks.create({ ...createInput, title: "Future" })
      const paused = yield* tasks.create({ ...createInput, title: "Paused", enabled: false })

      // Seed next_run_at directly through startRun on a prior cycle is circular;
      // instead update via update() does not set next_run_at, so claim via a due
      // task whose next_run_at was set by startRun rescheduling. Simplest: claim
      // nothing first.
      expect(yield* tasks.claimDue(now)).toEqual([])

      // Insert next_run_at in the past for the due task by running a startRun with next in past.
      yield* tasks.startRun({
        id: due.id,
        runID: Task.RunID.create(),
        sessionID: SessionID.make("ses_seed"),
        started_at: now - 1000,
        next: now - 500,
      })
      // Paused task also gets a next_run_at but must never be claimed.
      yield* tasks.startRun({
        id: paused.id,
        runID: Task.RunID.create(),
        sessionID: SessionID.make("ses_seed"),
        started_at: now - 1000,
        next: now - 500,
      })
      // Future task rescheduled into the future.
      yield* tasks.startRun({
        id: future.id,
        runID: Task.RunID.create(),
        sessionID: SessionID.make("ses_seed"),
        started_at: now - 1000,
        next: now + 60_000,
      })

      const claimed = yield* tasks.claimDue(now)
      expect(claimed.map((entry) => entry.task.id)).toEqual([due.id])

      // Claim clears next_run_at: a second claim gets nothing.
      expect(yield* tasks.claimDue(now)).toEqual([])

      // last_run_at advanced for the due task by startRun.
      const after = yield* tasks.get(due.id)
      expect(after?.last_run_at).toBe(now - 1000)
      expect(after?.run_count).toBe(1)
      expect(after?.next_run_at).toBeUndefined()

      // Paused task kept its next_run_at but is never claimable.
      const pausedAfter = yield* tasks.get(paused.id)
      expect(pausedAfter?.enabled).toBe(false)

      // Future task untouched.
      const futureAfter = yield* tasks.get(future.id)
      expect(futureAfter?.next_run_at).toBe(now + 60_000)
    }),
  )

  it.effect("claimDue advances time boundary inclusively", () =>
    Effect.gen(function* () {
      const tasks = yield* Task.Service
      const now = Date.now()
      const task = yield* tasks.create(createInput)
      yield* tasks.startRun({
        id: task.id,
        runID: Task.RunID.create(),
        sessionID: SessionID.make("ses_seed"),
        started_at: now - 1000,
        next: now,
      })
      const claimed = yield* tasks.claimDue(now)
      expect(claimed.map((entry) => entry.task.id)).toEqual([task.id])
    }),
  )

  it.effect("finishRun marks runs completed and failed", () =>
    Effect.gen(function* () {
      const tasks = yield* Task.Service
      const now = Date.now()
      const task = yield* tasks.create(createInput)

      const okRun = Task.RunID.create()
      yield* tasks.startRun({
        id: task.id,
        runID: okRun,
        sessionID: SessionID.make("ses_a"),
        started_at: now,
        next: now + 60_000,
      })
      yield* tasks.finishRun({ runID: okRun, ended_at: now + 10 })

      const badRun = Task.RunID.create()
      yield* tasks.startRun({
        id: task.id,
        runID: badRun,
        sessionID: SessionID.make("ses_b"),
        started_at: now + 20,
        next: now + 60_000,
      })
      yield* tasks.finishRun({ runID: badRun, ended_at: now + 30, error: "boom" })

      const history = yield* tasks.runs(task.id)
      expect(history.map((run) => run.id)).toEqual([badRun, okRun])
      expect(history[0]?.status).toBe("failed")
      expect(history[0]?.error).toBe("boom")
      expect(history[0]?.ended_at).toBe(now + 30)
      expect(history[1]?.status).toBe("completed")
      expect(history[1]?.error).toBeUndefined()

      const after = yield* tasks.get(task.id)
      expect(after?.run_count).toBe(2)
      expect(after?.last_run_at).toBe(now + 20)
    }),
  )

  it.effect("pendingRuns returns only running runs", () =>
    Effect.gen(function* () {
      const tasks = yield* Task.Service
      const now = Date.now()
      const task = yield* tasks.create(createInput)

      const running = Task.RunID.create()
      yield* tasks.startRun({
        id: task.id,
        runID: running,
        sessionID: SessionID.make("ses_r"),
        started_at: now,
        next: now + 60_000,
      })
      const done = Task.RunID.create()
      yield* tasks.startRun({
        id: task.id,
        runID: done,
        sessionID: SessionID.make("ses_d"),
        started_at: now + 10,
        next: now + 60_000,
      })
      yield* tasks.finishRun({ runID: done, ended_at: now + 20 })

      const pending = yield* tasks.pendingRuns()
      expect(pending.map((run) => run.id)).toEqual([running])
    }),
  )

  it.effect("recordMissed increments missed_runs only for enabled due tasks", () =>
    Effect.gen(function* () {
      const tasks = yield* Task.Service
      const now = Date.now()

      const due = yield* tasks.create(createInput)
      const paused = yield* tasks.create({ ...createInput, title: "Paused", enabled: false })
      for (const task of [due, paused]) {
        yield* tasks.startRun({
          id: task.id,
          runID: Task.RunID.create(),
          sessionID: SessionID.make("ses_seed"),
          started_at: now - 1000,
          next: now - 500,
        })
      }

      yield* tasks.recordMissed([due.id, paused.id], now)

      const afterDue = yield* tasks.get(due.id)
      expect(afterDue?.missed_runs).toBe(1)
      const afterPaused = yield* tasks.get(paused.id)
      expect(afterPaused?.missed_runs).toBe(0)
    }),
  )

  it.effect("runs respects the requested limit", () =>
    Effect.gen(function* () {
      const tasks = yield* Task.Service
      const now = Date.now()
      const task = yield* tasks.create(createInput)
      for (let i = 0; i < 3; i++) {
        yield* tasks.startRun({
          id: task.id,
          runID: Task.RunID.create(),
          sessionID: SessionID.make(`ses_${i}`),
          started_at: now + i,
          next: now + 60_000,
        })
      }
      const history = yield* tasks.runs(task.id, 2)
      expect(history).toHaveLength(2)
      expect(history[0]?.started_at).toBe(now + 2)
    }),
  )

  it.effect("removing a task cascades to its runs", () =>
    Effect.gen(function* () {
      const tasks = yield* Task.Service
      const now = Date.now()
      const task = yield* tasks.create(createInput)
      yield* tasks.startRun({
        id: task.id,
        runID: Task.RunID.create(),
        sessionID: SessionID.make("ses_cascade"),
        started_at: now,
        next: now + 60_000,
      })
      expect((yield* tasks.runs(task.id)).length).toBe(1)

      yield* tasks.remove(task.id)
      expect(yield* tasks.runs(task.id)).toEqual([])
    }),
  )
})
