import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Task } from "@opencode-ai/core/task"
import { ScheduleTaskTool } from "@opencode-ai/core/tool/schedule-task"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_schedule_task_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let deny = false

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      Task.node,
      Location.node,
      LocationMutation.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      ScheduleTaskTool.node,
    ]),
    [
      [Location.node, tempLocationLayer],
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const setup = Effect.gen(function* () {
  assertions.length = 0
  deny = false
  const locationService = yield* Location.Service
  const directory = locationService.directory
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "schedule-task",
      directory,
      title: "schedule-task",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return directory
})

const call = (input: typeof ScheduleTaskTool.Input.Type, id = "call-schedule-task") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: ScheduleTaskTool.name, input },
})

describe("ScheduleTaskTool", () => {
  it.live("creates a task in the current directory and returns its identity", () =>
    Effect.gen(function* () {
      const directory = yield* setup
      const registry = yield* ToolRegistry.Service
      const tasks = yield* Task.Service

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([ScheduleTaskTool.name])

      const result = yield* executeTool(
        registry,
        call({ title: "Nightly", prompt: "run checks", cron: "daily" }),
      )
      const taskID = Task.ID.make(JSON.parse(result.value).taskID)
      const stored = yield* tasks.get(taskID)

      expect(stored?.title).toBe("Nightly")
      expect(stored?.prompt.text).toBe("run checks")
      expect(stored?.cron).toBe("0 0 * * *")
      expect(stored?.directory).toBe(directory)
      expect(stored?.enabled).toBe(true)
      expect(stored?.next_run_at).toBeUndefined()
      expect(assertions).toMatchObject([
        { sessionID, action: "schedule_task", resources: ["*"], save: ["*"] },
      ])
    }),
  )

  it.live("rejects invalid cron with a tool error", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const tasks = yield* Task.Service

      const result = yield* executeTool(
        registry,
        call({ title: "Broken", prompt: "never fires", cron: "not a schedule" }),
      )
      expect(result.type).toBe("error")
      expect((yield* tasks.all())).toHaveLength(0)
    }),
  )

  it.live("does not create a task when permission is denied", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const tasks = yield* Task.Service
      deny = true

      const result = yield* executeTool(
        registry,
        call({ title: "Blocked", prompt: "nope", cron: "hourly" }),
      )
      expect(result.type).toBe("error")
      expect((yield* tasks.all())).toHaveLength(0)
    }),
  )
})
